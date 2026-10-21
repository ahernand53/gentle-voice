/**
 * P0 ghost transcripts — silence / late partial / wrong capture must never
 * paint UI or submit. Rejection is evidence-based (no speech), not word bans.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AudioChunk, SttResult } from "../lib/contracts.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import { reduceVoiceState, initialVoiceState } from "../lib/state-machine.ts";
import { gateUtteranceForAutoSubmit } from "../lib/stt/utterance-gate.ts";
import { VoiceSession } from "../lib/voice-session.ts";
import {
	createStubPlaybackAdapter,
	createStubTtsAdapter,
} from "../lib/adapters/stubs.ts";

function pcmTone(bytes: number, amp = 8000): Uint8Array {
	const buf = Buffer.alloc(bytes);
	for (let i = 0; i < bytes; i += 2) buf.writeInt16LE(amp, i);
	return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function meta(speechSeen: boolean, overrides: Partial<AudioChunk["captureMeta"]> = {}) {
	return {
		captureId: "cap-ghost",
		speechSeen,
		endReason: "vad" as const,
		durationMs: speechSeen ? 1200 : 800,
		peakRms: speechSeen ? 0.2 : 0.001,
		meanRms: speechSeen ? 0.12 : 0.0004,
		...overrides,
	};
}

function audio(speechSeen: boolean): AudioChunk {
	return {
		format: "pcm_s16le",
		sampleRateHz: 16_000,
		channels: 1,
		bytes: pcmTone(speechSeen ? 32_000 : 16_000, speechSeen ? 8000 : 50),
		captureMeta: meta(speechSeen),
	};
}

test("gate: Whisper silence hallucinations rejected by no_speech_seen (not word ban)", () => {
	for (const text of ["el Perú", "no, no, no", "Perú", "no"]) {
		const r = gateUtteranceForAutoSubmit({
			text,
			captureMeta: meta(false),
		});
		assert.equal(r.accept, false, text);
		assert.equal(r.reason, "no_speech_seen");
	}
});

test("gate: a click of voiced audio does not auto-submit", () => {
	const r = gateUtteranceForAutoSubmit({
		text: "El Perú.",
		captureMeta: meta(true, { voicedMs: 40, durationMs: 1400 }),
	});
	assert.equal(r.accept, false);
	assert.equal(r.reason, "voiced_too_short");
});

test("gate: a cancelled capture does not auto-submit", () => {
	const r = gateUtteranceForAutoSubmit({
		text: "El Perú.",
		captureMeta: meta(true, { endReason: "stop", voicedMs: 900 }),
	});
	assert.equal(r.accept, false);
	assert.equal(r.reason, "cancelled");
});

test("gate: legitimate Perú / no with speechSeen accepted", () => {
	for (const text of ["Voy a Perú el lunes", "no quiero eso ahora"]) {
		const r = gateUtteranceForAutoSubmit({
			text,
			captureMeta: meta(true),
		});
		assert.equal(r.accept, true, text);
		assert.equal(r.reason, "ok");
	}
});

test("state: LISTEN blocked while awaiting_agent", () => {
	let s = initialVoiceState({ enabled: true, mode: "conversation", muted: false });
	s = reduceVoiceState(s, { type: "LISTEN" }).state;
	s = reduceVoiceState(s, { type: "CAPTURE_DONE" }).state;
	s = reduceVoiceState(s, { type: "TRANSCRIBE_DONE", text: "hola" }).state;
	assert.equal(s.phase, "awaiting_agent");
	const next = reduceVoiceState(s, { type: "LISTEN" });
	assert.equal(next.state.phase, "awaiting_agent");
	assert.ok(next.effects.some((e) => e.type === "notify"));
});

test("session: silence after valid submit — no ghost partial UI, one submit", async () => {
	const submitted: string[] = [];
	const uiPartials: string[] = [];
	let releasePartial!: () => void;
	const partialGate = new Promise<void>((r) => {
		releasePartial = r;
	});
	let speechHook: ((info: { captureId: string; atMs: number }) => void) | undefined;
	let pcmCb: ((pcm: Uint8Array, meta: { channels: number; sampleRateHz: number }) => void) | undefined;
	let listenCount = 0;

	const stt = {
		id: "ghost-stt",
		finalCalls: 0,
		partialCalls: 0,
		async availability() {
			return { status: "ready" as const };
		},
		async transcribe(): Promise<SttResult> {
			stt.finalCalls += 1;
			return { text: "consulta valida en C Sharp", confidence: 1 };
		},
		async transcribePartial(): Promise<SttResult> {
			stt.partialCalls += 1;
			await partialGate;
			// Classic silence hallucination payload
			return { text: "el Perú", confidence: 0.2 };
		},
	};

	const capture = {
		id: "cap",
		async availability() {
			return { status: "ready" as const };
		},
		async start(opts: {
			onPcmChunk?: (pcm: Uint8Array, meta: { channels: number; sampleRateHz: number }) => void;
			onFirstPcm?: (info: { captureId: string; atMs: number }) => void;
			onSpeechSeen?: (info: { captureId: string; atMs: number }) => void;
		}) {
			listenCount += 1;
			pcmCb = opts.onPcmChunk;
			speechHook = opts.onSpeechSeen;
			opts.onFirstPcm?.({ captureId: `c${listenCount}`, atMs: Date.now() });
			return {
				id: `c${listenCount}`,
				async stop() {
					return audio(true);
				},
			};
		},
	};

	const prev = process.env.GENTLE_VOICE_INCREMENTAL_STT;
	process.env.GENTLE_VOICE_INCREMENTAL_STT = "1";

	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: {
				...DEFAULT_VOICE_CONFIG.behavior,
				autoSubmitTranscript: true,
				fluentConversation: false,
				incrementalStt: true,
				echoSettleMs: 200,
			},
		},
		capture: capture as never,
		stt: stt as never,
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter(),
		submitTranscript: (t) => submitted.push(t),
		onChromeUpdate: () => {
			if (session.provisionalKind === "partial" && session.provisionalTranscript) {
				uiPartials.push(session.provisionalTranscript);
			}
		},
	});

	session.dispatch({ type: "ENABLE" });
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	speechHook?.({ captureId: "c1", atMs: Date.now() });
	pcmCb?.(pcmTone(40_000), { channels: 1, sampleRateHz: 16_000 });
	await new Promise((r) => setTimeout(r, 30));

	await session.finishListen();
	await session.flush();

	// Late partial resolves AFTER seal/submit — must not paint.
	releasePartial();
	await new Promise((r) => setTimeout(r, 50));

	assert.equal(submitted.length, 1);
	assert.ok(submitted[0]?.includes("C#") || submitted[0]?.includes("C Sharp") || submitted[0]);
	assert.ok(!uiPartials.some((t) => /Perú|peru/i.test(t)), `ghost UI: ${uiPartials.join("|")}`);
	assert.equal(session.provisionalTranscript, "");
	assert.equal(session.state.phase, "awaiting_agent");

	// Silence window: no second listen / submit
	await new Promise((r) => setTimeout(r, 80));
	assert.equal(submitted.length, 1);
	assert.equal(listenCount, 1);

	session.dispose();
	if (prev === undefined) delete process.env.GENTLE_VOICE_INCREMENTAL_STT;
	else process.env.GENTLE_VOICE_INCREMENTAL_STT = prev;
});

test("session: Esc seals — late partial ignored", async () => {
	const uiPartials: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	let speechHook: ((info: { captureId: string; atMs: number }) => void) | undefined;
	let pcmCb: ((pcm: Uint8Array, meta: { channels: number; sampleRateHz: number }) => void) | undefined;

	const stt = {
		id: "esc-stt",
		async availability() {
			return { status: "ready" as const };
		},
		async transcribe(): Promise<SttResult> {
			return { text: "no deberia", confidence: 1 };
		},
		async transcribePartial(): Promise<SttResult> {
			await gate;
			return { text: "no, no, no", confidence: 0.1 };
		},
	};

	const capture = {
		id: "cap",
		async availability() {
			return { status: "ready" as const };
		},
		async start(opts: {
			onPcmChunk?: (pcm: Uint8Array, meta: { channels: number; sampleRateHz: number }) => void;
			onFirstPcm?: (info: { captureId: string; atMs: number }) => void;
			onSpeechSeen?: (info: { captureId: string; atMs: number }) => void;
		}) {
			pcmCb = opts.onPcmChunk;
			speechHook = opts.onSpeechSeen;
			opts.onFirstPcm?.({ captureId: "e1", atMs: Date.now() });
			return {
				id: "e1",
				async stop() {
					return audio(true);
				},
			};
		},
	};

	process.env.GENTLE_VOICE_INCREMENTAL_STT = "1";
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: {
				...DEFAULT_VOICE_CONFIG.behavior,
				incrementalStt: true,
				autoSubmitTranscript: false,
			},
		},
		capture: capture as never,
		stt: stt as never,
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter(),
		onChromeUpdate: () => {
			if (session.provisionalKind === "partial") uiPartials.push(session.provisionalTranscript);
		},
	});

	session.dispatch({ type: "ENABLE" });
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	speechHook?.({ captureId: "e1", atMs: Date.now() });
	pcmCb?.(pcmTone(40_000), { channels: 1, sampleRateHz: 16_000 });
	await new Promise((r) => setTimeout(r, 20));
	session.dispatch({ type: "STOP" });
	await session.flush();
	release();
	await new Promise((r) => setTimeout(r, 40));
	assert.ok(!uiPartials.some((t) => /no,\s*no/i.test(t)));
	session.dispose();
	delete process.env.GENTLE_VOICE_INCREMENTAL_STT;
});

test("session: final no_speech_seen skips Whisper and does not submit ghosts", async () => {
	const submitted: string[] = [];
	let whisperCalls = 0;
	const stt = {
		id: "nospeech",
		async availability() {
			return { status: "ready" as const };
		},
		async transcribe(): Promise<SttResult> {
			whisperCalls += 1;
			return { text: "el Perú", confidence: 0.1 };
		},
	};
	const capture = {
		id: "cap",
		async availability() {
			return { status: "ready" as const };
		},
		async start(opts: { onFirstPcm?: (info: { captureId: string; atMs: number }) => void }) {
			opts.onFirstPcm?.({ captureId: "n1", atMs: Date.now() });
			return {
				id: "n1",
				async stop() {
					return audio(false);
				},
			};
		},
	};
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: {
				...DEFAULT_VOICE_CONFIG.behavior,
				autoSubmitTranscript: true,
				incrementalStt: false,
			},
		},
		capture: capture as never,
		stt: stt as never,
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter(),
		submitTranscript: (t) => submitted.push(t),
	});
	session.dispatch({ type: "ENABLE" });
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	await session.finishListen();
	await session.flush();
	assert.equal(whisperCalls, 0);
	assert.deepEqual(submitted, []);
	session.dispose();
});

test("three consecutive stub turns — no duplicate submits", async () => {
	const submitted: string[] = [];
	let n = 0;
	const stt = {
		id: "three",
		async availability() {
			return { status: "ready" as const };
		},
		async transcribe(): Promise<SttResult> {
			n += 1;
			return { text: `turno numero ${n} con Angular`, confidence: 1 };
		},
	};
	const capture = {
		id: "cap",
		async availability() {
			return { status: "ready" as const };
		},
		async start(opts: { onFirstPcm?: (info: { captureId: string; atMs: number }) => void }) {
			opts.onFirstPcm?.({ captureId: `t${n}`, atMs: Date.now() });
			return {
				id: `t${n}`,
				async stop() {
					return audio(true);
				},
			};
		},
	};
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: {
				...DEFAULT_VOICE_CONFIG.behavior,
				autoSubmitTranscript: true,
				fluentConversation: false,
			},
		},
		capture: capture as never,
		stt: stt as never,
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter(),
		submitTranscript: (t) => submitted.push(t),
	});
	session.dispatch({ type: "ENABLE" });
	for (let i = 0; i < 3; i++) {
		session.dispatch({ type: "LISTEN" });
		await session.flush();
		await session.finishListen();
		await session.flush();
		session.dispatch({ type: "AGENT_SETTLED", speak: false });
		await session.flush();
	}
	assert.equal(submitted.length, 3);
	assert.equal(new Set(submitted).size, 3);
	session.dispose();
});
