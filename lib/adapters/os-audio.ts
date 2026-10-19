/**
 * OS audio adapters via ffmpeg (portable fallback).
 * - Linux: prefer PipeWire (see pipewire-*). This module is for win32/darwin.
 * - Windows: ffmpeg -f wasapi
 * - macOS: ffmpeg -f avfoundation
 *
 * Requires ffmpeg on PATH (user-installed or winget/choco/brew — we do not bundle it).
 * Hardware smoke tests are required before claiming platform support.
 */

import { accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type {
	AdapterAvailability,
	AudioChunk,
	CaptureAdapter,
	CaptureSession,
	PlaybackAdapter,
	PlaybackHandle,
} from "../contracts.ts";
import { AbortError, onAbort, throwIfAborted } from "../process-cancel.ts";
import { detectVoicePlatform } from "../config.ts";

function which(cmd: string): string | undefined {
	const pathEnv = process.env.PATH ?? process.env.Path ?? "";
	const exts = process.platform === "win32" ? [".exe", ""] : [""];
	for (const dir of pathEnv.split(delimiter)) {
		for (const ext of exts) {
			const candidate = join(dir, `${cmd}${ext}`);
			try {
				accessSync(candidate, constants.F_OK);
				return candidate;
			} catch {
				/* continue */
			}
		}
	}
	return undefined;
}

export function findFfmpeg(): string | undefined {
	return which("ffmpeg");
}

function inputArgsForPlatform(): { format: string; input: string; notes: string } {
	const platform = detectVoicePlatform();
	if (platform === "win32") {
		return {
			format: "wasapi",
			input: "default",
			notes: "WASAPI default device via ffmpeg. Device picker TBD after smoke tests.",
		};
	}
	if (platform === "darwin") {
		return {
			format: "avfoundation",
			input: ":0",
			notes: "AVFoundation default mic via ffmpeg. TCC permission required.",
		};
	}
	return {
		format: "pulse",
		input: "default",
		notes: "Pulse/ALSA via ffmpeg (Linux fallback when PipeWire missing).",
	};
}

export function createOsFfmpegCaptureAdapter(options?: {
	ffmpegPath?: string;
	maxListenMs?: number;
}): CaptureAdapter {
	const ffmpeg = options?.ffmpegPath ?? findFfmpeg();
	const maxListenMs = options?.maxListenMs ?? 60_000;
	const { format, input, notes } = inputArgsForPlatform();
	return {
		id: `ffmpeg-${format}-capture`,
		async availability(): Promise<AdapterAvailability> {
			if (!ffmpeg) {
				return {
					status: "unavailable",
					reason: "ffmpeg_not_found",
					detail:
						"Install ffmpeg (PATH) for WASAPI/AVFoundation capture, or use Linux PipeWire. Gentle Voice does not bundle ffmpeg.",
				};
			}
			return {
				status: "degraded",
				reason: "ffmpeg_os_audio_unverified",
				detail: `${notes} Binary: ${ffmpeg}. Not marked supported until hardware smoke passes.`,
			};
		},
		async start({ signal, onFirstPcm }) {
			throwIfAborted(signal);
			if (!ffmpeg) throw new Error("ffmpeg unavailable");
			const id = `os-cap-${randomUUID()}`;
			const out = join(tmpdir(), `gentle-voice-${id}.wav`);
			onFirstPcm?.({ captureId: id, atMs: Date.now() });
			const args = [
				"-y",
				"-f",
				format,
				"-i",
				input,
				"-t",
				String(Math.max(1, Math.ceil(maxListenMs / 1000))),
				"-ac",
				"1",
				"-ar",
				"16000",
				out,
			];
			const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
			const detach = onAbort(signal, () => {
				try {
					child.kill("SIGINT");
				} catch {
					/* ignore */
				}
			});
			const session: CaptureSession = {
				id,
				async stop(stopSignal) {
					detach();
					throwIfAborted(stopSignal ?? signal);
					try {
						child.kill("SIGINT");
					} catch {
						/* ignore */
					}
					await new Promise<void>((resolve) => {
						child.once("close", () => resolve());
						setTimeout(resolve, 2000);
					});
					const { readFile, rm } = await import("node:fs/promises");
					let bytes = new Uint8Array(0);
					try {
						bytes = new Uint8Array(await readFile(out));
					} catch {
						/* empty */
					}
					await rm(out, { force: true }).catch(() => undefined);
					return {
						bytes,
						sampleRateHz: 16_000,
						channels: 1,
						format: "wav" as const,
						captureMeta: {
							captureId: id,
							speechSeen: bytes.byteLength > 1000,
							endReason: "stop" as const,
							durationMs: 0,
							peakRms: bytes.byteLength > 1000 ? 0.05 : 0,
							meanRms: bytes.byteLength > 1000 ? 0.02 : 0,
						},
					};
				},
			};
			return session;
		},
	};
}

export function createOsFfmpegPlaybackAdapter(options?: {
	ffmpegPath?: string;
}): PlaybackAdapter {
	const ffmpeg = options?.ffmpegPath ?? findFfmpeg();
	const platform = detectVoicePlatform();
	return {
		id: `ffmpeg-${platform}-playback`,
		async availability(): Promise<AdapterAvailability> {
			if (!ffmpeg) {
				return {
					status: "unavailable",
					reason: "ffmpeg_not_found",
					detail: "Install ffmpeg for portable playback on Windows/macOS.",
				};
			}
			return {
				status: "degraded",
				reason: "ffmpeg_os_playback_unverified",
				detail: `ffmpeg present (${ffmpeg}); hardware smoke required before claiming support.`,
			};
		},
		async play(audio: AudioChunk, { signal }) {
			throwIfAborted(signal);
			if (!ffmpeg) throw new Error("ffmpeg unavailable");
			const wav = join(tmpdir(), `gentle-voice-play-${randomUUID()}.wav`);
			const { writeFile, rm } = await import("node:fs/promises");
			await writeFile(wav, audio.bytes);
			const outFormat = platform === "darwin" ? "avfoundation" : platform === "win32" ? "wasapi" : "pulse";
			const args =
				platform === "darwin"
					? ["-nostdin", "-i", wav, "-f", "avfoundation", "default"]
					: platform === "win32"
						? ["-nostdin", "-i", wav, "-f", "wasapi", "default"]
						: ["-nostdin", "-i", wav, "-f", outFormat, "default"];
			const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
			const detach = onAbort(signal, () => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* ignore */
				}
			});
			const done = new Promise<void>((resolve, reject) => {
				child.once("close", (code) => {
					detach();
					void rm(wav, { force: true }).finally(() => {
						if (signal.aborted) reject(new AbortError());
						else if (code && code !== 0) reject(new Error(`ffmpeg play exit ${code}`));
						else resolve();
					});
				});
			});
			const handle: PlaybackHandle = {
				id: randomUUID(),
				done: done.catch((error) => {
					if (error instanceof AbortError || signal.aborted) return;
					throw error;
				}),
				async stop() {
					try {
						child.kill("SIGKILL");
					} catch {
						/* ignore */
					}
				},
			};
			return handle;
		},
	};
}
