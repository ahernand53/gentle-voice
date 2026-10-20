/**
 * Cold-start bridge: Piper while VibeVoice warms.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createVibeVoicePiperBridge } from "../lib/adapters/vibevoice-piper-bridge.ts";
import type { TtsAdapter, TtsResult } from "../lib/contracts.ts";
import type { VibeVoiceTtsAdapter } from "../lib/adapters/vibevoice-tts.ts";

function fakePiper(): TtsAdapter & { calls: number } {
	const a = {
		id: "piper-tts",
		calls: 0,
		async availability() {
			return { status: "ready" as const };
		},
		async synthesize(text: string): Promise<TtsResult> {
			a.calls += 1;
			void text;
			return {
				audio: {
					bytes: new Uint8Array([1, 2, 3, 4]),
					sampleRateHz: 22_050,
					channels: 1,
					format: "wav",
				},
			};
		},
	};
	return a;
}

function fakeVv(warm: boolean): VibeVoiceTtsAdapter & { calls: number; prewarmCalls: number } {
	let isWarm = warm;
	const a = {
		id: "vibevoice" as const,
		calls: 0,
		prewarmCalls: 0,
		lastMetrics: undefined,
		get workerWarm() {
			return isWarm;
		},
		async availability() {
			return { status: "ready" as const, detail: "fake" };
		},
		async dispose() {},
		async prewarm() {
			a.prewarmCalls += 1;
			isWarm = true;
		},
		async synthesize(text: string): Promise<TtsResult> {
			a.calls += 1;
			void text;
			return {
				audio: {
					bytes: new Uint8Array([9, 9]),
					sampleRateHz: 24_000,
					channels: 1,
					format: "wav",
				},
			};
		},
	};
	return a as VibeVoiceTtsAdapter & { calls: number; prewarmCalls: number };
}

test("bridge: cold → Piper + prewarm kick", async () => {
	const notes: string[] = [];
	const vv = fakeVv(false);
	const piper = fakePiper();
	const bridge = createVibeVoicePiperBridge({
		vibevoice: vv,
		piper,
		notify: (m) => notes.push(m),
	});
	const r = await bridge.synthesize("hola", { signal: new AbortController().signal });
	assert.equal(piper.calls, 1);
	assert.equal(vv.calls, 0);
	assert.equal(vv.prewarmCalls, 1);
	assert.equal(bridge.lastEngineUsed, "piper");
	assert.equal(r.audio.sampleRateHz, 22_050);
	assert.ok(notes[0]?.includes("Piper"));
});

test("bridge: warm → VibeVoice direct", async () => {
	const vv = fakeVv(true);
	const piper = fakePiper();
	const bridge = createVibeVoicePiperBridge({ vibevoice: vv, piper });
	const r = await bridge.synthesize("hola", { signal: new AbortController().signal });
	assert.equal(vv.calls, 1);
	assert.equal(piper.calls, 0);
	assert.equal(bridge.lastEngineUsed, "vibevoice");
	assert.equal(r.audio.sampleRateHz, 24_000);
});
