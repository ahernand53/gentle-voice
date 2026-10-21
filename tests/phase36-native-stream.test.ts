/**
 * VibeVoice PCM is the default when the host can play it. Esc cancels voice only.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createStubCaptureAdapter,
	createStubPlaybackAdapter,
	createStubSttAdapter,
	createStubTtsAdapter,
} from "../lib/adapters/stubs.ts";
import {
	decodeVibeVoicePcmLine,
	nativeVibeVoiceStreamEnabled,
	resolveVibeVoicePlayback,
	writeVibeVoicePlaybackPreference,
} from "../lib/adapters/vibevoice-pcm.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import { VoiceSession } from "../lib/voice-session.ts";

test("PCM is the default when supported; WAV is explicit", () => {
	assert.equal(nativeVibeVoiceStreamEnabled({}, true), true);
	assert.equal(nativeVibeVoiceStreamEnabled({}, false), false);
	assert.equal(
		nativeVibeVoiceStreamEnabled({ GENTLE_VOICE_VIBEVOICE_NATIVE_STREAM: "0" }, true),
		false,
	);
	assert.equal(
		nativeVibeVoiceStreamEnabled({ GENTLE_VOICE_VIBEVOICE_NATIVE_STREAM: "wav" }, true),
		false,
	);
	assert.equal(
		nativeVibeVoiceStreamEnabled({ GENTLE_VOICE_VIBEVOICE_NATIVE_STREAM: "1" }, false),
		false,
	);
	const home = mkdtempSync(join(tmpdir(), "gv-playback-"));
	writeVibeVoicePlaybackPreference(home, "wav");
	assert.equal(
		nativeVibeVoiceStreamEnabled({ GENTLE_VOICE_HOME: home }, true),
		false,
	);
	const forced = resolveVibeVoicePlayback({
		env: { GENTLE_VOICE_VIBEVOICE_NATIVE_STREAM: "0" },
		preference: "pcm",
		pcmSupported: true,
	});
	assert.equal(forced.mode, "wav");
	assert.equal(forced.source, "env");
	const unsupported = resolveVibeVoicePlayback({
		preference: "auto",
		pcmSupported: false,
	});
	assert.equal(unsupported.mode, "wav");
	assert.equal(unsupported.fallbackReason, "pcm_unsupported");
});

test("pcm frames must be float32 mono 24 kHz and in order", () => {
	const pcm = Buffer.alloc(8);
	pcm.writeFloatLE(0.1, 0);
	pcm.writeFloatLE(-0.2, 4);
	const first = decodeVibeVoicePcmLine({
		op: "pcm",
		seq: 0,
		dtype: "float32",
		sample_rate: 24000,
		channels: 1,
		samples: 2,
		min: -0.2,
		max: 0.1,
		pcm_b64: pcm.toString("base64"),
	}, 0);
	assert.equal(first.ok, true);
	if (!first.ok) return;
	assert.equal(first.frame.pcm.byteLength, 8);
	const skipped = decodeVibeVoicePcmLine({
		op: "pcm",
		seq: 2,
		dtype: "float32",
		sample_rate: 24000,
		channels: 1,
		samples: 2,
		pcm_b64: pcm.toString("base64"),
	}, 1);
	assert.equal(skipped.ok, false);
	const loud = decodeVibeVoicePcmLine({
		op: "pcm",
		seq: 0,
		dtype: "float32",
		sample_rate: 24000,
		channels: 1,
		samples: 2,
		min: -20,
		max: 20,
		pcm_b64: pcm.toString("base64"),
	}, 0);
	assert.equal(loud.ok, false);
});

test("Esc during WORKING drops the later reply and leaves phase idle", () => {
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: {
				...DEFAULT_VOICE_CONFIG.behavior,
				mode: "conversation",
				fluentConversation: false,
			},
		},
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter(),
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter({ durationMs: 1 }),
	});
	session.dispatch({ type: "SUBMIT_REVIEW", text: "revisa el error" });
	assert.equal(session.state.phase, "awaiting_agent");
	session.cancelVoiceAudio("escape");
	assert.equal(session.state.phase, "idle");
	session.cancelVoiceAudio("escape");
	assert.equal(session.state.phase, "idle");
	const decision = session.onAgentSettled({
		outcome: "completed",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Encontré el problema en la consulta." }],
		},
	});
	assert.equal(decision.speak, false);
	assert.equal(decision.reason, "voice_escape");
});
