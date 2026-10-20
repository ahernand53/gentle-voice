/**
 * Non-destructive real-world probes for Whisper.cpp, Piper, models, and known alternatives.
 * Never modifies, moves, or deletes discovered files.
 */

import { access, constants, open, readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import {
	resolveLabBinDirs,
	resolveLabModelRoots,
	resolveLabWhisperPaths,
} from "../runtime/lab-paths.ts";
import { resolveRuntimeLayout } from "../runtime/paths.ts";
import type { EngineProbe, EngineProbeHit } from "./detect.ts";
import type { DetectedModel, EngineId } from "./contracts.ts";

export interface FsProbeOptions {
	/** Extra PATH-like directories to search for binaries. */
	readonly pathDirs?: readonly string[];
	/** Extra roots that may contain models (read-only scan). */
	readonly modelRoots?: readonly string[];
	/** Env for PATH resolution (defaults to process.env). */
	readonly env?: NodeJS.ProcessEnv;
	/** Home directory override (tests). */
	readonly home?: string;
}

/** Product + optional lab search roots (exported for regression tests). */
export function defaultProbeSearchRoots(input: {
	readonly env?: NodeJS.ProcessEnv;
	readonly home?: string;
}): { readonly pathDirs: readonly string[]; readonly modelRoots: readonly string[] } {
	const env = input.env ?? process.env;
	const home = input.home ?? homedir();
	const layout = resolveRuntimeLayout(env);
	const pathDirs = [
		layout.binDir,
		join(home, ".local", "bin"),
		"/usr/local/bin",
		"/usr/bin",
		...resolveLabBinDirs(env),
	];
	const modelRoots = [
		layout.modelsDir,
		join(layout.modelsDir, "whisper"),
		join(layout.modelsDir, "piper"),
		env.GENTLE_VOICE_MODELS?.trim() ?? "",
		...resolveLabModelRoots(env),
	].filter(Boolean);

	return { pathDirs: [...new Set(pathDirs)], modelRoots: [...new Set(modelRoots)] };
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		const s = await stat(path);
		return s.isFile();
	} catch {
		return false;
	}
}

async function existsFile(path: string): Promise<boolean> {
	try {
		const s = await stat(path);
		return s.isFile();
	} catch {
		return false;
	}
}

function pathDirs(env: NodeJS.ProcessEnv, extra: readonly string[]): string[] {
	const fromEnv = (env.PATH ?? "").split(":").filter(Boolean);
	return [...extra, ...fromEnv];
}

async function findOnPath(names: readonly string[], dirs: readonly string[]): Promise<string | undefined> {
	for (const dir of dirs) {
		for (const name of names) {
			const candidate = join(dir, name);
			if (await isExecutable(candidate)) return candidate;
		}
	}
	return undefined;
}

async function fileSize(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).size;
	} catch {
		return undefined;
	}
}

async function looksLikeGgml(path: string): Promise<boolean> {
	try {
		const handle = await open(path, "r");
		try {
			const buf = Buffer.alloc(4);
			const { bytesRead } = await handle.read(buf, 0, 4, 0);
			if (bytesRead < 4) return false;
			// whisper.cpp ggml files often start with "ggml" or "lmgg" (endian-swapped in some builds)
			const magic = buf.toString("ascii");
			return magic === "ggml" || magic === "lmgg";
		} finally {
			await handle.close();
		}
	} catch {
		return false;
	}
}

async function collectWhisperModels(roots: readonly string[]): Promise<DetectedModel[]> {
	const out: DetectedModel[] = [];
	for (const root of roots) {
		let entries: string[] = [];
		try {
			entries = await readdir(root);
		} catch {
			continue;
		}
		for (const name of entries) {
			if (!name.endsWith(".bin")) continue;
			const path = join(root, name);
			if (!(await existsFile(path))) continue;
			if (!(await looksLikeGgml(path))) continue;
			const approxBytes = await fileSize(path);
			const id = basename(name, ".bin");
			out.push({
				id: `whisper/${id}`,
				path,
				languageTags: id.includes(".en") ? ["en"] : ["multilingual", "es", "en"],
				compatibleWith: "whisper-cpp",
				...(approxBytes !== undefined ? { approxBytes } : {}),
			});
		}
	}
	return out;
}

async function collectPiperVoices(roots: readonly string[]): Promise<DetectedModel[]> {
	const out: DetectedModel[] = [];
	for (const root of roots) {
		let entries: string[] = [];
		try {
			entries = await readdir(root);
		} catch {
			continue;
		}
		for (const name of entries) {
			if (!name.endsWith(".onnx")) continue;
			const path = join(root, name);
			if (!(await existsFile(path))) continue;
			const jsonPath = `${path}.json`;
			const hasJson = await existsFile(jsonPath);
			const approxBytes = await fileSize(path);
			let languageTags = ["unknown"];
			if (hasJson) {
				try {
					const meta = JSON.parse(await readFile(jsonPath, "utf8")) as {
						language?: { code?: string; family?: string };
					};
					const code = meta.language?.code;
					const family = meta.language?.family;
					languageTags = [code, family].filter((x): x is string => Boolean(x));
				} catch {
					/* keep unknown */
				}
			}
			out.push({
				id: `piper/${basename(name, ".onnx")}`,
				path,
				languageTags,
				compatibleWith: "piper",
				...(approxBytes !== undefined ? { approxBytes } : {}),
			});
		}
	}
	return out;
}

