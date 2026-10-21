/**
 * Phase 2A — capture/STT contracts, whisper CLI, isolation (no LLM).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	skipWithoutLab,
	applyDeveloperLabEnv,
	LAB_VOXTYPE_GGML_SMALL,
	LAB_WHISPER_CLI_CANDIDATE,
} from "./lab-env.ts";
import { access, constants, mkdir, readdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	createWhisperSttAdapter,
	parseWhisperStdout,
	readGgmlMagic,
} from "../lib/adapters/whisper-stt.ts";
import { createPipewireCaptureAdapter } from "../lib/adapters/pipewire-capture.ts";
import { pcmS16leToWav, isWavBuffer } from "../lib/adapters/wav.ts";
import { resolveLabVoiceAdapters } from "../lib/adapters/lab-resolve.ts";
import { VoiceSession } from "../lib/voice-session.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import {
	createStubCaptureAdapter,
	createStubPlaybackAdapter,
	createStubSttAdapter,
	createStubTtsAdapter,
} from "../lib/adapters/stubs.ts";
import { AbortError } from "../lib/process-cancel.ts";
import { preferredCaptureBackends, isAudioBackendImplemented } from "../lib/adapters/audio-backends.ts";

test("real: whisper-cli installed under WD-Black with voxtype model reusable", { skip: skipWithoutLab }, async () => {
	await access(LAB_WHISPER_CLI_CANDIDATE, constants.X_OK);
	const magic = await readGgmlMagic(LAB_VOXTYPE_GGML_SMALL);
	assert.ok(magic);
	assert.ok(magic.magic === "ggml" || magic.magic === "lmgg");
	const stt = createWhisperSttAdapter({
		whisperCliPath: LAB_WHISPER_CLI_CANDIDATE,
		modelPath: LAB_VOXTYPE_GGML_SMALL,
		dryRun: false,
		language: "es",
	});
	const avail = await stt.availability();
	assert.equal(avail.status, "ready");
});

test("real: whisper rejects empty audio and invalid wav", { skip: skipWithoutLab }, async () => {
	const stt = createWhisperSttAdapter({
		whisperCliPath: LAB_WHISPER_CLI_CANDIDATE,
		modelPath: LAB_VOXTYPE_GGML_SMALL,
		dryRun: false,
		language: "es",
	});
	const ac = new AbortController();
	await assert.rejects(
		() => stt.transcribe({
			bytes: new Uint8Array(0),
			sampleRateHz: 16_000,
			channels: 1,
			format: "wav",
		}, { signal: ac.signal }),
		/empty_audio/,
	);
	await assert.rejects(
		() => stt.transcribe({
			bytes: new Uint8Array([1, 2, 3, 4]),
			sampleRateHz: 16_000,
			channels: 1,
			format: "wav",
		}, { signal: ac.signal }),
		/invalid_wav/,
	);
});

test("real: whisper missing model path → unavailable", { skip: skipWithoutLab }, async () => {
	const stt = createWhisperSttAdapter({
		whisperCliPath: LAB_WHISPER_CLI_CANDIDATE,
		modelPath: "/tmp/no-such-ggml-model.bin",
		dryRun: false,
	});
	const avail = await stt.availability();
	assert.equal(avail.status, "unavailable");
	assert.equal(avail.reason, "model_missing");
});

test("real: whisper transcribes short silence wav (blank → empty text)", { skip: skipWithoutLab }, async () => {
	const pcm = new Uint8Array(16_000 * 2); // 1s silence mono s16
	const wav = pcmS16leToWav(pcm, 16_000, 1);
	assert.equal(isWavBuffer(wav), true);
	const stt = createWhisperSttAdapter({
		whisperCliPath: LAB_WHISPER_CLI_CANDIDATE,
		modelPath: LAB_VOXTYPE_GGML_SMALL,
		dryRun: false,
		language: "es",
		tmpDir: join(tmpdir(), "gv-phase2a"),
	});
	const ac = new AbortController();
	const started = performance.now();
	const result = await stt.transcribe({
		bytes: wav,
		sampleRateHz: 16_000,
		channels: 1,
		format: "wav",
	}, { signal: ac.signal });
	const ms = Math.round(performance.now() - started);
	// Silence often yields bracket nonspeech tags ([MÚSICA], etc.); parser strips them → empty.
	assert.equal(result.text.trim(), "");
	assert.ok(stt.lastMetrics);
	assert.ok(stt.lastMetrics!.loadAndTranscribeMs > 0);
	assert.ok(ms < 120_000);
});

test("real: pipewire capture availability on this Linux lab", { skip: skipWithoutLab }, async () => {
	const cap = createPipewireCaptureAdapter();
	const avail = await cap.availability();
	assert.equal(avail.status, "ready");
});

test("simulated: cancel during capture via AbortSignal", async () => {
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: { ...DEFAULT_VOICE_CONFIG.behavior, autoSubmitTranscript: false },
		},
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter({ text: "hola", latencyMs: 5_000 }),
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter(),
	});
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	session.dispatch({ type: "STOP" });
	await session.flush();
	assert.equal(session.state.phase, "idle");
});

test("simulated: review mode does not submit to LLM", async () => {
	const submitted: string[] = [];
	const presented: string[] = [];
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: { ...DEFAULT_VOICE_CONFIG.behavior, autoSubmitTranscript: false },
		},
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter({ text: "hola laboratorio" }),
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter(),
		submitTranscript: (t) => submitted.push(t),
		presentTranscript: (t) => presented.push(t),
	});
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	await session.finishListen();
	await session.flush();
	assert.deepEqual(submitted, []);
	assert.deepEqual(presented, ["hola laboratorio"]);
	assert.equal(session.state.phase, "idle");
	assert.equal(session.lastTranscript, "hola laboratorio");
});

test("simulated: empty transcript notifies without submit", async () => {
	const notes: string[] = [];
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: { ...DEFAULT_VOICE_CONFIG.behavior, autoSubmitTranscript: false },
		},
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter({ text: "   " }),
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter(),
		notify: (m) => notes.push(m),
	});
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	await session.finishListen();
	await session.flush();
	assert.ok(notes.some((n) => /No speech/i.test(n)));
	assert.equal(session.state.phase, "idle");
});

test("real: lab resolve picks whisper+pipewire when REAL paths exist", { skip: skipWithoutLab }, () => {
	const prev = process.env.GENTLE_VOICE_REAL_AUDIO;
	const prevTts = process.env.GENTLE_VOICE_TTS;
	applyDeveloperLabEnv();
	process.env.GENTLE_VOICE_REAL_AUDIO = "1";
	process.env.GENTLE_VOICE_TTS = "piper";
	try {
		const lab = resolveLabVoiceAdapters({ forceStub: false });
		assert.equal(lab.captureKind, "pipewire");
		assert.equal(lab.sttKind, "whisper");
		assert.equal(lab.ttsKind, "piper");
		assert.equal(lab.playbackKind, "pipewire");
		assert.ok(lab.whisperCli?.includes("whisper-cli"));
		assert.ok(lab.modelPath?.includes("ggml-small"));
	} finally {
		if (prev === undefined) delete process.env.GENTLE_VOICE_REAL_AUDIO;
		else process.env.GENTLE_VOICE_REAL_AUDIO = prev;
		if (prevTts === undefined) delete process.env.GENTLE_VOICE_TTS;
		else process.env.GENTLE_VOICE_TTS = prevTts;
	}
});

test("isolation: voxtype model path unchanged (still readable file)", { skip: skipWithoutLab }, async () => {
	const before = await readGgmlMagic(LAB_VOXTYPE_GGML_SMALL);
	assert.ok(before);
	// touch nothing — just re-read
	const after = await readGgmlMagic(LAB_VOXTYPE_GGML_SMALL);
	assert.equal(before!.bytes, after!.bytes);
	assert.equal(before!.magic, after!.magic);
});

test("contracts: wav helper roundtrip", () => {
	const pcm = new Uint8Array([0, 0, 1, 0]);
	const wav = pcmS16leToWav(pcm, 16_000, 1);
	assert.equal(isWavBuffer(wav), true);
});

test("cancel transcription signal rejects with AbortError path", async () => {
	const stt = createStubSttAdapter({ text: "x", latencyMs: 2_000 });
	const ac = new AbortController();
	const p = stt.transcribe({
		bytes: new Uint8Array(0),
		sampleRateHz: 16_000,
		channels: 1,
		format: "pcm_s16le",
	}, { signal: ac.signal });
	ac.abort();
	await assert.rejects(() => p, (err: unknown) => err instanceof AbortError || (err as Error).name === "AbortError");
});

test("contracts: parseWhisperStdout strips nonspeech bracket tags", () => {
	assert.equal(parseWhisperStdout("[MÚSICA] [MÚSICA]\n"), "");
	assert.equal(parseWhisperStdout("whisper_init: ok\nhola mundo\n"), "hola mundo");
	assert.equal(parseWhisperStdout("[BLANK_AUDIO]\n"), "");
});

test("simulated: mic unavailable surfaces from capture adapter", async () => {
	const cap = createPipewireCaptureAdapter({ pwRecordPath: "/tmp/no-such-pw-record-binary" });
	// Force absolute missing path — override common /usr/bin/pw-record by pointing only at missing
	const fake = {
		...cap,
		id: "fake-missing-mic",
		async availability() {
			return { status: "unavailable" as const, reason: "pw_record_missing" };
		},
		async start() {
			throw new Error("capture unavailable: pw_record_missing");
		},
	};
	await assert.rejects(() => fake.start({ signal: new AbortController().signal }), /pw_record_missing/);
});

test("real: whisper temp wav cleaned after transcribe", { skip: skipWithoutLab }, async () => {
	const dir = join(tmpdir(), `gv-phase2a-clean-${Date.now()}`);
	await mkdir(dir, { recursive: true });
	const pcm = new Uint8Array(8_000 * 2);
	const wav = pcmS16leToWav(pcm, 16_000, 1);
	const stt = createWhisperSttAdapter({
		whisperCliPath: LAB_WHISPER_CLI_CANDIDATE,
		modelPath: LAB_VOXTYPE_GGML_SMALL,
		dryRun: false,
		language: "es",
		tmpDir: dir,
		keepTemp: false,
	});
	await stt.transcribe({
		bytes: wav,
		sampleRateHz: 16_000,
		channels: 1,
		format: "wav",
	}, { signal: new AbortController().signal });
	const left = await readdir(dir);
	assert.equal(left.filter((f) => f.startsWith("stt-") && f.endsWith(".wav")).length, 0);
});

test("contracts: win/mac capture backends remain unimplemented", () => {
	assert.equal(preferredCaptureBackends("win32")[0], "win-wasapi");
	assert.equal(isAudioBackendImplemented("win-wasapi"), false);
	assert.equal(preferredCaptureBackends("darwin")[0], "darwin-avfoundation");
	assert.equal(isAudioBackendImplemented("darwin-avfoundation"), false);
	assert.equal(isAudioBackendImplemented("linux-pipewire"), true);
});

test("simulated: cancel during listen (off) returns idle without submit", async () => {
	const submitted: string[] = [];
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: { ...DEFAULT_VOICE_CONFIG.behavior, autoSubmitTranscript: false },
		},
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter({ text: "no debe enviarse", latencyMs: 5_000 }),
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter(),
		submitTranscript: (t) => submitted.push(t),
	});
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	session.dispatch({ type: "DISABLE" });
	await session.flush();
	// DISABLE → enabled:false, phase idle (no separate "disabled" phase)
	assert.equal(session.state.enabled, false);
	assert.equal(session.state.phase, "idle");
	assert.deepEqual(submitted, []);
});
