/**
 * Phase 2D.1 — hands-free conversation (lab): shortcut toggle, VAD auto-submit,
 * multi-turn re-listen, mute recovery, dictation isolation. No LLM tokens.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createVoiceExtension, labAutoSubmitOptIn, VOICE_WIDGET_KEY } from "../extensions/voice.ts";
import { createPiHostHarness } from "../lib/lab/pi-host-harness.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import { VoiceSession } from "../lib/voice-session.ts";
import {
	createStubCaptureAdapter,
	createStubPlaybackAdapter,
	createStubSttAdapter,
	createStubTtsAdapter,
} from "../lib/adapters/stubs.ts";
import { allowlistShortcutProbe, labShortcutProbeFromEnv } from "../lib/shortcut.ts";
import { PREFERRED_SHORTCUT } from "../lib/engines/contracts.ts";
import { createEnergyVad } from "../lib/vad/energy-vad.ts";
import { voiceWidgetContent, paintVoiceWidgetLines, createCompactVoiceLeaf } from "../lib/visual/compact-widget.ts";
import { VOICE_COMMAND } from "../lib/commands.ts";
import type { AudioChunk, CaptureAdapter, CaptureSession } from "../lib/contracts.ts";

function pcmChunk(samples: number, amp: number): Uint8Array {
	const out = new Uint8Array(samples * 2);
	const view = new DataView(out.buffer);
	for (let i = 0; i < samples; i++) {
		view.setInt16(i * 2, Math.floor(amp * 20000), true);
	}
	return out;
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
	const prev: Record<string, string | undefined> = {};
	for (const k of Object.keys(vars)) {
		prev[k] = process.env[k];
		const v = vars[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	return Promise.resolve(fn()).finally(() => {
		for (const k of Object.keys(vars)) {
			const v = prev[k];
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});
}

test("labAutoSubmitOptIn requires LAB + AUTO env", () => {
	assert.equal(labAutoSubmitOptIn({}), false);
	assert.equal(labAutoSubmitOptIn({ GENTLE_VOICE_LAB: "1" }), false);
	assert.equal(
		labAutoSubmitOptIn({ GENTLE_VOICE_LAB: "1", GENTLE_VOICE_LAB_AUTO_SUBMIT: "1" }),
		true,
	);
});

test("VAD: speech → pause → hang → post-roll before end; max listen", () => {
	const vad = createEnergyVad({
		sampleRateHz: 16_000,
		speechThreshold: 0.01,
		maxIntraPauseMs: 50,
		silenceHangMs: 100,
		postRollMs: 50,
		maxListenMs: 5_000,
	});
	// 100ms speech
	assert.equal(vad.pushPcmS16le(pcmChunk(1600, 0.3)), false);
	// 40ms pause (intra)
	assert.equal(vad.pushPcmS16le(pcmChunk(640, 0)), false);
	// more speech
	assert.equal(vad.pushPcmS16le(pcmChunk(800, 0.3)), false);
	// hang 100ms silence
	assert.equal(vad.pushPcmS16le(pcmChunk(1600, 0)), false);
	// post-roll 50ms
	assert.equal(vad.pushPcmS16le(pcmChunk(800, 0)), true);
});

test("compact widget factory: no full-width pad; theme paint keeps roles", () => {
	const factory = voiceWidgetContent(
		["🎙 Gentle Voice │ READY │ 🔊 ON", "▁ ▄ █"],
		"READY",
	);
	assert.equal(typeof factory, "function");
	const theme = {
		fg: (c: string, t: string) => `{${c}}${t}`,
		bold: (t: string) => `*${t}*`,
	};
	const leaf = (factory as Function)({}, theme) as { render: (w: number) => string[] };
	const lines = leaf.render(200);
	assert.equal(lines.length, 2);
	assert.ok(lines[0]!.length < 120, "must not pad to 200 cols");
	assert.match(lines[0]!, /\{muted\}|\{accent\}|READY/);
	const plain = createCompactVoiceLeaf(paintVoiceWidgetLines(["hi"], "LISTENING"));
	assert.deepEqual(plain.render(999), ["hi"]);
});

test("shortcut first press (lab): enables fluent conversation + listen", async () => {
	await withEnv({
		GENTLE_VOICE_LAB: "1",
		GENTLE_VOICE_LAB_SHORTCUT: "1",
		GENTLE_VOICE_SHORTCUT_VERIFIED: "1",
		GENTLE_VOICE_LAB_AUTO_SUBMIT: "1",
	}, async () => {
		const harness = createPiHostHarness();
		let submits = 0;
		harness.pi.sendUserMessage = () => {
			submits += 1;
		};
		const session = createVoiceExtension(harness.pi, {
			config: {
				...DEFAULT_VOICE_CONFIG,
				enabled: false,
				behavior: {
					...DEFAULT_VOICE_CONFIG.behavior,
					mode: "conversation",
					autoSubmitTranscript: false,
					fluentConversation: false,
					echoSettleMs: 0,
				},
			},
			shortcutProbe: labShortcutProbeFromEnv(),
			forceStubAdapters: true,
			session: undefined,
		});
		// Re-create with stubs that return speech — need custom session
		void session;
		const captureAudio: AudioChunk = {
			bytes: new Uint8Array(64),
			sampleRateHz: 16_000,
			channels: 1,
			format: "pcm_s16le",
		};
		const owned = new VoiceSession({
			config: {
				...DEFAULT_VOICE_CONFIG,
				enabled: false,
				behavior: {
					...DEFAULT_VOICE_CONFIG.behavior,
					echoSettleMs: 0,
					autoSubmitTranscript: false,
					fluentConversation: false,
				},
			},
			capture: createStubCaptureAdapter({ audio: captureAudio }),
			stt: createStubSttAdapter({ text: "hola" }),
			tts: createStubTtsAdapter({
				audio: {
					bytes: new Uint8Array([1, 0, 2, 0]),
					sampleRateHz: 24_000,
					channels: 1,
					format: "pcm_s16le",
				},
			}),
			playback: createStubPlaybackAdapter({ durationMs: 5 }),
			submitTranscript: () => {
				submits += 1;
			},
		});
		const harness2 = createPiHostHarness();
		harness2.pi.sendUserMessage = () => {
			submits += 1;
		};
		createVoiceExtension(harness2.pi, {
			config: owned.config,
			session: owned,
			shortcutProbe: allowlistShortcutProbe([PREFERRED_SHORTCUT]),
			forceStubAdapters: true,
		});
		// maybeRegisterVoiceShortcut is async (void) — wait one tick.
		await new Promise((r) => setImmediate(r));
		assert.ok(harness2.shortcuts.has(PREFERRED_SHORTCUT));
		await harness2.shortcuts.get(PREFERRED_SHORTCUT)!(harness2.ctx);
		await owned.flush();
		assert.equal(owned.state.enabled, true);
		assert.equal(owned.config.behavior.fluentConversation, true);
		assert.equal(owned.config.behavior.autoSubmitTranscript, true);
		assert.equal(owned.config.behavior.mode, "conversation");
		assert.equal(owned.state.phase, "listening");

		// Second press ends session (does not merely finish utterance).
		await harness2.shortcuts.get(PREFERRED_SHORTCUT)!(harness2.ctx);
		await owned.flush();
		assert.equal(owned.config.behavior.fluentConversation, false);
		assert.equal(owned.state.phase, "idle");
		owned.dispose();
	});
});

test("fluent auto-submit + two turns + re-listen after speak", async () => {
	let submits = 0;
	const texts: string[] = [];
	let listenStarts = 0;
	const capture: CaptureAdapter = {
		id: "count-capture",
		async availability() {
			return { status: "ready" };
		},
		async start() {
			listenStarts += 1;
			const session: CaptureSession = {
				id: `c-${listenStarts}`,
				async stop() {
					return {
						bytes: new Uint8Array(32),
						sampleRateHz: 16_000,
						channels: 1,
						format: "pcm_s16le",
					};
				},
			};
			return session;
		},
	};
	const sttTexts = ["uno", "dos"];
	let sttI = 0;
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: {
				...DEFAULT_VOICE_CONFIG.behavior,
				mode: "conversation",
				fluentConversation: true,
				autoSubmitTranscript: true,
				echoSettleMs: 0,
				muted: false,
			},
		},
		capture,
		stt: {
			id: "seq-stt",
			async availability() {
				return { status: "ready" };
			},
			async transcribe() {
				const text = sttTexts[sttI++] ?? "x";
				return { text };
			},
		},
		tts: createStubTtsAdapter({
			audio: {
				bytes: new Uint8Array([1, 0]),
				sampleRateHz: 24_000,
				channels: 1,
				format: "pcm_s16le",
			},
		}),
		playback: createStubPlaybackAdapter({ durationMs: 10 }),
		submitTranscript: (t) => {
			submits += 1;
			texts.push(t);
		},
		onSpeakFinished: () => {
			session.scheduleFluentRelisten();
		},
	});

	session.dispatch({ type: "LISTEN" });
	await session.flush();
	assert.equal(listenStarts, 1);
	await session.finishListen();
	await session.flush();
	assert.equal(submits, 1);
	assert.equal(texts[0], "uno");
	assert.equal(session.state.phase, "awaiting_agent");

	session.onAgentSettled({
		message: { role: "assistant", content: [{ type: "text", text: "ok uno." }] },
		outcome: "completed",
	});
	await session.flush();
	// After speak + settle delay 0 → listening again
	await new Promise((r) => setTimeout(r, 20));
	await session.flush();
	assert.ok(listenStarts >= 2, `expected re-listen, got ${listenStarts}`);

	await session.finishListen();
	await session.flush();
	assert.equal(submits, 2);
	assert.equal(texts[1], "dos");
	session.dispose();
});

test("duplicate transcript prevented while submit open", async () => {
	let submits = 0;
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: {
				...DEFAULT_VOICE_CONFIG.behavior,
				mode: "conversation",
				fluentConversation: true,
				autoSubmitTranscript: true,
				echoSettleMs: 0,
			},
		},
		capture: createStubCaptureAdapter({
			audio: {
				bytes: new Uint8Array(16),
				sampleRateHz: 16_000,
				channels: 1,
				format: "pcm_s16le",
			},
		}),
		stt: createStubSttAdapter({ text: "same" }),
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter(),
		submitTranscript: () => {
			submits += 1;
		},
	});
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	await session.finishListen();
	await session.flush();
	assert.equal(submits, 1);
	assert.equal(session.state.phase, "awaiting_agent");
	// Second identical finish while still awaiting should not double-send via finishListen
	// (phase not listening). Explicitly try submitPending duplicate:
	const r = await session.submitPending("same");
	assert.ok(r === "busy" || r === "duplicate");
	assert.equal(submits, 1);
	session.dispose();
});

test("mic not capturing during TTS (echo guard) + mute still re-listens", async () => {
	let listenStarts = 0;
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: {
				...DEFAULT_VOICE_CONFIG.behavior,
				mode: "conversation",
				fluentConversation: true,
				autoSubmitTranscript: true,
				echoSettleMs: 0,
				muted: true,
			},
		},
		capture: {
			id: "c",
			async availability() {
				return { status: "ready" };
			},
			async start() {
				listenStarts += 1;
				if (session.state.phase === "speaking") {
					throw new Error("echo: capture during speak");
				}
				return {
					id: "s",
					async stop() {
						return {
							bytes: new Uint8Array(8),
							sampleRateHz: 16_000,
							channels: 1,
							format: "pcm_s16le",
						};
					},
				};
			},
		},
		stt: createStubSttAdapter({ text: "hola" }),
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter(),
		submitTranscript: () => {},
		onSpeakFinished: () => session.scheduleFluentRelisten(),
	});
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	await session.finishListen();
	await session.flush();
	session.onAgentSettled({
		message: { role: "assistant", content: [{ type: "text", text: "respuesta." }] },
		outcome: "completed",
	});
	await session.flush();
	await new Promise((r) => setTimeout(r, 20));
	await session.flush();
	assert.ok(listenStarts >= 2, "muted fluent still re-opens mic");
	session.dispose();
});

test("dictation never auto-submits", async () => {
	let submits = 0;
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: {
				...DEFAULT_VOICE_CONFIG.behavior,
				mode: "dictation",
				autoSubmitTranscript: true, // even if mis-set
				fluentConversation: false,
			},
		},
		capture: createStubCaptureAdapter({
			audio: {
				bytes: new Uint8Array(16),
				sampleRateHz: 16_000,
				channels: 1,
				format: "pcm_s16le",
			},
		}),
		stt: createStubSttAdapter({ text: "dictado" }),
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter(),
		submitTranscript: () => {
			submits += 1;
		},
		presentTranscript: () => {},
	});
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	await session.finishListen();
	await session.flush();
	assert.equal(submits, 0);
	assert.equal(session.pendingReviewText, "dictado");
	assert.equal(session.state.phase, "idle");
	session.dispose();
});

test("TTS error recovers fluent re-listen", async () => {
	let listenStarts = 0;
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: {
				...DEFAULT_VOICE_CONFIG.behavior,
				mode: "conversation",
				fluentConversation: true,
				autoSubmitTranscript: true,
				echoSettleMs: 0,
			},
		},
		capture: {
			id: "c",
			async availability() {
				return { status: "ready" };
			},
			async start() {
				listenStarts += 1;
				return {
					id: "s",
					async stop() {
						return {
							bytes: new Uint8Array(8),
							sampleRateHz: 16_000,
							channels: 1,
							format: "pcm_s16le",
						};
					},
				};
			},
		},
		stt: createStubSttAdapter({ text: "hola" }),
		tts: {
			id: "bad-tts",
			async availability() {
				return { status: "ready" };
			},
			async synthesize() {
				throw new Error("tts_boom");
			},
		},
		playback: createStubPlaybackAdapter(),
		submitTranscript: () => {},
		onSpeakFinished: () => session.scheduleFluentRelisten(),
		notify: () => {},
	});
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	await session.finishListen();
	await session.flush();
	session.onAgentSettled({
		message: { role: "assistant", content: [{ type: "text", text: "hola de vuelta." }] },
		outcome: "completed",
	});
	await session.flush();
	await new Promise((r) => setTimeout(r, 30));
	await session.flush();
	assert.ok(listenStarts >= 2, "recover after TTS error");
	assert.notEqual(session.state.phase, "speaking");
	session.dispose();
});

test("harness converse on|off + widget factory renders", async () => {
	await withEnv({ GENTLE_VOICE_LAB: "1", GENTLE_VOICE_LAB_AUTO_SUBMIT: "1" }, async () => {
		const harness = createPiHostHarness();
		createVoiceExtension(harness.pi, {
			config: {
				...DEFAULT_VOICE_CONFIG,
				enabled: false,
				behavior: { ...DEFAULT_VOICE_CONFIG.behavior, echoSettleMs: 0 },
			},
			shortcutProbe: allowlistShortcutProbe([]),
			forceStubAdapters: true,
		});
		await harness.runCommand(VOICE_COMMAND, "converse on");
		const w = harness.widgets.filter((x) => x.key === VOICE_WIDGET_KEY).at(-1);
		assert.ok(w?.content?.[0]?.includes("LISTENING") || w?.content?.[0]?.includes("READY"));
		await harness.runCommand(VOICE_COMMAND, "converse off");
	});
});
