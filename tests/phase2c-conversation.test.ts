/**
 * Phase 2C — review/send, agent final utterance, mute mid-run, no LLM tokens in suite.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createStubCaptureAdapter,
	createStubPlaybackAdapter,
	createStubSttAdapter,
	createStubTtsAdapter,
} from "../lib/adapters/stubs.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import { VoiceSession } from "../lib/voice-session.ts";
import { buildFinalUtterance } from "../lib/final-utterance.ts";
import { normalizeAgentSettledEvent } from "../lib/agent-settled.ts";
import { parseVoiceArgs } from "../lib/commands.ts";
import { createVoiceExtension } from "../extensions/voice.ts";
import type { VoiceHostApi } from "../lib/contracts.ts";
import { deniedShortcutProbe } from "../lib/shortcut.ts";
import { createPiHostHarness } from "../lib/lab/pi-host-harness.ts";

function baseSession(opts?: {
	sttText?: string;
	autoSubmit?: boolean;
	muted?: boolean;
	playDurationMs?: number;
	ttsLatencyMs?: number;
}) {
	const submitted: string[] = [];
	const notes: string[] = [];
	const played: string[] = [];
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: {
				...DEFAULT_VOICE_CONFIG.behavior,
				mode: "conversation",
				autoSubmitTranscript: opts?.autoSubmit ?? false,
				muted: opts?.muted ?? false,
			},
		},
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter({ text: opts?.sttText ?? "hola agente" }),
		tts: {
			id: "spy-tts",
			async availability() {
				return { status: "ready" as const };
			},
			async synthesize(text, { signal }) {
				if (opts?.ttsLatencyMs) {
					await new Promise((r, j) => {
						const t = setTimeout(r, opts.ttsLatencyMs);
						signal.addEventListener("abort", () => {
							clearTimeout(t);
							j(Object.assign(new Error("Aborted"), { name: "AbortError" }));
						}, { once: true });
					});
				}
				played.push(text);
				return {
					audio: {
						bytes: new Uint8Array(8),
						sampleRateHz: 22_050,
						channels: 1 as const,
						format: "raw" as const,
					},
				};
			},
		},
		playback: createStubPlaybackAdapter({ durationMs: opts?.playDurationMs ?? 1 }),
		submitTranscript: (t) => submitted.push(t),
		presentTranscript: (t) => notes.push(`present:${t}`),
		notify: (m) => notes.push(m),
	});
	return { session, submitted, notes, played };
}

test("2C: review keeps draft; draft edit; explicit send once", async () => {
	const { session, submitted, notes } = baseSession({ sttText: "pregunta simple" });
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	await session.finishListen();
	await session.flush();
	assert.deepEqual(submitted, []);
	assert.equal(session.pendingReviewText, "pregunta simple");
	assert.ok(notes.some((n) => n.includes("present:")));

	session.setReviewDraft("pregunta simple corregida");
	assert.equal(session.pendingReviewText, "pregunta simple corregida");

	const first = await session.submitPending();
	assert.equal(first, "sent");
	assert.deepEqual(submitted, ["pregunta simple corregida"]);
	assert.equal(session.state.phase, "awaiting_agent");

	const dup = await session.submitPending("pregunta simple corregida");
	assert.equal(dup, "duplicate");
	assert.equal(submitted.length, 1);
});

test("2C: empty send rejected; empty STT does not submit", async () => {
	const { session, submitted } = baseSession({ sttText: "   " });
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	await session.finishListen();
	await session.flush();
	assert.deepEqual(submitted, []);
	assert.equal(await session.submitPending(), "empty");
});

test("2C: agent final text spoken; thinking/tools suppressed", async () => {
	const { session, played } = baseSession();
	await session.submitPending("hola");
	const decision = session.onAgentSettled({
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "plan secreto" },
				{ type: "toolCall", name: "bash" },
				{ type: "text", text: "In summary, two plus two is four." },
			],
		},
		outcome: "completed",
	});
	await session.flush();
	assert.equal(decision.speak, true);
	assert.match(decision.text, /summary|four/i);
	assert.ok(!/plan secreto|bash/i.test(decision.text));
	assert.equal(played.length, 1);
});

test("2C: aborted agent stays silent; error does not claim success", async () => {
	const { session, played } = baseSession();
	await session.submitPending("x");
	const aborted = session.onAgentSettled({
		message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
		outcome: "aborted",
	});
	assert.equal(aborted.speak, false);
	assert.equal(played.length, 0);

	await session.submitPending("y");
	const err = session.onAgentSettled({
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Warning: the request failed." }],
		},
		outcome: "error",
	});
	await session.flush();
	assert.equal(err.speak, true);
	assert.match(err.text, /Warning|failed/i);
	assert.ok(!/^Done\.?$/i.test(err.text.trim()));
});

test("2C: mute during agent run blocks TTS; STT draft still works", async () => {
	const { session, played } = baseSession();
	session.dispatch({ type: "LISTEN" });
	await session.finishListen();
	await session.flush();
	assert.ok(session.pendingReviewText);

	session.dispatch({ type: "MUTE" });
	await session.submitPending();
	const decision = session.onAgentSettled({
		message: { role: "assistant", content: [{ type: "text", text: "In summary, ok." }] },
		outcome: "completed",
	});
	await session.flush();
	assert.equal(decision.speak, false);
	assert.equal(played.length, 0);
});

test("2C: consecutive sessions — newer speakDirect wins; no duplicate pending audio", async () => {
	const { session, played } = baseSession({ playDurationMs: 30, ttsLatencyMs: 60 });
	const first = session.speakDirect("Obsolete conclusion that should be cancelled.");
	await new Promise((r) => setTimeout(r, 15));
	const second = session.speakDirect("Second conclusion wins.");
	await first;
	await second;
	assert.ok(played.length >= 1);
	assert.equal(played[played.length - 1], "Second conclusion wins.");
});

test("2C: unfaithful long code dump → write-only, no speak", () => {
	const code = `${"```\n"}${"x = 1\n".repeat(80)}${"```\n"}`.repeat(2);
	const result = buildFinalUtterance({
		message: { role: "assistant", content: [{ type: "text", text: code }] },
		outcome: "completed",
		maxSentences: 2,
		maxChars: 200,
	});
	assert.equal(result.speak, false);
	assert.equal(result.reason, "unfaithful_skip_show_full");
	assert.ok(result.text.length > 200);
});

test("2C: normalize agent_settled payloads", () => {
	const a = normalizeAgentSettledEvent({
		aborted: false,
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "text", text: "hola" }] },
		],
	});
	assert.equal(a.outcome, "completed");
	assert.equal(extractText(a.message), "hola");

	const b = normalizeAgentSettledEvent({ aborted: true, message: { role: "assistant", content: [] } });
	assert.equal(b.outcome, "aborted");
});

function extractText(message: { content?: readonly { type: string; text?: string }[] } | null): string {
	if (!message?.content) return "";
	return message.content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
}

test("2C: parseVoiceArgs send/draft; extension send does not double-fire", async () => {
	assert.equal(parseVoiceArgs("send").command, "send");
	assert.equal(parseVoiceArgs("draft hola").command, "draft");
	assert.equal(parseVoiceArgs("draft hola").rest, "hola");

	const submitted: string[] = [];
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: { ...DEFAULT_VOICE_CONFIG.behavior, autoSubmitTranscript: false },
		},
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter({ text: "ping" }),
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter({ durationMs: 1 }),
		submitTranscript: (t) => submitted.push(t),
	});
	session.setReviewDraft("ping");
	const pi: VoiceHostApi = {
		registerCommand(_n, opts) {
			(pi as { _h?: typeof opts.handler })._h = opts.handler;
		},
		sendUserMessage(content) {
			submitted.push(`pi:${content}`);
		},
	};
	createVoiceExtension(pi, {
		session,
		forceStubAdapters: true,
		shortcutProbe: deniedShortcutProbe(),
	});
	// Wire submit to pi like the real extension does after create
	session.deps.submitTranscript = async (text) => {
		pi.sendUserMessage?.(text);
	};
	const handler = (pi as { _h?: (a: string, c: never) => Promise<void> })._h!;
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: { notify() {}, setStatus() {}, setWidget() {} },
		isIdle: () => true,
	} as never;
	await handler("send", ctx);
	assert.deepEqual(submitted, ["pi:ping"]);
	await handler("send", ctx);
	assert.equal(submitted.length, 1);
});

test("2C: harness agent_settled with message speaks without tokens", async () => {
	const harness = createPiHostHarness();
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
		tts: createStubTtsAdapter({
			audio: {
				bytes: new Uint8Array(4),
				sampleRateHz: 22_050,
				channels: 1,
				format: "raw",
			},
		}),
		playback: createStubPlaybackAdapter({ durationMs: 1 }),
	});
	createVoiceExtension(harness.pi, {
		session,
		forceStubAdapters: true,
		shortcutProbe: deniedShortcutProbe(),
	});
	await session.submitPending("test");
	harness.fire("turn_end", {
		type: "turn_end",
		outcome: "completed",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "In summary, all good." }],
		},
	});
	harness.fire("agent_settled", { type: "agent_settled", aborted: false });
	await session.flush();
	assert.equal(session.state.phase, "idle");
	// P4 2D.3: no duplicate "Speaking:" notify — widget only.
	assert.ok(!harness.notifies.some((n) => /🔊 Speaking:/i.test(n.message)));
});

test("2C: isolation — shortcut remains fail-closed by default", async () => {
	const harness = createPiHostHarness();
	createVoiceExtension(harness.pi, {
		forceStubAdapters: true,
		shortcutProbe: deniedShortcutProbe(),
	});
	assert.equal(harness.shortcuts.size, 0);
});
