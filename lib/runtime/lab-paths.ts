/**
 * Lab-only path resolution from environment / explicit options.
 * Never embeds developer machine absolute paths in the published package.
 *
 * Required for lab defaults: GENTLE_VOICE_LAB=1 (or REAL_AUDIO) plus
 * GENTLE_VOICE_LAB_ROOT and/or the specific GENTLE_VOICE_* path vars below.
 */

import { join } from "node:path";
import { isGentleVoiceLabPathsAllowed } from "./lab-gate.ts";

function trim(env: NodeJS.ProcessEnv, key: string): string | undefined {
	const v = env[key]?.trim();
	return v && v.length > 0 ? v : undefined;
}

/** Root of an isolated lab tree (bin/, models/, tmp/, venv/, …). */
export function labRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (!isGentleVoiceLabPathsAllowed(env)) return undefined;
	return trim(env, "GENTLE_VOICE_LAB_ROOT");
}

export interface LabKokoroPaths {
	readonly pythonPath: string;
	readonly scriptPath: string;
	readonly modelPath: string;
	readonly voicesPath: string;
	readonly vocabPath: string;
}

/**
 * Kokoro lab paths — all from env (or LAB_ROOT-relative defaults when root is set).
 */
export function resolveLabKokoroPaths(
	env: NodeJS.ProcessEnv = process.env,
): LabKokoroPaths | undefined {
	if (!isGentleVoiceLabPathsAllowed(env)) return undefined;
	const root = labRoot(env);
	const pythonPath =
		trim(env, "GENTLE_VOICE_KOKORO_PYTHON")
		?? (root ? join(root, "venv", "bin", "python") : undefined);
	const scriptPath =
		trim(env, "GENTLE_VOICE_KOKORO_SCRIPT")
		?? (root ? join(root, "bin", "kokoro-synth.py") : undefined);
	const modelPath =
		trim(env, "GENTLE_VOICE_KOKORO_MODEL")
		?? (root ? join(root, "models", "kokoro", "onnx", "model_quantized.onnx") : undefined);
	const voicesPath =
		trim(env, "GENTLE_VOICE_KOKORO_VOICES")
		?? (root ? join(root, "models", "kokoro", "voices", "ef_dora_only.npz") : undefined);
	const vocabPath =
		trim(env, "GENTLE_VOICE_KOKORO_VOCAB")
		?? (root ? join(root, "models", "kokoro", "vocab-config.json") : undefined);
	if (!pythonPath || !scriptPath || !modelPath || !voicesPath || !vocabPath) {
		return undefined;
	}
	return { pythonPath, scriptPath, modelPath, voicesPath, vocabPath };
}

export interface LabPiperPaths {
	readonly piperPath: string;
	readonly voiceModelPath: string;
	readonly voiceConfigPath: string;
}

export function resolveLabPiperPaths(
	env: NodeJS.ProcessEnv = process.env,
): LabPiperPaths | undefined {
	if (!isGentleVoiceLabPathsAllowed(env)) return undefined;
	const piperPath = trim(env, "GENTLE_VOICE_PIPER");
	const voiceModelPath = trim(env, "GENTLE_VOICE_PIPER_VOICE");
	if (!piperPath || !voiceModelPath) return undefined;
	const voiceConfigPath =
		trim(env, "GENTLE_VOICE_PIPER_VOICE_CONFIG") ?? `${voiceModelPath}.json`;
	return { piperPath, voiceModelPath, voiceConfigPath };
}

export interface LabWhisperPaths {
	readonly cli: string;
	readonly model?: string;
	readonly installRoot?: string;
	readonly binDir?: string;
}

export function resolveLabWhisperPaths(
	env: NodeJS.ProcessEnv = process.env,
): LabWhisperPaths | undefined {
	if (!isGentleVoiceLabPathsAllowed(env)) return undefined;
	const root = labRoot(env);
	const cli =
		trim(env, "GENTLE_VOICE_WHISPER_CLI")
		?? (root ? join(root, "bin", "whisper-cli") : undefined);
	if (!cli) return undefined;
	const model =
		trim(env, "GENTLE_VOICE_WHISPER_MODEL")
		?? trim(env, "GENTLE_VOICE_VOXTYPE_MODEL");
	const installRoot = root ?? trim(env, "GENTLE_VOICE_WHISPER_INSTALL_ROOT");
	const binDir =
		trim(env, "GENTLE_VOICE_WHISPER_BIN_DIR")
		?? (installRoot ? join(installRoot, "bin") : undefined);
	return {
		cli,
		...(model ? { model } : {}),
		...(installRoot ? { installRoot } : {}),
		...(binDir ? { binDir } : {}),
	};
}

export function resolveLabTmpDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (!isGentleVoiceLabPathsAllowed(env)) return undefined;
	const explicit = trim(env, "GENTLE_VOICE_LAB_TMP") ?? trim(env, "GENTLE_VOICE_TMP");
	if (explicit) return explicit;
	const root = labRoot(env);
	return root ? join(root, "tmp") : undefined;
}

/** Extra bin dirs for lab probes (colon-separated) + LAB_ROOT/bin. */
export function resolveLabBinDirs(env: NodeJS.ProcessEnv = process.env): string[] {
	if (!isGentleVoiceLabPathsAllowed(env)) return [];
	const out: string[] = [];
	const root = labRoot(env);
	if (root) out.push(join(root, "bin"));
	const whisper = resolveLabWhisperPaths(env);
	if (whisper?.binDir) out.push(whisper.binDir);
	const extra = trim(env, "GENTLE_VOICE_LAB_BIN_DIRS");
	if (extra) {
		for (const part of extra.split(/[:;]/)) {
			const p = part.trim();
			if (p) out.push(p);
		}
	}
	return [...new Set(out)];
}

/** Extra model roots for lab probes. */
export function resolveLabModelRoots(env: NodeJS.ProcessEnv = process.env): string[] {
	if (!isGentleVoiceLabPathsAllowed(env)) return [];
	const out: string[] = [];
	const root = labRoot(env);
	if (root) {
		out.push(join(root, "models"));
		out.push(join(root, "models", "whisper"));
		out.push(join(root, "models", "piper"));
		out.push(join(root, "models", "kokoro"));
	}
	const models = trim(env, "GENTLE_VOICE_MODELS");
	if (models) out.push(models);
	const extra = trim(env, "GENTLE_VOICE_LAB_MODEL_ROOTS");
	if (extra) {
		for (const part of extra.split(/[:;]/)) {
			const p = part.trim();
			if (p) out.push(p);
		}
	}
	const voxtype = trim(env, "GENTLE_VOICE_VOXTYPE_MODELS_DIR");
	if (voxtype) out.push(voxtype);
	const piperVoices = trim(env, "GENTLE_VOICE_PIPER_VOICES_DIR");
	if (piperVoices) out.push(piperVoices);
	return [...new Set(out)];
}
