/**
 * Phase 2B.1 — mute UX (single notify, no synth), TTS profiles catalog, cancel.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createVoiceExtension } from "../extensions/voice.ts";
import type { VoiceHostApi } from "../lib/contracts.ts";
import { VoiceSession } from "../lib/voice-session.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import {
	createStubCaptureAdapter,
	createStubPlaybackAdapter,
	createStubSttAdapter,
	createStubTtsAdapter,
} from "../lib/adapters/stubs.ts";
import { deniedShortcutProbe } from "../lib/shortcut.ts";
import { LAB_TEST_SPEAK_PHRASE } from "../lib/adapters/piper-tts.ts";
import {
	TTS_QUALITY_PROFILES,
	TTS_PROVIDER_RESEARCH_CATALOG,
	getQualityProfile,
	preferredProvidersForProfile,
} from "../lib/tts/profiles.ts";
import { formatSpeakBenchLine, emptySpeakBench } from "../lib/tts/metrics.ts";
import { AbortError } from "../lib/process-cancel.ts";

function makeHost(notes: string[], messages: string[] = []) {
	const pi: VoiceHostApi = {
		registerCommand(_name, opts) {
			(pi as { _handler?: typeof opts.handler })._handler = opts.handler;
		},
		sendUserMessage(content) {
			messages.push(content);
		},
	};
	return pi;
}

test("2B.1: muted test-speak → one warning, zero TTS calls, no LLM", async () => {
	const prevLab = process.env.GENTLE_VOICE_LAB;
	process.env.GENTLE_VOICE_LAB = "1";
	const notes: string[] = [];
	const messages: string[] = [];
	let synthCount = 0;
	try {
		const baseTts = createStubTtsAdapter();
		const session = new VoiceSession({
			config: { ...DEFAULT_VOICE_CONFIG, enabled: true },
			capture: createStubCaptureAdapter(),
			stt: createStubSttAdapter(),
			tts: {
				id: baseTts.id,
				availability: () => baseTts.availability(),
				async synthesize(text, opts) {
					synthCount += 1;
					return baseTts.synthesize(text, opts);
				},
			},
			playback: createStubPlaybackAdapter({ durationMs: 1 }),
		});
		session.dispatch({ type: "MUTE" });
		await session.flush();

		const pi = makeHost(notes, messages);
		createVoiceExtension(pi, {
			session,
			forceStubAdapters: true,
			shortcutProbe: deniedShortcutProbe(),
		});
		const handler = (pi as { _handler?: (a: string, c: never) => Promise<void> })._handler!;
		await handler("test-speak", {
			mode: "tui",
			hasUI: true,
			ui: {
				notify: (m: string) => notes.push(m),
				setStatus: () => {},
				setWidget: () => {},
			},
			isIdle: () => true,
		} as never);

		assert.equal(synthCount, 0);
		assert.deepEqual(messages, []);
		assert.equal(notes.length, 1);
		assert.match(notes[0]!, /Muted/i);
		assert.ok(!/synthesizing/i.test(notes[0]!));
	} finally {
		if (prevLab === undefined) delete process.env.GENTLE_VOICE_LAB;
		else process.env.GENTLE_VOICE_LAB = prevLab;
	}
});

test("2B.1: mute off restores test-speak audio path", async () => {
	const prevLab = process.env.GENTLE_VOICE_LAB;
	process.env.GENTLE_VOICE_LAB = "1";
	const notes: string[] = [];
	let synthCount = 0;
	try {
		const baseTts = createStubTtsAdapter({
			audio: {
				bytes: new Uint8Array(32),
				sampleRateHz: 22_050,
				channels: 1,
				format: "raw",
			},
		});
		const session = new VoiceSession({
			config: { ...DEFAULT_VOICE_CONFIG, enabled: true },
			capture: createStubCaptureAdapter(),
			stt: createStubSttAdapter(),
			tts: {
				id: baseTts.id,
				availability: () => baseTts.availability(),
				async synthesize(text, opts) {
					synthCount += 1;
					return baseTts.synthesize(text, opts);
				},
			},
			playback: createStubPlaybackAdapter({ durationMs: 1 }),
		});
		const pi = makeHost(notes);
		createVoiceExtension(pi, {
			session,
			forceStubAdapters: true,
			shortcutProbe: deniedShortcutProbe(),
		});
		const handler = (pi as { _handler?: (a: string, c: never) => Promise<void> })._handler!;
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				notify: (m: string) => notes.push(m),
				setStatus: () => {},
				setWidget: () => {},
			},
			isIdle: () => true,
		} as never;

		session.dispatch({ type: "MUTE" });
		await handler("test-speak", ctx);
		assert.equal(synthCount, 0);

		session.dispatch({ type: "UNMUTE" });
		notes.length = 0;
		await handler("test-speak", ctx);
		assert.equal(synthCount, 1);
		assert.equal(notes.length, 1);
		assert.match(notes[0]!, /done/i);
	} finally {
		if (prevLab === undefined) delete process.env.GENTLE_VOICE_LAB;
		else process.env.GENTLE_VOICE_LAB = prevLab;
	}
});

test("2B.1: cancel during slow TTS aborts without orphan play", async () => {
	let playStarted = 0;
	const session = new VoiceSession({
		config: { ...DEFAULT_VOICE_CONFIG, enabled: true },
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter(),
		tts: createStubTtsAdapter({ latencyMs: 2_000 }),
		playback: {
			id: "guard",
			async availability() {
				return { status: "ready" as const };
			},
			async play() {
				playStarted += 1;
				throw new AbortError();
			},
		},
	});
	const speakP = session.speakDirect(LAB_TEST_SPEAK_PHRASE);
	await new Promise((r) => setTimeout(r, 30));
	session.dispatch({ type: "STOP" });
	await session.flush();
	await speakP;
	assert.equal(playStarted, 0);
	assert.equal(session.state.phase, "idle");
});

test("2B.1: quality profiles declared; Piper+Kokoro lab-verified locally", () => {
	assert.equal(TTS_QUALITY_PROFILES.length, 3);
	assert.ok(getQualityProfile("light"));
	assert.ok(getQualityProfile("balanced"));
	assert.ok(getQualityProfile("natural"));
	assert.ok(preferredProvidersForProfile("balanced").length > 0);
	const verified = TTS_PROVIDER_RESEARCH_CATALOG.filter((p) => p.verifiedLocally);
	const ids = verified.map((p) => p.id).sort();
	assert.deepEqual(ids, ["kokoro-ef-dora", "piper-es-AR-daniela-high"]);
	assert.ok(TTS_PROVIDER_RESEARCH_CATALOG.every((p) => p.licenseHint.length > 0));
});

test("2B.1: speak bench formatter ready for lab logs", () => {
	const sample = {
		...emptySpeakBench(64),
		providerId: "piper-es-AR-daniela-high",
		profileId: "balanced",
		synthesizeMs: 2100,
		timeToPlaybackStartMs: 3,
		peakRssKb: 232_708,
		modelBytes: 114 * 1024 * 1024,
		audioDurationSec: 3.2,
		audioBytes: 140_844,
		userQualityScore: 2,
		mutedSkipped: false,
	};
	const line = formatSpeakBenchLine(sample);
	assert.match(line, /synthMs=2100/);
	assert.match(line, /mos=2/);
});
