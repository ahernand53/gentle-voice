/**
 * Silero VAD (ONNX) — speech probability over 32 ms frames @ 16 kHz.
 * Model: snakers4/silero-vad (MIT). Runtime: optional `onnxruntime-node`.
 * Never throws into the capture path: callers use resolveVad / tryCreateSileroVad.
 *
 * Frame inference may be async (ORT). `pushPcmS16le` returns the current ended
 * flag; end may latch one chunk later — capture keeps buffering until then.
 */

import { access, constants, readFile } from "node:fs/promises";
import type { VadEngine, VadEngineState, VadPhase, VadTimingOptions } from "./types.ts";

/** 16 kHz Silero window (official). */
export const SILERO_WINDOW_SAMPLES = 512;
export const SILERO_STATE_SIZE = 2 * 1 * 128;

export interface SileroVadOptions extends VadTimingOptions {
	/** Path to silero_vad.onnx (required for real inference). */
	readonly modelPath: string;
	/** Speech probability threshold (0–1). Default 0.5. */
	readonly speechProbThreshold?: number;
	/**
	 * Injected frame runner (tests / non-ORT). Returns speech probability in [0, 1].
	 * Sync or async.
	 */
	readonly runFrame?: (frame: Float32Array) => number | Promise<number>;
}

export type SileroLoadResult =
	| { readonly ok: true; readonly engine: VadEngine }
	| { readonly ok: false; readonly reason: string };

type OrtModule = {
	InferenceSession: {
		create(path: string | Uint8Array, options?: object): Promise<{
			run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
			release?(): Promise<void>;
		}>;
	};
	Tensor: new (
		type: string,
		data: Float32Array | BigInt64Array,
		dims: number[],
	) => unknown;
};

async function tryImportOrt(): Promise<OrtModule | undefined> {
	try {
		const mod = await import("onnxruntime-node");
		return mod as unknown as OrtModule;
	} catch {
		return undefined;
	}
}

function pcmChunkToFloat32(chunk: Uint8Array): Float32Array {
	const samples = Math.floor(chunk.byteLength / 2);
	const out = new Float32Array(samples);
	const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	for (let i = 0; i < samples; i++) {
		out[i] = view.getInt16(i * 2, true) / 32768;
	}
	return out;
}

/**
 * Create Silero VAD from a frame scorer (sync or async).
 */
