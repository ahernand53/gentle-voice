/**
 * Barge-in gate, activation, and speaking-phase entry. No mic, no speakers.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBargeGate } from "../lib/barge-in/gate.ts";
import {
	bargeTranscriptSubmittable,
	createBargeTranscript,
} from "../lib/barge-in/transcript-window.ts";
import { voiceInterruptWindow } from "../lib/barge-in/window.ts";
import { createStubPlaybackAdapter, createStubSttAdapter } from "../lib/adapters/stubs.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import type { CaptureAdapter, TtsAdapter } from "../lib/contracts.ts";
import { createVoiceNarrationAdapter } from "../lib/narration/index.ts";
import { VoiceSession } from "../lib/voice-session.ts";
import {
	readBargePreference,
	resolveBargeActivation,
	writeBargePreference,
} from "../lib/barge-in/preference.ts";
import { initialVoiceState, reduceVoiceState } from "../lib/state-machine.ts";

test("constant mic at the echo floor does not confirm", () => {
	const gate = createBargeGate({ minVoicedMs: 400, dipMs: 0, floorRise: 0.2 });
	let last = gate.push({ atMs: 0, micRms: 0.05, playbackRms: 0.4 });
	for (let t = 40; t <= 1000; t += 40) {
		last = gate.push({ atMs: t, micRms: 0.05, playbackRms: 0.4 });
	}
	assert.equal(last.confirmed, false);
	assert.equal(last.reason, "echo_like");
});

test("short spike above the floor does not confirm", () => {
	const gate = createBargeGate({ minVoicedMs: 500 });
	gate.push({ atMs: 0, micRms: 0.008, playbackRms: 0.3 });
	const d = gate.push({ atMs: 60, micRms: 0.2, playbackRms: 0.3 });
	assert.equal(d.confirmed, false);
	assert.equal(d.reason, "building");
});

test("voice above a quiet mic floor confirms even if the WAV is digitally loud", () => {
	const gate = createBargeGate({ minVoicedMs: 400, dipMs: 0, floorRise: 0.02 });
	gate.push({ atMs: 0, micRms: 0.006, playbackRms: 0.45 });
	gate.push({ atMs: 40, micRms: 0.006, playbackRms: 0.45 });
	let last = gate.push({ atMs: 80, micRms: 0.09, playbackRms: 0.45 });
	last = gate.push({ atMs: 520, micRms: 0.09, playbackRms: 0.45 });
	assert.equal(last.confirmed, true, `reason=${last.reason} floor=${last.echoFloor}`);
	assert.equal(last.reason, "confirmed");
});

test("brief noise under the absolute floor is rejected", () => {
	const gate = createBargeGate({ minVoicedMs: 200, micFloor: 0.02 });
	const d = gate.push({ atMs: 100, micRms: 0.01, playbackRms: 0 });
	assert.equal(d.confirmed, false);
	assert.equal(d.reason, "below_floor");
});

test("BARGE_COMMIT leaves speaking for listening and only cancels audio", () => {
	const speaking = initialVoiceState({ enabled: true, phase: "speaking", mode: "conversation" });
	const next = reduceVoiceState(speaking, { type: "BARGE_COMMIT" });
	assert.equal(next.state.phase, "listening");
	assert.deepEqual(next.effects.map((e) => e.type), ["cancel_tts", "cancel_playback"]);
});

test("BARGE_COMMIT does not apply while the agent is still working", () => {
	const working = initialVoiceState({ enabled: true, phase: "awaiting_agent" });
	const next = reduceVoiceState(working, { type: "BARGE_COMMIT" });
	assert.equal(next.changed, false);
	assert.equal(next.state.phase, "awaiting_agent");
});

test("BARGE_COMMIT_VOICE cancels narration prep and does not stay in WORKING", () => {
	const preparing = initialVoiceState({ enabled: true, phase: "awaiting_agent", mode: "conversation" });
	const next = reduceVoiceState(preparing, { type: "BARGE_COMMIT_VOICE" });
	assert.equal(next.state.phase, "listening");
	assert.deepEqual(next.effects.map((e) => e.type), ["cancel_tts", "cancel_playback"]);
	const tools = reduceVoiceState(preparing, { type: "BARGE_COMMIT" });
	assert.equal(tools.changed, false);
});

test("interrupt window is open for speaking and narrating, closed while tools run", () => {
	assert.equal(voiceInterruptWindow({ phase: "speaking", narrating: false, synthesizing: true }), true);
	assert.equal(voiceInterruptWindow({ phase: "awaiting_agent", narrating: true, synthesizing: false }), true);
	assert.equal(voiceInterruptWindow({ phase: "awaiting_agent", narrating: false, synthesizing: true }), false);
	assert.equal(voiceInterruptWindow({ phase: "awaiting_agent", narrating: false, synthesizing: false }), false);
	assert.equal(voiceInterruptWindow({ phase: "listening", narrating: false, synthesizing: false }), false);
});

function pcmAt(sample: number): Uint8Array {
	const frames = 160;
	const buf = new Uint8Array(frames * 2);
	const signed = sample < 0 ? sample + 65536 : sample;
	for (let i = 0; i < frames; i++) {
		buf[i * 2] = signed & 0xff;
		buf[i * 2 + 1] = (signed >> 8) & 0xff;
	}
	return buf;
}

test("barge during NARRATING opens the mic, cancels the narrator, and does not submit tools", async () => {
	let clock = 1_000;
	let onChunk: ((pcm: Uint8Array, meta: { channels: number; sampleRateHz: number }) => void) | undefined;
	let starts = 0;
	const capture: CaptureAdapter = {
		id: "cap",
		async availability() {
			return { status: "ready" };
		},
		async start(options) {
			starts += 1;
			onChunk = options.onPcmChunk;
			options.onFirstPcm?.({ captureId: "c", atMs: clock });
			return {
				id: "c",
				async stop() {
					return {
						bytes: new Uint8Array(0),
						sampleRateHz: 16_000,
						channels: 1,
						format: "raw",
					};
				},
			};
		},
	};
	const tts: TtsAdapter = {
		id: "vibevoice",
		async availability() {
			return { status: "ready" };
		},
		synthesize: (_text, options) => new Promise((_resolve, reject) => {
			options.signal.addEventListener("abort", () => {
				reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
			}, { once: true });
		}),
	};
	let narratorCalls = 0;
	const narration = createVoiceNarrationAdapter({
		config: {
			enabled: true,
			role: "voice-ai",
			onError: "deterministic",
			style: "natural",
			timeoutMs: 5_000,
			maxInputChars: 2_000,
		},
		resolveOverride: () => ({
			status: "ready",
			source: "active_model_fallback",
			model: { provider: "openai", id: "gpt", ref: "openai/gpt" },
		}),
		host: {
			find: () => ({ id: "gpt" }),
			hasConfiguredAuth: () => true,
			complete: (_model, _ctx, opts) => new Promise((_resolve, reject) => {
				narratorCalls += 1;
				opts?.signal?.addEventListener("abort", () => {
					reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
				}, { once: true });
			}),
		},
	});
	const submitted: string[] = [];
	const session = new VoiceSession({
		now: () => clock,
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: {
				...DEFAULT_VOICE_CONFIG.behavior,
				mode: "conversation",
				fluentConversation: true,
			},
			voiceAi: { ...DEFAULT_VOICE_CONFIG.voiceAi, enabled: true },
		},
		capture,
		stt: createStubSttAdapter({ text: "espera quiero otra pregunta" }),
		tts,
		playback: createStubPlaybackAdapter({ durationMs: 1 }),
		narrationAdapter: narration,
		bargeInEnabled: () => true,
		submitTranscript: (text) => {
			submitted.push(text);
		},
	});
	session.dispatch({ type: "ENABLE" });
	session.dispatch({ type: "AGENT_STARTED" });
	session.beginStreamSpeak();
	const decision = session.onAgentSettled({
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Esta es una respuesta larga que no debe seguir sonando." }],
		},
		outcome: "completed",
	});
	assert.equal(decision.narrating, true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(starts, 1, "mic must open while NARRATING, before TTS");
	assert.equal(session.state.phase, "awaiting_agent");
	assert.ok(onChunk);
	onChunk!(pcmAt(200), { channels: 1, sampleRateHz: 16_000 });
	clock += 40;
	onChunk!(pcmAt(200), { channels: 1, sampleRateHz: 16_000 });
	clock += 40;
	onChunk!(pcmAt(12_000), { channels: 1, sampleRateHz: 16_000 });
	clock += 500;
	onChunk!(pcmAt(12_000), { channels: 1, sampleRateHz: 16_000 });
	await session.flush();
	assert.equal(session.state.phase, "listening");
	assert.equal(narratorCalls, 1);
	assert.deepEqual(submitted, []);
});

test("barge during SYNTHESIZING opens the mic before the first audio frame", async () => {
	let clock = 2_000;
	let starts = 0;
	let onChunk: ((pcm: Uint8Array, meta: { channels: number; sampleRateHz: number }) => void) | undefined;
	let synthStarted = false;
	const capture: CaptureAdapter = {
		id: "cap",
		async availability() {
			return { status: "ready" };
		},
		async start(options) {
			starts += 1;
			onChunk = options.onPcmChunk;
			return {
				id: "c",
				async stop() {
					return { bytes: new Uint8Array(0), sampleRateHz: 16_000, channels: 1, format: "raw" };
				},
			};
		},
	};
	const tts: TtsAdapter = {
		id: "piper",
		async availability() {
			return { status: "ready" };
		},
		synthesize: (_text, options) => new Promise((_resolve, reject) => {
			synthStarted = true;
			options.signal.addEventListener("abort", () => {
				reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
			}, { once: true });
		}),
	};
	const session = new VoiceSession({
		now: () => clock,
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: { ...DEFAULT_VOICE_CONFIG.behavior, mode: "conversation" },
		},
		capture,
		stt: createStubSttAdapter({ text: "otra pregunta" }),
		tts,
		playback: createStubPlaybackAdapter({ durationMs: 1 }),
		bargeInEnabled: () => true,
	});
	session.dispatch({ type: "ENABLE" });
	session.dispatch({ type: "AGENT_STARTED" });
	session.onAgentSettled({
		message: { role: "assistant", content: [{ type: "text", text: "Respuesta que todavía se está sintetizando." }] },
		outcome: "completed",
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(synthStarted, true);
	assert.equal(starts, 1);
	assert.equal(session.state.phase, "speaking");
	assert.equal(session.chromeVisual().speakStage, "synthesizing");
	assert.ok(onChunk);
	onChunk!(pcmAt(200), { channels: 1, sampleRateHz: 16_000 });
	clock += 40;
	onChunk!(pcmAt(12_000), { channels: 1, sampleRateHz: 16_000 });
	clock += 500;
	onChunk!(pcmAt(12_000), { channels: 1, sampleRateHz: 16_000 });
	await session.flush();
	assert.equal(session.state.phase, "listening");
});

test("ENTER_SPEAKING moves awaiting_agent to speaking without starting a second TTS", () => {
	const waiting = initialVoiceState({ enabled: true, phase: "awaiting_agent" });
	const next = reduceVoiceState(waiting, { type: "ENTER_SPEAKING" });
	assert.equal(next.state.phase, "speaking");
	assert.deepEqual(next.effects, []);
});

test("barge preference: explicit off beats conversation; unset follows it", () => {
	const off = resolveBargeActivation({ preference: "off", fluentConversation: true });
	assert.equal(off.enabled, false);
	assert.equal(off.source, "explicit-off");
	const auto = resolveBargeActivation({ preference: "unset", fluentConversation: true });
	assert.equal(auto.enabled, true);
	assert.equal(auto.source, "automatic");
	const idle = resolveBargeActivation({ preference: "unset", fluentConversation: false });
	assert.equal(idle.enabled, false);
	assert.equal(idle.source, "automatic");
	const sticky = resolveBargeActivation({ preference: "on", fluentConversation: false });
	assert.equal(sticky.enabled, true);
	assert.equal(sticky.source, "explicit-on");
});

test("legacy enabled:true file is an explicit on", () => {
	const dir = mkdtempSync(join(tmpdir(), "gv-barge-"));
	writeFileSync(
		join(dir, "barge-in-preference.json"),
		JSON.stringify({ kind: "gentle-voice.barge-in-preference", enabled: true }),
	);
	assert.equal(readBargePreference(dir), "on");
	writeBargePreference(dir, "off");
	const saved = JSON.parse(readFileSync(join(dir, "barge-in-preference.json"), "utf8")) as {
		preference?: string;
	};
	assert.equal(saved.preference, "off");
	assert.equal(readBargePreference(dir), "off");
});

function tone(byte: number, atMs: number): { atMs: number; pcm: Uint8Array } {
	return { atMs, pcm: Uint8Array.of(byte, 0, byte, 0) };
}

test("barge transcript drops assistant bleed from before the user onset", () => {
	const gate = createBargeGate({ minVoicedMs: 400, dipMs: 0, floorRise: 0.02 });
	const window = createBargeTranscript(80);
	const bleed = tone(0xab, 0);
	window.observe(bleed.atMs, bleed.pcm, undefined);
	gate.push({ atMs: 0, micRms: 0.006, playbackRms: 0.4 });
	gate.push({ atMs: 40, micRms: 0.006, playbackRms: 0.4 });
	window.observe(500, tone(0x11, 500).pcm, undefined);
	const building = gate.push({ atMs: 500, micRms: 0.1, playbackRms: 0.4 });
	window.observe(500, tone(0x11, 500).pcm, building.runStartMs);
	const confirmed = gate.push({ atMs: 920, micRms: 0.1, playbackRms: 0.4 });
	assert.equal(confirmed.confirmed, true);
	window.observe(920, tone(0x11, 920).pcm, confirmed.runStartMs);
	window.pushDuringRun(1100, tone(0x22, 1100).pcm);
	const pcm = window.pcm();
	assert.equal(pcm.includes(0xab), false);
	assert.equal(pcm.includes(0x11), true);
	assert.equal(pcm.includes(0x22), true);
	assert.equal(window.anchored(), true);
});

test("user audio before confirm stays in the transcript window", () => {
	const window = createBargeTranscript(80);
	window.observe(0, tone(0xab, 0).pcm, undefined);
	window.observe(400, tone(0x11, 400).pcm, 400);
	window.observe(500, tone(0x11, 500).pcm, 400);
	const pcm = window.pcm();
	assert.equal(pcm.includes(0xab), false);
	assert.equal(pcm.filter((b) => b === 0x11).length >= 2, true);
});

test("a short user onset is not removed by a fixed cut", () => {
	const window = createBargeTranscript(80);
	const phrase = new Uint8Array(3200);
	phrase.fill(0x3c);
	window.observe(1000, phrase, 1000);
	const pcm = window.pcm();
	assert.equal(pcm.byteLength, phrase.byteLength);
	assert.equal(pcm[0], 0x3c);
	assert.equal(pcm[pcm.byteLength - 1], 0x3c);
});

test("assistant bleed alone is not submittable", () => {
	const window = createBargeTranscript(80);
	window.observe(0, new Uint8Array(8000), undefined);
	window.observe(40, new Uint8Array(8000), undefined);
	assert.equal(window.anchored(), false);
	const wouldSend = window.anchored() && bargeTranscriptSubmittable(window.pcm().byteLength, 16_000);
	assert.equal(wouldSend, false);
});

test("a reset run drops the previous candidate and the next turn starts empty", () => {
	const window = createBargeTranscript(80);
	window.observe(0, tone(0x11, 0).pcm, 0);
	window.observe(200, tone(0x00, 200).pcm, undefined);
	assert.equal(window.anchored(), false);
	assert.equal(window.pcm().includes(0x11), false);
	window.clear();
	window.observe(0, tone(0x22, 0).pcm, 0);
	assert.equal(window.pcm().includes(0x11), false);
	assert.equal(window.pcm().includes(0x22), true);
});
