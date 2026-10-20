/**
 * Whisper.cpp STT adapter — lab-local binary + Voxtype ggml by path (never copy/move).
 * Phase 2A: execute mode writes a temp WAV, runs whisper-cli, deletes temp by default.
 */

import { access, constants, mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AdapterAvailability, AudioChunk, SttAdapter, SttResult } from "../contracts.ts";
import { throwIfAborted } from "../process-cancel.ts";
import { runCaptured } from "./node-process.ts";
import { isWavBuffer, pcmS16leToWav } from "./wav.ts";

export interface WhisperSttPlan {
	readonly command: string;
	readonly args: readonly string[];
	readonly modelPath: string;
	readonly dryRun: boolean;
}

export interface WhisperMetrics {
	readonly loadAndTranscribeMs: number;
	readonly inputBytes: number;
	readonly tempWavBytes?: number;
}

export interface WhisperSttAdapterOptions {
	readonly whisperCliPath: string;
	readonly modelPath: string;
	readonly dryRun?: boolean;
	readonly timeoutMs?: number;
	readonly language?: string;
	readonly tmpDir?: string;
	readonly keepTemp?: boolean;
	readonly threads?: number;
	/** Whisper.cpp `--prompt` (initial context; does not rewrite transcript alone). */
	readonly initialPrompt?: string;
}

