/**
 * First-run readiness + consent-gated preparation.
 * Idempotent: if readiness says ready and files exist, no prompts.
 * Never downloads without explicit consent AND GENTLE_VOICE_ALLOW_DOWNLOADS=1
 * AND pinned sha256+url on the artifact.
 */

import { access, constants, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { arch as osArch } from "node:os";
import { detectVoicePlatform } from "../config.ts";
import {
	artifactsFor,
	formatBytes,
	totalEstimatedBytes,
	type RuntimeArtifact,
} from "./artifacts.ts";
import { checksumMatches, sha256File } from "./checksum.ts";
import { resolveRuntimeLayout, type GentleVoiceRuntimeLayout } from "./paths.ts";

export type CpuArch = "x64" | "arm64" | "other";

export type ReadinessStatus =
	| "ready"
	| "needs_consent"
	| "needs_manual"
	| "unsupported_platform"
	| "downloads_disabled"
	| "checksum_unpinned";

export interface ReadinessSnapshot {
	readonly schema: "gentle-voice.readiness/v1";
	readonly status: ReadinessStatus;
	readonly checkedAt: string;
	readonly platform: string;
	readonly arch: CpuArch;
	readonly layoutHome: string;
	readonly missing: readonly string[];
	readonly present: readonly string[];
	readonly message: string;
	readonly estimatedDownloadBytes: number;
}

export interface FirstRunPlan {
	readonly layout: GentleVoiceRuntimeLayout;
	readonly arch: CpuArch;
	readonly missing: readonly RuntimeArtifact[];
	readonly present: readonly RuntimeArtifact[];
	readonly status: ReadinessStatus;
	readonly summary: string;
	readonly estimatedDownloadBytes: number;
}

export interface FirstRunHost {
	notify(message: string, level?: "info" | "warning" | "error"): void;
	confirm?(title: string, message: string): Promise<boolean>;
}

function detectArch(raw: string = osArch()): CpuArch {
	if (raw === "x64" || raw === "x86_64") return "x64";
	if (raw === "arm64" || raw === "aarch64") return "arm64";
	return "other";
}

async function existsReadable(path: string): Promise<boolean> {
	try {
		await access(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

function artifactAbsolute(layout: GentleVoiceRuntimeLayout, art: RuntimeArtifact): string {
	if (art.kind === "stt-binary" || art.kind === "tts-binary") {
		return join(layout.dataDir, art.relativePath);
	}
	return join(layout.dataDir, art.relativePath);
}

export async function buildFirstRunPlan(
	env: NodeJS.ProcessEnv = process.env,
): Promise<FirstRunPlan> {
	const platform = detectVoicePlatform();
	const layout = resolveRuntimeLayout(env, platform);
	const arch = detectArch();

	if (platform === "unsupported" || arch === "other") {
		return {
			layout,
			arch,
			missing: [],
			present: [],
			status: "unsupported_platform",
			summary: `Platform/arch not supported yet (${platform}/${arch}).`,
			estimatedDownloadBytes: 0,
		};
	}

	const catalog = artifactsFor(platform, arch);
	const present: RuntimeArtifact[] = [];
	const missing: RuntimeArtifact[] = [];
	for (const art of catalog) {
		const path = artifactAbsolute(layout, art);
		if (await existsReadable(path)) present.push(art);
		else missing.push(art);
	}

	if (missing.length === 0) {
		return {
			layout,
			arch,
			missing,
			present,
			status: "ready",
			summary: "All default STT/TTS artifacts present under private Gentle Voice data dir.",
			estimatedDownloadBytes: 0,
		};
	}

	const unpinned = missing.filter((a) => !a.sha256 || !a.url);
	if (unpinned.length === missing.length) {
		return {
			layout,
			arch,
			missing,
			present,
			status: "checksum_unpinned",
			summary:
				`Missing ${missing.length} artifact(s) (~${formatBytes(totalEstimatedBytes(missing))}). `
				+ "Release has not pinned download URLs/SHA-256 yet — install engines manually or wait for a pinned beta.",
			estimatedDownloadBytes: totalEstimatedBytes(missing),
		};
	}

	if (env.GENTLE_VOICE_ALLOW_DOWNLOADS !== "1") {
		return {
			layout,
			arch,
			missing,
			present,
			status: "downloads_disabled",
			summary:
				`Missing ${missing.length} artifact(s) (~${formatBytes(totalEstimatedBytes(missing))}). `
				+ "Set GENTLE_VOICE_ALLOW_DOWNLOADS=1 and approve the consent prompt to fetch pinned releases.",
			estimatedDownloadBytes: totalEstimatedBytes(missing),
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

export async function saveReadiness(snapshot: ReadinessSnapshot, layout: GentleVoiceRuntimeLayout): Promise<void> {
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
	};
}

/**
 * Ensure private dirs exist; evaluate readiness; optionally consent-download.
 * Does not modify PATH, shell rc, or system packages.
 */
export async function runFirstRunPreparation(
	host: FirstRunHost,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ReadinessSnapshot> {
	const plan = await buildFirstRunPlan(env);
	await mkdir(plan.layout.dataDir, { recursive: true });
	await mkdir(plan.layout.configDir, { recursive: true });
	await mkdir(plan.layout.modelsDir, { recursive: true });
	await mkdir(plan.layout.binDir, { recursive: true });
	await mkdir(plan.layout.cacheDir, { recursive: true });
	await mkdir(plan.layout.tmpDir, { recursive: true });
	await mkdir(plan.layout.logsDir, { recursive: true });

	if (plan.status === "ready") {
		const snap = snapshotFromPlan(plan);
		await saveReadiness(snap, plan.layout);
		return snap;
	}

	host.notify(plan.summary, plan.status === "unsupported_platform" ? "warning" : "info");

	if (plan.status !== "needs_consent") {
		const snap = snapshotFromPlan(plan);
		await saveReadiness(snap, plan.layout);
		return snap;
	}

	const lines = [
		"Gentle Voice wants to download local STT/TTS components:",
		...plan.missing.map(
			(a) => `• ${a.displayName} (~${formatBytes(a.estimatedBytes)}) — ${a.license}`,
		),
		`Total ≈ ${formatBytes(plan.estimatedDownloadBytes)}`,
		`Install root: ${plan.layout.dataDir}`,
		"No sudo. No PATH changes. Artifacts stay private to Gentle Voice.",
	].join("\n");

	let ok = false;
	if (typeof host.confirm === "function") {
		ok = await host.confirm("Gentle Voice setup", lines);
	}
	if (!ok) {
		const snap = snapshotFromPlan({
			...plan,
			status: "needs_manual",
			summary: "User declined downloads. Provide engines under the data dir or re-run with consent.",
		});
		await saveReadiness(snap, plan.layout);
		host.notify(snap.message, "warning");
		return snap;
	}

	// Download path reserved for pinned artifacts only.
	for (const art of plan.missing) {
		if (!art.url || !art.sha256) {
			const snap = snapshotFromPlan({
				...plan,
				status: "checksum_unpinned",
				summary: `Cannot download ${art.id}: url/sha256 not pinned in this release.`,
			});
			await saveReadiness(snap, plan.layout);
			host.notify(snap.message, "error");
			return snap;
		}
	}

	host.notify(
		"Download URLs are pinned in catalog but network fetch is not enabled in this beta build yet. Place verified binaries manually under the data dir.",
		"warning",
	);
	const snap = snapshotFromPlan({
		...plan,
		status: "needs_manual",
		summary: "Consent recorded; automated fetch lands after checksum-pinned release assets.",
	});
	await saveReadiness(snap, plan.layout);
	return snap;
}

/** Verify a file against expected sha256 (for tests + future download). */
export async function verifyArtifactFile(
	path: string,
	expectedSha256: string,
): Promise<boolean> {
	if (!expectedSha256) return false;
	const actual = await sha256File(path);
	return checksumMatches(actual, expectedSha256);
}
