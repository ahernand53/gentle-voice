#!/usr/bin/env node
/**
 * A/B: classic final-only STT vs incremental provisional (single-flight).
 *
 * Does NOT measure ASR quality — wall-clock / CPU of the lab stack.
 *
 *   GENTLE_VOICE_WHISPER_CLI=... GENTLE_VOICE_WHISPER_MODEL=... \
 *     node --experimental-strip-types scripts/incremental-stt-ab.mjs
 */
import { performance } from "node:perf_hooks";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createWhisperSttAdapter } from "../lib/adapters/whisper-stt.ts";
import { createIncrementalSttController } from "../lib/stt/incremental-stt.ts";
const CLI = process.env.GENTLE_VOICE_WHISPER_CLI?.trim() ?? "";
const MODEL = process.env.GENTLE_VOICE_WHISPER_MODEL?.trim() ?? "";
const OUT = process.env.GENTLE_VOICE_INC_STT_REPORT?.trim()
	|| join(tmpdir(), "gentle-voice-incremental-stt-ab.json");
const TMP = process.env.GENTLE_VOICE_TMP?.trim()
	|| join(tmpdir(), "gentle-voice-inc-stt");

function sinePcm(seconds, hz = 440, sr = 16_000) {
	const n = Math.floor(seconds * sr);
	const buf = Buffer.alloc(n * 2);
	for (let i = 0; i < n; i++) {
		const s = Math.sin((2 * Math.PI * hz * i) / sr) * 0.25;
		buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(s * 32767))), i * 2);
	}
	return buf;
}

async function memRssKb() {
	try {
		const status = readFileSync("/proc/self/status", "utf8");
		const m = status.match(/VmRSS:\s+(\d+)/);
		return m ? Number(m[1]) : undefined;
	} catch {
		return undefined;
	}
}

async function main() {
	if (!CLI || !MODEL || !existsSync(CLI) || !existsSync(MODEL)) {
		console.error("Set GENTLE_VOICE_WHISPER_CLI and GENTLE_VOICE_WHISPER_MODEL — skip A/B");
		process.exit(2);
	}
	process.env.LD_LIBRARY_PATH = [
		dirname(CLI),
		process.env.LD_LIBRARY_PATH ?? "",
	].filter(Boolean).join(":");

	mkdirSync(TMP, { recursive: true });
	const stt = createWhisperSttAdapter({
		whisperCliPath: CLI,
		modelPath: MODEL,
		language: "es",
		threads: 4,
		tmpDir: TMP,
		partialThreads: 2,
		partialTimeoutMs: 60_000,
	});

	const utterSec = 4.5;
	const pcm = sinePcm(utterSec);
	const audio = {
		format: "pcm_s16le",
		sampleRateHz: 16_000,
		channels: 1,
		bytes: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
	};

	const rss0 = await memRssKb();

	// --- Classic: only final after "VAD end" ---
	const tClassic0 = performance.now();
	const finalClassic = await stt.transcribe(audio, {
		signal: AbortSignal.timeout(180_000),
		language: "es",
	});
	const classicFinalMs = Math.round(performance.now() - tClassic0);

	// --- Incremental: feed PCM in chunks, then final ---
	let firstPartialMs;
	const partialMs = [];
	const tInc0 = performance.now();
	const ctrl = createIncrementalSttController({
		stt,
		language: "es",
		minPcmBytes: 16_000 * 2 * 0.9,
		minNewBytes: 16_000 * 2 * 0.7,
		intervalMs: 1_200,
		now: () => performance.now(),
		onPartial: (ev) => {
			partialMs.push(ev.elapsedMs);
			if (firstPartialMs === undefined) {
				firstPartialMs = Math.round(performance.now() - tInc0);
			}
		},
	});

	const chunk = 16_000 * 2 * 0.25; // 250 ms
	for (let off = 0; off < pcm.byteLength; off += chunk) {
		ctrl.pushPcm(pcm.subarray(off, Math.min(off + chunk, pcm.byteLength)));
		await new Promise((r) => setTimeout(r, 250));
	}
	// Allow in-flight partial to finish or be cancelled
	await new Promise((r) => setTimeout(r, 500));
	await ctrl.cancelInFlight();
	const tFinal0 = performance.now();
	const finalInc = await stt.transcribe(audio, {
		signal: AbortSignal.timeout(180_000),
		language: "es",
	});
	const incFinalOnlyMs = Math.round(performance.now() - tFinal0);
	const incTotalMs = Math.round(performance.now() - tInc0);
	const metrics = ctrl.metrics;
	ctrl.dispose();

	const rss1 = await memRssKb();
	const report = {
		at: new Date().toISOString(),
		conditions: {
			utterSec,
			model: MODEL,
			cli: CLI,
			note: "Synthetic sine — engine wall time, NOT ASR quality / WER",
		},
		classic: {
			finalMs: classicFinalMs,
			textLen: finalClassic.text.length,
			firstTextMs: classicFinalMs, // first == final
		},
		incremental: {
			firstPartialMs: firstPartialMs ?? null,
			partialAttempts: metrics.attempts,
			partialAccepted: metrics.acceptedPartials,
			partialDecodeMs: partialMs,
			finalOnlyMs: incFinalOnlyMs,
			totalWallMs: incTotalMs,
			textLen: finalInc.text.length,
		},
		resources: {
			rssKbBefore: rss0,
			rssKbAfter: rss1,
		},
		interpretation: {
			firstTextImproved: firstPartialMs != null && firstPartialMs < classicFinalMs,
			finalLatencyDeltaMs: incFinalOnlyMs - classicFinalMs,
			warning:
				"Final STT cost stays ~same; provisional helps long utterances only. "
				+ "Single-flight prevents concurrent whisper-cli.",
		},
	};

	mkdirSync(join(OUT, ".."), { recursive: true });
	writeFileSync(OUT, JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
	console.log(`wrote ${OUT}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