export interface WhisperSttAdapter extends SttAdapter {
	readonly lastPlan: WhisperSttPlan | undefined;
	readonly lastMetrics: WhisperMetrics | undefined;
	buildPlan(wavPath: string, language?: string): WhisperSttPlan;
	validateModelMagic(): Promise<{ ok: boolean; magic?: string; bytes?: number; problem?: string }>;
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

export async function readGgmlMagic(path: string): Promise<{ magic: string; bytes: number } | undefined> {
	try {
		const handle = await open(path, "r");
		try {
			const buf = Buffer.alloc(4);
			const { bytesRead } = await handle.read(buf, 0, 4, 0);
			if (bytesRead < 4) return undefined;
			const size = (await handle.stat()).size;
			return { magic: buf.toString("ascii"), bytes: size };
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

/** Bracket-only tokens Whisper often emits on silence / noise (not speech). */
const WHISPER_NONSPEECH_TOKEN = /^\[[^\]]+\]$/;

function stripNonspeechTokens(text: string): string {
	return text
		.split(/\s+/)
		.filter((tok) => tok.length > 0 && !WHISPER_NONSPEECH_TOKEN.test(tok))
		.join(" ")
		.trim();
}

export function parseWhisperStdout(stdout: string): string {
	const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	const filtered = lines.filter((l) => {
		if (l.startsWith("whisper_")) return false;
		if (l.startsWith("system_info")) return false;
		if (l.startsWith("main:")) return false;
		if (l.startsWith("ggml_")) return false;
		if (l.includes("reading audio data")) return false;
		if (l.includes("trying to decode")) return false;
		if (l === "[BLANK_AUDIO]") return false;
		return true;
	});
	return stripNonspeechTokens(filtered.join(" ").replace(/\s+/g, " ").trim());
}

export function createWhisperSttAdapter(options: WhisperSttAdapterOptions): WhisperSttAdapter {
	const dryRun = options.dryRun === true;
	const tmpDir = options.tmpDir ?? join(tmpdir(), "gentle-voice");
	let lastPlan: WhisperSttPlan | undefined;
	let lastMetrics: WhisperMetrics | undefined;

	const buildPlan = (wavPath: string, language?: string): WhisperSttPlan => {
		const lang = language ?? options.language ?? "es";
		const args = [
			"-m", options.modelPath,
			"-f", wavPath,
			"-nt",
			"-np",
		];
		if (options.threads && options.threads > 0) {
			args.push("-t", String(options.threads));
		}
		if (lang && lang !== "auto") {
			args.push("-l", lang);
		}
		const prompt = options.initialPrompt?.trim();
		if (prompt) {
			args.push("--prompt", prompt);
		}
		return {
			command: options.whisperCliPath,
			args,
			modelPath: options.modelPath,
			dryRun,
		};
	};

	const adapter: WhisperSttAdapter = {
		id: "whisper-cpp-stt",
		get lastPlan() {
			return lastPlan;
		},
		get lastMetrics() {
			return lastMetrics;
		},
		buildPlan,
		async validateModelMagic() {
			if (!(await isFile(options.modelPath))) {
				return { ok: false, problem: "model_missing" };
			}
			const meta = await readGgmlMagic(options.modelPath);
			if (!meta) return { ok: false, problem: "unreadable" };
			const ok = meta.magic === "ggml" || meta.magic === "lmgg";
			return {
				ok,
				magic: meta.magic,
				bytes: meta.bytes,
				...(ok ? {} : { problem: `unexpected_magic:${meta.magic}` }),
			};
		},
		async availability(): Promise<AdapterAvailability> {
			const model = await adapter.validateModelMagic();
			if (!model.ok) {
				return { status: "unavailable", reason: model.problem ?? "model_invalid" };
			}
			if (!(await isExecutable(options.whisperCliPath))) {
				return {
					status: "unavailable",
					reason: "whisper_cli_missing",
					detail: `model_ok:${basename(options.modelPath)}`,
				};
			}
			return {
				status: "ready",
				detail: dryRun ? "whisper_ready_dry_run" : "whisper_ready_execute",
			};
		},
		async transcribe(audio: AudioChunk, { signal, language }): Promise<SttResult> {
			throwIfAborted(signal);
			const avail = await adapter.availability();
			if (avail.status === "unavailable") {
				throw new Error(`whisper unavailable: ${avail.reason}`);
			}

			if (dryRun) {
				const plan = buildPlan("<dry-run.wav>", language);
				lastPlan = plan;
				throwIfAborted(signal);
				return { text: "", language: language ?? options.language ?? "es", confidence: 0 };
			}

			if (audio.bytes.byteLength === 0) {
				throw new Error("empty_audio");
			}

			let wavBytes: Uint8Array;
			if (audio.format === "wav" && isWavBuffer(audio.bytes)) {
				wavBytes = audio.bytes;
			} else if (audio.format === "pcm_s16le" || audio.format === "raw") {
				wavBytes = pcmS16leToWav(audio.bytes, audio.sampleRateHz, audio.channels);
			} else if (audio.format === "wav") {
				throw new Error("invalid_wav");
			} else {
				throw new Error(`unsupported_audio_format:${audio.format}`);
			}

			await mkdir(tmpDir, { recursive: true });
			const wavPath = join(tmpDir, `stt-${randomUUID()}.wav`);
			await writeFile(wavPath, wavBytes);
			const plan = buildPlan(wavPath, language);
			lastPlan = plan;

			const started = performance.now();
			try {
				const result = await runCaptured(plan.command, plan.args, {
					signal,
					timeoutMs: options.timeoutMs ?? 180_000,
					env: {
						...process.env,
						// $ORIGIN already on binary; keep PATH clean
					},
				});
				throwIfAborted(signal);
				const elapsed = Math.round(performance.now() - started);
				lastMetrics = {
					loadAndTranscribeMs: elapsed,
					inputBytes: audio.bytes.byteLength,
					tempWavBytes: wavBytes.byteLength,
				};
				if (result.code !== 0) {
					throw new Error(
						`whisper-cli exited ${result.code}: ${result.stderr.toString("utf8").slice(0, 400)}`,
					);
				}
				const text = parseWhisperStdout(result.stdout.toString("utf8"));
				return {
					text,
					language: language ?? options.language ?? "es",
					confidence: text ? 1 : 0,
				};
			} finally {
				if (!options.keepTemp) {
					await unlink(wavPath).catch(() => {});
				}
			}
		},
	};

	return adapter;
}

/**
 * Lab whisper/voxtype paths — resolved from env only.
 * @see resolveLabWhisperPaths in runtime/lab-paths.ts
 */
export {
	resolveLabWhisperPaths,
	labRoot as resolveLabWhisperInstallRoot,
} from "../runtime/lab-paths.ts";