export function createSileroVadFromRunner(
	options: Omit<SileroVadOptions, "modelPath"> & {
		runFrame: (frame: Float32Array) => number | Promise<number>;
		modelPath?: string;
	},
): VadEngine {
	const silenceHangMs = options.silenceHangMs ?? 900;
	const maxIntraPauseMs = options.maxIntraPauseMs ?? 350;
	const postRollMs = options.postRollMs ?? 150;
	const maxListenMs = options.maxListenMs ?? 60_000;
	const sampleRateHz = options.sampleRateHz ?? 16_000;
	const speechProbThreshold = options.speechProbThreshold ?? 0.5;
	const runFrame = options.runFrame;

	let phase: VadPhase = "leading_silence";
	let speechSeen = false;
	let elapsedSamples = 0;
	let silenceSamples = 0;
	let postRollSamples = 0;
	let lastProb = 0;
	let pending = new Float32Array(0);
	let ended = false;
	let draining = false;

	const samplesToMs = (n: number) => (n / sampleRateHz) * 1_000;

	const applyProb = (prob: number, frameSamples: number): void => {
		lastProb = prob;
		elapsedSamples += frameSamples;
		const elapsedMs = samplesToMs(elapsedSamples);
		if (elapsedMs >= maxListenMs) {
			phase = "ended";
			ended = true;
			return;
		}
		const speaking = prob >= speechProbThreshold;
		if (speaking) {
			speechSeen = true;
			silenceSamples = 0;
			postRollSamples = 0;
			phase = "speech";
			return;
		}
		silenceSamples += frameSamples;
		const silenceMs = samplesToMs(silenceSamples);
		if (!speechSeen) {
			phase = "leading_silence";
			return;
		}
		if (silenceMs < maxIntraPauseMs) {
			phase = "pause";
			return;
		}
		if (silenceMs >= silenceHangMs) {
			postRollSamples += frameSamples;
			if (samplesToMs(postRollSamples) >= postRollMs) {
				phase = "ended";
				ended = true;
				return;
			}
			phase = "pause";
			return;
		}
		phase = "pause";
	};

	const drain = async (): Promise<void> => {
		if (draining) return;
		draining = true;
		try {
			while (pending.length >= SILERO_WINDOW_SAMPLES && !ended) {
				const frame = pending.slice(0, SILERO_WINDOW_SAMPLES);
				pending = pending.slice(SILERO_WINDOW_SAMPLES);
				const prob = await runFrame(frame);
				applyProb(prob, SILERO_WINDOW_SAMPLES);
			}
		} finally {
			draining = false;
			if (pending.length >= SILERO_WINDOW_SAMPLES && !ended) {
				void drain();
			}
		}
	};

	return {
		backend: "silero",
		get state(): VadEngineState {
			return {
				phase,
				speechSeen,
				elapsedMs: samplesToMs(elapsedSamples),
				silenceMs: samplesToMs(silenceSamples),
				backend: "silero",
				speechProb: lastProb,
			};
		},
		pushPcmS16le(chunk: Uint8Array): boolean {
			if (ended) return true;
			const f32 = pcmChunkToFloat32(chunk);
			const merged = new Float32Array(pending.length + f32.length);
			merged.set(pending);
			merged.set(f32, pending.length);
			pending = merged;
			// Sync fast-path (tests / sync scorers): end latches in the same call.
			while (pending.length >= SILERO_WINDOW_SAMPLES && !ended) {
				const frame = pending.subarray(0, SILERO_WINDOW_SAMPLES);
				const scored = runFrame(frame);
				if (typeof scored !== "number") {
					void drain();
					break;
				}
				pending = pending.slice(SILERO_WINDOW_SAMPLES);
				applyProb(scored, SILERO_WINDOW_SAMPLES);
			}
			return ended;
		},
		reset(): void {
			phase = "leading_silence";
			speechSeen = false;
			elapsedSamples = 0;
			silenceSamples = 0;
			postRollSamples = 0;
			lastProb = 0;
			pending = new Float32Array(0);
			ended = false;
			draining = false;
		},
	};
}

/**
 * Load Silero ONNX via onnxruntime-node. Fail-soft reasons for resolveVad.
 */
export async function tryCreateSileroVad(options: SileroVadOptions): Promise<SileroLoadResult> {
	if (options.runFrame) {
		return {
			ok: true,
			engine: createSileroVadFromRunner({ ...options, runFrame: options.runFrame }),
		};
	}
	const modelPath = options.modelPath?.trim();
	if (!modelPath) {
		return { ok: false, reason: "silero_model_path_missing" };
	}
	try {
		await access(modelPath, constants.R_OK);
	} catch {
		return { ok: false, reason: "silero_model_unreadable" };
	}
	if ((options.sampleRateHz ?? 16_000) !== 16_000) {
		return { ok: false, reason: "silero_requires_16khz" };
	}

	const ort = await tryImportOrt();
	if (!ort) {
		return { ok: false, reason: "onnxruntime_node_missing" };
	}

	try {
		const modelBytes = await readFile(modelPath);
		const session = await ort.InferenceSession.create(modelBytes);
		let stateData = new Float32Array(SILERO_STATE_SIZE);
		const sr = BigInt64Array.from([BigInt(16_000)]);

		const runFrame = async (frame: Float32Array): Promise<number> => {
			const input = new ort.Tensor("float32", frame, [1, SILERO_WINDOW_SAMPLES]);
			const state = new ort.Tensor("float32", stateData, [2, 1, 128]);
			const srT = new ort.Tensor("int64", sr, []);
			const out = await session.run({
				input,
				state,
				sr: srT,
			});
			const keys = Object.keys(out);
			const probTensor = out.output ?? out.out ?? out[keys[0]!];
			const stateOut = out.stateN ?? out.state ?? out[keys[1]!];
			const probData = probTensor?.data;
			const nextState = stateOut?.data;
			if (nextState && nextState.length === stateData.length) {
				stateData = Float32Array.from(nextState);
			}
			const p = probData?.[0];
			return typeof p === "number" && Number.isFinite(p) ? p : 0;
		};

		const engine = createSileroVadFromRunner({ ...options, runFrame });
		engine.dispose = async () => {
			await session.release?.();
		};
		return { ok: true, engine };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, reason: `silero_session_failed:${message.slice(0, 120)}` };
	}
}
