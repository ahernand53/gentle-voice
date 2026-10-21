/**
 * Incremental / provisional STT — UI-only progressive transcripts.
 *
 * Lifecycle (critical for ghost prevention):
 * - Buffer PCM only while listening; attempts require speechSeen.
 * - Single-flight whisper-cli (never concurrent with another partial).
 * - seal() on VAD end / cancel / submit: stop timer, abort, never accept again
 *   until reset() on a new listen. cancelInFlight alone used to bump generation
 *   but leave the interval running → post-submit hallucinations ("el Perú").
 * - Final Pi submit stays on post-VAD full STT + utterance gate.
 */

import type { AudioChunk, SttAdapter } from "../contracts.ts";
import { AbortError, isAbortError } from "../process-cancel.ts";

export type IncrementalSttKind = "partial" | "final";

export type IncrementalSttUiStatus =
	| "listening"
	| "decoding"
	| "partial"
	| "stale_cleared"
	| "sealed";

export interface IncrementalPartialEvent {
	readonly text: string;
	readonly kind: IncrementalSttKind;
	readonly generation: number;
	readonly captureGeneration: number;
	readonly elapsedMs: number;
	readonly pcmBytes: number;
}

export interface IncrementalStatusEvent {
	readonly status: IncrementalSttUiStatus;
	readonly generation: number;
	readonly captureGeneration: number;
	readonly staleAgeMs?: number;
	readonly busyMs?: number;
}

export interface IncrementalSttControllerOptions {
	readonly stt: SttAdapter;
	readonly language?: string;
	readonly preferPartialProfile?: boolean;
	readonly minPcmBytes?: number;
	readonly minNewBytes?: number;
	readonly intervalMs?: number;
	readonly staleMs?: number;
	readonly decodingHideMs?: number;
	readonly sampleRateHz?: number;
	readonly channels?: 1 | 2;
	/** Correlates UI events to one listen window. */
	readonly captureGeneration?: number;
	readonly now?: () => number;
	readonly onPartial?: (ev: IncrementalPartialEvent) => void;
	readonly onStatus?: (ev: IncrementalStatusEvent) => void;
	readonly onError?: (err: unknown) => void;
}

export interface IncrementalSttController {
	readonly enabled: true;
	pushPcm(pcm: Uint8Array): void;
	/** Unlock partial decode after VAD/energy first sees speech. */
	markSpeechSeen(): void;
	/** Hard stop: no further attempts/UI until reset (VAD end / Esc / submit). */
	seal(): void;
	reset(): void;
	/** @deprecated use seal() — kept as alias. */
	cancelInFlight(): Promise<void>;
	getProvisional(): string;
	getGeneration(): number;
	getUiStatus(): IncrementalSttUiStatus;
	isSealed(): boolean;
	hasSpeechSeen(): boolean;
	dispose(): void;
	readonly metrics: IncrementalSttMetrics;
}

export interface IncrementalSttMetrics {
	readonly attempts: number;
	readonly acceptedPartials: number;
	readonly droppedStale: number;
	readonly droppedNoSpeech: number;
	readonly staleClears: number;
	readonly decodingSignals: number;
	readonly sealedDrops: number;
	readonly firstPartialMs?: number;
	readonly lastPartialMs?: number;
	readonly lastPartialText?: string;
	readonly lastAcceptAgeMs?: number;
	readonly maxBusyMs?: number;
}

type PartialCapable = SttAdapter & {
	transcribePartial?: (
		audio: AudioChunk,
		options: { signal: AbortSignal; language?: string },
	) => Promise<{ text: string }>;
};

const DEFAULT_MIN_PCM = 16_000 * 2 * 0.9;
const DEFAULT_MIN_NEW = 16_000 * 2 * 0.55;
const DEFAULT_INTERVAL_MS = 900;
const DEFAULT_STALE_MS = 3_200;
const DEFAULT_DECODING_HIDE_MS = 1_800;

