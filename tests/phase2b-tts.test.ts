/**
 * Phase 2B — Piper TTS, PipeWire playback, mute, STT corrections, lab test-speak.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { skipWithoutLab, applyDeveloperLabEnv, LAB_PIPER_DEFAULTS } from "./lab-env.ts";
import { isWavBuffer } from "../lib/adapters/wav.ts";
import {
	createPiperTtsAdapter,
	LAB_TEST_SPEAK_PHRASE,
} from "../lib/adapters/piper-tts.ts";
import { createPipewirePlaybackAdapter } from "../lib/adapters/pipewire-playback.ts";
import { resolveLabVoiceAdapters } from "../lib/adapters/lab-resolve.ts";
import {
	applySttCorrections,
	DEFAULT_WHISPER_INITIAL_PROMPT,
	formatCorrectionDiff,
} from "../lib/stt/corrections.ts";
import { VoiceSession } from "../lib/voice-session.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import {
	createStubCaptureAdapter,
	createStubPlaybackAdapter,
	createStubSttAdapter,
	createStubTtsAdapter,
} from "../lib/adapters/stubs.ts";
import { isGentleVoiceLabMode, parseVoiceArgs } from "../lib/commands.ts";
import { createVoiceExtension } from "../extensions/voice.ts";
import type { VoiceHostApi } from "../lib/contracts.ts";
import { deniedShortcutProbe } from "../lib/shortcut.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preferredPlaybackBackends, isAudioBackendImplemented } from "../lib/adapters/audio-backends.ts";

test("contracts: STT corrections fix Gentle / PostgreSQL / C# without global damage", () => {
	const sample =
		"Hola, Jendred Voice. Estoy probando desde Jendred Shell. C Sharp y Postgres SQL.";
	const result = applySttCorrections(sample);
	assert.equal(result.changed, true);
	assert.match(result.corrected, /Gentle Voice/);
	assert.match(result.corrected, /Gentle Shell/);
	assert.match(result.corrected, /C#/);
	assert.match(result.corrected, /PostgreSQL/);
	assert.ok(!/Jendred/.test(result.corrected));
	// Do not rewrite unrelated words
	const safe = applySttCorrections("El género literario es amplio.");
	assert.equal(safe.changed, false);
	assert.match(DEFAULT_WHISPER_INITIAL_PROMPT, /Gentle Voice/);
	assert.match(formatCorrectionDiff(result), /STT original/);
});

test("lab: test-speak hidden without GENTLE_VOICE_LAB", () => {
	const prev = process.env.GENTLE_VOICE_LAB;
	delete process.env.GENTLE_VOICE_LAB;
	try {
		const parsed = parseVoiceArgs("test-speak");
		assert.ok(parsed.error);
		assert.equal(parsed.labCommand, undefined);
		assert.equal(isGentleVoiceLabMode(), false);
	} finally {
		if (prev === undefined) delete process.env.GENTLE_VOICE_LAB;
		else process.env.GENTLE_VOICE_LAB = prev;
	}
});

test("lab: test-speak accepted when GENTLE_VOICE_LAB=1", () => {
	const prev = process.env.GENTLE_VOICE_LAB;
	process.env.GENTLE_VOICE_LAB = "1";
	try {
		const parsed = parseVoiceArgs("test-speak");
		assert.equal(parsed.labCommand, "test-speak");
		assert.equal(parsed.error, undefined);
	} finally {
		if (prev === undefined) delete process.env.GENTLE_VOICE_LAB;
		else process.env.GENTLE_VOICE_LAB = prev;
	}
});

test("real: Piper synthesizes WAV for fixed Spanish phrase", { skip: skipWithoutLab }, async () => {
	const tts = createPiperTtsAdapter({
		...LAB_PIPER_DEFAULTS,
		dryRun: false,
	});
	const avail = await tts.availability();
	assert.equal(avail.status, "ready");
	const ac = new AbortController();
	const started = performance.now();
	const { audio } = await tts.synthesize(LAB_TEST_SPEAK_PHRASE, { signal: ac.signal });
	const wall = Math.round(performance.now() - started);
	assert.equal(audio.format, "wav");
	assert.equal(isWavBuffer(audio.bytes), true);
	assert.equal(audio.sampleRateHz, 22_050);
	assert.equal(audio.channels, 1);
	assert.ok(audio.bytes.byteLength > 1_000);
	assert.ok(tts.lastMetrics);
	assert.ok(tts.lastMetrics!.synthesizeMs > 0);
	assert.ok(tts.lastMetrics!.durationSec > 0.5);
	assert.ok(wall < 60_000);
});

test("real: PipeWire playback availability + cancel before finish", { skip: skipWithoutLab }, async () => {
	const play = createPipewirePlaybackAdapter({
		tmpDir: join(tmpdir(), "gv-phase2b-play"),
	});
	const avail = await play.availability();
	assert.equal(avail.status, "ready");

	const tts = createPiperTtsAdapter({ ...LAB_PIPER_DEFAULTS, dryRun: false });
	const { audio } = await tts.synthesize("Hola.", { signal: new AbortController().signal });
	const ac = new AbortController();
	const handle = await play.play(audio, { signal: ac.signal });
	await handle.stop();
	await handle.done;
});

test("simulated: mute blocks speakDirect before TTS; unmute restores; capture still allowed", async () => {
	let playCount = 0;
	let synthCount = 0;
	const notes: string[] = [];
	const baseTts = createStubTtsAdapter({
		audio: {
			bytes: new Uint8Array([1, 2, 3, 4]),
			sampleRateHz: 22_050,
			channels: 1,
			format: "raw",
		},
	});
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: { ...DEFAULT_VOICE_CONFIG.behavior, muted: false },
		},
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter({ text: "hola" }),
		tts: {
			id: baseTts.id,
			availability: () => baseTts.availability(),
			async synthesize(text, opts) {
				synthCount += 1;
				return baseTts.synthesize(text, opts);
			},
		},
		playback: {
			id: "count-play",
			async availability() {
				return { status: "ready" as const };
			},
			async play() {
				playCount += 1;
				return {
					id: "h",
					done: Promise.resolve(),
					async stop() {},
				};
			},
		},
		notify: (m) => notes.push(m),
	});

	session.dispatch({ type: "MUTE" });
	const muted = await session.speakDirect(LAB_TEST_SPEAK_PHRASE);
	assert.equal(muted, "muted");
	assert.equal(synthCount, 0, "must not call Piper/TTS while muted");
	assert.equal(playCount, 0);
	assert.equal(notes.length, 0, "speakDirect muted must not emit stacked notifies");

	// Mute must not block listen/capture
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	assert.equal(session.state.phase, "listening");
	assert.equal(session.state.muted, true);
	session.dispatch({ type: "STOP" });
	await session.flush();

	session.dispatch({ type: "UNMUTE" });
	const played = await session.speakDirect(LAB_TEST_SPEAK_PHRASE);
	assert.equal(played, "played");
	assert.equal(synthCount, 1);
	assert.equal(playCount, 1);
});

test("simulated: off during speaking cancels playback", async () => {
	const session = new VoiceSession({
		config: { ...DEFAULT_VOICE_CONFIG, enabled: true },
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter(),
		tts: createStubTtsAdapter({ latencyMs: 50 }),
		playback: createStubPlaybackAdapter({ durationMs: 5_000 }),
	});
	const speakP = session.speakDirect("largo");
	// Let speaking start
	await new Promise((r) => setTimeout(r, 20));
	session.dispatch({ type: "DISABLE" });
	await session.flush();
	await speakP;
	assert.equal(session.state.enabled, false);
	assert.equal(session.state.phase, "idle");
});

test("simulated: STT corrections applied in review path without LLM submit", async () => {
	const submitted: string[] = [];
	const notes: string[] = [];
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: { ...DEFAULT_VOICE_CONFIG.behavior, autoSubmitTranscript: false },
		},
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter({
			text: "Quiero revisar C Sharp y Postgres SQL con Jendred Voice.",
		}),
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter(),
		submitTranscript: (t) => submitted.push(t),
		presentTranscript: (t) => notes.push(t),
		notify: (m) => notes.push(m),
	});
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	await session.finishListen();
	await session.flush();
	assert.deepEqual(submitted, []);
	assert.equal(session.lastTranscript.includes("Gentle Voice"), true);
	assert.equal(session.lastTranscript.includes("C#"), true);
	assert.equal(session.lastTranscript.includes("PostgreSQL"), true);
	assert.ok(session.lastCorrection?.changed);
});

test("contracts: win/mac playback remain unimplemented", () => {
	assert.equal(preferredPlaybackBackends("win32")[0], "win-wasapi");
	assert.equal(isAudioBackendImplemented("win-wasapi"), false);
	assert.equal(preferredPlaybackBackends("darwin")[0], "darwin-avfoundation");
	assert.equal(isAudioBackendImplemented("darwin-avfoundation"), false);
	assert.equal(isAudioBackendImplemented("linux-pipewire"), true);
});

test("isolation: test-speak extension path does not call sendUserMessage", async () => {
	const prevLab = process.env.GENTLE_VOICE_LAB;
	process.env.GENTLE_VOICE_LAB = "1";
	const messages: string[] = [];
	const notes: string[] = [];
	try {
		const session = new VoiceSession({
			config: { ...DEFAULT_VOICE_CONFIG, enabled: true },
			capture: createStubCaptureAdapter(),
			stt: createStubSttAdapter(),
			tts: createStubTtsAdapter({
				audio: {
					bytes: new Uint8Array(100),
					sampleRateHz: 22_050,
					channels: 1,
					format: "raw",
				},
			}),
			playback: createStubPlaybackAdapter({ durationMs: 1 }),
		});
		const pi: VoiceHostApi = {
			registerCommand(_name, opts) {
				void (pi as { _h?: typeof opts.handler })._h;
				(pi as { _handler?: typeof opts.handler })._handler = opts.handler;
			},
			sendUserMessage(content) {
				messages.push(content);
			},
		};
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
		assert.deepEqual(messages, []);
		assert.ok(notes.some((n) => /test-speak/i.test(n)));
	} finally {
		if (prevLab === undefined) delete process.env.GENTLE_VOICE_LAB;
		else process.env.GENTLE_VOICE_LAB = prevLab;
	}
});

test("real: lab resolve wires piper + pipewire playback under REAL_AUDIO", { skip: skipWithoutLab }, () => {
	const prev = process.env.GENTLE_VOICE_REAL_AUDIO;
	applyDeveloperLabEnv();
	process.env.GENTLE_VOICE_REAL_AUDIO = "1";
	try {
		const lab = resolveLabVoiceAdapters({ forceStub: false });
		assert.equal(lab.ttsKind, "piper");
		assert.equal(lab.playbackKind, "pipewire");
		assert.ok(lab.piperPath?.includes("piper"));
		assert.ok(lab.piperVoice?.includes("daniela"));
	} finally {
		if (prev === undefined) delete process.env.GENTLE_VOICE_REAL_AUDIO;
		else process.env.GENTLE_VOICE_REAL_AUDIO = prev;
	}
});
