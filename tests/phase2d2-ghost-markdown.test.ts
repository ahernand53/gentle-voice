/**
 * Phase 2D.2 — ghost transcript gates, Markdown→TTS, silence harness, ElevenLabs design.
 * No LLM tokens. No ElevenLabs network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_WHISPER_INITIAL_PROMPT,
	applySttCorrections,
} from "../lib/stt/corrections.ts";
import {
	gateUtteranceForAutoSubmit,
	isLikelyWhisperPromptEcho,
} from "../lib/stt/utterance-gate.ts";
import { markdownToSpeakable } from "../lib/tts/markdown-for-tts.ts";
import { normalizeForTts } from "../lib/tts/normalize-for-tts.ts";
import { buildFinalUtterance } from "../lib/final-utterance.ts";
import {
	DEFAULT_ELEVENLABS_QUOTA,
	elevenLabsDesignNotes,
	wouldExceedBudget,
} from "../lib/tts/elevenlabs-design.ts";
import { VoiceSession } from "../lib/voice-session.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import {
	createStubCaptureAdapter,
	createStubPlaybackAdapter,
	createStubSttAdapter,
	createStubTtsAdapter,
} from "../lib/adapters/stubs.ts";
import type { AudioChunk, CaptureAdapter, CaptureSession } from "../lib/contracts.ts";

test("P0 evidence: old ghost phrase echoes tech-list prompt pattern", () => {
	const oldPrompt = "Gentle Voice, Gentle Shell, C#, Angular, PostgreSQL.";
	assert.equal(isLikelyWhisperPromptEcho("C#, Angular, PostgreSQL", oldPrompt), true);
	assert.equal(isLikelyWhisperPromptEcho("hola cómo estás", oldPrompt), false);
});

test("P0: current prompt no longer embeds C#/Angular/PostgreSQL list", () => {
	assert.match(DEFAULT_WHISPER_INITIAL_PROMPT, /Gentle Voice/);
	assert.doesNotMatch(DEFAULT_WHISPER_INITIAL_PROMPT, /Angular/);
	assert.doesNotMatch(DEFAULT_WHISPER_INITIAL_PROMPT, /PostgreSQL/);
	// Post-corrections still fix spoken mishears of stack names
	const c = applySttCorrections("usa C Sharp y Postgres SQL");
	assert.match(c.corrected, /C#/);
	assert.match(c.corrected, /PostgreSQL/);
});

test("P0 gate: no_speech_seen / prompt_echo / rms reject; real speech ok", () => {
	const metaBase = {
		captureId: "pw-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		speechSeen: true,
		endReason: "vad" as const,
		durationMs: 1200,
		peakRms: 0.08,
		meanRms: 0.02,
	};
	assert.equal(
		gateUtteranceForAutoSubmit({
			text: "hola",
			captureMeta: { ...metaBase, speechSeen: false },
		}).accept,
		false,
	);
	assert.equal(
		gateUtteranceForAutoSubmit({
			text: "Gentle Voice Gentle Shell",
			captureMeta: metaBase,
			whisperPrompt: DEFAULT_WHISPER_INITIAL_PROMPT,
		}).reason,
		"prompt_echo",
	);
	assert.equal(
		gateUtteranceForAutoSubmit({
			text: "hola discord",
			captureMeta: metaBase,
		}).accept,
		true,
	);
	assert.equal(
		gateUtteranceForAutoSubmit({
			text: "hola",
			captureMeta: { ...metaBase, meanRms: 0.0001, peakRms: 0.0001 },
		}).accept,
		false,
	);
});

test("P0 session: silence meta skips Whisper and sends zero messages", async () => {
	let sttCalls = 0;
	let submits = 0;
	const capture: CaptureAdapter = {
		id: "silence-cap",
		async availability() {
			return { status: "ready" };
		},
		async start() {
			const session: CaptureSession = {
				id: "cap-1",
				async stop() {
					const audio: AudioChunk = {
						bytes: new Uint8Array(128),
						sampleRateHz: 16_000,
						channels: 1,
						format: "wav",
						captureMeta: {
							captureId: "pw-silent-0001",
							speechSeen: false,
							endReason: "max",
							durationMs: 5000,
							peakRms: 0.001,
							meanRms: 0.0004,
						},
					};
					return audio;
				},
			};
			return session;
		},
	};
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
		capture,
		stt: {
			id: "count-stt",
			async availability() {
				return { status: "ready" };
			},
			async transcribe() {
				sttCalls += 1;
				return { text: "C#, Angular, PostgreSQL" };
			},
		},
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
	assert.equal(sttCalls, 0, "must not call Whisper without speechSeen");
	assert.equal(submits, 0, "silence must not auto-submit");
	assert.match(session.lastLabDiag, /no_speech_seen/);
	session.dispose();
});

test("P0 session: prompt-echo text with speech meta still blocked from auto-send", async () => {
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
		capture: {
			id: "c",
			async availability() {
				return { status: "ready" };
			},
			async start() {
				return {
					id: "s",
					async stop() {
						return {
							bytes: new Uint8Array(64),
							sampleRateHz: 16_000,
							channels: 1,
							format: "wav",
							captureMeta: {
								captureId: "pw-echo-1",
								speechSeen: true,
								endReason: "vad",
								durationMs: 900,
								peakRms: 0.05,
								meanRms: 0.02,
							},
						};
					},
				};
			},
		},
		stt: createStubSttAdapter({ text: "Gentle Voice. Gentle Shell." }),
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter(),
		submitTranscript: () => {
			submits += 1;
		},
		whisperInitialPrompt: DEFAULT_WHISPER_INITIAL_PROMPT,
		notify: () => {},
	});
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	await session.finishListen();
	await session.flush();
	assert.equal(submits, 0);
	assert.match(session.lastLabDiag, /prompt_echo/);
	session.dispose();
});

test("P0 harness: valid → silence → valid = exactly 2 submits, no ghost", async () => {
	let submits = 0;
	const texts: string[] = [];
	let round = 0;
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
			id: "seq",
			async availability() {
				return { status: "ready" };
			},
			async start() {
				const n = ++round;
				return {
					id: `s-${n}`,
					async stop() {
						if (n === 2) {
							// silence between turns
							return {
								bytes: new Uint8Array(64),
								sampleRateHz: 16_000,
								channels: 1,
								format: "wav",
								captureMeta: {
									captureId: `pw-sil-${n}`,
									speechSeen: false,
									endReason: "max",
									durationMs: 3000,
									peakRms: 0.001,
									meanRms: 0.0003,
								},
							};
						}
						return {
							bytes: new Uint8Array(64),
							sampleRateHz: 16_000,
							channels: 1,
							format: "wav",
							captureMeta: {
								captureId: `pw-ok-${n}`,
								speechSeen: true,
								endReason: "vad",
								durationMs: 1100,
								peakRms: 0.1,
								meanRms: 0.03,
							},
						};
					},
				};
			},
		},
		stt: {
			id: "stt",
			async availability() {
				return { status: "ready" };
			},
			async transcribe() {
				return { text: round === 1 ? "pregunta uno" : "pregunta dos" };
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
		playback: createStubPlaybackAdapter({ durationMs: 5 }),
		submitTranscript: (t) => {
			submits += 1;
			texts.push(t);
		},
		onSpeakFinished: () => session.scheduleFluentRelisten(),
	});

	session.dispatch({ type: "LISTEN" });
	await session.flush();
	await session.finishListen();
	await session.flush();
	assert.equal(submits, 1);
	assert.equal(texts[0], "pregunta uno");

	session.onAgentSettled({
		message: { role: "assistant", content: [{ type: "text", text: "ok." }] },
		outcome: "completed",
	});
	await session.flush();
	await new Promise((r) => setTimeout(r, 25));
	await session.flush();

	// silence listen
	await session.finishListen();
	await session.flush();
	assert.equal(submits, 1, "silence must not add submit");

	await new Promise((r) => setTimeout(r, 25));
	await session.flush();
	await session.finishListen();
	await session.flush();
	assert.equal(submits, 2);
	assert.equal(texts[1], "pregunta dos");
	assert.ok(!texts.includes("C#, Angular, PostgreSQL"));
	session.dispose();
});

test("P1 Markdown stripped for spoken path; C# preserved", () => {
	const md = [
		"## Resumen",
		"",
		"Usa **C#** y `Angular` con [PostgreSQL](https://postgresql.org).",
		"",
		"- item uno",
		"- item dos",
		"",
		"```ts",
		"const x = 1;",
		"```",
		"",
		"Listo.",
	].join("\n");
	const spoken = markdownToSpeakable(md);
	assert.doesNotMatch(spoken, /\*\*/);
	assert.doesNotMatch(spoken, /```/);
	assert.doesNotMatch(spoken, /\[PostgreSQL\]/);
	assert.match(spoken, /C#/);
	assert.match(spoken, /Angular/);
	assert.match(spoken, /PostgreSQL/);
	assert.match(spoken, /bloque de código/i);

	const utt = buildFinalUtterance({
		message: {
			role: "assistant",
			content: [{ type: "text", text: "La respuesta es **2 + 2 = 4**." }],
		},
		outcome: "completed",
	});
	assert.equal(utt.speak, true);
	assert.doesNotMatch(utt.text, /\*\*/);
	assert.match(normalizeForTts(utt.text), /dos/i);
});

test("P3 ElevenLabs design only — no network, budget math", () => {
	const notes = elevenLabsDesignNotes();
	assert.equal(notes.status, "not_installed");
	assert.equal(notes.apiNotMcpPerReply, true);
	assert.equal(notes.freeTierCreditsPerMonth, 10_000);
	assert.equal(wouldExceedBudget(9_500, 600, DEFAULT_ELEVENLABS_QUOTA.monthlyCharBudget), true);
	assert.equal(wouldExceedBudget(100, 50, DEFAULT_ELEVENLABS_QUOTA.monthlyCharBudget), false);
});
