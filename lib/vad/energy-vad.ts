/**
 * Local energy VAD — no LLM, no network.
 * Distinguishes: leading silence → speech → brief pause → end-of-utterance.
 */

export type VadPhase = "leading_silence" | "speech" | "pause" | "ended";

export interface EnergyVadOptions {
	/** RMS threshold (0–1 relative to int16 full scale). */
	readonly speechThreshold?: number;
	/** Silence hang after speech before end (ms). */
	readonly silenceHangMs?: number;
	/** Ignore leading silence shorter than this before arming (ms). */
	readonly minLeadingSilenceMs?: number;
	/** Brief pause inside utterance that must NOT end capture (ms). */
	readonly maxIntraPauseMs?: number;
	/**
	 * Extra audio kept after silence-hang fires before ending (ms).
	 * Catches the tail of the last word / buffer drain.
	 */
	readonly postRollMs?: number;
	/** Hard cap on total capture (ms). */
	readonly maxListenMs?: number;
	readonly sampleRateHz?: number;
}

export interface EnergyVadState {
	phase: VadPhase;
	readonly speechSeen: boolean;
	readonly elapsedMs: number;
	readonly silenceMs: number;
}

export function createEnergyVad(options: EnergyVadOptions = {}) {
	const speechThreshold = options.speechThreshold ?? 0.012;
	const silenceHangMs = options.silenceHangMs ?? 1_200;
	const maxIntraPauseMs = options.maxIntraPauseMs ?? 450;
	const postRollMs = options.postRollMs ?? 200;
	const maxListenMs = options.maxListenMs ?? 60_000;
	const sampleRateHz = options.sampleRateHz ?? 16_000;

	let phase: VadPhase = "leading_silence";
	let speechSeen = false;
	let elapsedSamples = 0;
	let silenceSamples = 0;
	/** Samples collected after hang threshold while draining post-roll. */
	let postRollSamples = 0;

	const samplesToMs = (n: number) => (n / sampleRateHz) * 1_000;

	return {
		get state(): EnergyVadState {
			return {
				phase,
				speechSeen,
				elapsedMs: samplesToMs(elapsedSamples),
				silenceMs: samplesToMs(silenceSamples),
			};
		},
		/** Feed interleaved s16le mono PCM. Returns true when utterance should end. */
		pushPcmS16le(chunk: Uint8Array): boolean {
			const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
			const samples = Math.floor(chunk.byteLength / 2);
			for (let i = 0; i < samples; i++) {
				const s = view.getInt16(i * 2, true) / 32768;
				const amp = Math.abs(s);
				elapsedSamples += 1;
				const elapsedMs = samplesToMs(elapsedSamples);
				if (elapsedMs >= maxListenMs) {
					phase = "ended";
					return true;
				}
				if (amp >= speechThreshold) {
					speechSeen = true;
					silenceSamples = 0;
					postRollSamples = 0;
					phase = "speech";
					continue;
				}
				silenceSamples += 1;
				const silenceMs = samplesToMs(silenceSamples);
				if (!speechSeen) {
					phase = "leading_silence";
					continue;
				}
				if (silenceMs < maxIntraPauseMs) {
					phase = "pause";
					continue;
				}
				if (silenceMs >= silenceHangMs) {
					postRollSamples += 1;
					if (samplesToMs(postRollSamples) >= postRollMs) {
						phase = "ended";
						return true;
					}
					phase = "pause";
					continue;
				}
				phase = "pause";
			}
			return phase === "ended";
		},
		reset(): void {
			phase = "leading_silence";
			speechSeen = false;
			elapsedSamples = 0;
			silenceSamples = 0;
			postRollSamples = 0;
		},
	};
}

export type EnergyVad = ReturnType<typeof createEnergyVad>;
