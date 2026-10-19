/**
 * Resolve real lab adapters when binaries exist; otherwise stubs.
 * Never downloads. Never touches Voxtype/Piper files beyond read/exec.
 * Developer absolute paths are used ONLY when GENTLE_VOICE_LAB or REAL_AUDIO is set.
 */

import { accessSync, constants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectVoicePlatform, type VoiceConfig } from "../config.ts";
import type { CaptureAdapter, PlaybackAdapter, SttAdapter, TtsAdapter } from "../contracts.ts";
import { createPipewireCaptureAdapter } from "./pipewire-capture.ts";
import { createPipewirePlaybackAdapter } from "./pipewire-playback.ts";
import {
	createPiperTtsAdapter,
	LAB_PIPER_DEFAULTS,
} from "./piper-tts.ts";
import {
	createKokoroTtsAdapter,
	labKokoroPresent,
} from "./kokoro-tts.ts";
import {
	createStubCaptureAdapter,
	createStubPlaybackAdapter,
	createStubSttAdapter,
	createStubTtsAdapter,
} from "./stubs.ts";
import {
	createWhisperSttAdapter,
	LAB_VOXTYPE_GGML_SMALL,
	LAB_WHISPER_CLI_CANDIDATE,
} from "./whisper-stt.ts";
import { DEFAULT_WHISPER_INITIAL_PROMPT } from "../stt/corrections.ts";
import { isGentleVoiceLabPathsAllowed } from "../runtime/lab-gate.ts";
import { resolveRuntimeLayout } from "../runtime/paths.ts";
import { resolveVoiceAdapters, type VoiceAdapterBundle } from "./platform.ts";
import {
	createOsFfmpegCaptureAdapter,
	createOsFfmpegPlaybackAdapter,
	findFfmpeg,
} from "./os-audio.ts";

/** @deprecated Prefer isGentleVoiceLabPathsAllowed — kept as alias for call sites. */
export function labPathsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
	return isGentleVoiceLabPathsAllowed(env);
}