/**
 * Build a probe that scans the local machine (Linux-oriented defaults).
 * Lab paths only when GENTLE_VOICE_LAB/REAL_AUDIO is 1 and env roots are set.
 * Product default: private Gentle Voice storage + PATH — never hard-coded developer homes.
 */
export function createFilesystemEngineProbe(options: FsProbeOptions = {}): EngineProbe {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const defaults = defaultProbeSearchRoots({ env, home });
	const dirs = pathDirs(env, options.pathDirs ?? defaults.pathDirs);
	const modelRoots = options.modelRoots ?? defaults.modelRoots;
	const labWhisperPaths = resolveLabWhisperPaths(env);

	return {
		async listHits(): Promise<EngineProbeHit[]> {
			const hits: EngineProbeHit[] = [];

			const envWhisper = env.GENTLE_VOICE_WHISPER_CLI?.trim();
			const labWhisper = labWhisperPaths?.cli;
			const whisperBin =
				(envWhisper && (await isExecutable(envWhisper)) ? envWhisper : undefined)
				?? (labWhisper && (await isExecutable(labWhisper)) ? labWhisper : undefined)
				?? await findOnPath(
					["whisper-cli", "whisper-cpp", "whisper", "main"],
					dirs,
				);
			const allWhisperModels = await collectWhisperModels(modelRoots);
			const managedLab = Boolean(labWhisper && whisperBin === labWhisper)
				|| whisperBin === envWhisper;

			if (whisperBin) {
				hits.push({
					engineId: "whisper-cpp",
					path: whisperBin,
					compatible: true,
					external: !managedLab,
					models: allWhisperModels,
					version: managedLab ? "lab-managed" : "detected-binary",
				});
			} else if (allWhisperModels.length > 0) {
				// Model assets exist (e.g. Voxtype) but no standalone whisper.cpp CLI.
				hits.push({
					engineId: "whisper-cpp",
					path: allWhisperModels[0]!.path,
					compatible: false,
					external: true,
					models: allWhisperModels,
					problem: "ggml_model_found_without_whisper_cpp_binary",
				});
			}

			const piperBin = await findOnPath(["piper", "piper-tts"], dirs);
			const piperModels = await collectPiperVoices(modelRoots);
			if (piperBin) {
				hits.push({
					engineId: "piper",
					path: piperBin,
					compatible: true,
					external: true,
					models: piperModels,
					version: "cli-help-ok",
				});
			} else if (piperModels.length > 0) {
				hits.push({
					engineId: "piper",
					path: piperModels[0]!.path,
					compatible: false,
					external: true,
					models: piperModels,
					problem: "piper_voice_found_without_piper_binary",
				});
			}

			const espeak = await findOnPath(["espeak-ng", "espeak"], dirs);
			if (espeak) {
				hits.push({
					engineId: "espeak-ng",
					path: espeak,
					compatible: true,
					external: true,
					models: [],
				});
			}

			const vosk = await findOnPath(["vosk-transcriber", "vosk"], dirs);
			if (vosk) {
				hits.push({
					engineId: "vosk",
					path: vosk,
					compatible: true,
					external: true,
					models: [],
				});
			}

			return hits;
		},
	};
}

/**
 * Engines with a real adapter module (not stubs).
 * Piper TTS adapter is ready in dry-run (no playback).
 * Whisper STT adapter exists but is not ready until whisper-cli is installed.
 */
export const ADAPTER_READY_ENGINES: ReadonlySet<EngineId> = new Set([
	"piper",
	"whisper-cpp",
]);

export type EngineOperationalLabel =
	| "detected"
	| "compatible"
	| "adapter_ready"
	| "incompatible"
	| "unavailable";

export function operationalLabel(hit: {
	status: string;
	spec: { id: EngineId };
}): EngineOperationalLabel {
	if (hit.status === "missing") return "unavailable";
	if (hit.status === "incompatible") return "incompatible";
	if (hit.status === "compatible" && ADAPTER_READY_ENGINES.has(hit.spec.id)) return "adapter_ready";
	if (hit.status === "compatible") return "compatible";
	if (hit.status === "unknown") return "detected";
	return "detected";
}

/** Alternatives may appear in detection reports but are not selectable without an adapter. */
export function isSelectableEngine(engineId: EngineId): boolean {
	return ADAPTER_READY_ENGINES.has(engineId) || engineId === "whisper-cpp" || engineId === "piper";
}
