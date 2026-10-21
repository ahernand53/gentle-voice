/**
 * Phase 3.6 — Streaming TTS: prefetch queue, early-first assembler,
 * ordered play, cancel, Speech Renderer isolation.
 * No LLM / no Piper binary required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AudioChunk } from "../lib/contracts.ts";
import { createStubPlaybackAdapter, createStubTtsAdapter } from "../lib/adapters/stubs.ts";
import { SentenceAssembler } from "../lib/tts/sentence-assembler.ts";
import { renderForSpeech } from "../lib/tts/speech-renderer.ts";
import { StreamSpeakQueue } from "../lib/tts/stream-speak-queue.ts";
import { VoiceSession } from "../lib/voice-session.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import {
	createStubCaptureAdapter,
	createStubSttAdapter,
} from "../lib/adapters/stubs.ts";

const SILENT: AudioChunk = Object.freeze({
	bytes: new Uint8Array(32),
	sampleRateHz: 16_000,
	channels: 1,
	format: "pcm_s16le" as const,
});

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

test("3.6 assembler earlyFirstUnit: first sentence alone, then Strategy B", () => {
	const a = new SentenceAssembler({
		language: "es",
		minSentencesPerUnit: 2,
		minCharsPerUnit: 140,
		earlyFirstUnit: true,
	});
	const u1 = a.pushDelta("Primera lista. ");
	assert.equal(u1.length, 1, "first complete sentence must flush alone");
	assert.match(u1[0]!.speakable, /Primera/);
	assert.deepEqual(a.pushDelta("Segunda corta. "), []);
	const u2 = a.pushDelta("Tercera también corta.");
	assert.equal(u2.length, 1);
	assert.match(u2[0]!.speakable, /Segunda/);
	assert.match(u2[0]!.speakable, /Tercera/);
});

test("3.6 assembler: incomplete markdown waits for sentence end", () => {
	const a = new SentenceAssembler({
		language: "es",
		minSentencesPerUnit: 1,
		minCharsPerUnit: 1,
		earlyFirstUnit: true,
	});
	assert.deepEqual(a.pushDelta("Mirá **códi"), []);
	const u = a.pushDelta("go** en /tmp/x.ts listo.");
	assert.equal(u.length, 1);
	assert.ok(!u[0]!.speakable.includes("*"));
	assert.ok(!u[0]!.speakable.includes("/tmp"));
});

test("3.6 Speech Renderer: written text untouched; spoken softens path", () => {
	const written = "Abrí `/home/proj/foo.ts` y corré npm test.";
	const { spoken, written: w } = renderForSpeech(written, {
		mode: "natural",
		cwd: "/other",
	});
	assert.equal(w, written);
	assert.ok(!spoken.includes("/home/proj"));
	assert.match(spoken, /comando npm test|npm test/i);
});

test("3.6 prefetch: synth overlaps play — order preserved, no dupes", async () => {
	const q = new StreamSpeakQueue(() => Date.now());
	q.begin();
	const synthOrder: string[] = [];
	const playOrder: string[] = [];
	let concurrentSynthWhilePlay = 0;
	let playing = false;

	q.enqueue([
		{ id: "1", raw: "A.", speakable: "A." },
		{ id: "2", raw: "B.", speakable: "B." },
		{ id: "3", raw: "C.", speakable: "C." },
	]);

	const ac = new AbortController();
	await q.kickPipeline(
		{
			prefetchDepth: 1,
			async synthesize(unit) {
				synthOrder.push(unit.speakable);
				await sleep(25);
				// Overlap check after delay: play of prior unit should already be running.
				if (playing) concurrentSynthWhilePlay += 1;
				return { ...SILENT, bytes: new Uint8Array([unit.speakable.charCodeAt(0)]) };
			},
			async play(unit, _audio) {
				playOrder.push(unit.speakable);
				playing = true;
				await sleep(40);
				playing = false;
			},
		},
		ac.signal,
	);
	await q.idle();

	assert.deepEqual(playOrder, ["A.", "B.", "C."]);
	assert.deepEqual(synthOrder, ["A.", "B.", "C."]);
	assert.ok(concurrentSynthWhilePlay >= 1, "must prefetch while previous plays");
	assert.equal(q.metrics.unitsPlayed, 3);
	assert.equal(q.metrics.unitsDropped, 0);
	assert.ok(q.metrics.prefetchStarts >= 3);
});

test("3.6 prefetch cancel mid-stream drops pending + ready", async () => {
	const q = new StreamSpeakQueue(() => Date.now());
	q.begin();
	const played: string[] = [];
	q.enqueue([
		{ id: "1", raw: "A.", speakable: "A." },
		{ id: "2", raw: "B.", speakable: "B." },
		{ id: "3", raw: "C.", speakable: "C." },
		{ id: "4", raw: "D.", speakable: "D." },
	]);
	const ac = new AbortController();
	const p = q.kickPipeline(
		{
			prefetchDepth: 1,
			async synthesize(unit, signal) {
				await sleep(15);
				if (signal.aborted) throw new Error("aborted");
				return SILENT;
			},
			async play(unit) {
				played.push(unit.speakable);
				if (unit.speakable === "A.") {
					q.cancel();
					ac.abort();
				}
				await sleep(10);
			},
		},
		ac.signal,
	);
	await p;
	await q.idle();
	assert.equal(played[0], "A.");
	assert.ok(!played.includes("C."));
	assert.ok(!played.includes("D."));
	assert.ok(q.metrics.unitsDropped >= 1);
});

test("3.6 sequential kick still works (legacy / tests)", async () => {
	const q = new StreamSpeakQueue(() => Date.now());
	q.begin();
	const played: string[] = [];
	q.enqueue([
		{ id: "1", raw: "X.", speakable: "X." },
		{ id: "2", raw: "Y.", speakable: "Y." },
	]);
	await q.kick(async (unit) => {
		played.push(unit.speakable);
	}, new AbortController().signal);
	await q.idle();
	assert.deepEqual(played, ["X.", "Y."]);
});

test("3.6 session: Esc cancels pending stream synth+play", async () => {
	const synthTexts: string[] = [];
	const playStarts: string[] = [];
	let playCount = 0;
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: {
				...DEFAULT_VOICE_CONFIG.behavior,
				mode: "conversation",
				fluentConversation: true,
				echoSettleMs: 0,
				muted: false,
			},
		},
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter(),
		tts: {
			...createStubTtsAdapter({ latencyMs: 40 }),
			async synthesize(text, opts) {
				synthTexts.push(text);
				return createStubTtsAdapter({ latencyMs: 40 }).synthesize(text, opts);
			},
		},
		playback: {
			...createStubPlaybackAdapter({ durationMs: 80 }),
			async play(audio, opts) {
				playCount += 1;
				playStarts.push(`p${playCount}`);
				return createStubPlaybackAdapter({ durationMs: 80 }).play(audio, opts);
			},
		},
	});
	session.dispatch({ type: "ENABLE" });
	session.beginStreamSpeak();
	session.onMessageUpdate({
		assistantMessageEvent: {
			type: "text_delta",
			delta: "Oración uno completa para TTS. ",
		},
	});
	session.onMessageUpdate({
		assistantMessageEvent: {
			type: "text_delta",
			delta: "Oración dos también lista. ",
		},
	});
	session.onMessageUpdate({
		assistantMessageEvent: {
			type: "text_delta",
			delta: "Oración tres no debería sonar tras Esc.",
		},
	});
	await sleep(30);
	// Real Esc path: cancelVoiceAudio (not only STOP while awaiting_agent).
	session.cancelVoiceAudio("escape");
	session.dispatch({ type: "STOP" });
	await session.flush();
	await sleep(120);
	assert.equal(session.streamActive, false);
	assert.ok(session.streamMetrics.unitsDropped >= 1, "pending units must be dropped on Esc");
	assert.ok(playCount <= 2, "Esc must not play the full queue");
});

test("3.6 inter-play gaps shrink with prefetch vs serial", async () => {
	const units = [
		{ id: "1", raw: "A.", speakable: "A." },
		{ id: "2", raw: "B.", speakable: "B." },
		{ id: "3", raw: "C.", speakable: "C." },
	];
	const synthMs = 30;
	const playMs = 50;

	const serial = new StreamSpeakQueue(() => Date.now());
	serial.begin();
	serial.enqueue(units);
	const t0 = Date.now();
	await serial.kick(async () => {
		await sleep(synthMs);
		await sleep(playMs);
	}, new AbortController().signal);
	await serial.idle();
	const serialTotal = Date.now() - t0;

	const prefetch = new StreamSpeakQueue(() => Date.now());
	prefetch.begin();
	prefetch.enqueue(units);
	const t1 = Date.now();
	await prefetch.kickPipeline(
		{
			prefetchDepth: 1,
			async synthesize() {
				await sleep(synthMs);
				return SILENT;
			},
			async play() {
				await sleep(playMs);
			},
		},
		new AbortController().signal,
	);
	await prefetch.idle();
	const prefetchTotal = Date.now() - t1;

	assert.ok(
		prefetchTotal < serialTotal - 20,
		`prefetch (${prefetchTotal}ms) should beat serial (${serialTotal}ms)`,
	);
	const gaps = prefetch.metrics.interPlayGapsMs;
	assert.ok(gaps.length >= 1);
	const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
	assert.ok(avgGap < synthMs, `avg gap ${avgGap} should be < synth ${synthMs}`);
});
