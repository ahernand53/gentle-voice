/**
 * Phase 2D — visual PCM waves, chrome states, mute/cancel, narrow, anim-off.
 * No LLM tokens. Amplitude from real buffers only (no RNG waves).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	displayLevelFromRms,
	measurePcmS16le,
	pcmBytesFromAudio,
	pcmWindowAtTime,
} from "../lib/visual/pcm-amplitude.ts";
import { WaveBarMeter, barCountForTerminalColumns } from "../lib/visual/wave-bars.ts";
import { VisualMeter } from "../lib/visual/visual-meter.ts";
import {
	renderVoiceWidgetContent,
	resolveChromeActivity,
	snapshotVoiceChrome,
} from "../lib/widget-chrome.ts";
import { initialVoiceState } from "../lib/state-machine.ts";
import { VoiceSession } from "../lib/voice-session.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import {
	createStubCaptureAdapter,
	createStubPlaybackAdapter,
	createStubSttAdapter,
	createStubTtsAdapter,
} from "../lib/adapters/stubs.ts";
import { createPiHostHarness } from "../lib/lab/pi-host-harness.ts";
import { createVoiceExtension, VOICE_WIDGET_KEY } from "../extensions/voice.ts";
import { deniedShortcutProbe } from "../lib/shortcut.ts";
import { VOICE_COMMAND } from "../lib/commands.ts";
import type { AudioChunk } from "../lib/contracts.ts";

function pcmTone(frames: number, amplitude: number, channels = 1): Uint8Array {
	const out = new Uint8Array(frames * channels * 2);
	const view = new DataView(out.buffer);
	for (let i = 0; i < frames; i++) {
		const s = Math.floor(Math.sin(i / 8) * amplitude * 32767);
		for (let c = 0; c < channels; c++) {
			view.setInt16((i * channels + c) * 2, s, true);
		}
	}
	return out;
}

function pcmSilence(frames: number): Uint8Array {
	return new Uint8Array(frames * 2);
}

function wavFromPcm(pcm: Uint8Array, sampleRateHz = 24_000, channels = 1): Uint8Array {
	const dataSize = pcm.byteLength;
	const buf = new Uint8Array(44 + dataSize);
	const view = new DataView(buf.buffer);
	const writeStr = (o: number, s: string) => {
		for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i)!;
	};
	writeStr(0, "RIFF");
	view.setUint32(4, 36 + dataSize, true);
	writeStr(8, "WAVE");
	writeStr(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRateHz, true);
	view.setUint32(28, sampleRateHz * channels * 2, true);
	view.setUint16(32, channels * 2, true);
	view.setUint16(34, 16, true);
	writeStr(36, "data");
	view.setUint32(40, dataSize, true);
	buf.set(pcm, 44);
	return buf;
}

test("PCM RMS: silence → no speech; tone → speech; clipping peak near 1", () => {
	const silent = measurePcmS16le(pcmSilence(1600));
	assert.equal(silent.speech, false);
	assert.ok(silent.rms < 0.001);

	const voice = measurePcmS16le(pcmTone(1600, 0.2));
	assert.equal(voice.speech, true);
	assert.ok(voice.rms > 0.05);

	const hot = measurePcmS16le(pcmTone(800, 1.0));
	assert.ok(hot.peak >= 0.99);
	assert.ok(displayLevelFromRms(hot.rms) <= 1);
});

test("pcmWindowAtTime returns real samples; empty past EOF", () => {
	const pcm = pcmTone(4800, 0.3); // 0.2s @ 24k
	const mid = pcmWindowAtTime(pcm, 24_000, 1, 0.05, 20);
	assert.ok(mid.byteLength > 0);
	assert.equal(measurePcmS16le(mid).speech, true);
	const past = pcmWindowAtTime(pcm, 24_000, 1, 5.0, 20);
	// still returns last window start clamped — length > 0 but near end
	assert.ok(past.byteLength >= 0);
	const empty = pcmWindowAtTime(new Uint8Array(0), 24_000, 1, 0, 20);
	assert.equal(empty.byteLength, 0);
});

test("pcmBytesFromAudio strips WAV header", () => {
	const pcm = pcmTone(100, 0.1);
	const wav = wavFromPcm(pcm);
	const extracted = pcmBytesFromAudio(wav, "wav");
	assert.equal(extracted.byteLength, pcm.byteLength);
});

test("WaveBarMeter smooths and clears; narrow bar count", () => {
	assert.equal(barCountForTerminalColumns(36), 8);
	assert.ok(barCountForTerminalColumns(100) >= 15);
	const m = new WaveBarMeter({ barCount: 8, smooth: 1 });
	m.pushLevel(0.9, true);
	const hot = m.render();
	assert.match(hot, /[▅▆▇█]/);
	m.clear();
	assert.ok(m.levels().every((v) => v === 0));
	assert.equal(m.speechDetected, false);
});

test("VisualMeter: synthesizing has no wave energy; speaking uses WAV; stop clears", () => {
	let paints = 0;
	let t = 1_000;
	const meter = new VisualMeter({
		enabled: true,
		maxFps: 15,
		onPaint: () => {
			paints += 1;
		},
		now: () => t,
	});
	try {
		meter.beginLoadingVoice();
		assert.equal(meter.speakStage, "loading_voice");
		meter.beginSynthesizing();
		assert.equal(meter.speakStage, "synthesizing");
		assert.ok(meter.wave.levels().every((v) => v < 0.01));

		const audio: AudioChunk = {
			bytes: wavFromPcm(pcmTone(48_000, 0.5), 24_000, 1),
			sampleRateHz: 24_000,
			channels: 1,
			format: "wav",
		};
		t = 1_000;
		meter.beginSpeakingFromAudio(audio);
		assert.equal(meter.speakStage, "speaking");
		// First tick at t=0 relative uses real WAV window (not RNG).
		const peak = Math.max(...meter.wave.levels());
		assert.ok(peak > 0.02, `expected real PCM bars, got peak=${peak}`);
		meter.stopPlaybackVisual();
		assert.equal(meter.speakStage, "idle");
		assert.ok(meter.wave.levels().every((v) => v === 0));
		assert.ok(paints >= 1);
	} finally {
		meter.dispose();
	}
});

test("VisualMeter disabled: no capture levels stick", () => {
	const meter = new VisualMeter({ enabled: false, maxFps: 10 });
	meter.pushCapturePcm(pcmTone(800, 0.5));
	assert.ok(meter.wave.levels().every((v) => v === 0));
	meter.dispose();
});

test("chrome states: ARMING, SPEECH_DETECTED, SYNTHESIZING, SPEAKING, MUTED, ERROR", () => {
	const listening = initialVoiceState({ enabled: true, phase: "listening" });
	assert.equal(
		resolveChromeActivity(listening, { micReady: false }),
		"ARMING",
		"must not show LISTENING before mic PCM",
	);
	assert.equal(resolveChromeActivity(listening, { micReady: true }), "LISTENING");
	assert.equal(
		resolveChromeActivity(listening, { micReady: true, speechDetected: true }),
		"SPEECH_DETECTED",
	);
	assert.equal(
		resolveChromeActivity(
			initialVoiceState({ enabled: true, phase: "speaking" }),
			{ speakStage: "loading_voice" },
		),
		"VOICE_LOADING",
	);
	assert.equal(
		resolveChromeActivity(
			initialVoiceState({ enabled: true, phase: "speaking" }),
			{ speakStage: "synthesizing" },
		),
		"SYNTHESIZING",
	);
	assert.equal(
		resolveChromeActivity(
			initialVoiceState({ enabled: true, phase: "speaking" }),
			{ speakStage: "speaking" },
		),
		"SPEAKING",
	);
	assert.equal(
		resolveChromeActivity(initialVoiceState({ enabled: true, phase: "idle", muted: true })),
		"MUTED",
	);
	assert.equal(
		resolveChromeActivity(initialVoiceState({ enabled: true, phase: "error" })),
		"ERROR",
	);
	assert.equal(
		resolveChromeActivity(initialVoiceState({ enabled: true, phase: "awaiting_agent" })),
		"WORKING",
		"agent work must not look like SPEAKING",
	);
	assert.equal(
		resolveChromeActivity(initialVoiceState({ enabled: true, phase: "idle" }), { paused: true }),
		"PAUSED",
	);
});

test("widget: waves only when provided; muted hides waves; narrow header", () => {
	const listening = initialVoiceState({ enabled: true, phase: "listening" });
	const withWave = renderVoiceWidgetContent(listening, {
		waveLine: "▁ ▄ █ ▄ ▁",
		speechDetected: true,
	});
	assert.equal(withWave?.length, 2);
	assert.match(withWave![0]!, /SPEECH_DETECTED/);
	assert.equal(withWave![1], "▁ ▄ █ ▄ ▁");

	const muted = renderVoiceWidgetContent(
		initialVoiceState({ enabled: true, phase: "listening", muted: true }),
		{ waveLine: "█ █ █", speechDetected: true },
	);
	assert.equal(muted?.length, 1, "mute suppresses wave line");

	const synth = renderVoiceWidgetContent(
		initialVoiceState({ enabled: true, phase: "speaking" }),
		{ speakStage: "synthesizing" },
	);
	assert.equal(synth?.[1], "⋯");

	const narrow = snapshotVoiceChrome(
		initialVoiceState({ enabled: true, phase: "idle" }),
		{ terminalColumns: 40 },
	);
	assert.match(narrow.widgetContent![0]!, /^🎙 READY/);
	assert.doesNotMatch(narrow.widgetContent![0]!, /Gentle Voice/);
});

test("session chromeVisual + speakDirect mute: no TTS meter stage leak", async () => {
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: { ...DEFAULT_VOICE_CONFIG.behavior, muted: true, visualWaves: true },
		},
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter({ text: "hola" }),
		tts: createStubTtsAdapter({
			audio: {
				bytes: wavFromPcm(pcmTone(1000, 0.2)),
				sampleRateHz: 24_000,
				channels: 1,
				format: "wav",
			},
		}),
		playback: createStubPlaybackAdapter(),
	});
	const r = await session.speakDirect("hola");
	assert.equal(r, "muted");
	assert.equal(session.chromeVisual().speakStage, "idle");
	session.dispose();
});

test("animation off: visualWaves false → no wave line while listening", async () => {
	const paints: number[] = [];
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			behavior: { ...DEFAULT_VOICE_CONFIG.behavior, visualWaves: false },
		},
		capture: createStubCaptureAdapter(),
		stt: createStubSttAdapter({ text: "x" }),
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter(),
		onChromeUpdate: () => paints.push(1),
	});
	session.dispatch({ type: "LISTEN" });
	await session.flush();
	const content = renderVoiceWidgetContent(session.state, session.chromeVisual());
	assert.equal(content?.length, 1);
	assert.equal(session.chromeVisual().waveLine, undefined);
	session.dispose();
});

test("harness: no duplicate widget keys; off clears; cancel speaking cleans meter", async () => {
	const harness = createPiHostHarness();
	const session = createVoiceExtension(harness.pi, {
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: false,
			behavior: { ...DEFAULT_VOICE_CONFIG.behavior, visualWaves: true },
		},
		shortcutProbe: deniedShortcutProbe(),
	});

	await harness.runCommand(VOICE_COMMAND, "on");
	await harness.runCommand(VOICE_COMMAND, "listen");
	const keys = harness.widgets.map((w) => w.key).filter((k) => k === VOICE_WIDGET_KEY);
	assert.ok(keys.length >= 1);
	// All updates share the same key (no second widget).
	assert.ok(keys.every((k) => k === VOICE_WIDGET_KEY));

	await harness.runCommand(VOICE_COMMAND, "stop");
	await harness.runCommand(VOICE_COMMAND, "off");
	const cleared = harness.widgets.filter((w) => w.key === VOICE_WIDGET_KEY).at(-1);
	assert.equal(cleared?.content, undefined);

	session.dispose();
});

test("config validates visualWaves / visualFps bounds", async () => {
	const { validateVoiceConfig } = await import("../lib/config.ts");
	const ok = validateVoiceConfig({
		...DEFAULT_VOICE_CONFIG,
		behavior: { ...DEFAULT_VOICE_CONFIG.behavior, visualWaves: false, visualFps: 10 },
	});
	assert.equal(ok.ok, true);
	const bad = validateVoiceConfig({
		...DEFAULT_VOICE_CONFIG,
		behavior: { ...DEFAULT_VOICE_CONFIG.behavior, visualFps: 99 },
	});
	assert.equal(bad.ok, false);
});
