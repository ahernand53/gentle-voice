/**
 * Session visual meter: throttled FPS, listen levels, playback scrub from real WAV.
 * Does not store audio beyond the current playback buffer reference.
 */

import {
	displayLevelFromRms,
	measurePcmS16le,
	pcmBytesFromAudio,
	pcmWindowAtTime,
} from "./pcm-amplitude.ts";
import { WaveBarMeter, barCountForTerminalColumns } from "./wave-bars.ts";

export type VisualSpeakStage = "idle" | "loading_voice" | "synthesizing" | "speaking";

export interface VisualMeterOptions {
	readonly enabled?: boolean;
	/** Target paint rate (capped). */
	readonly maxFps?: number;
	readonly speechThreshold?: number;
	readonly terminalColumns?: number;
	readonly now?: () => number;
	readonly onPaint?: () => void;
}

export interface VisualMetrics {
	readonly paintCount: number;
	readonly lastPaintAt: number;
	readonly measuredFps: number;
	readonly lastAmplitudeLatencyMs: number;
}

export class VisualMeter {
	readonly wave: WaveBarMeter;
	#enabled: boolean;
	#maxFps: number;
	#speechThreshold: number;
	#now: () => number;
	#onPaint?: () => void;
	#lastPaintAt = 0;
	#paintCount = 0;
	#fpsWindowStart = 0;
	#fpsWindowPaints = 0;
	#measuredFps = 0;
	#lastAmpAt = 0;
	#lastAmpLatencyMs = 0;
	#speakStage: VisualSpeakStage = "idle";
	#playbackPcm: Uint8Array | undefined;
	#playbackRms = 0;
	#playbackRate = 24_000;
	#playbackChannels = 1;
	#playbackStartedAt = 0;
	#playbackTimer: ReturnType<typeof setInterval> | undefined;
	#useSimpleSpeakingActivity = false;

	constructor(options: VisualMeterOptions = {}) {
		this.#enabled = options.enabled !== false;
		this.#maxFps = Math.min(15, Math.max(4, options.maxFps ?? 12));
		this.#speechThreshold = options.speechThreshold ?? 0.012;
		this.#now = options.now ?? Date.now;
		this.#onPaint = options.onPaint;
		this.wave = new WaveBarMeter({
			barCount: barCountForTerminalColumns(options.terminalColumns ?? 80),
			maxWidth: options.terminalColumns ?? 80,
		});
		this.#fpsWindowStart = this.#now();
	}

	get enabled(): boolean {
		return this.#enabled;
	}

	setEnabled(on: boolean): void {
		this.#enabled = on;
		if (!on) {
			this.stopPlaybackVisual();
			this.wave.clear();
			this.#speakStage = "idle";
		}
	}

	get speakStage(): VisualSpeakStage {
		return this.#speakStage;
	}

	get metrics(): VisualMetrics {
		return {
			paintCount: this.#paintCount,
			lastPaintAt: this.#lastPaintAt,
			measuredFps: this.#measuredFps,
			lastAmplitudeLatencyMs: this.#lastAmpLatencyMs,
		};
	}

	/** Prefer simple activity indicator (no fake sync) when playback progress is unreliable. */
	setSimpleSpeakingActivity(on: boolean): void {
		this.#useSimpleSpeakingActivity = on;
	}

	setTerminalColumns(cols: number): void {
		this.wave.setMaxWidth(cols);
	}