function exeSync(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function readableSync(path: string): boolean {
	try {
		accessSync(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveTmpDir(options?: { config?: VoiceConfig; tmpDir?: string }): string {
	if (options?.tmpDir) return options.tmpDir;
	if (options?.config?.paths.tmp) return options.config.paths.tmp;
	if (process.env.GENTLE_VOICE_TMP) return process.env.GENTLE_VOICE_TMP;
	const layout = resolveRuntimeLayout();
	if (existsSync(layout.tmpDir)) return layout.tmpDir;
	const wd = "/home/erickfm/WD-Black/gentle-voice/tmp";
	if (isGentleVoiceLabPathsAllowed() && existsSync(wd)) return wd;
	return join(tmpdir(), "gentle-voice");
}

function resolvePiperFromEnvOrLab(): {
	piperPath: string;
	voiceModelPath: string;
	voiceConfigPath: string;
} | undefined {
	const envPiper = process.env.GENTLE_VOICE_PIPER?.trim();
	const envVoice = process.env.GENTLE_VOICE_PIPER_VOICE?.trim();
	if (envPiper && envVoice) {
		return {
			piperPath: envPiper,
			voiceModelPath: envVoice,
			voiceConfigPath: process.env.GENTLE_VOICE_PIPER_VOICE_CONFIG?.trim()
				|| `${envVoice}.json`,
		};
	}
	const layout = resolveRuntimeLayout();
	const runtimePiper = process.platform === "win32"
		? join(layout.dataDir, "bin", "piper.exe")
		: join(layout.dataDir, "bin", "piper");
	const runtimeVoice = join(layout.dataDir, "models", "piper", "es_AR-daniela-high.onnx");
	const runtimeVoiceCfg = `${runtimeVoice}.json`;
	if (exeSync(runtimePiper) && readableSync(runtimeVoice)) {
		return {
			piperPath: runtimePiper,
			voiceModelPath: runtimeVoice,
			voiceConfigPath: readableSync(runtimeVoiceCfg) ? runtimeVoiceCfg : `${runtimeVoice}.json`,
		};
	}
	if (!isGentleVoiceLabPathsAllowed()) return undefined;
	if (
		exeSync(LAB_PIPER_DEFAULTS.piperPath)
		&& readableSync(LAB_PIPER_DEFAULTS.voiceModelPath)
	) {
		return { ...LAB_PIPER_DEFAULTS };
	}
	return undefined;
}

function resolveWhisperFromRuntimeOrLab(config?: VoiceConfig): {
	cli: string;
	model: string;
} | undefined {
	const layout = resolveRuntimeLayout();
	const runtimeCli = process.platform === "win32"
		? join(layout.dataDir, "bin", "whisper-cli.exe")
		: join(layout.dataDir, "bin", "whisper-cli");
	const runtimeModel = join(layout.dataDir, "models", "whisper", "ggml-base-q5_1.bin");
	const envCli = process.env.GENTLE_VOICE_WHISPER_CLI?.trim();
	const envModel = process.env.GENTLE_VOICE_WHISPER_MODEL?.trim()
		|| config?.engines.sttModel?.trim();
	const cli = (envCli && exeSync(envCli) ? envCli : undefined)
		|| (exeSync(runtimeCli) ? runtimeCli : undefined)
		|| (isGentleVoiceLabPathsAllowed() && exeSync(LAB_WHISPER_CLI_CANDIDATE)
			? LAB_WHISPER_CLI_CANDIDATE
			: undefined);
	const model = (envModel && readableSync(envModel) ? envModel : undefined)
		|| (readableSync(runtimeModel) ? runtimeModel : undefined)
		|| (isGentleVoiceLabPathsAllowed() && readableSync(LAB_VOXTYPE_GGML_SMALL)
			? LAB_VOXTYPE_GGML_SMALL
			: undefined);
	if (cli && model) return { cli, model };
	return undefined;
}

export interface LabResolveResult {
	readonly bundle: VoiceAdapterBundle;
	readonly captureKind: "pipewire" | "ffmpeg" | "stub";
	readonly sttKind: "whisper" | "stub";
	readonly ttsKind: "piper" | "kokoro" | "stub";
	readonly playbackKind: "pipewire" | "ffmpeg" | "stub";
	readonly whisperCli?: string;
	readonly modelPath?: string;
	readonly piperPath?: string;
	readonly piperVoice?: string;
	readonly kokoroReady?: boolean;
	readonly piperAdapter?: TtsAdapter;
	readonly kokoroAdapter?: TtsAdapter;
}

export function resolveLabVoiceAdapters(options?: {
	config?: VoiceConfig;
	tmpDir?: string;
	forceStub?: boolean;
	onVadEnd?: () => void;
}): LabResolveResult {
	const platform = detectVoicePlatform();
	const tmpDir = resolveTmpDir(options);

	let capture: CaptureAdapter = createStubCaptureAdapter();
	let captureKind: "pipewire" | "ffmpeg" | "stub" = "stub";
	let stt: SttAdapter = createStubSttAdapter();
	let sttKind: "whisper" | "stub" = "stub";
	let tts: TtsAdapter = createStubTtsAdapter();
	let ttsKind: "piper" | "kokoro" | "stub" = "stub";
	let playback: PlaybackAdapter = createStubPlaybackAdapter();
	let playbackKind: "pipewire" | "ffmpeg" | "stub" = "stub";
	let whisperCli: string | undefined;
	let modelPath: string | undefined;
	let piperPath: string | undefined;
	let piperVoice: string | undefined;
	let piperAdapter: TtsAdapter | undefined;
	let kokoroAdapter: TtsAdapter | undefined;
	let kokoroReady = false;

	if (!options?.forceStub) {
		if (platform === "linux") {
			if (exeSync("/usr/bin/pw-record")) {
				const behavior = options?.config?.behavior;
				capture = createPipewireCaptureAdapter({
					pwRecordPath: "/usr/bin/pw-record",
					vad: {
						silenceHangMs: behavior?.silenceMs ?? 1_200,
						maxListenMs: behavior?.maxListenMs ?? 60_000,
						speechThreshold: behavior?.vadSpeechThreshold ?? 0.012,
						maxIntraPauseMs: behavior?.vadMaxIntraPauseMs ?? 450,
						postRollMs: 220,
					},
					vadArmDelayMs: behavior?.echoSettleMs ?? 250,
					...(options?.onVadEnd ? { onVadEnd: options.onVadEnd } : {}),
				});
				captureKind = "pipewire";
			}

			if (exeSync("/usr/bin/pw-play") || exeSync("/usr/bin/pw-cat")) {
				playback = createPipewirePlaybackAdapter({
					pwPlayPath: "/usr/bin/pw-play",
					tmpDir,
					keepTemp: false,
				});
				playbackKind = "pipewire";
			}
		} else if (platform === "win32" || platform === "darwin") {
			// Portable ffmpeg WASAPI / AVFoundation path (degraded until hardware smoke).
			if (findFfmpeg()) {
				const behavior = options?.config?.behavior;
				capture = createOsFfmpegCaptureAdapter({
					maxListenMs: behavior?.maxListenMs ?? 60_000,
				});
				playback = createOsFfmpegPlaybackAdapter();
				captureKind = "ffmpeg";
				playbackKind = "ffmpeg";
			}
		}

		const whisper = resolveWhisperFromRuntimeOrLab(options?.config);
		if (whisper) {
			stt = createWhisperSttAdapter({
				whisperCliPath: whisper.cli,
				modelPath: whisper.model,
				dryRun: false,
				language: options?.config?.engines.language === "auto"
					? "es"
					: (options?.config?.engines.language ?? "es"),
				tmpDir,
				keepTemp: false,
				initialPrompt: process.env.GENTLE_VOICE_WHISPER_PROMPT?.trim()
					|| DEFAULT_WHISPER_INITIAL_PROMPT,
			});
			sttKind = "whisper";
			whisperCli = whisper.cli;
			modelPath = whisper.model;
		}

		const piper = resolvePiperFromEnvOrLab();
		if (piper) {
			piperAdapter = createPiperTtsAdapter({
				...piper,
				dryRun: false,
				tmpDir,
				keepTemp: false,
			});
			tts = piperAdapter;
			ttsKind = "piper";
			piperPath = piper.piperPath;
			piperVoice = piper.voiceModelPath;
		}

		// Kokoro lab paths only when gate is ON (labKokoroPresent short-circuits OFF).
		if (labKokoroPresent()) {
			kokoroAdapter = createKokoroTtsAdapter({ tmpDir, keepTemp: false, dryRun: false });
			kokoroReady = true;
			const prefer = (process.env.GENTLE_VOICE_TTS ?? "").trim().toLowerCase();
			// Product default remains Piper; Kokoro only when explicitly preferred in lab.
			if (prefer === "kokoro" && kokoroAdapter) {
				tts = kokoroAdapter;
				ttsKind = "kokoro";
			}
		}
	}

	const bundle = resolveVoiceAdapters({
		platform,
		capture,
		stt,
		tts,
		playback,
	});

	return {
		bundle,
		captureKind,
		sttKind,
		ttsKind,
		playbackKind,
		kokoroReady,
		...(whisperCli ? { whisperCli } : {}),
		...(modelPath ? { modelPath } : {}),
		...(piperPath ? { piperPath } : {}),
		...(piperVoice ? { piperVoice } : {}),
		...(piperAdapter ? { piperAdapter } : {}),
		...(kokoroAdapter ? { kokoroAdapter } : {}),
	};
}
