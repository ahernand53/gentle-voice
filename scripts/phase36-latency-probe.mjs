#!/usr/bin/env -S node --experimental-strip-types
/**
 * Phase 3.6 — real latency probe (monotone clocks).
 *
 * Conditions are printed in the report. Never claims stub timings as production.
 *
 * Usage (lab):
 *   GENTLE_VOICE_LAB=1 GENTLE_VOICE_LAB_ROOT=… \
 *   GENTLE_VOICE_WHISPER_CLI=… GENTLE_VOICE_WHISPER_MODEL=… \
 *   GENTLE_VOICE_PIPER=… GENTLE_VOICE_PIPER_VOICE=… \
 *   node --experimental-strip-types scripts/phase36-latency-probe.mjs
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const now = () => performance.now();

function ms(a, b) {
	return Math.round((b - a) * 100) / 100;
}

function pcmSineWavApproxAsS16le(seconds, hz = 16_000, freq = 220) {
	const n = Math.floor(seconds * hz);
	const buf = Buffer.alloc(n * 2);
	for (let i = 0; i < n; i++) {
		const t = i / hz;
		const sample = Math.sin(2 * Math.PI * freq * t) * 0.25;
		buf.writeInt16LE(Math.floor(sample * 32767), i * 2);
	}
	return { bytes: new Uint8Array(buf), sampleRateHz: hz, channels: 1, format: "pcm_s16le" };
}

async function main() {
	const report = {
		generatedAt: new Date().toISOString(),
		clock: "performance.now() (monotonic)",
		conditions: {
			node: process.version,
			platform: process.platform,
			arch: process.arch,
			lab: process.env.GENTLE_VOICE_LAB === "1",
			whisperCli: process.env.GENTLE_VOICE_WHISPER_CLI || "(unset)",
			whisperModel: process.env.GENTLE_VOICE_WHISPER_MODEL || "(unset)",
			piper: process.env.GENTLE_VOICE_PIPER || "(unset)",
			piperVoice: process.env.GENTLE_VOICE_PIPER_VOICE || "(unset)",
			note: "Synthetic sine PCM for STT (not human speech) — measures engine wall time, not recognition quality.",
		},
		marks: {},
		stagesMs: {},
		mode: "unavailable",
	};

	const lab =
		process.env.GENTLE_VOICE_LAB === "1"
		&& process.env.GENTLE_VOICE_WHISPER_CLI
		&& process.env.GENTLE_VOICE_WHISPER_MODEL
		&& process.env.GENTLE_VOICE_PIPER
		&& process.env.GENTLE_VOICE_PIPER_VOICE;

	if (!lab) {
		report.mode = "skipped_no_lab_env";
		report.error =
			"Set GENTLE_VOICE_LAB=1 and WHISPER/PIPER path env vars for real measurements.";
		console.log(JSON.stringify(report, null, 2));
		process.exit(2);
	}

	const { createWhisperSttAdapter } = await import(
		pathToFileURL(join(root, "lib/adapters/whisper-stt.ts")).href
	);
	const { createPiperTtsAdapter } = await import(
		pathToFileURL(join(root, "lib/adapters/piper-tts.ts")).href
	);
	const { createEnergyVad } = await import(
		pathToFileURL(join(root, "lib/vad/energy-vad.ts")).href
	);

	report.mode = "real_lab_adapters";

	// ——— VAD hang simulation (config defaults: hang 1200 + postRoll 200) ———
	const tVad0 = now();
	const vad = createEnergyVad({
		speechThreshold: 0.01,
		silenceHangMs: 1_200,
		maxIntraPauseMs: 450,
		postRollMs: 200,
		sampleRateHz: 16_000,
	});
	// 300ms speech then silence until end
	const speech = pcmSineWavApproxAsS16le(0.3).bytes;
	vad.pushPcmS16le(speech);
	let ended = false;
	const silenceChunk = pcmSineWavApproxAsS16le(0.05).bytes;
	const tSpeechEnd = now();
	report.marks.lastRealSpeechSample = tSpeechEnd;
	while (!ended) {
		ended = vad.pushPcmS16le(silenceChunk);
	}
	const tVadEnd = now();
	report.marks.vadUtteranceEnd = tVadEnd;
	// Sample-based VAD: wall clock of this tight loop is NOT product latency.
	report.stagesMs.vadProbeLoopWallMs = ms(tSpeechEnd, tVadEnd);
	report.stagesMs.vadConfiguredHangMs = 1_200;
	report.stagesMs.vadConfiguredPostRollMs = 200;
	report.stagesMs.vadProductEndOfUtteranceAudioMs = 1_200 + 200;
	report.stagesMs.vadNote =
		"Product adds ~silenceHangMs+postRollMs of AUDIO time after last speech before STT. Probe loop wall time is not that delay.";

	// ——— STT ———
	const stt = createWhisperSttAdapter({
		whisperCliPath: process.env.GENTLE_VOICE_WHISPER_CLI,
		modelPath: process.env.GENTLE_VOICE_WHISPER_MODEL,
		dryRun: false,
	});
	const availStt = await stt.availability();
	report.conditions.sttAvailability = availStt;
	const audio = pcmSineWavApproxAsS16le(1.5);
	const tStt0 = now();
	report.marks.sttStart = tStt0;
	const ac = new AbortController();
	let sttResult;
	try {
		sttResult = await stt.transcribe(audio, { signal: ac.signal, language: "es" });
	} catch (err) {
		report.stagesMs.sttError = String(err?.message ?? err);
	}
	const tStt1 = now();
	report.marks.sttEnd = tStt1;
	report.stagesMs.sttWallMs = ms(tStt0, tStt1);
	report.stagesMs.sttTextChars = sttResult?.text?.length ?? 0;
	report.stagesMs.sttTextPreview = (sttResult?.text ?? "").slice(0, 80);

	// ——— TTS Piper ———
	const tts = createPiperTtsAdapter({
		piperPath: process.env.GENTLE_VOICE_PIPER,
		voiceModelPath: process.env.GENTLE_VOICE_PIPER_VOICE,
		voiceConfigPath:
			process.env.GENTLE_VOICE_PIPER_VOICE_CONFIG
			|| `${process.env.GENTLE_VOICE_PIPER_VOICE}.json`,
		dryRun: false,
	});
	const availTts = await tts.availability();
	report.conditions.ttsAvailability = availTts;
	const phrase =
		"Hola, esta es una prueba de latencia de síntesis con Piper en español argentino.";
	const tTts0 = now();
	report.marks.ttsStart = tTts0;
	const ttsResult = await tts.synthesize(phrase, { signal: new AbortController().signal });
	const tTts1 = now();
	report.marks.ttsEnd = tTts1;
	report.stagesMs.ttsWallMs = ms(tTts0, tTts1);
	report.stagesMs.ttsAudioBytes = ttsResult.audio.bytes.byteLength;
	report.stagesMs.ttsMetrics = tts.lastMetrics ?? null;

	// ——— Playback not measured (would require PipeWire device) ———
	report.stagesMs.playbackMs = null;
	report.stagesMs.playbackNote = "Not measured — requires interactive PipeWire session.";

	// ——— Agent LLM not measured ———
	report.stagesMs.firstLlmDeltaMs = null;
	report.stagesMs.llmNote = "Not measured — would consume tokens; out of scope for this probe.";

	report.stagesMs.pipelineEngineOnlyMs =
		(report.stagesMs.vadProductEndOfUtteranceAudioMs ?? 0)
		+ (report.stagesMs.sttWallMs ?? 0)
		+ (report.stagesMs.ttsWallMs ?? 0);
	report.stagesMs.pipelineNote =
		"Sum of configured VAD audio hang+postRoll + measured STT wall + measured TTS wall. Excludes mic I/O, LLM, and playback.";

	const outDir = join(tmpdir(), "gentle-voice-phase36");
	await mkdir(outDir, { recursive: true });
	const outFile = join(outDir, `latency-${Date.now()}.json`);
	await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`);
	report.outputFile = outFile;
	console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
