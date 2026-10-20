/**
 * VibeVoice onboarding. Network I/O is injected.
 * The extension calls the network adapter only when
 * GENTLE_VOICE_VIBEVOICE_ALLOW_NETWORK=1. Tests pass a fake fetcher.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { VIBEVOICE_PREFERRED_VOICE } from "../adapters/vibevoice-tts.ts";
import { planVibeVoiceInstall, type VibeVoiceHardwareReport } from "./install-plan.ts";
import {
	VIBEVOICE_ARTIFACTS,
	VIBEVOICE_CODE_COMMIT,
	VIBEVOICE_INTEGRITY_KIND,
	type VibeVoiceArtifact,
} from "./manifest.ts";
import { readTtsEnginePreference, writeTtsEnginePreference } from "./tts-preference.ts";

export interface OnboardingIo {
	fetch(artifact: VibeVoiceArtifact, destination: string, signal: AbortSignal): Promise<void>;
	run(command: string, args: readonly string[], signal: AbortSignal): Promise<{ code: number }>;
}

export type OnboardingStatus =
	| "reused"
	| "kept_piper"
	| "blocked"
	| "declined"
	| "consent_unavailable"
	| "network_not_authorized"
	| "installed"
	| "cancelled"
	| "corrupt"
	| "partial"
	| "failed";

export interface OnboardingResult {
	readonly status: OnboardingStatus;
	readonly engine: "piper" | "vibevoice";
	readonly voice: typeof VIBEVOICE_PREFERRED_VOICE;
	readonly playback: "pcm";
	readonly targetDir: string;
	readonly reason: string;
	readonly fetched: readonly string[];
	readonly skipped: readonly string[];
	readonly offeredEngine: "piper";
}

export function vibeVoiceInside(path: string, root: string): boolean {
	const abs = resolve(path);
	const base = resolve(root);
	return abs === base || abs.startsWith(base.endsWith(sep) ? base : base + sep);
}

async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	await new Promise<void>((resolveHash, reject) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolveHash());
	});
	return hash.digest("hex");
}

export async function artifactMatches(path: string, artifact: VibeVoiceArtifact): Promise<boolean> {
	try {
		const info = await stat(path);
		if (info.size !== artifact.bytes) return false;
		return (await sha256File(path)) === artifact.sha256;
	} catch {
		return false;
	}
}

function assertNoPrivilege(command: string, args: readonly string[]): void {
	if (command === "sudo" || args.includes("sudo")) {
		throw new Error("sudo_refused");
	}
}

function assertPrivateTool(command: string, targetDir: string): void {
	if (!isAbsolute(command)) return;
	if (!vibeVoiceInside(command, join(targetDir, ".venv"))) {
		throw new Error("python_not_private");
	}
}

async function placeArtifact(
	artifact: VibeVoiceArtifact,
	targetDir: string,
	io: OnboardingIo,
	signal: AbortSignal,
): Promise<"fetched" | "skipped"> {
	const dest = join(targetDir, artifact.relativePath);
	if (!vibeVoiceInside(dest, targetDir)) throw new Error("path_escapes");
	if (await artifactMatches(dest, artifact)) return "skipped";
	const partial = `${dest}.partial`;
	await mkdir(dirname(dest), { recursive: true });
	try {
		await io.fetch(artifact, partial, signal);
	} catch (error) {
		await rm(partial, { force: true });
		throw error;
	}
	if (!(await artifactMatches(partial, artifact))) {
		await rm(partial, { force: true });
		throw Object.assign(new Error(`corrupt:${artifact.id}`), { code: "corrupt" });
	}
	await rename(partial, dest);
	return "fetched";
}

export async function runVibeVoiceOnboarding(input: {
	readonly targetDir: string;
	readonly voiceHome: string;
	readonly hardware: VibeVoiceHardwareReport;
	readonly alreadyInstalled: boolean;
	readonly consent: boolean | undefined;
	readonly allowNetwork: boolean;
	readonly signal?: AbortSignal;
	readonly io?: OnboardingIo;
	readonly artifacts?: readonly VibeVoiceArtifact[];
}): Promise<OnboardingResult> {
	const signal = input.signal ?? new AbortController().signal;
	const artifacts = input.artifacts ?? VIBEVOICE_ARTIFACTS;
	const base = {
		voice: VIBEVOICE_PREFERRED_VOICE,
		playback: "pcm" as const,
		targetDir: input.targetDir,
		fetched: [] as string[],
		skipped: [] as string[],
		offeredEngine: "piper" as const,
	};
	const stored = readTtsEnginePreference(input.voiceHome);
	if (input.alreadyInstalled) {
		if (stored === "piper") {
			return { ...base, status: "kept_piper", engine: "piper", reason: "explicit_piper" };
		}
		writeTtsEnginePreference(input.voiceHome, "vibevoice");
		return { ...base, status: "reused", engine: "vibevoice", reason: "existing_engine" };
	}
	const plan = planVibeVoiceInstall({
		targetDir: input.targetDir,
		hardware: input.hardware,
		alreadyInstalled: false,
	});
	if (plan.status === "blocked") {
		return { ...base, status: "blocked", engine: "piper", reason: plan.reasons.join(",") };
	}
	if (input.consent === undefined) {
		return { ...base, status: "consent_unavailable", engine: "piper", reason: "confirm_required" };
	}
	if (!input.consent) {
		writeTtsEnginePreference(input.voiceHome, "piper");
		return { ...base, status: "declined", engine: "piper", reason: "user_declined" };
	}
	if (!input.allowNetwork || !input.io) {
		return { ...base, status: "network_not_authorized", engine: "piper", reason: "network_not_authorized" };
	}
	if (signal.aborted) {
		return { ...base, status: "cancelled", engine: "piper", reason: "cancelled" };
	}

	const io = input.io;
	const fetched: string[] = [];
	const skipped: string[] = [];
	try {
		const venv = join(input.targetDir, ".venv");
		assertNoPrivilege("python3", ["-m", "venv", venv]);
		const created = await io.run("python3", ["-m", "venv", venv], signal);
		if (created.code !== 0) throw new Error("venv_failed");
		const python = join(venv, "bin", "python");
		const pip = join(venv, "bin", "pip");
		assertPrivateTool(python, input.targetDir);
		assertPrivateTool(pip, input.targetDir);
		const checked = await io.run(
			python,
			["-c", "import sys; raise SystemExit(0 if sys.prefix.endswith('.venv') else 3)"],
			signal,
		);
		if (checked.code !== 0) throw new Error("python_not_private");
		for (const artifact of artifacts) {
			if (signal.aborted) {
				return { ...base, status: "cancelled", engine: "piper", reason: "cancelled", fetched, skipped };
			}
			const outcome = await placeArtifact(artifact, input.targetDir, io, signal);
			if (outcome === "fetched") fetched.push(artifact.id);
			else skipped.push(artifact.id);
		}
		const pipArgs = ["install", "-e", `${join(input.targetDir, "code")}[streamingtts]`];
		assertNoPrivilege(pip, pipArgs);
		const installed = await io.run(pip, pipArgs, signal);
		if (installed.code !== 0) throw new Error("pip_failed");
		const receipt = {
			kind: VIBEVOICE_INTEGRITY_KIND,
			commit: VIBEVOICE_CODE_COMMIT,
			artifacts: artifacts.map((artifact) => ({
				path: artifact.relativePath,
				bytes: artifact.bytes,
				sha256: artifact.sha256,
			})),
		};
		const receiptPath = join(input.targetDir, "integrity.json");
		await mkdir(input.targetDir, { recursive: true });
		await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
		await writeFile(
			join(input.targetDir, "INSTALL_PENDING.json"),
			`${JSON.stringify({ authorized: true, status: "installed" }, null, 2)}\n`,
			{ mode: 0o600 },
		);
		writeTtsEnginePreference(input.voiceHome, "vibevoice");
		return {
			...base,
			status: "installed",
			engine: "vibevoice",
			reason: "verified",
			fetched,
			skipped,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed";
		if (message === "cancelled" || signal.aborted) {
			return { ...base, status: "cancelled", engine: "piper", reason: "cancelled", fetched, skipped };
		}
		const code = (error as { code?: string }).code;
		const status = code === "corrupt" ? "corrupt" : fetched.length + skipped.length > 0 ? "partial" : "failed";
		return { ...base, status, engine: "piper", reason: message, fetched, skipped };
	}
}

export async function uninstallVibeVoiceEngine(input: {
	readonly targetDir: string;
	readonly confirmToken?: string;
	readonly artifacts?: readonly VibeVoiceArtifact[];
}): Promise<{ deleted: boolean; reason: string }> {
	if (input.confirmToken !== "UNINSTALL_VIBEVOICE") return { deleted: false, reason: "confirm_required" };
	const receiptPath = join(input.targetDir, "integrity.json");
	let receipt: { kind?: string } | undefined;
	try {
		receipt = JSON.parse(await readFile(receiptPath, "utf8")) as { kind?: string };
	} catch {
		return { deleted: false, reason: "receipt_missing" };
	}
	if (receipt.kind !== VIBEVOICE_INTEGRITY_KIND) return { deleted: false, reason: "receipt_missing" };
	const artifacts = input.artifacts ?? VIBEVOICE_ARTIFACTS;
	const paths = [
		...artifacts.map((artifact) => artifact.relativePath),
		"integrity.json",
		"INSTALL_PENDING.json",
	];
	for (const rel of paths) {
		const abs = join(input.targetDir, rel);
		if (!vibeVoiceInside(abs, input.targetDir)) return { deleted: false, reason: "path_escapes" };
		const relCheck = relative(input.targetDir, abs);
		if (relCheck.startsWith("..") || isAbsolute(relCheck)) return { deleted: false, reason: "path_escapes" };
		await rm(abs, { force: true });
	}
	const venv = join(input.targetDir, ".venv");
	if (vibeVoiceInside(venv, input.targetDir)) await rm(venv, { recursive: true, force: true });
	return { deleted: true, reason: "removed_known_files" };
}
