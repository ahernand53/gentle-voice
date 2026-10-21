/**
 * Barge transcription window.
 * Detection may use the whole monitor. Whisper only receives audio from the
 * onset of the confirming voiced run, plus a short attack preroll.
 * Earlier samples stay out: that is where speaker bleed lives.
 * This is not a fixed trim of the user's phrase, and it is not acoustic echo cancellation.
 */

export const BARGE_ONSET_PREROLL_MS = 80;
/** Below this, the window is not a reliable user turn. Do not send it to STT. */
export const BARGE_MIN_TRANSCRIPT_MS = 200;

export interface BargeTranscriptFrame {
	readonly atMs: number;
	readonly pcm: Uint8Array;
}

export interface BargeTranscript {
	observe(atMs: number, pcm: Uint8Array, runStartMs: number | undefined): void;
	/** Audio after the interrupt is confirmed. Ignored until a run is anchored. */
	pushDuringRun(atMs: number, pcm: Uint8Array): void;
	pcm(): Uint8Array;
	/** True once a voiced candidate has anchored the window. */
	anchored(): boolean;
	clear(): void;
}

export function createBargeTranscript(prerollMs = BARGE_ONSET_PREROLL_MS): BargeTranscript {
	let frames: BargeTranscriptFrame[] = [];
	let anchored = false;

	const trimPreroll = (nowMs: number): void => {
		frames = frames.filter((frame) => nowMs - frame.atMs <= prerollMs);
	};

	return {
		observe(atMs, pcm, runStartMs) {
			const copy = pcm.slice();
			if (runStartMs === undefined) {
				anchored = false;
				frames.push({ atMs, pcm: copy });
				trimPreroll(atMs);
				return;
			}
			if (!anchored) {
				anchored = true;
				frames = frames.filter((frame) => frame.atMs >= runStartMs - prerollMs);
			}
			frames.push({ atMs, pcm: copy });
		},
		pushDuringRun(atMs, pcm) {
			if (!anchored) return;
			frames.push({ atMs, pcm: pcm.slice() });
		},
		pcm() {
			const total = frames.reduce((sum, frame) => sum + frame.pcm.byteLength, 0);
			const out = new Uint8Array(total);
			let offset = 0;
			for (const frame of frames) {
				out.set(frame.pcm, offset);
				offset += frame.pcm.byteLength;
			}
			return out;
		},
		anchored: () => anchored,
		clear() {
			frames = [];
			anchored = false;
		},
	};
}

export function bargeTranscriptMs(byteLength: number, sampleRateHz: number, channels = 1): number {
	const bytesPerSecond = Math.max(1, sampleRateHz) * Math.max(1, channels) * 2;
	return (byteLength / bytesPerSecond) * 1000;
}

export function bargeTranscriptSubmittable(
	byteLength: number,
	sampleRateHz: number,
	channels = 1,
): boolean {
	return bargeTranscriptMs(byteLength, sampleRateHz, channels) >= BARGE_MIN_TRANSCRIPT_MS;
}
