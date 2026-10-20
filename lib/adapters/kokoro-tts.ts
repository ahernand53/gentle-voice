/**
 * Kokoro ONNX TTS adapter — lab-isolated Python synth (ef_dora).
 * Does not replace Piper. No network. No global installs at runtime.
 */

import { accessSync, constants as fsConstants } from "node:fs";
import { access, constants, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AdapterAvailability, AudioChunk, TtsAdapter, TtsResult } from "../contracts.ts";
import { throwIfAborted } from "../process-cancel.ts";
import { isGentleVoiceLabPathsAllowed } from "../runtime/lab-gate.ts";
import { resolveLabKokoroPaths } from "../runtime/lab-paths.ts";
import { runCaptured } from "./node-process.ts";
import { isWavBuffer } from "./wav.ts";

export interface KokoroMetrics {
	readonly synthesizeMs: number;
	readonly loadMs?: number;
	readonly outputBytes: number;
	readonly sampleRateHz: number;
	readonly durationSec: number;
	readonly textChars: number;
	readonly maxRssKb?: number;
	readonly timeToPlaybackStartMs?: number;
}

export interface KokoroTtsAdapterOptions {
	readonly pythonPath?: string;
	readonly scriptPath?: string;
	readonly modelPath?: string;
	readonly voicesPath?: string;
	readonly vocabPath?: string;
	readonly voice?: string;
	readonly lang?: string;
	readonly dryRun?: boolean;
	readonly timeoutMs?: number;
	readonly tmpDir?: string;
	readonly keepTemp?: boolean;
}