	/** Called from capture PCM chunks (real mic). */
	pushCapturePcm(pcmChunk: Uint8Array, channels = 1): void {
		if (!this.#enabled) return;
		const ampAt = this.#now();
		const sample = measurePcmS16le(pcmChunk, {
			speechThreshold: this.#speechThreshold,
			channels,
		});
		this.#lastAmpAt = ampAt;
		this.wave.pushLevel(displayLevelFromRms(sample.rms), sample.speech, ampAt);
		this.#maybePaint(ampAt);
	}

	beginSynthesizing(): void {
		this.#speakStage = "synthesizing";
		this.stopPlaybackVisual(false);
		this.wave.clear();
		this.#paint(this.#now());
	}

	/** Checkpoint / CUDA load — not generate. Distinct from SYNTHESIZING. */
	beginLoadingVoice(): void {
		this.#speakStage = "loading_voice";
		this.stopPlaybackVisual(false);
		this.wave.clear();
		this.#paint(this.#now());
	}

	/**
	 * Start speaking visual from real WAV/PCM. Progress estimated by wall clock
	 * (pw-play has no byte cursor) — levels come from the WAV window at t, not RNG.
	 */
	beginSpeakingFromAudio(audio: {
		bytes: Uint8Array;
		sampleRateHz: number;
		channels: number;
		format: string;
	}): void {
		// Stop prior timer only — keep new PCM assignment after.
		this.#clearPlaybackTimer();
		this.#speakStage = "speaking";
		this.#playbackPcm = pcmBytesFromAudio(audio.bytes, audio.format);
		this.#playbackRms = 0;
		this.#playbackRate = audio.sampleRateHz;
		this.#playbackChannels = audio.channels;
		this.#playbackStartedAt = this.#now();
		this.wave.clear();

		if (this.#useSimpleSpeakingActivity || !this.#enabled) {
			this.#paint(this.#now());
			return;
		}

		const intervalMs = Math.max(66, Math.round(1000 / this.#maxFps));
		this.#playbackTimer = setInterval(() => {
			this.#tickPlayback();
		}, intervalMs);
		// Do not keep the Node process alive for cosmetic paints (tests / exit).
		this.#playbackTimer.unref?.();
		this.#tickPlayback();
	}

	/** RMS of the playback window the meter is showing. 0 when not speaking. */
	playbackLevel(): number {
		return this.#speakStage === "speaking" ? this.#playbackRms : 0;
	}

	stopPlaybackVisual(clearStage = true): void {
		this.#clearPlaybackTimer();
		this.#playbackPcm = undefined;
		this.#playbackRms = 0;
		if (clearStage) this.#speakStage = "idle";
		this.wave.clear();
	}

	#clearPlaybackTimer(): void {
		if (this.#playbackTimer) {
			clearInterval(this.#playbackTimer);
			this.#playbackTimer = undefined;
		}
	}

	#tickPlayback(): void {
		if (!this.#playbackPcm || this.#speakStage !== "speaking") return;
		const now = this.#now();
		const t = (now - this.#playbackStartedAt) / 1000;
		const win = pcmWindowAtTime(
			this.#playbackPcm,
			this.#playbackRate,
			this.#playbackChannels,
			t,
			80,
		);
		if (win.byteLength === 0) {
			this.wave.decay(0.7);
			this.#maybePaint(now);
			return;
		}
		const sample = measurePcmS16le(win, {
			speechThreshold: this.#speechThreshold,
			channels: this.#playbackChannels,
		});
		this.#playbackRms = sample.rms;
		this.#lastAmpAt = now;
		this.wave.pushLevel(displayLevelFromRms(sample.rms), true, now);
		this.#maybePaint(now);
	}

	#maybePaint(now: number): void {
		const minGap = 1000 / this.#maxFps;
		if (now - this.#lastPaintAt < minGap && this.#lastPaintAt !== 0) return;
		this.#paint(now);
	}

	#paint(now: number): void {
		this.#lastPaintAt = now;
		this.#paintCount += 1;
		this.#fpsWindowPaints += 1;
		const elapsed = now - this.#fpsWindowStart;
		if (elapsed >= 1000) {
			this.#measuredFps = (this.#fpsWindowPaints * 1000) / elapsed;
			this.#fpsWindowStart = now;
			this.#fpsWindowPaints = 0;
		}
		this.#lastAmpLatencyMs = this.#lastAmpAt ? Math.max(0, now - this.#lastAmpAt) : 0;
		this.#onPaint?.();
	}

	dispose(): void {
		this.stopPlaybackVisual();
	}
}
