/**
 * Phase 2C.1 — Pi event contracts, reply recovery, VAD, engine status.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { skipWithoutLab } from "./lab-env.ts";
import {
	AgentReplyTracker,
	asAssistantMessage,
	fingerprintMessage,
	lastAssistantFromSessionEntries,
} from "../lib/agent-reply-tracker.ts";
import { createEnergyVad } from "../lib/vad/energy-vad.ts";
import { createFilesystemEngineProbe } from "../lib/engines/probe-fs.ts";
import { beginSetup } from "../lib/engines/setup.ts";
import { LAB_WHISPER_CLI_CANDIDATE } from "../lib/adapters/whisper-stt.ts";
import { access, constants } from "node:fs/promises";
import { createVoiceExtension } from "../extensions/voice.ts";
import { createPiHostHarness } from "../lib/lab/pi-host-harness.ts";
import { VoiceSession } from "../lib/voice-session.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import {
	createStubCaptureAdapter,
	createStubPlaybackAdapter,
	createStubSttAdapter,
	createStubTtsAdapter,
} from "../lib/adapters/stubs.ts";
import { deniedShortcutProbe } from "../lib/shortcut.ts";

test("2C.1: agent_settled alone has no message — tracker needs turn_end", () => {
	const tracker = new AgentReplyTracker();
	tracker.markVoiceSubmit("t1");
	const empty = tracker.consumeSettled({ aborted: false });
	assert.equal(empty.skipReason, "no_assistant_message");

	const t2 = new AgentReplyTracker();
	t2.markVoiceSubmit("t2");
	t2.onTurnEnd({
		type: "turn_end",
		outcome: "completed",
		message: { role: "assistant", content: [{ type: "text", text: "Dos más dos son cuatro." }] },
	});
	const plan = t2.consumeSettled({ aborted: false });
	assert.equal(plan.skipReason, undefined);
	assert.equal(plan.source, "turn_end");
	assert.match(JSON.stringify(plan.message), /cuatro/i);
});

test("2C.1: agent_end messages recover last assistant", () => {
	const tracker = new AgentReplyTracker();
	tracker.markVoiceSubmit("t");
	tracker.onAgentEnd({
		type: "agent_end",
		messages: [
			{ role: "user", content: [{ type: "text", text: "q" }] },
			{ role: "assistant", content: [{ type: "text", text: "4" }] },
		],
	});
	const plan = tracker.consumeSettled({ aborted: false });
	assert.equal(plan.source, "agent_end");
	assert.ok(plan.message);
});

test("2C.1: duplicate fingerprint skipped", () => {
	const tracker = new AgentReplyTracker();
	const msg = { role: "assistant" as const, content: [{ type: "text" as const, text: "same" }] };
	tracker.markVoiceSubmit("a");
	tracker.onTurnEnd({ message: msg });
	const first = tracker.consumeSettled({ aborted: false });
	assert.ok(!first.skipReason);
	tracker.markVoiceSubmit("b");
	tracker.onTurnEnd({ message: msg });
	const second = tracker.consumeSettled({ aborted: false });
	assert.equal(second.skipReason, "duplicate_fingerprint");
});

test("2C.1: session entries fallback", () => {
	const msg = asAssistantMessage({
		role: "assistant",
		content: [{ type: "text", text: "from entries" }],
	});
	assert.ok(msg);
	const found = lastAssistantFromSessionEntries([
		{ type: "message", message: { role: "user", content: [] } },
		{ type: "message", message: msg },
	]);
	assert.equal(fingerprintMessage(found), fingerprintMessage(msg));
});

test("2C.1: energy VAD ends after speech then hang silence", () => {
	const vad = createEnergyVad({
		speechThreshold: 0.05,
		silenceHangMs: 100,
		postRollMs: 50,
		maxIntraPauseMs: 30,
		sampleRateHz: 1_000,
		maxListenMs: 10_000,
	});
	// 50ms silence
	const silence = new Uint8Array(100); // 50 samples * 2
	assert.equal(vad.pushPcmS16le(silence), false);
	// speech burst
	const speech = new Uint8Array(200);
	const view = new DataView(speech.buffer);
	for (let i = 0; i < 100; i++) view.setInt16(i * 2, 10_000, true);
	assert.equal(vad.pushPcmS16le(speech), false);
	assert.equal(vad.state.speechSeen, true);
	// hang (100ms) + post-roll (50ms) → end
	const longSil = new Uint8Array(400); // 200ms at 1kHz
	assert.equal(vad.pushPcmS16le(longSil), true);
	assert.equal(vad.state.phase, "ended");
});

test("2C.1: filesystem probe finds lab whisper-cli under WD-Black", { skip: skipWithoutLab }, async () => {
	await access(LAB_WHISPER_CLI_CANDIDATE, constants.X_OK);
	const setup = await beginSetup({ probe: createFilesystemEngineProbe() });
	const whisper = setup.report.stt.find((e) => e.spec.id === "whisper-cpp");
	assert.ok(whisper);
	assert.equal(whisper.status, "compatible");
	assert.ok(
		whisper.path?.includes("whisper-cli") || whisper.path?.includes("ggml"),
	);
	assert.match(setup.report.message, /Whisper|Piper|ready|compatible/i);
	assert.ok(!/Whisper\.cpp missing/i.test(setup.report.message));
});

test("2C.1: harness turn_end + settled speaks (no tokens)", async () => {
	const harness = createPiHostHarness();
	const played: string[] = [];
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: {
				...DEFAULT_VOICE_CONFIG.behavior,
				mode: "conversation",
				autoSubmitTranscript: false,
			},
		},
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter(),
		tts: {
			id: "spy",
			async availability() {
				return { status: "ready" as const };
			},
			async synthesize(text) {
				played.push(text);
				return {
					audio: {
						bytes: new Uint8Array(4),
						sampleRateHz: 22_050,
						channels: 1,
						format: "raw",
					},
				};
			},
		},
		playback: createStubPlaybackAdapter({ durationMs: 1 }),
	});
	createVoiceExtension(harness.pi, {
		session,
		forceStubAdapters: true,
		shortcutProbe: deniedShortcutProbe(),
	});
	await session.submitPending("¿Cuánto es dos más dos?");
	harness.fire("turn_end", {
		type: "turn_end",
		outcome: "completed",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Dos más dos son cuatro." }],
		},
	});
	harness.fire("agent_settled", { type: "agent_settled", aborted: false });
	await session.flush();
	assert.ok(played.some((p) => /cuatro/i.test(p)));
	// P4 2D.3: spoken reply is not duplicated as a notify.
	assert.ok(!harness.notifies.some((n) => /🔊 Speaking:/i.test(n.message)));
});

test("2C.1: settled without turn_end → diag skip, no Piper", async () => {
	const harness = createPiHostHarness();
	const prev = process.env.GENTLE_VOICE_LAB;
	const prevDiag = process.env.GENTLE_VOICE_LAB_DIAG;
	process.env.GENTLE_VOICE_LAB = "1";
	process.env.GENTLE_VOICE_LAB_DIAG = "1"; // 2D.4: voice-diag only with explicit lab diag
	const played: string[] = [];
	try {
		const session = new VoiceSession({
			config: {
				...DEFAULT_VOICE_CONFIG,
				enabled: true,
				behavior: { ...DEFAULT_VOICE_CONFIG.behavior, mode: "conversation" },
			},
			capture: createStubCaptureAdapter(),
			stt: createStubSttAdapter(),
			tts: {
				id: "spy",
				async availability() {
					return { status: "ready" as const };
				},
				async synthesize(text) {
					played.push(text);
					return {
						audio: {
							bytes: new Uint8Array(4),
							sampleRateHz: 22_050,
							channels: 1,
							format: "raw",
						},
					};
				},
			},
			playback: createStubPlaybackAdapter({ durationMs: 1 }),
		});
		createVoiceExtension(harness.pi, {
			session,
			forceStubAdapters: true,
			shortcutProbe: deniedShortcutProbe(),
		});
		await session.submitPending("hola");
		harness.fire("agent_settled", { type: "agent_settled", aborted: false });
		await session.flush();
		assert.equal(played.length, 0);
		assert.ok(harness.notifies.some((n) => /skip=no_assistant_message/i.test(n.message)));
	} finally {
		if (prev === undefined) delete process.env.GENTLE_VOICE_LAB;
		else process.env.GENTLE_VOICE_LAB = prev;
		if (prevDiag === undefined) delete process.env.GENTLE_VOICE_LAB_DIAG;
		else process.env.GENTLE_VOICE_LAB_DIAG = prevDiag;
	}
});