export function createIncrementalSttController(
	options: IncrementalSttControllerOptions,
): IncrementalSttController {
	const minPcm = options.minPcmBytes ?? DEFAULT_MIN_PCM;
	const minNew = options.minNewBytes ?? DEFAULT_MIN_NEW;
	const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	const decodingHideMs = options.decodingHideMs ?? DEFAULT_DECODING_HIDE_MS;
	const sampleRateHz = options.sampleRateHz ?? 16_000;
	const channels = options.channels ?? 1;
	const captureGeneration = options.captureGeneration ?? 0;
	const now = options.now ?? (() => Date.now());
	const stt = options.stt as PartialCapable;

	const chunks: Buffer[] = [];
	let bufferedBytes = 0;
	let bytesAtLastStart = 0;
	let generation = 0;
	let provisional = "";
	let busy = false;
	let sealed = false;
	let speechSeen = false;
	let inFlight: AbortController | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let startedAt = now();
	let disposed = false;
	let lastAcceptedAt: number | undefined;
	let busyStartedAt: number | undefined;
	let uiStatus: IncrementalSttUiStatus = "listening";
	let decodingSignaledForAttempt = false;

	const metrics: {
		attempts: number;
		acceptedPartials: number;
		droppedStale: number;
		droppedNoSpeech: number;
		staleClears: number;
		decodingSignals: number;
		sealedDrops: number;
		firstPartialMs?: number;
		lastPartialMs?: number;
		lastPartialText?: string;
		maxBusyMs?: number;
	} = {
		attempts: 0,
		acceptedPartials: 0,
		droppedStale: 0,
		droppedNoSpeech: 0,
		staleClears: 0,
		decodingSignals: 0,
		sealedDrops: 0,
	};

	const stopTimer = (): void => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	const emitStatus = (
		status: IncrementalSttUiStatus,
		extra?: { staleAgeMs?: number; busyMs?: number },
	): void => {
		uiStatus = status;
		options.onStatus?.({
			status,
			generation,
			captureGeneration,
			...(extra?.staleAgeMs !== undefined ? { staleAgeMs: extra.staleAgeMs } : {}),
			...(extra?.busyMs !== undefined ? { busyMs: extra.busyMs } : {}),
		});
	};

	const clearProvisionalForStale = (reason: "stale" | "decoding"): void => {
		if (!provisional) {
			if (reason === "decoding" && uiStatus !== "decoding") {
				metrics.decodingSignals += 1;
				emitStatus("decoding", {
					busyMs: busyStartedAt !== undefined ? now() - busyStartedAt : undefined,
				});
			}
			return;
		}
		const age = lastAcceptedAt !== undefined ? now() - lastAcceptedAt : undefined;
		provisional = "";
		if (reason === "stale") {
			metrics.staleClears += 1;
			emitStatus("stale_cleared", { staleAgeMs: age });
		} else {
			metrics.decodingSignals += 1;
			emitStatus("decoding", {
				staleAgeMs: age,
				busyMs: busyStartedAt !== undefined ? now() - busyStartedAt : undefined,
			});
		}
	};

	const snapshotPcm = (): Buffer => {
		if (chunks.length === 0) return Buffer.alloc(0);
		if (chunks.length === 1) return chunks[0]!;
		return Buffer.concat(chunks);
	};

	const tickUiFreshness = (): void => {
		if (disposed || sealed) return;
		const t = now();
		if (provisional && lastAcceptedAt !== undefined && t - lastAcceptedAt >= staleMs) {
			clearProvisionalForStale("stale");
		}
		if (
			busy
			&& busyStartedAt !== undefined
			&& !decodingSignaledForAttempt
			&& t - busyStartedAt >= decodingHideMs
		) {
			decodingSignaledForAttempt = true;
			clearProvisionalForStale("decoding");
		}
	};

	const runAttempt = async (): Promise<void> => {
		if (disposed || sealed || busy) return;
		if (!speechSeen) {
			metrics.droppedNoSpeech += 1;
			return;
		}
		if (bufferedBytes < minPcm) return;
		if (bufferedBytes - bytesAtLastStart < minNew && metrics.attempts > 0) return;

		const gen = generation;
		const pcm = snapshotPcm();
		if (pcm.byteLength < minPcm) return;

		busy = true;
		busyStartedAt = now();
		decodingSignaledForAttempt = false;
		bytesAtLastStart = bufferedBytes;
		metrics.attempts += 1;
		const ac = new AbortController();
		inFlight = ac;
		const t0 = now();

		const audio: AudioChunk = {
			format: "pcm_s16le",
			sampleRateHz,
			channels,
			bytes: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
		};

		try {
			const result = stt.transcribePartial && options.preferPartialProfile !== false
				? await stt.transcribePartial(audio, {
					signal: ac.signal,
					language: options.language,
				})
				: await stt.transcribe(audio, {
					signal: ac.signal,
					language: options.language,
				});
			if (disposed || sealed || gen !== generation) {
				metrics.droppedStale += 1;
				if (sealed) metrics.sealedDrops += 1;
				return;
			}
			const text = result.text.trim();
			const elapsedMs = Math.max(0, now() - t0);
			if (metrics.maxBusyMs === undefined || elapsedMs > metrics.maxBusyMs) {
				metrics.maxBusyMs = elapsedMs;
			}
			if (!text) return;

			provisional = text;
			lastAcceptedAt = now();
			metrics.acceptedPartials += 1;
			metrics.lastPartialMs = elapsedMs;
			metrics.lastPartialText = text;
			if (metrics.firstPartialMs === undefined) {
				metrics.firstPartialMs = Math.max(0, now() - startedAt);
			}
			emitStatus("partial");
			options.onPartial?.({
				text,
				kind: "partial",
				generation: gen,
				captureGeneration,
				elapsedMs,
				pcmBytes: pcm.byteLength,
			});
		} catch (err) {
			if (isAbortError(err) || (err instanceof Error && err.name === "AbortError")) {
				return;
			}
			if (disposed || sealed || gen !== generation) {
				metrics.droppedStale += 1;
				return;
			}
			options.onError?.(err);
		} finally {
			if (inFlight === ac) inFlight = undefined;
			busy = false;
			busyStartedAt = undefined;
			decodingSignaledForAttempt = false;
			if (!disposed && !sealed && gen === generation) {
				queueMicrotask(() => {
					void runAttempt();
				});
			}
		}
	};

	const ensureTimer = (): void => {
		if (timer || disposed || sealed) return;
		timer = setInterval(() => {
			tickUiFreshness();
			void runAttempt();
		}, intervalMs);
		if (typeof timer === "object" && "unref" in timer) {
			(timer as NodeJS.Timeout).unref?.();
		}
	};

	const seal = (): void => {
		if (sealed && !busy && !timer) return;
		sealed = true;
		generation += 1;
		stopTimer();
		inFlight?.abort();
		inFlight = undefined;
		busy = false;
		busyStartedAt = undefined;
		decodingSignaledForAttempt = false;
		provisional = "";
		lastAcceptedAt = undefined;
		emitStatus("sealed");
	};

	return {
		enabled: true,
		pushPcm(pcm: Uint8Array) {
			if (disposed || sealed || pcm.byteLength === 0) return;
			chunks.push(Buffer.from(pcm));
			bufferedBytes += pcm.byteLength;
			ensureTimer();
			tickUiFreshness();
			if (!busy && speechSeen && bufferedBytes >= minPcm && metrics.attempts === 0) {
				void runAttempt();
			}
		},
		markSpeechSeen() {
			if (disposed || sealed) return;
			if (speechSeen) return;
			speechSeen = true;
			ensureTimer();
			if (!busy && bufferedBytes >= minPcm) {
				void runAttempt();
			}
		},
		seal,
		reset() {
			generation += 1;
			inFlight?.abort();
			inFlight = undefined;
			busy = false;
			busyStartedAt = undefined;
			decodingSignaledForAttempt = false;
			sealed = false;
			speechSeen = false;
			chunks.length = 0;
			bufferedBytes = 0;
			bytesAtLastStart = 0;
			provisional = "";
			lastAcceptedAt = undefined;
			startedAt = now();
			uiStatus = "listening";
			stopTimer();
		},
		async cancelInFlight() {
			seal();
			await Promise.resolve();
		},
		getProvisional() {
			return provisional;
		},
		getGeneration() {
			return generation;
		},
		getUiStatus() {
			return uiStatus;
		},
		isSealed() {
			return sealed;
		},
		hasSpeechSeen() {
			return speechSeen;
		},
		dispose() {
			disposed = true;
			seal();
			chunks.length = 0;
			bufferedBytes = 0;
		},
		get metrics() {
			return {
				...metrics,
				...(lastAcceptedAt !== undefined
					? { lastAcceptAgeMs: Math.max(0, now() - lastAcceptedAt) }
					: {}),
			};
		},
	};
}

