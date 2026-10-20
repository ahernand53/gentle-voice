/**
 * Linux PipeWire capture via `pw-record` (stdout PCM s16).
 * Optional VAD (Silero → energy fallback) auto-ends the utterance.
 * No system audio config changes.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, constants } from "node:fs/promises";
import type {
	AdapterAvailability,
	AudioChunk,
	CaptureAdapter,
	CaptureSegmentMeta,
	CaptureSession,
} from "../contracts.ts";
import { AbortError, ignoreUnhandledAbort, onAbort, throwIfAborted } from "../process-cancel.ts";
import type { EnergyVadOptions } from "../vad/energy-vad.ts";
import {
	resolveEnergyVadOnly,
	resolveVad,
	type VadBackendPreference,
} from "../vad/resolve-vad.ts";
import type { VadEngine } from "../vad/types.ts";
import { pcmS16leToWav } from "./wav.ts";

function chunkRmsS16le(pcm: Buffer, channels: number): number {
	const frameBytes = 2 * Math.max(1, channels);
	const frames = Math.floor(pcm.byteLength / frameBytes);
	if (frames <= 0) return 0;
	let sumSq = 0;
	for (let f = 0; f < frames; f++) {
		let acc = 0;
		for (let c = 0; c < channels; c++) {
			acc += pcm.readInt16LE((f * channels + c) * 2);
		}
		const mixed = acc / channels;
		sumSq += mixed * mixed;
	}
	return Math.sqrt(sumSq / frames) / 32768;
}

export interface PipewireCaptureOptions {
	readonly pwRecordPath?: string;
	readonly sampleRateHz?: number;
	readonly channels?: 1 | 2;
	/** Energy VAD options, or false to disable VAD. Ignored when vadEngine is set. */
	readonly vad?: EnergyVadOptions | false;
	/** energy | silero | auto (default auto when Silero path/env present). */
	readonly vadBackend?: VadBackendPreference;
	/** Absolute path to silero_vad.onnx (or set GENTLE_VOICE_SILERO_VAD). */
	readonly sileroModelPath?: string;
	/** Pre-built engine (tests). Skips resolveVad. */
	readonly vadEngine?: VadEngine;
	readonly onVadEnd?: () => void;
	/**
	 * Delay after capture start before VAD may end an utterance (echo settle).
	 * PCM is still buffered (pre-roll for speech that starts during the hold).
	 */
	readonly vadArmDelayMs?: number;
	/** Fired once when the first PCM chunk arrives (mic really producing). */
	readonly onFirstPcm?: (info: { captureId: string; atMs: number }) => void;
	/** Lab/metrics: which backend was selected for the last start(). */
	readonly onVadResolved?: (info: { backend: string; fallbackReason?: string }) => void;
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function createPipewireCaptureAdapter(options: PipewireCaptureOptions = {}): CaptureAdapter {
	const pwRecordPath = options.pwRecordPath ?? "pw-record";
	const sampleRateHz = options.sampleRateHz ?? 16_000;
	const channels = options.channels ?? 1;
	const vadEnabled = options.vad !== false;

	return {
		id: "linux-pipewire-capture",
		async availability(): Promise<AdapterAvailability> {
			if (await isExecutable("/usr/bin/pw-record")) {
				return { status: "ready", detail: "/usr/bin/pw-record" };
			}
			if (pwRecordPath.includes("/") && (await isExecutable(pwRecordPath))) {
				return { status: "ready", detail: pwRecordPath };
			}
			return { status: "unavailable", reason: "pw_record_missing" };
		},
		async start({ signal, onPcmChunk, vadArmDelayMs: armFromStart, onFirstPcm }): Promise<CaptureSession> {
			throwIfAborted(signal);
			const avail = await this.availability();
			if (avail.status === "unavailable") {
				throw new Error(`capture unavailable: ${avail.reason}`);
			}

			const bin = avail.detail?.startsWith("/") ? avail.detail : "/usr/bin/pw-record";
			const id = `pw-${randomUUID()}`;
			const pcmChunks: Buffer[] = [];
			let totalBytes = 0;
			let endReason: CaptureSegmentMeta["endReason"] = "unknown";
			let rmsSum = 0;
			let rmsCount = 0;
			let peakRms = 0;
			const startedAt = Date.now();
			const vadArmDelayMs = Math.max(0, armFromStart ?? options.vadArmDelayMs ?? 0);
			const firstPcmHook = onFirstPcm ?? options.onFirstPcm;
			let firstPcmAt: number | undefined;
			let speechSeenAt: number | undefined;
			const maxListenMs = (typeof options.vad === "object" && options.vad?.maxListenMs)
				|| 60_000;
			const maxBytes = sampleRateHz * channels * 2 * (maxListenMs / 1000 + 2);

			const child = spawn(
				bin,
				[`--rate=${sampleRateHz}`, `--channels=${channels}`, "--format=s16", "-"],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);

			let stderr = "";
			child.stderr?.on("data", (c: Buffer) => {
				stderr += c.toString("utf8");
			});

			let vad: VadEngine | undefined;
			if (options.vadEngine) {
				vad = options.vadEngine;
				options.onVadResolved?.({ backend: vad.backend });
			} else if (vadEnabled) {
				const energyOpts: EnergyVadOptions = {
					...(typeof options.vad === "object" ? options.vad : {}),
					sampleRateHz,
					maxListenMs,
				};
				const resolved = options.vadBackend === "energy"
					? resolveEnergyVadOnly(energyOpts)
					: await resolveVad({
						preference: options.vadBackend ?? "auto",
						energy: energyOpts,
						silero: {
							modelPath: options.sileroModelPath,
							sampleRateHz,
							maxListenMs,
							maxIntraPauseMs: energyOpts.maxIntraPauseMs,
						},
					});
				vad = resolved.engine;
				options.onVadResolved?.({
					backend: resolved.backend,
					...(resolved.fallbackReason ? { fallbackReason: resolved.fallbackReason } : {}),
				});
			}

			let settle!: (chunk: AudioChunk) => void;
			let fail!: (err: Error) => void;
			let settled = false;
			const done = new Promise<AudioChunk>((resolve, reject) => {
				settle = (chunk) => {
					if (settled) return;
					settled = true;
					resolve(chunk);
				};
				fail = (err) => {
					if (settled) return;
					settled = true;
					reject(err);
				};
			});
			// Esc / cancelVoiceAudio aborts the signal before stop() is awaited.
			// Without this, AbortError becomes an uncaughtException and kills Pi.
			ignoreUnhandledAbort(done);

			const buildChunk = (): AudioChunk => {
				const pcm = Buffer.concat(pcmChunks);
				const speechSeen = vad?.state.speechSeen ?? peakRms >= 0.012;
				const captureMeta: CaptureSegmentMeta = {
					captureId: id,
					speechSeen,
					endReason,
					durationMs: Math.max(0, Date.now() - startedAt),
					peakRms,
					meanRms: rmsCount > 0 ? rmsSum / rmsCount : 0,
					...(firstPcmAt !== undefined ? { firstPcmLatencyMs: firstPcmAt - startedAt } : {}),
					...(speechSeenAt !== undefined ? { speechSeenLatencyMs: speechSeenAt - startedAt } : {}),
				};
				return {
					bytes: pcmS16leToWav(new Uint8Array(pcm), sampleRateHz, channels),
					sampleRateHz,
					channels,
					format: "wav",
					captureMeta,
				};
			};

			const endCapture = (reason: "vad" | "stop" | "max") => {
				endReason = reason;
				if (!child.killed) child.kill("SIGINT");
				if (reason === "vad") options.onVadEnd?.();
			};

			child.stdout?.on("data", (c: Buffer) => {
				if (settled) return;
				if (totalBytes + c.byteLength > maxBytes) {
					endCapture("max");
					return;
				}
				pcmChunks.push(c);
				totalBytes += c.byteLength;
				const now = Date.now();
				if (firstPcmAt === undefined) {
					firstPcmAt = now;
					try {
						firstPcmHook?.({ captureId: id, atMs: now });
					} catch {
						/* diag only */
					}
				}
				const rms = chunkRmsS16le(c, channels);
				rmsSum += rms;
				rmsCount += 1;
				if (rms > peakRms) peakRms = rms;
				// Same process stream → visual meter (no second capture).
				try {
					onPcmChunk?.(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), {
						channels,
						sampleRateHz,
					});
				} catch {
					/* visual is best-effort */
				}
				// Echo hold: buffer PCM (pre-roll for immediate speech) but do not
				// let VAD end until armed — residual TTS must not close the turn.
				if (now - startedAt < vadArmDelayMs) return;
				const beforeSpeech = vad?.state.speechSeen ?? false;
				const ended = vad?.pushPcmS16le(c) ?? false;
				if (!beforeSpeech && vad?.state.speechSeen && speechSeenAt === undefined) {
					speechSeenAt = now;
				}
				if (ended) endCapture("vad");
			});

			child.once("error", (err) => {
				fail(err instanceof Error ? err : new Error(String(err)));
			});

			child.once("exit", () => {
				if (settled) return;
				const pcm = Buffer.concat(pcmChunks);
				if (pcm.byteLength < 64) {
					fail(
						new Error(
							`pipewire capture failed: empty stream${stderr.trim() ? ` (${stderr.trim().slice(0, 300)})` : ""}`,
						),
					);
					return;
				}
				if (endReason === "unknown") endReason = "stop";
				settle(buildChunk());
			});

			const detach = onAbort(signal, () => {
				if (!child.killed) child.kill("SIGTERM");
				fail(new AbortError());
			});

			return {
				id,
				async stop(_stopSignal) {
					// Do not throwIfAborted here: abort already rejects `done`.
					// Throwing first would orphan that rejection and crash the host.
					detach();
					if (!settled) endCapture("stop");
					return done;
				},
			};
		},
	};
}
