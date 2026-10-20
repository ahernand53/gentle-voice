/**
 * Silero VAD — synthetic frames (no ORT / no model download).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnergyVad } from "../lib/vad/energy-vad.ts";
import { resolveVad } from "../lib/vad/resolve-vad.ts";
import {
	SILERO_WINDOW_SAMPLES,
	createSileroVadFromRunner,
	tryCreateSileroVad,
} from "../lib/vad/silero-vad.ts";

function s16leTone(samples: number, amplitude: number): Uint8Array {
	const buf = Buffer.alloc(samples * 2);
	for (let i = 0; i < samples; i++) {
		buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(amplitude * 32767))), i * 2);
	}
	return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

test("energy VAD still ends after hang (regression baseline)", () => {
	const vad = createEnergyVad({
		speechThreshold: 0.01,
		silenceHangMs: 100,
		maxIntraPauseMs: 40,
		postRollMs: 20,
		sampleRateHz: 16_000,
	});
	// ~50 ms speech
	assert.equal(vad.pushPcmS16le(s16leTone(800, 0.2)), false);
	assert.equal(vad.state.speechSeen, true);
	// silence long enough
	let ended = false;
	for (let i = 0; i < 20 && !ended; i++) {
		ended = vad.pushPcmS16le(s16leTone(800, 0));
	}
	assert.equal(ended, true);
	assert.equal(vad.backend, "energy");
});

test("silero runner: speech then silence ends with tighter hang", () => {
	let frames = 0;
	const vad = createSileroVadFromRunner({
		runFrame: () => {
			frames += 1;
			// First 4 frames speech, then silence
			return frames <= 4 ? 0.9 : 0.05;
		},
		silenceHangMs: 100,
		maxIntraPauseMs: 40,
		postRollMs: 20,
		sampleRateHz: 16_000,
		speechProbThreshold: 0.5,
	});
	let ended = false;
	for (let i = 0; i < 40 && !ended; i++) {
		ended = vad.pushPcmS16le(s16leTone(SILERO_WINDOW_SAMPLES, 0.1));
	}
	assert.equal(ended, true);
	assert.equal(vad.backend, "silero");
	assert.equal(vad.state.speechSeen, true);
	assert.ok(frames >= 5);
});

test("resolveVad auto falls back to energy without model", async () => {
	const r = await resolveVad({
		preference: "auto",
		env: {},
		energy: { speechThreshold: 0.01 },
		silero: { modelPath: "" },
	});
	assert.equal(r.backend, "energy");
	assert.ok(r.fallbackReason);
});

test("resolveVad silero with runFrame selects silero", async () => {
	const r = await resolveVad({
		preference: "silero",
		silero: {
			modelPath: "/unused",
			runFrame: () => 0.1,
		},
	});
	assert.equal(r.backend, "silero");
	assert.equal(r.fallbackReason, undefined);
});

test("tryCreateSileroVad fails soft on missing model", async () => {
	const r = await tryCreateSileroVad({ modelPath: "/tmp/no-such-silero-vad.onnx" });
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.reason, /unreadable|missing/);
});

test("silero does not end during leading silence", () => {
	const vad = createSileroVadFromRunner({
		runFrame: () => 0.1,
		silenceHangMs: 50,
		maxIntraPauseMs: 20,
		postRollMs: 10,
	});
	for (let i = 0; i < 10; i++) {
		assert.equal(vad.pushPcmS16le(s16leTone(SILERO_WINDOW_SAMPLES, 0)), false);
	}
	assert.equal(vad.state.speechSeen, false);
	assert.equal(vad.state.phase, "leading_silence");
});
