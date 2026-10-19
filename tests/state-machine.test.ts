import assert from "node:assert/strict";
import { test } from "node:test";
import { describeVoiceStatus, initialVoiceState, reduceVoiceState } from "../lib/state-machine.ts";

test("enable then listen starts capture", () => {
	let state = initialVoiceState();
	state = reduceVoiceState(state, { type: "ENABLE" }).state;
	const listen = reduceVoiceState(state, { type: "LISTEN" });
	assert.equal(listen.state.phase, "listening");
	assert.ok(listen.effects.some((e) => e.type === "start_capture"));
});

test("listen while disabled warns", () => {
	const state = initialVoiceState();
	const listen = reduceVoiceState(state, { type: "LISTEN" });
	assert.equal(listen.state.phase, "idle");
	assert.ok(listen.effects.some((e) => e.type === "notify"));
});

test("conversation path submits transcript and can speak", () => {
	let state = initialVoiceState({ enabled: true, mode: "conversation" });
	state = reduceVoiceState(state, { type: "LISTEN" }).state;
	state = reduceVoiceState(state, { type: "CAPTURE_DONE" }).state;
	const done = reduceVoiceState(state, { type: "TRANSCRIBE_DONE", text: "fix the build" });
	assert.equal(done.state.phase, "awaiting_agent");
	assert.deepEqual(done.effects, [{ type: "submit_transcript", text: "fix the build" }]);

	const settled = reduceVoiceState(done.state, { type: "AGENT_SETTLED", speak: true });
	assert.equal(settled.state.phase, "speaking");
	assert.ok(settled.effects.some((e) => e.type === "start_tts"));
});

test("silent mode submits but never starts tts", () => {
	let state = initialVoiceState({ enabled: true, mode: "silent" });
	state = reduceVoiceState(state, { type: "LISTEN" }).state;
	state = reduceVoiceState(state, { type: "CAPTURE_DONE" }).state;
	state = reduceVoiceState(state, { type: "TRANSCRIBE_DONE", text: "hello" }).state;
	const settled = reduceVoiceState(state, { type: "AGENT_SETTLED", speak: true });
	assert.equal(settled.state.phase, "idle");
	assert.ok(!settled.effects.some((e) => e.type === "start_tts"));
});

test("dictation submits and returns idle without awaiting agent speech", () => {
	let state = initialVoiceState({ enabled: true, mode: "dictation" });
	state = reduceVoiceState(state, { type: "LISTEN" }).state;
	state = reduceVoiceState(state, { type: "CAPTURE_DONE" }).state;
	const done = reduceVoiceState(state, { type: "TRANSCRIBE_DONE", text: "note to self" });
	assert.equal(done.state.phase, "idle");
	assert.ok(done.effects.some((e) => e.type === "submit_transcript"));
});

test("mute cancels speaking", () => {
	const state = initialVoiceState({ enabled: true, phase: "speaking" });
	const muted = reduceVoiceState(state, { type: "MUTE" });
	assert.equal(muted.state.muted, true);
	assert.ok(muted.effects.some((e) => e.type === "cancel_playback"));
});

test("stop cancels active work", () => {
	const state = initialVoiceState({ enabled: true, phase: "listening" });
	const stopped = reduceVoiceState(state, { type: "STOP" });
	assert.equal(stopped.state.phase, "idle");
	assert.ok(stopped.effects.some((e) => e.type === "stop_capture"));
});

test("status line is stable", () => {
	const line = describeVoiceStatus(initialVoiceState({ enabled: true, muted: true, mode: "silent" }));
	assert.match(line, /on/);
	assert.match(line, /muted/);
	assert.match(line, /silent/);
});