export function createDisabledIncrementalStt(): Pick<
	IncrementalSttController,
	| "pushPcm"
	| "markSpeechSeen"
	| "seal"
	| "reset"
	| "cancelInFlight"
	| "getProvisional"
	| "getUiStatus"
	| "isSealed"
	| "hasSpeechSeen"
	| "dispose"
	| "metrics"
> & { enabled: false } {
	return {
		enabled: false,
		pushPcm() {},
		markSpeechSeen() {},
		seal() {},
		reset() {},
		async cancelInFlight() {},
		getProvisional() {
			return "";
		},
		getUiStatus() {
			return "listening";
		},
		isSealed() {
			return true;
		},
		hasSpeechSeen() {
			return false;
		},
		dispose() {},
		metrics: {
			attempts: 0,
			acceptedPartials: 0,
			droppedStale: 0,
			droppedNoSpeech: 0,
			staleClears: 0,
			decodingSignals: 0,
			sealedDrops: 0,
		},
	};
}

export function isIncrementalSttEnabled(
	configFlag: boolean | undefined,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const raw = env.GENTLE_VOICE_INCREMENTAL_STT?.trim().toLowerCase();
	if (raw === "0" || raw === "false" || raw === "off") return false;
	if (raw === "1" || raw === "true" || raw === "on") return true;
	return configFlag === true;
}

export { AbortError };
