/**
 * Stub adapters for capture / STT / TTS / playback.
 * Phase 0: no microphone, no models, no GPU, no network.
 */

import type {
	AdapterAvailability,
	AudioChunk,
	CaptureAdapter,
	CaptureSession,
	PlaybackAdapter,
	PlaybackHandle,
	SttAdapter,
	SttResult,
	TtsAdapter,
	TtsResult,
} from "../contracts.ts";
import { AbortError, onAbort, throwIfAborted } from "../process-cancel.ts";

const EMPTY_PCM: AudioChunk = Object.freeze({
	bytes: new Uint8Array(0),
	sampleRateHz: 16_000,
	channels: 1,
	format: "pcm_s16le",
});

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new AbortError());
			return;
		}
		const timer = setTimeout(resolve, ms);
		onAbort(signal, () => {
			clearTimeout(timer);
			reject(new AbortError());
		});
	});
}

export interface StubCaptureOptions {
	/** Text returned when stop() is called (simulates a recording). */
	audio?: AudioChunk;
	availability?: AdapterAvailability;
}

export function createStubCaptureAdapter(options: StubCaptureOptions = {}): CaptureAdapter {
	const availability: AdapterAvailability = options.availability ?? {
		status: "degraded",
		reason: "stub_capture",
		detail: "No real microphone in phase 0",
	};
	return {
		id: "stub-capture",
		async availability() {
			return availability;
		},
		async start({ signal, onFirstPcm }) {
			throwIfAborted(signal);
			const id = `capture-${Date.now()}`;
			// Stub is instantly "mic ready" so ARMING→LISTENING tests can progress.
			try {
				onFirstPcm?.({ captureId: id, atMs: Date.now() });
			} catch {
				/* ignore */
			}
			const session: CaptureSession = {
				id,
				async stop(stopSignal) {
					throwIfAborted(stopSignal ?? signal);
					return options.audio ?? EMPTY_PCM;
				},
			};
			return session;
		},
	};
}

export interface StubSttOptions {
	text?: string;
	availability?: AdapterAvailability;
	latencyMs?: number;
}

export function createStubSttAdapter(options: StubSttOptions = {}): SttAdapter {
	const availability: AdapterAvailability = options.availability ?? {
		status: "degraded",
		reason: "stub_stt",
		detail: "No whisper/model wired in phase 0",
	};
	return {
		id: "stub-stt",
		async availability() {
			return availability;
		},
		async transcribe(_audio, { signal }) {
			throwIfAborted(signal);
			if (options.latencyMs) await delay(options.latencyMs, signal);
			throwIfAborted(signal);
			const result: SttResult = {
				text: options.text ?? "",
				language: "und",
				confidence: 1,
			};
			return result;
		},
	};
}

export interface StubTtsOptions {
	availability?: AdapterAvailability;
	latencyMs?: number;
	audio?: AudioChunk;
}

export function createStubTtsAdapter(options: StubTtsOptions = {}): TtsAdapter {
	const availability: AdapterAvailability = options.availability ?? {
		status: "degraded",
		reason: "stub_tts",
		detail: "No piper/voice wired in phase 0",
	};
	return {
		id: "stub-tts",
		async availability() {
			return availability;
		},
		async synthesize(text, { signal }) {
			throwIfAborted(signal);
			if (!text.trim()) {
				return { audio: EMPTY_PCM };
			}
			if (options.latencyMs) await delay(options.latencyMs, signal);
			throwIfAborted(signal);
			const result: TtsResult = { audio: options.audio ?? EMPTY_PCM };
			return result;
		},
	};
}

export interface StubPlaybackOptions {
	availability?: AdapterAvailability;
	durationMs?: number;
}

export function createStubPlaybackAdapter(options: StubPlaybackOptions = {}): PlaybackAdapter {
	const availability: AdapterAvailability = options.availability ?? {
		status: "degraded",
		reason: "stub_playback",
		detail: "No real playback device in phase 0",
	};
	return {
		id: "stub-playback",
		async availability() {
			return availability;
		},
		async play(_audio, { signal }) {
			throwIfAborted(signal);
			const id = `play-${Date.now()}`;
			let stopFn: (() => void) | undefined;
			const done = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					detach();
					resolve();
				}, options.durationMs ?? 0);
				const detach = onAbort(signal, () => {
					clearTimeout(timer);
					reject(new AbortError());
				});
				stopFn = () => {
					clearTimeout(timer);
					detach();
					resolve();
				};
			});
			const handle: PlaybackHandle = {
				id,
				done: done.catch((error) => {
					if (error instanceof AbortError) return;
					throw error;
				}),
				async stop() {
					stopFn?.();
				},
			};
			return handle;
		},
	};
}

/** Platform-shaped adapter factories — all stubs in phase 0. */
export function createPlatformStubBundle(_platform: string): {
	capture: CaptureAdapter;
	stt: SttAdapter;
	tts: TtsAdapter;
	playback: PlaybackAdapter;
} {
	return {
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter(),
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter(),
	};
}
