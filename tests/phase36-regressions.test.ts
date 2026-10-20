/**
 * Phase 3.6 synthetic regressions — not real-audio ground truth.
 * Covers renderer, gates, Esc/history, cancel paths, multi-turn stubs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderForSpeech } from "../lib/tts/speech-renderer.ts";
import { SentenceAssembler } from "../lib/tts/sentence-assembler.ts";
import { gateUtteranceForAutoSubmit } from "../lib/stt/utterance-gate.ts";
import {
	createEditorHistoryBinding,
	isLoneEscape,
	restorePromptAfterVoiceEscape,
} from "../lib/editor-history.ts";
import { AbortError, ignoreUnhandledAbort, isAbortError } from "../lib/process-cancel.ts";
import { VoiceSession } from "../lib/voice-session.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import {
	createStubCaptureAdapter,
	createStubPlaybackAdapter,
	createStubSttAdapter,
	createStubTtsAdapter,
} from "../lib/adapters/stubs.ts";
import type { CaptureSegmentMeta, VoiceHostCommandContext } from "../lib/contracts.ts";

function meta(partial: Partial<CaptureSegmentMeta> & Pick<CaptureSegmentMeta, "captureId">): CaptureSegmentMeta {
	return {
		speechSeen: true,
		endReason: "vad",
		durationMs: 600,
		peakRms: 0.05,
		meanRms: 0.02,
		...partial,
	};
}

test("3.6 regression: renderer returns written unchanged; spoken separate", () => {
	const written = "Estoy en `/home/erickfm/proj` y **npm test** ver https://example.com/x.";
	const result = renderForSpeech(written, { mode: "natural", cwd: "/other" });
	assert.equal(result.written, written);
	assert.notEqual(result.spoken, written);
	assert.ok(!result.spoken.includes("`"));
	assert.ok(!/barra/i.test(result.spoken));
});

test("3.6 regression: markdown stripped for speech only", () => {
	const written = "Usa **negrita** y `código` en /tmp/x.";
	const { spoken, written: w } = renderForSpeech(written, { mode: "natural", cwd: "/home" });
	assert.equal(w, written);
	assert.ok(!spoken.includes("**"));
	assert.ok(!spoken.includes("`"));
});

test("3.6 regression: low-RMS / empty / prompt-echo blocked (no ghost submit)", () => {
	assert.equal(
		gateUtteranceForAutoSubmit({ text: "", captureMeta: undefined }).reason,
		"empty_text",
	);
	assert.equal(
		gateUtteranceForAutoSubmit({
			text: "hola",
			captureMeta: meta({
				captureId: "c1",
				peakRms: 0.001,
				meanRms: 0.0005,
			}),
		}).accept,
		false,
	);
	const echo = gateUtteranceForAutoSubmit({
		text: "Gentle Voice Gentle Shell",
		captureMeta: meta({ captureId: "c2" }),
	});
	assert.equal(echo.accept, false);
	assert.equal(echo.reason, "prompt_echo");
});

test("3.6 regression: low volume above gate threshold can accept (synthetic)", () => {
	const soft = gateUtteranceForAutoSubmit({
		text: "hola mundo suave",
		captureMeta: meta({
			captureId: "c3",
			peakRms: 0.015,
			meanRms: 0.005,
		}),
	});
	assert.equal(soft.accept, true);
});

test("3.6 regression: streaming assembler applies speechMode per chunk", () => {
	const asm = new SentenceAssembler({
		speechMode: "natural",
		cwd: "/mnt/lab",
		minSentencesPerUnit: 1,
		minCharsPerUnit: 1,
	});
	const units = [
		...asm.pushDelta("Estoy en /mnt/lab ahora. "),
		...asm.flush(),
	];
	assert.ok(units.length >= 1);
	assert.ok(units.every((u) => !u.speakable.includes("/mnt")));
	assert.ok(units.some((u) => /directorio de trabajo/i.test(u.speakable)));
});

test("3.6 regression: Esc key vs ArrowUp CSI", () => {
	assert.equal(isLoneEscape("\x1b"), true);
	assert.equal(isLoneEscape("\x1b[A"), false);
});

test("3.6 regression: Esc restore recovers last voice line into empty editor", () => {
	let editor = "";
	const ctx = {
		ui: {
			notify() {},
			setEditorText(t: string) {
				editor = t;
			},
			getEditorText() {
				return editor;
			},
		},
	} as VoiceHostCommandContext;
	assert.equal(restorePromptAfterVoiceEscape(ctx, ["frase recuperada"]), true);
	assert.equal(editor, "frase recuperada");
});

test("3.6 regression: voice history push for Up-arrow path", () => {
	const hist: string[] = [];
	const binding = createEditorHistoryBinding();
	binding.tryBind({
		ui: {
			notify() {},
			addToHistory(t: string) {
				hist.unshift(t);
			},
		},
	} as VoiceHostCommandContext);
	assert.equal(binding.push("turno uno"), true);
	assert.deepEqual(hist, ["turno uno"]);
});

test("3.6 regression: cancel during speak then resume listen without AbortError", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (r: unknown) => unhandled.push(r);
	process.on("unhandledRejection", onUnhandled);
	try {
		const session = new VoiceSession({
			config: {
				...DEFAULT_VOICE_CONFIG,
				enabled: true,
				behavior: {
					...DEFAULT_VOICE_CONFIG.behavior,
					fluentConversation: true,
					autoSubmitTranscript: true,
					echoSettleMs: 0,
				},
			},
			capture: createStubCaptureAdapter(),
			stt: createStubSttAdapter({ text: "uno" }),
			tts: createStubTtsAdapter({ durationMs: 50 }),
			playback: createStubPlaybackAdapter({ durationMs: 50 }),
			submitTranscript: () => {},
		});
		session.dispatch({ type: "LISTEN" });
		await session.flush();
		session.cancelVoiceAudio("escape");
		session.dispatch({ type: "LISTEN" });
		await session.flush();
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(unhandled.filter((e) => isAbortError(e)).length, 0);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("3.6 regression: three stub conversation submits (not real audio)", async () => {
	const submitted: string[] = [];
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: {
				...DEFAULT_VOICE_CONFIG.behavior,
				fluentConversation: true,
				autoSubmitTranscript: false,
				echoSettleMs: 0,
			},
		},
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter({ text: "turno" }),
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter({ durationMs: 1 }),
		submitTranscript: (t) => {
			submitted.push(t);
		},
	});
	session.dispatch({ type: "SET_MODE", mode: "silent" });
	for (const line of ["alpha", "beta", "gamma"]) {
		const r = await session.submitPending(line);
		assert.equal(r, "sent");
		session.onAgentSettled({
			message: {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
			},
			outcome: "completed",
		});
		await session.flush();
	}
	assert.deepEqual(submitted, ["alpha", "beta", "gamma"]);
});

test("3.6 regression: ignoreUnhandledAbort keeps Esc→Space path safe", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (r: unknown) => unhandled.push(r);
	process.on("unhandledRejection", onUnhandled);
	try {
		let reject!: (e: Error) => void;
		const p = new Promise<never>((_, r) => {
			reject = r;
		});
		ignoreUnhandledAbort(p);
		reject(new AbortError());
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(unhandled.length, 0);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});