export interface KokoroTtsAdapter extends TtsAdapter {
	readonly lastMetrics: KokoroMetrics | undefined;
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

export function createKokoroTtsAdapter(options: KokoroTtsAdapterOptions = {}): KokoroTtsAdapter {
	const fromEnv = resolveLabKokoroPaths();
	const pythonPath = options.pythonPath ?? fromEnv?.pythonPath ?? "";
	const scriptPath = options.scriptPath ?? fromEnv?.scriptPath ?? "";
	const modelPath = options.modelPath ?? fromEnv?.modelPath ?? "";
	const voicesPath = options.voicesPath ?? fromEnv?.voicesPath ?? "";
	const vocabPath = options.vocabPath ?? fromEnv?.vocabPath ?? "";
	const voice = options.voice ?? "ef_dora";
	const lang = options.lang ?? "es";
	const dryRun = options.dryRun ?? false;
	const timeoutMs = options.timeoutMs ?? 120_000;
	const tmpDir = options.tmpDir ?? join(tmpdir(), "gentle-voice");
	const keepTemp = options.keepTemp ?? false;

	let lastMetrics: KokoroMetrics | undefined;

	return {
		id: "kokoro-ef-dora",
		get lastMetrics() {
			return lastMetrics;
		},
		async availability(): Promise<AdapterAvailability> {
			if (!pythonPath || !scriptPath || !modelPath || !voicesPath) {
				return {
					status: "unavailable",
					reason: "kokoro_not_configured",
					detail:
						"Kokoro requires explicit paths or lab env (GENTLE_VOICE_LAB=1 + GENTLE_VOICE_LAB_ROOT / GENTLE_VOICE_KOKORO_*).",
				};
			}
			if (!(await isExecutable(pythonPath))) {
				return { status: "unavailable", reason: "kokoro_python_missing", detail: pythonPath };
			}
			if (!(await isFile(scriptPath))) {
				return { status: "unavailable", reason: "kokoro_script_missing", detail: scriptPath };
			}
			if (!(await isFile(modelPath))) {
				return { status: "unavailable", reason: "kokoro_model_missing", detail: modelPath };
			}
			if (!(await isFile(voicesPath))) {
				return { status: "unavailable", reason: "kokoro_voices_missing", detail: voicesPath };
			}
			return {
				status: "ready",
				detail: dryRun ? "kokoro dry-run" : `kokoro ${voice} (${lang})`,
			};
		},
		async synthesize(text, { signal }): Promise<TtsResult> {
			throwIfAborted(signal);
			const trimmed = text.trim();
			if (!trimmed) {
				return {
					audio: {
						bytes: new Uint8Array(0),
						sampleRateHz: 24_000,
						channels: 1,
						format: "wav",
					},
				};
			}
			if (dryRun) {
				lastMetrics = {
					synthesizeMs: 0,
					outputBytes: 0,
					sampleRateHz: 24_000,
					durationSec: 0,
					textChars: trimmed.length,
				};
				return {
					audio: {
						bytes: new Uint8Array(0),
						sampleRateHz: 24_000,
						channels: 1,
						format: "wav",
					},
				};
			}

			if (!pythonPath || !scriptPath || !modelPath || !voicesPath) {
				throw new Error(
					"Kokoro is not configured (lab OFF and no explicit paths). Product TTS default is Piper.",
				);
			}

			await mkdir(tmpDir, { recursive: true });
			const outWav = join(tmpDir, `kokoro-${randomUUID()}.wav`);
			const metricsPath = join(tmpDir, `kokoro-${randomUUID()}.json`);
			const t0 = performance.now();
			try {
				const result = await runCaptured(
					pythonPath,
					[
						scriptPath,
						"--text", trimmed,
						"--out", outWav,
						"--voice", voice,
						"--lang", lang,
						"--model", modelPath,
						"--voices", voicesPath,
						"--vocab", vocabPath,
						"--metrics-json", metricsPath,
					],
					{ signal, timeoutMs },
				);
				if (result.code !== 0) {
					throw new Error(
						`kokoro-synth exited ${result.code}: ${result.stderr.toString("utf8").slice(0, 400)}`,
					);
				}
				const buf = await readFile(outWav);
				if (!isWavBuffer(buf)) {
					throw new Error("kokoro-synth did not produce a valid WAV");
				}
				const wallMs = Math.round(performance.now() - t0);
				let loadMs: number | undefined;
				let maxRssKb: number | undefined;
				let durationSec = 0;
				let sampleRateHz = 24_000;
				try {
					const m = JSON.parse(await readFile(metricsPath, "utf8")) as {
						loadMs?: number;
						synthesizeMs?: number;
						maxRssKb?: number;
						audioDurationSec?: number;
						sampleRateHz?: number;
					};
					loadMs = m.loadMs;
					maxRssKb = m.maxRssKb;
					durationSec = m.audioDurationSec ?? 0;
					sampleRateHz = m.sampleRateHz ?? 24_000;
				} catch {
					/* metrics optional */
				}
				lastMetrics = {
					synthesizeMs: wallMs,
					...(loadMs !== undefined ? { loadMs } : {}),
					outputBytes: buf.byteLength,
					sampleRateHz,
					durationSec,
					textChars: trimmed.length,
					...(maxRssKb !== undefined ? { maxRssKb } : {}),
					timeToPlaybackStartMs: wallMs,
				};
				const audio: AudioChunk = {
					bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
					sampleRateHz,
					channels: 1,
					format: "wav",
				};
				return { audio };
			} finally {
				if (!keepTemp) {
					await unlink(outWav).catch(() => {});
					await unlink(metricsPath).catch(() => {});
				}
			}
		},
	};
}

/**
 * True when lab Kokoro install looks complete.
 * Lab OFF → always false (no disk probes).
 * Lab ON → probes only env-configured paths.
 */
export function labKokoroPresent(env: NodeJS.ProcessEnv = process.env): boolean {
	if (!isGentleVoiceLabPathsAllowed(env)) return false;
	const paths = resolveLabKokoroPaths(env);
	if (!paths) return false;
	try {
		accessSync(paths.pythonPath, fsConstants.X_OK);
		accessSync(paths.scriptPath, fsConstants.R_OK);
		accessSync(paths.modelPath, fsConstants.R_OK);
		accessSync(paths.voicesPath, fsConstants.R_OK);
		return true;
	} catch {
		return false;
	}
}
