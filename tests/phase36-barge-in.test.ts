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
