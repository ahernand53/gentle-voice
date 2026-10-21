/**
 * Linux PipeWire playback via `pw-play` (WAV preferred).
 * Single-flight: a new play() stops any prior handle.
 * Does not change the default audio device or system PipeWire config.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, constants, mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AdapterAvailability,
	AudioChunk,
	PlaybackAdapter,
	PlaybackHandle,
} from "../contracts.ts";
import { AbortError, onAbort, throwIfAborted } from "../process-cancel.ts";
import { isWavBuffer, pcmS16leToWav } from "./wav.ts";

export interface PipewirePlaybackOptions {
	readonly pwPlayPath?: string;
	readonly tmpDir?: string;
	readonly keepTemp?: boolean;
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function resolvePwPlay(preferred: string): Promise<string | undefined> {
	const candidates = [preferred, "/usr/bin/pw-play", "/usr/bin/pw-cat"];
	for (const c of candidates) {
		if (await isExecutable(c)) return c;
	}
	return undefined;
}

function toWavBytes(audio: AudioChunk): Uint8Array {
	if (audio.format === "wav" && isWavBuffer(audio.bytes)) {
		return audio.bytes;
	}
	if (audio.bytes.byteLength === 0) {
		throw new Error("empty_audio");
	}
	// raw / pcm_s16le → WAV
	return pcmS16leToWav(audio.bytes, audio.sampleRateHz, audio.channels);
}

export interface RawPcmStream {
	write(pcm: Uint8Array): void;
	/** Close stdin so pw-play drains and exits. */
	finish(): void;
	readonly done: Promise<void>;
	stop(): Promise<void>;
}

/**
 * Progressive playback. WAV `play()` stays the default path.
 * `pw-play --raw --format f32` is the installed PipeWire reader for float32 mono.
 */
export function openPipewirePcmStream(options: {
	signal: AbortSignal;
	sampleRateHz: number;
	channels: number;
	format: "f32" | "s16";
	pwPlayPath?: string;
}): RawPcmStream {
	const bin = options.pwPlayPath ?? "pw-play";
	const args = [
		"--raw",
		`--rate=${options.sampleRateHz}`,
		`--channels=${options.channels}`,
		`--format=${options.format}`,
		"--latency=80ms",
		"-",
	];
	const child = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"] });
	let stderr = "";
	child.stderr?.on("data", (c: Buffer) => {
		stderr += c.toString("utf8");
	});
	let settled = false;
	let finished = false;
	let cancelled = false;
	let playbackError: Error | undefined;

	const stop = async () => {
		cancelled = true;
		if (settled) return;
		finished = true;
		try {
			child.stdin?.end();
		} catch {
			/* already closed */
		}
		if (!child.killed) child.kill("SIGINT");
		await new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
			setTimeout(() => {
				if (!child.killed) child.kill("SIGTERM");
				resolve();
			}, 1_500);
		});
		settled = true;
	};

	const detach = onAbort(options.signal, () => {
		void stop();
	});

	const done = new Promise<void>((resolve, reject) => {
		child.once("exit", (code, sig) => {
			detach();
			settled = true;
			if (options.signal.aborted || cancelled) {
				resolve();
				return;
			}
			if (code !== 0 || sig) {
				playbackError = new Error(`pw-play raw exited ${code}${sig ? ` (${sig})` : ""}: ${stderr.trim().slice(-300)}`);
				reject(playbackError);
				return;
			}
			resolve();
		});
		child.once("error", (err) => {
			detach();
			settled = true;
			playbackError = err;
			reject(err);
		});
	});
	// Playback may fail while the model is still loading. Keep the rejection
	// handled until the owner awaits done, without hiding it from that owner.
	void done.catch(() => {});
	child.stdin?.on("error", (err) => { playbackError = err; });

	return {
		write(pcm: Uint8Array) {
			if (playbackError) throw playbackError;
			if (settled || options.signal.aborted || pcm.byteLength === 0) return;
			child.stdin?.write(pcm);
		},
		finish() {
			if (settled || finished) return;
			finished = true;
			try {
				child.stdin?.end();
			} catch {
				/* already closed */
			}
		},
		done,
		stop,
	};
}

export function createPipewirePlaybackAdapter(
	options: PipewirePlaybackOptions = {},
): PlaybackAdapter {
	const preferred = options.pwPlayPath ?? "pw-play";
	const tmpDir = options.tmpDir ?? join(tmpdir(), "gentle-voice");
	const keepTemp = options.keepTemp === true;

	let activeStop: (() => Promise<void>) | undefined;

	return {
		id: "linux-pipewire-playback",
		async availability(): Promise<AdapterAvailability> {
			const bin = await resolvePwPlay(preferred);
			if (!bin) {
				return { status: "unavailable", reason: "pw_play_missing" };
			}
			return { status: "ready", detail: bin };
		},
		async play(audio, { signal }): Promise<PlaybackHandle> {
			throwIfAborted(signal);
			if (activeStop) {
				await activeStop().catch(() => {});
				activeStop = undefined;
			}

			const avail = await this.availability();
			if (avail.status === "unavailable") {
				throw new Error(`playback unavailable: ${avail.reason}`);
			}
			const bin = (avail.detail && avail.detail.startsWith("/"))
				? avail.detail
				: (await resolvePwPlay(preferred))!;

			const wav = toWavBytes(audio);
			await mkdir(tmpDir, { recursive: true });
			const wavPath = join(tmpDir, `play-${randomUUID()}.wav`);
			await writeFile(wavPath, wav);

			const id = `pw-play-${randomUUID()}`;
			const args = bin.endsWith("pw-cat")
				? ["--playback", `--rate=${audio.sampleRateHz}`, `--channels=${audio.channels}`, "--format=s16", wavPath]
				: [wavPath];

			const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
			let stderr = "";
			child.stderr?.on("data", (c: Buffer) => {
				stderr += c.toString("utf8");
			});

			let settled = false;
			const cleanup = async () => {
				if (!keepTemp) await unlink(wavPath).catch(() => {});
			};

			const stop = async () => {
				if (settled) return;
				if (!child.killed) child.kill("SIGINT");
				await new Promise<void>((resolve) => {
					child.once("exit", () => resolve());
					setTimeout(() => {
						if (!child.killed) child.kill("SIGTERM");
						resolve();
					}, 1_500);
				});
				settled = true;
				if (activeStop === stop) activeStop = undefined;
				await cleanup();
			};
			activeStop = stop;

			const detach = onAbort(signal, () => {
				void stop();
			});

			const done = new Promise<void>((resolve, reject) => {
				child.once("exit", (code, sig) => {
					detach();
					settled = true;
					if (activeStop === stop) activeStop = undefined;
					void cleanup().finally(() => {
						if (signal.aborted) {
							resolve();
							return;
						}
						if (code !== 0 && code !== null && !sig) {
							reject(
								new Error(
									`pw-play exited ${code}: ${stderr.trim().slice(0, 300)}`,
								),
							);
							return;
						}
						resolve();
					});
				});
				child.once("error", (err) => {
					detach();
					settled = true;
					if (activeStop === stop) activeStop = undefined;
					void cleanup().finally(() => {
						reject(err instanceof AbortError ? err : err);
					});
				});
			});

			const handle: PlaybackHandle = {
				id,
				done: done.catch((error) => {
					if (error instanceof AbortError || signal.aborted) return;
					throw error;
				}),
				stop,
			};
			return handle;
		},
	};
}
