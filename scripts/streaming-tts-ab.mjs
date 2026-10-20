#!/usr/bin/env node
/**
 * A/B: serial synth+play vs prefetch pipeline (depth=1).
 * Stub timings by default (deterministic). Optional real Piper if env set.
 *
 *   node --experimental-strip-types scripts/streaming-tts-ab.mjs
 *
 * Report → gs-lab/logs/streaming-tts-ab-report.json (or GENTLE_VOICE_STREAM_TTS_REPORT)
 */
import { performance } from "node:perf_hooks";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamSpeakQueue } from "../lib/tts/stream-speak-queue.ts";
import { SentenceAssembler } from "../lib/tts/sentence-assembler.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.GENTLE_VOICE_STREAM_TTS_REPORT
	|| join(ROOT, "gs-lab/logs/streaming-tts-ab-report.json");

const PHRASES = [
	"Primera frase corta del agente. Segunda también corta. Tercera cierra el bloque.",
	"Discord es una app de chat. Sirve para comunidades. También tiene canales de voz.",
	"La consulta PostgreSQL terminó bien. Revisá el índice. Después corré el plan.",
];

const SILENT = {
	bytes: new Uint8Array(64),
	sampleRateHz: 16_000,
	channels: 1,
	format: "pcm_s16le",
};

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

/** Approximate Piper cost from char length (lab default). */
function synthMsFor(text) {
	return 40 + Math.min(180, text.length * 2.2);
}

function playMsFor(text) {
	return 80 + Math.min(400, text.length * 4);
}

function assemble(text) {
	const a = new SentenceAssembler({
		language: "es",
		minSentencesPerUnit: 2,
		minCharsPerUnit: 140,
		earlyFirstUnit: true,
	});
	const units = [...a.pushDelta(text), ...a.flush()];
	return units;
}

async function runSerial(units) {
	const q = new StreamSpeakQueue(() => performance.now());
	q.begin();
	q.enqueue(units);
	const t0 = performance.now();
	let firstPlay;
	await q.kick(async (unit) => {
		await sleep(synthMsFor(unit.speakable));
		if (firstPlay === undefined) firstPlay = performance.now() - t0;
		await sleep(playMsFor(unit.speakable));
	}, new AbortController().signal);
	await q.idle();
	return {
		mode: "serial",
		ttfaMs: firstPlay ?? 0,
		totalMs: performance.now() - t0,
		units: units.length,
		gapsMs: [],
		prefetchHits: 0,
	};
}

async function runPrefetch(units) {
	const q = new StreamSpeakQueue(() => performance.now());
	q.begin();
	q.enqueue(units);
	const t0 = performance.now();
	let firstPlay;
	await q.kickPipeline(
		{
			prefetchDepth: 1,
			async synthesize(unit) {
				await sleep(synthMsFor(unit.speakable));
				return SILENT;
			},
			async play(unit) {
				if (firstPlay === undefined) firstPlay = performance.now() - t0;
				await sleep(playMsFor(unit.speakable));
			},
		},
		new AbortController().signal,
	);
	await q.idle();
	const m = q.metrics;
	return {
		mode: "prefetch",
		ttfaMs: firstPlay ?? 0,
		totalMs: performance.now() - t0,
		units: units.length,
		gapsMs: [...m.interPlayGapsMs],
		prefetchHits: m.prefetchHits,
		prefetchStarts: m.prefetchStarts,
	};
}

/** Live delta TTFA: first audio when first unit emits (early-first vs Strategy B). */
async function liveTtfa(text, earlyFirst) {
	const a = new SentenceAssembler({
		language: "es",
		minSentencesPerUnit: 2,
		minCharsPerUnit: 140,
		earlyFirstUnit: earlyFirst,
	});
	const chunks = text.match(/.{1,18}/g) ?? [text];
	const t0 = performance.now();
	let firstUnitAt;
	for (const c of chunks) {
		await sleep(8); // simulate token arrival
		const units = a.pushDelta(c);
		if (units.length && firstUnitAt === undefined) {
			firstUnitAt = performance.now() - t0;
			// + first synth (TTFA includes Piper of first unit)
			firstUnitAt += synthMsFor(units[0].speakable);
			break;
		}
	}
	if (firstUnitAt === undefined) {
		const rest = a.flush();
		firstUnitAt = performance.now() - t0 + (rest[0] ? synthMsFor(rest[0].speakable) : 0);
	}
	return firstUnitAt;
}

async function main() {
	const trials = [];
	for (let i = 0; i < PHRASES.length; i++) {
		const units = assemble(PHRASES[i]);
		const serial = await runSerial(units);
		const prefetch = await runPrefetch(units);
		const gapCutPct = serial.totalMs > 0
			? Math.round((1 - prefetch.totalMs / serial.totalMs) * 1000) / 10
			: 0;
		const ttfaStrategyB = await liveTtfa(PHRASES[i], false);
		const ttfaEarlyFirst = await liveTtfa(PHRASES[i], true);
		trials.push({
			phraseIndex: i,
			phrase: PHRASES[i],
			unitCount: units.length,
			unitSpeakables: units.map((u) => u.speakable),
			serial,
			prefetch,
			totalCutPct: gapCutPct,
			ttfaDeltaMs: Math.round((serial.ttfaMs - prefetch.ttfaMs) * 10) / 10,
			liveTtfaStrategyBMs: Math.round(ttfaStrategyB),
			liveTtfaEarlyFirstMs: Math.round(ttfaEarlyFirst),
			liveTtfaCutPct: ttfaStrategyB > 0
				? Math.round((1 - ttfaEarlyFirst / ttfaStrategyB) * 1000) / 10
				: 0,
		});
	}

	const avgCut = trials.reduce((s, t) => s + t.totalCutPct, 0) / trials.length;
	const avgTtfaCut = trials.reduce((s, t) => s + t.liveTtfaCutPct, 0) / trials.length;
	const report = {
		startedAt: new Date().toISOString(),
		engine: "stub-timing",
		voice: "es_AR-daniela-high (unchanged; not invoked in stub A/B)",
		note: "Stub models Piper cost; human GS-Lab validates real PipeWire gaps.",
		avgTotalCutPct: Math.round(avgCut * 10) / 10,
		avgLiveTtfaCutPct: Math.round(avgTtfaCut * 10) / 10,
		trials,
	};

	mkdirSync(dirname(OUT), { recursive: true });
	writeFileSync(OUT, JSON.stringify(report, null, 2));
	console.log(JSON.stringify({
		avgTotalCutPct: report.avgTotalCutPct,
		avgLiveTtfaCutPct: report.avgLiveTtfaCutPct,
		trials: trials.map((t) => ({
			i: t.phraseIndex,
			units: t.unitCount,
			serialMs: Math.round(t.serial.totalMs),
			prefetchMs: Math.round(t.prefetch.totalMs),
			cutPct: t.totalCutPct,
			serialTtfa: Math.round(t.serial.ttfaMs),
			prefetchTtfa: Math.round(t.prefetch.ttfaMs),
			liveTtfaB: t.liveTtfaStrategyBMs,
			liveTtfaEarly: t.liveTtfaEarlyFirstMs,
			liveTtfaCutPct: t.liveTtfaCutPct,
			avgGapMs: t.prefetch.gapsMs.length
				? Math.round(t.prefetch.gapsMs.reduce((a, b) => a + b, 0) / t.prefetch.gapsMs.length)
				: 0,
		})),
		report: OUT,
	}, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
