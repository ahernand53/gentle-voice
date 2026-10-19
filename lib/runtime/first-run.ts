/**
 * First-run readiness + consent-gated preparation (no lab env vars required).
 * Idempotent. Opt-out: GENTLE_VOICE_DISABLE_DOWNLOADS=1
 */

import { access, constants, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { detectVoicePlatform } from "../config.ts";
import {
	artifactsFor,
	detectArch,
	formatBytes,
	totalEstimatedBytes,
	type CpuArch,
	type RuntimeArtifact,
} from "./artifacts.ts";
import { checksumMatches, sha256File } from "./checksum.ts";
import { installArtifact } from "./download.ts";
import { resolveRuntimeLayout, type GentleVoiceRuntimeLayout } from "./paths.ts";

export type ReadinessStatus =
	| "ready"
	| "needs_consent"
	| "needs_manual"
	| "unsupported_platform"
	| "downloads_disabled"
	| "partial"
	| "error";

export interface ReadinessSnapshot {
	readonly schema: "gentle-voice.readiness/v1";
	readonly status: ReadinessStatus;
	readonly checkedAt: string;
	readonly platform: string;
	readonly arch: CpuArch | "other";
	readonly layoutHome: string;
	readonly missing: readonly string[];
	readonly present: readonly string[];
	readonly message: string;
	readonly estimatedDownloadBytes: number;
	readonly blockers: readonly string[];
}

export interface FirstRunPlan {
	readonly layout: GentleVoiceRuntimeLayout;
	readonly arch: CpuArch | "other";
	readonly missing: readonly RuntimeArtifact[];
	readonly present: readonly RuntimeArtifact[];
	readonly status: ReadinessStatus;
	readonly summary: string;
	readonly estimatedDownloadBytes: number;
	readonly blockers: readonly string[];
}

export interface FirstRunHost {
	notify(message: string, level?: "info" | "warning" | "error"): void;
	confirm?(title: string, message: string): Promise<boolean>;
}

async function existsReadable(path: string): Promise<boolean> {
	try {
		await access(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

function artifactTarget(layout: GentleVoiceRuntimeLayout, art: RuntimeArtifact): string {
	if (art.archive) return join(layout.dataDir, art.archive.installBinaryAs);
	return join(layout.dataDir, art.relativePath);
}

export async function buildFirstRunPlan(
	env: NodeJS.ProcessEnv = process.env,
): Promise<FirstRunPlan> {
	const platform = detectVoicePlatform();
	const layout = resolveRuntimeLayout(env, platform);
	const arch = detectArch();
	const blockers: string[] = [];

	if (platform === "unsupported" || arch === "other") {
		return {
			layout,
			arch,
			missing: [],
			present: [],
			status: "unsupported_platform",
			summary: `Platform/arch not supported yet (${platform}/${arch}).`,
			estimatedDownloadBytes: 0,
			blockers: [`unsupported:${platform}/${arch}`],
		};
	}

	if (platform === "darwin") {
		blockers.push(
			"whisper-cli: no official macOS CLI binary in whisper.cpp b5454 — STT auto-install incomplete on macOS until a pinned binary is added.",
		);
	}

	const catalog = artifactsFor(platform, arch);
	const present: RuntimeArtifact[] = [];
	const missing: RuntimeArtifact[] = [];
	for (const art of catalog) {
		const path = artifactTarget(layout, art);
		if (await existsReadable(path)) present.push(art);
		else missing.push(art);
	}

	if (missing.length === 0 && blockers.length === 0) {
		return {
			layout,
			arch,
			missing,
			present,
			status: "ready",
			summary: "All pinned STT/TTS artifacts present under the private Gentle Voice data dir.",
			estimatedDownloadBytes: 0,
			blockers,
		};
	}

	if (missing.length === 0 && blockers.length > 0) {
		return {
			layout,
			arch,
			missing,
			present,
			status: "partial",
			summary: `Binaries/models present, but platform blockers remain: ${blockers.join(" ")}`,
			estimatedDownloadBytes: 0,
			blockers,
		};
	}

	if (env.GENTLE_VOICE_DISABLE_DOWNLOADS === "1") {
		return {
			layout,
			arch,
			missing,
			present,
			status: "downloads_disabled",
			summary:
				`Missing ${missing.length} artifact(s) (~${formatBytes(totalEstimatedBytes(missing))}). `
				+ "Downloads disabled via GENTLE_VOICE_DISABLE_DOWNLOADS=1.",
			estimatedDownloadBytes: totalEstimatedBytes(missing),
			blockers,
		};
	}

	return {
		layout,
		arch,
		missing,
		present,
		status: "needs_consent",
		summary:
			`Ready to download ${missing.length} artifact(s) (~${formatBytes(totalEstimatedBytes(missing))}) `
			+ "into the private Gentle Voice data directory after consent.",
		estimatedDownloadBytes: totalEstimatedBytes(missing),
		blockers,
	};
}

export async function loadReadiness(
	layout: GentleVoiceRuntimeLayout,
): Promise<ReadinessSnapshot | undefined> {
	try {
		const raw = await readFile(layout.readinessFile, "utf8");
		return JSON.parse(raw) as ReadinessSnapshot;
	} catch {
		return undefined;
	}
}

export async function saveReadiness(
	snapshot: ReadinessSnapshot,
	layout: GentleVoiceRuntimeLayout,
): Promise<void> {
	await mkdir(dirname(layout.readinessFile), { recursive: true });
	const tmp = `${layout.readinessFile}.${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
	await rename(tmp, layout.readinessFile);
}

export function snapshotFromPlan(plan: FirstRunPlan): ReadinessSnapshot {
	return {
		schema: "gentle-voice.readiness/v1",
		status: plan.status,
		checkedAt: new Date().toISOString(),
		platform: plan.layout.platform,
		arch: plan.arch,
		layoutHome: plan.layout.home,
		missing: plan.missing.map((a) => a.id),
		present: plan.present.map((a) => a.id),
		message: plan.summary,
		estimatedDownloadBytes: plan.estimatedDownloadBytes,
		blockers: plan.blockers,
	};
}

async function ensureDirs(layout: GentleVoiceRuntimeLayout): Promise<void> {
	await mkdir(layout.dataDir, { recursive: true });
	await mkdir(layout.configDir, { recursive: true });
	await mkdir(layout.modelsDir, { recursive: true });
	await mkdir(layout.binDir, { recursive: true });
	await mkdir(layout.cacheDir, { recursive: true });
	await mkdir(layout.tmpDir, { recursive: true });
	await mkdir(layout.logsDir, { recursive: true });
	await mkdir(join(layout.cacheDir, "downloads"), { recursive: true });
}

/**
 * Ensure private dirs exist; evaluate readiness; download after consent.
 */
export async function runFirstRunPreparation(
	host: FirstRunHost,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ReadinessSnapshot> {
	const plan = await buildFirstRunPlan(env);
	await ensureDirs(plan.layout);

	if (plan.status === "ready" || plan.status === "partial") {
		const snap = snapshotFromPlan(plan);
		await saveReadiness(snap, plan.layout);
		if (plan.status === "partial") host.notify(plan.summary, "warning");
		return snap;
	}

	host.notify(plan.summary, plan.status === "unsupported_platform" ? "warning" : "info");

	if (plan.status !== "needs_consent") {
		const snap = snapshotFromPlan(plan);
		await saveReadiness(snap, plan.layout);
		return snap;
	}

	const lines = [
		"Gentle Voice needs local STT/TTS components (one-time download):",
		...plan.missing.map(
			(a) => `• ${a.displayName} (~${formatBytes(a.estimatedBytes)}) — ${a.license}`,
		),
		`Total ≈ ${formatBytes(plan.estimatedDownloadBytes)}`,
		`Install root: ${plan.layout.dataDir}`,
		"No sudo. No PATH changes. Artifacts stay private to Gentle Voice.",
		...(plan.blockers.length ? ["", "Known blockers:", ...plan.blockers.map((b) => `• ${b}`)] : []),
	].join("\n");

	let ok = false;
	if (typeof host.confirm === "function") {
		ok = await host.confirm("Gentle Voice setup", lines);
	} else if (env.GENTLE_VOICE_AUTO_DOWNLOAD === "1") {
		ok = true;
		host.notify("GENTLE_VOICE_AUTO_DOWNLOAD=1 — proceeding without interactive confirm.", "warning");
	} else {
		const snap = snapshotFromPlan({
			...plan,
			status: "needs_manual",
			summary:
				"Host has no confirm() UI. Re-run /gentle:voice setup in an interactive session, "
				+ "or set GENTLE_VOICE_AUTO_DOWNLOAD=1 after reviewing licenses/sizes.",
		});
		await saveReadiness(snap, plan.layout);
		host.notify(`${snap.message}\n\n${lines}`, "warning");
		return snap;
	}
	if (!ok) {
		const snap = snapshotFromPlan({
			...plan,
			status: "needs_manual",
			summary: "User declined downloads. Re-run /gentle:voice setup when ready.",
		});
		await saveReadiness(snap, plan.layout);
		host.notify(snap.message, "warning");
		return snap;
	}

	try {
		for (const art of plan.missing) {
			await installArtifact(art, plan.layout, (msg) => host.notify(msg, "info"));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const snap = snapshotFromPlan({
			...plan,
			status: "error",
			summary: `Download/install failed: ${message}`,
		});
		await saveReadiness(snap, plan.layout);
		host.notify(snap.message, "error");
		return snap;
	}

	const after = await buildFirstRunPlan(env);
	const snap = snapshotFromPlan(after);
	await saveReadiness(snap, plan.layout);
	host.notify(snap.message, snap.status === "ready" || snap.status === "partial" ? "info" : "warning");
	return snap;
}

/** Verify a file against expected sha256. */
export async function verifyArtifactFile(
	path: string,
	expectedSha256: string,
): Promise<boolean> {
	if (!expectedSha256) return false;
	const actual = await sha256File(path);
	return checksumMatches(actual, expectedSha256);
}
