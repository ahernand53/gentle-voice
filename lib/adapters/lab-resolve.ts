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
import { resolveVoiceAdapters, type VoiceAdapterBundle } from "./platform.ts";

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

function labPathsAllowed(): boolean {
	return process.env.GENTLE_VOICE_LAB === "1"
		|| process.env.GENTLE_VOICE_REAL_AUDIO === "1";
}

function resolveTmpDir(options?: { config?: VoiceConfig; tmpDir?: string }): string {
	if (options?.tmpDir) return options.tmpDir;
	if (options?.config?.paths.tmp) return options.config.paths.tmp;
	if (process.env.GENTLE_VOICE_TMP) return process.env.GENTLE_VOICE_TMP;
	const wd = "/home/erickfm/WD-Black/gentle-voice/tmp";
	if (labPathsAllowed() && existsSync(wd)) return wd;
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
	if (!labPathsAllowed()) return undefined;
	if (
		exeSync(LAB_PIPER_DEFAULTS.piperPath)
		&& readableSync(LAB_PIPER_DEFAULTS.voiceModelPath)
	) {
		return { ...LAB_PIPER_DEFAULTS };
	}
	return undefined;
}

export interface LabResolveResult {
	readonly bundle: VoiceAdapterBundle;
	readonly captureKind: "pipewire" | "stub";
	readonly sttKind: "whisper" | "stub";
	readonly ttsKind: "piper" | "kokoro" | "stub";
	readonly playbackKind: "pipewire" | "stub";
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
	let captureKind: "pipewire" | "stub" = "stub";
	let stt: SttAdapter = createStubSttAdapter();
	let sttKind: "whisper" | "stub" = "stub";
	let tts: TtsAdapter = createStubTtsAdapter();
	let ttsKind: "piper" | "kokoro" | "stub" = "stub";
	let playback: PlaybackAdapter = createStubPlaybackAdapter();
	let playbackKind: "pipewire" | "stub" = "stub";
	let whisperCli: string | undefined;
	let modelPath: string | undefined;
	let piperPath: string | undefined;
	let piperVoice: string | undefined;
	let piperAdapter: TtsAdapter | undefined;
	let kokoroAdapter: TtsAdapter | undefined;
	let kokoroReady = false;

	if (!options?.forceStub && platform === "linux") {
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
				// Default arm delay; session overrides per start() with echoSettleMs.
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

		const cli = process.env.GENTLE_VOICE_WHISPER_CLI?.trim() || LAB_WHISPER_CLI_CANDIDATE;
		const model = options?.config?.engines.sttModel?.trim()
			|| process.env.GENTLE_VOICE_WHISPER_MODEL?.trim()
			|| (labPathsAllowed() ? LAB_VOXTYPE_GGML_SMALL : "");
		if (cli && model && exeSync(cli) && readableSync(model)) {
			stt = createWhisperSttAdapter({
				whisperCliPath: cli,
				modelPath: model,
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
			whisperCli = cli;
			modelPath = model;
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

		// Kokoro available for A/B selection — default remains Piper unless env forces Kokoro.
		if (labKokoroPresent()) {
			kokoroAdapter = createKokoroTtsAdapter({ tmpDir, keepTemp: false, dryRun: false });
			kokoroReady = true;
			const prefer = (process.env.GENTLE_VOICE_TTS ?? "").trim().toLowerCase();
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
