/**
 * Developer-lab gate for tests that require a local lab tree.
 * CI and clean machines must skip those tests.
 *
 * Machine-specific paths live HERE (tests only — not shipped in npm).
 * Runtime code reads GENTLE_VOICE_* env exclusively.
 */

import { existsSync } from "node:fs";
import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { TestContext } from "node:test";

/** Local developer lab root (tests only). */
export const LAB_ROOT = "/home/erickfm/WD-Black/gentle-voice";
export const LAB_HOME = "/home/erickfm";

export const LAB_PIPER_DEFAULTS = Object.freeze({
	piperPath: `${LAB_HOME}/.local/bin/piper`,
	voiceModelPath: `${LAB_HOME}/.local/share/piper-voices/es_AR-daniela-high.onnx`,
	voiceConfigPath: `${LAB_HOME}/.local/share/piper-voices/es_AR-daniela-high.onnx.json`,
});

export const LAB_VOXTYPE_GGML_SMALL =
	`${LAB_HOME}/.local/share/voxtype/models/ggml-small.bin`;

export const LAB_WHISPER_INSTALL_ROOT = LAB_ROOT;
export const LAB_WHISPER_BIN_DIR = `${LAB_ROOT}/bin`;
export const LAB_WHISPER_CLI_CANDIDATE = `${LAB_WHISPER_BIN_DIR}/whisper-cli`;

export const LAB_KOKORO_ROOT = LAB_ROOT;
export const LAB_KOKORO_PYTHON = `${LAB_ROOT}/venv/bin/python`;
export const LAB_KOKORO_SCRIPT = `${LAB_ROOT}/bin/kokoro-synth.py`;
export const LAB_KOKORO_MODEL = `${LAB_ROOT}/models/kokoro/onnx/model_quantized.onnx`;
export const LAB_KOKORO_VOICES = `${LAB_ROOT}/models/kokoro/voices/ef_dora_only.npz`;
export const LAB_KOKORO_VOCAB = `${LAB_ROOT}/models/kokoro/vocab-config.json`;

/**
 * Inject lab env so production resolvers find this machine's tree.
 * Call at the start of skipWithoutLab tests (and keep GENTLE_VOICE_LAB=1).
 */
export function applyDeveloperLabEnv(): void {
	process.env.GENTLE_VOICE_LAB = "1";
	process.env.GENTLE_VOICE_LAB_ROOT = LAB_ROOT;
	process.env.GENTLE_VOICE_PIPER = LAB_PIPER_DEFAULTS.piperPath;
	process.env.GENTLE_VOICE_PIPER_VOICE = LAB_PIPER_DEFAULTS.voiceModelPath;
	process.env.GENTLE_VOICE_PIPER_VOICE_CONFIG = LAB_PIPER_DEFAULTS.voiceConfigPath;
	process.env.GENTLE_VOICE_WHISPER_CLI = LAB_WHISPER_CLI_CANDIDATE;
	process.env.GENTLE_VOICE_WHISPER_MODEL = LAB_VOXTYPE_GGML_SMALL;
	process.env.GENTLE_VOICE_VOXTYPE_MODEL = LAB_VOXTYPE_GGML_SMALL;
	process.env.GENTLE_VOICE_VOXTYPE_MODELS_DIR = `${LAB_HOME}/.local/share/voxtype/models`;
	process.env.GENTLE_VOICE_PIPER_VOICES_DIR = `${LAB_HOME}/.local/share/piper-voices`;
	process.env.GENTLE_VOICE_KOKORO_PYTHON = LAB_KOKORO_PYTHON;
	process.env.GENTLE_VOICE_KOKORO_SCRIPT = LAB_KOKORO_SCRIPT;
	process.env.GENTLE_VOICE_KOKORO_MODEL = LAB_KOKORO_MODEL;
	process.env.GENTLE_VOICE_KOKORO_VOICES = LAB_KOKORO_VOICES;
	process.env.GENTLE_VOICE_KOKORO_VOCAB = LAB_KOKORO_VOCAB;
	process.env.GENTLE_VOICE_LAB_TMP = `${LAB_ROOT}/tmp`;
}

/** True only when this machine actually has the developer lab tree. */
export function developerLabPresent(): boolean {
	if (process.env.GENTLE_VOICE_CI_LAB === "1") {
		return existsSync(LAB_ROOT);
	}
	if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
		return false;
	}
	return existsSync(LAB_ROOT);
}

/** node:test skip option — falsy when lab is available. */
export const skipWithoutLab: false | string = developerLabPresent()
	? false
	: "developer lab paths not present (CI/portable)";

/** Soft skip inside a test body. */
export function skipIfNoLab(t: TestContext): boolean {
	if (developerLabPresent()) return false;
	t.skip(skipWithoutLab || "developer lab paths not present");
	return true;
}

/** Append a line to a temp lab log — never touches developer trees on CI. */
export async function appendLabLog(fileName: string, line: string): Promise<void> {
	const base = developerLabPresent()
		? join(LAB_HOME, "D-SSD/personal/gs-lab/logs")
		: join(tmpdir(), "gentle-voice-ci-logs");
	try {
		await mkdir(base, { recursive: true });
		await appendFile(join(base, fileName), `${new Date().toISOString()} ${line}\n`);
	} catch {
		/* logging must never fail tests */
	}
}

export function portableHome(): string {
	return process.env.HOME?.trim() || homedir();
}

/** Absolute paths for this machine's gs-lab layout (tests only). */
export function developerDefaultLabPaths(): {
	labHome: string;
	experimentalGs: string;
	voiceExtension: string;
	launcherConfig: string;
	modelsRoot: string;
} {
	return {
		labHome: join(LAB_HOME, "D-SSD/personal/gs-lab/agent"),
		experimentalGs: join(LAB_HOME, "D-SSD/personal/projects/gentle-shell"),
		voiceExtension: join(
			LAB_HOME,
			"D-SSD/personal/projects/gentle-voice/extensions/voice.ts",
		),
		launcherConfig: join(LAB_HOME, "D-SSD/personal/gs-lab/launcher-config.json"),
		modelsRoot: join(LAB_ROOT, "models"),
	};
}
