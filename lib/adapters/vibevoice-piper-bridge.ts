/**
 * Opt-in cold-start bridge (GENTLE_VOICE_TTS_ON_COLD_START=piper only).
 *
 * Default product policy is wait: keep VibeVoice selected and show VOICE_LOADING.
 * This bridge is explicit: Piper answers cold turns while VV prewarms.
 */

import type { AdapterAvailability, TtsAdapter, TtsResult } from "../contracts.ts";
import type { VibeVoiceTtsAdapter } from "./vibevoice-tts.ts";
import { VIBEVOICE_TTS_ID } from "./vibevoice-tts.ts";

export interface VibeVoicePiperBridge extends TtsAdapter {
	readonly vibevoice: VibeVoiceTtsAdapter;
	readonly piper: TtsAdapter;
	readonly workerWarm: boolean;
	prewarm(): Promise<void>;
	dispose(): Promise<void>;
	setNotify(fn: (message: string, level?: "info" | "warning" | "error") => void): void;
	/** Last engine that actually produced audio. */
	readonly lastEngineUsed: "vibevoice" | "piper" | undefined;
}

export function createVibeVoicePiperBridge(options: {
	readonly vibevoice: VibeVoiceTtsAdapter;
	readonly piper: TtsAdapter;
	readonly notify?: (message: string, level?: "info" | "warning" | "error") => void;
}): VibeVoicePiperBridge {
	const { vibevoice, piper } = options;
	let notify = options.notify;
	let lastEngineUsed: "vibevoice" | "piper" | undefined;
	let coldFallbackNotified = false;

	const bridge: VibeVoicePiperBridge = {
		id: VIBEVOICE_TTS_ID,
		get vibevoice() {
			return vibevoice;
		},
		get piper() {
			return piper;
		},
		get workerWarm() {
			return vibevoice.workerWarm;
		},
		get lastEngineUsed() {
			return lastEngineUsed;
		},
		setNotify(fn) {
			notify = fn;
		},
		prewarm() {
			return vibevoice.prewarm();
		},
		dispose() {
			return vibevoice.dispose();
		},
		async availability(): Promise<AdapterAvailability> {
			const vv = await vibevoice.availability();
			if (vv.status === "ready") {
				return {
					status: "ready",
					detail: vibevoice.workerWarm
						? "vibevoice warm (direct)"
						: "vibevoice cold → piper until warm",
				};
			}
			return piper.availability();
		},
		async synthesize(text, opts): Promise<TtsResult> {
			if (vibevoice.workerWarm) {
				lastEngineUsed = "vibevoice";
				return vibevoice.synthesize(text, opts);
			}

			// Kick load in parallel; do not block this turn on CUDA.
			void vibevoice.prewarm().catch(() => {});

			if (!coldFallbackNotified) {
				coldFallbackNotified = true;
				notify?.(
					"VibeVoice cargando en background (~30–60s). Esta respuesta usa Piper (rápido); las siguientes usarán VibeVoice.",
					"info",
				);
			}

			lastEngineUsed = "piper";
			return piper.synthesize(text, opts);
		},
	};

	return bridge;
}
