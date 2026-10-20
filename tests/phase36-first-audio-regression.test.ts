/**
 * P0 regression: Streaming TTS must never start mid-reply
 * (e.g. skip to "Por ejemplo…" after omitting the PostgreSQL lead).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import {
	createStubCaptureAdapter,
	createStubPlaybackAdapter,
	createStubSttAdapter,
	createStubTtsAdapter,
} from "../lib/adapters/stubs.ts";
import { buildFinalUtterance, selectSpokenSentences } from "../lib/final-utterance.ts";
import { createPiHostHarness } from "../lib/lab/pi-host-harness.ts";
import { createVoiceExtension } from "../extensions/voice.ts";
import { StreamSpeakQueue } from "../lib/tts/stream-speak-queue.ts";
import { VoiceSession } from "../lib/voice-session.ts";
import { deniedShortcutProbe } from "../lib/shortcut.ts";
import type { AudioChunk } from "../lib/contracts.ts";

const PG_REPLY = [
	"PostgreSQL es un sistema que permite guardar y organizar datos, como clientes, productos o ventas.",
	"Sirve para que una aplicación pueda buscar, agregar y actualizar esa información.",
	"Por ejemplo, una tienda puede usarlo para registrar sus pedidos y controlar el stock.",
	"Sus ventajas son que es gratuito, de código abierto y confiable, con herramientas para proteger los datos.",
	"Además, puede manejar mucha información y crecer junto con tu proyecto.",
].join(" ");

const SILENT: AudioChunk = Object.freeze({
	bytes: new Uint8Array(64),
	sampleRateHz: 16_000,
	channels: 1,
	format: "pcm_s16le" as const,
});

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function convoConfig() {
	return {
		...DEFAULT_VOICE_CONFIG,
		enabled: true,
		behavior: {
			...DEFAULT_VOICE_CONFIG.behavior,
			mode: "conversation" as const,
			fluentConversation: true,
			echoSettleMs: 0,
			muted: false,
			maxSpokenSentences: 3,
		},
	};
}

test("P0: maxSpokenSentences=3 must still open with PostgreSQL (not Por ejemplo)", () => {
	const spoken = selectSpokenSentences(PG_REPLY, { maxSentences: 3, maxChars: 800 });
	assert.match(spoken, /^PostgreSQL/i);
	assert.ok(
		!spoken.trim().toLowerCase().startsWith("por ejemplo"),
		"must never start spoken summary at sentence 3",
	);

	const result = buildFinalUtterance({
		message: {
			role: "assistant",
			content: [{ type: "text", text: PG_REPLY }],
		},
		outcome: "completed",
		maxSentences: 3,
		maxChars: 800,
	});
	assert.equal(result.speak, true);
	assert.match(result.text, /^PostgreSQL/i);
});

test("P0: prefetch first synth failure must NOT play later units", async () => {
	const q = new StreamSpeakQueue(() => Date.now());
	q.begin();
	const played: string[] = [];
	q.enqueue([
		{ id: "u1", raw: "Uno.", speakable: "Uno." },
		{ id: "u2", raw: "Dos.", speakable: "Dos." },
		{ id: "u3", raw: "Tres.", speakable: "Tres." },
	]);
	await q.kickPipeline(
		{
			prefetchDepth: 1,
			async synthesize(unit) {
				if (unit.id === "u1") throw new Error("piper_boom");
				return SILENT;
			},
			async play(unit) {
				played.push(unit.speakable);
			},
		},
		new AbortController().signal,
	);
	await q.idle();
	assert.deepEqual(played, [], "must not skip ahead to Dos/Tres after first synth fails");
	assert.ok(q.metrics.unitsDropped >= 1);
	assert.ok(
		q.metrics.fragmentLog.some(
			(e) => e.type === "drop" && (e.dropReason.includes("piper_boom") || e.dropReason.includes("first_")),
		),
	);
});

test("P0: empty first audio must not advance playhead", async () => {
	const q = new StreamSpeakQueue(() => Date.now());
	q.begin();
	const played: string[] = [];
	q.enqueue([
		{ id: "u1", raw: "A.", speakable: "A." },
		{ id: "u2", raw: "B.", speakable: "B." },
	]);
	const empty: AudioChunk = { ...SILENT, bytes: new Uint8Array(0) };
	await q.kickPipeline(
		{
			prefetchDepth: 1,
			async synthesize(unit) {
				return unit.id === "u1" ? empty : SILENT;
			},
			async play(unit) {
				played.push(unit.speakable);
			},
		},
		new AbortController().signal,
	);
	await q.idle();
	assert.deepEqual(played, []);
});

test("P0: session streams PostgreSQL reply from first sentence", async () => {
	const harness = createPiHostHarness();
	const synthOrder: string[] = [];
	const tts = {
		...createStubTtsAdapter({ latencyMs: 5 }),
		id: "stub-tts",
		async synthesize(text: string, opts: { signal: AbortSignal }) {
			synthOrder.push(text);
			return createStubTtsAdapter({
				latencyMs: 5,
				audio: {
					bytes: new Uint8Array(64),
					sampleRateHz: 22_050,
					channels: 1,
					format: "pcm_s16le" as const,
				},
			}).synthesize(text, opts);
		},
		availability: async () => ({ status: "ready" as const }),
	};

	const session = new VoiceSession({
		config: convoConfig(),
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter(),
		tts,
		playback: createStubPlaybackAdapter({ durationMs: 8 }),
	});
	createVoiceExtension(harness.pi, {
		session,
		forceStubAdapters: true,
		shortcutProbe: deniedShortcutProbe(),
	});
	session.dispatch({ type: "ENABLE" });
	await session.submitPending("qué es postgresql");
	harness.fire("agent_start", { type: "agent_start" });

	const sentences = PG_REPLY.match(/[^.!?]+[.!?]+/g) ?? [PG_REPLY];
	for (const s of sentences) {
		harness.fire("message_update", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: `${s.trim()} ` },
		});
		await sleep(15);
	}

	harness.fire("turn_end", {
		type: "turn_end",
		outcome: "completed",
		message: {
			role: "assistant",
			content: [{ type: "text", text: PG_REPLY }],
		},
	});
	harness.fire("agent_settled", { type: "agent_settled", aborted: false });
	await session.flush();
	await sleep(200);
	await session.flush();

	assert.ok(synthOrder.length >= 1, "must synthesize at least one unit");
	assert.match(synthOrder[0]!, /PostgreSQL/i);
	assert.ok(
		!/^Por ejemplo/i.test(synthOrder[0]!.trim()),
		`first synth must not be Por ejemplo; got: ${synthOrder[0]!.slice(0, 80)}`,
	);
	const joined = synthOrder.join(" ");
	assert.match(joined, /PostgreSQL/i);
	assert.match(joined, /Sirve para/i);
});

test("P0: fragment log records synth/play lifecycle ids", async () => {
	const events: string[] = [];
	const q = new StreamSpeakQueue(
		() => Date.now(),
		(e) => {
			events.push(e.type === "drop" ? `drop:${e.unitId}:${e.dropReason}` : `${e.type}:${"unitId" in e ? e.unitId : ""}`);
		},
	);
	q.begin();
	q.enqueue([{ id: "u1", raw: "Hola.", speakable: "Hola." }]);
	await q.kickPipeline(
		{
			async synthesize() {
				return SILENT;
			},
			async play() {},
		},
		new AbortController().signal,
	);
	await q.idle();
	assert.ok(events.some((e) => e.startsWith("enqueue:u1")));
	assert.ok(events.some((e) => e.startsWith("synth_start:u1")));
	assert.ok(events.some((e) => e.startsWith("synth_done:u1")));
	assert.ok(events.some((e) => e.startsWith("play_start:u1")));
	assert.ok(events.some((e) => e.startsWith("play_done:u1")));
});
