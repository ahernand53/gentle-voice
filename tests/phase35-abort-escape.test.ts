/**
 * Regression: Esc / cancelVoiceAudio must not crash the host with an orphan
 * AbortError when PipeWire capture is aborted before stop() is awaited
 * (Esc → Ctrl+Alt+Space).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AbortError, ignoreUnhandledAbort, isAbortError } from "../lib/process-cancel.ts";
import { VoiceSession } from "../lib/voice-session.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import {
	createStubCaptureAdapter,
	createStubPlaybackAdapter,
	createStubSttAdapter,
	createStubTtsAdapter,
} from "../lib/adapters/stubs.ts";
import type { AudioChunk, CaptureAdapter, CaptureSession } from "../lib/contracts.ts";

test("isAbortError recognizes AbortError name", () => {
	assert.equal(isAbortError(new AbortError()), true);
	assert.equal(isAbortError(Object.assign(new Error("Aborted"), { name: "AbortError" })), true);
	assert.equal(isAbortError(new Error("boom")), false);
});

test("ignoreUnhandledAbort swallows AbortError without crashing process", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	try {
		let reject!: (err: Error) => void;
		const done = new Promise<AudioChunk>((_resolve, r) => {
			reject = r;
		});
		ignoreUnhandledAbort(done);
		reject(new AbortError());
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(unhandled.length, 0);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("cancelVoiceAudio after listen does not leave unhandled AbortError", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);

	let captureSignal: AbortSignal | undefined;
	let rejectDone: ((err: Error) => void) | undefined;

	const capture: CaptureAdapter = {
		id: "test-abort-capture",
		async availability() {
			return { status: "ready" as const };
		},
		async start({ signal }) {
			captureSignal = signal;
			const done = new Promise<AudioChunk>((_resolve, reject) => {
				rejectDone = reject;
			});
			ignoreUnhandledAbort(done);
			const detach = () => {};
			signal.addEventListener(
				"abort",
				() => {
					rejectDone?.(new AbortError());
				},
				{ once: true },
			);
			const session: CaptureSession = {
				id: "cap-1",
				async stop() {
					detach();
					return done;
				},
			};
			return session;
		},
	};

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
			capture,
			stt: createStubSttAdapter({ text: "hola" }),
			tts: createStubTtsAdapter(),
			playback: createStubPlaybackAdapter({ durationMs: 1 }),
			submitTranscript: () => {},
		});

		session.dispatch({ type: "LISTEN" });
		await session.flush();
		assert.ok(captureSignal);

		// Esc / shortcut_stop path
		session.cancelVoiceAudio("escape");
		// Second Space would cancel again then LISTEN — abort must stay handled
		session.cancelVoiceAudio("shortcut_stop");
		session.dispatch({ type: "LISTEN" });
		await session.flush();
		await new Promise((r) => setTimeout(r, 20));

		assert.equal(
			unhandled.filter((e) => isAbortError(e)).length,
			0,
			`unexpected AbortError unhandledRejection: ${String(unhandled[0])}`,
		);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});
