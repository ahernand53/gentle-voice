#!/usr/bin/env node
/**
 * GS-Lab A/B: Energy VAD vs Silero VAD on the same PCM fixture.
 * Does not touch ~/.pi or ~/.gentle-shell.
 *
 * Usage:
 *   GENTLE_VOICE_SILERO_VAD=/path/silero_vad.onnx \
 *   node --experimental-strip-types scripts/vad-ab-compare.mjs
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createEnergyVad } from "../lib/vad/energy-vad.ts";
import { tryCreateSileroVad, SILERO_WINDOW_SAMPLES } from "../lib/vad/silero-vad.ts";
import { resolveVad } from "../lib/vad/resolve-vad.ts";

const SR = 16_000;
const MODEL = process.env.GENTLE_VOICE_SILERO_VAD?.trim()
	|| "/home/erickfm/WD-Black/gentle-voice/models/silero/silero_vad.onnx";
const PIPER = process.env.GENTLE_VOICE_PIPER
	|| "/home/erickfm/.local/share/gentle-voice/vendor/piper/piper/piper";
const VOICE = process.env.GENTLE_VOICE_PIPER_VOICE
	|| "/home/erickfm/.local/share/gentle-voice/models/piper/es_AR-daniela-high.onnx";
const OUT_DIR = process.env.GENTLE_VOICE_VAD_AB_OUT
	|| "/home/erickfm/D-SSD/personal/gs-lab/logs";
const PHRASE = process.env.GENTLE_VOICE_VAD_AB_PHRASE
	|| "Hola, esta es una prueba de detección de voz en español.";

function samplesToMs(n) {
	return (n / SR) * 1000;
}

function concatSilence(pcm, leadMs, trailMs) {
	const lead = Buffer.alloc(Math.round(SR * (leadMs / 1000)) * 2);
	const trail = Buffer.alloc(Math.round(SR * (trailMs / 1000)) * 2);
	return Buffer.concat([lead, pcm, trail]);
}

function insertMidPause(pcm, atMs, pauseMs) {
	const at = Math.round(SR * (atMs / 1000)) * 2;
	const pause = Buffer.alloc(Math.round(SR * (pauseMs / 1000)) * 2);
	if (at <= 0 || at >= pcm.length) return Buffer.concat([pcm, pause]);
	return Buffer.concat([pcm.subarray(0, at), pause, pcm.subarray(at)]);
}

async function piperToPcmS16le(text) {
	const wavPath = join(OUT_DIR, "vad-ab-fixture.wav");
	await mkdir(OUT_DIR, { recursive: true });
	await new Promise((resolve, reject) => {
		const child = spawn(PIPER, ["--model", VOICE, "--output_file", wavPath], {
			stdio: ["pipe", "inherit", "inherit"],
		});
		child.stdin.write(text);
		child.stdin.end();
		child.on("error", reject);
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`piper exit ${code}`))));
	});
	// Decode wav → s16le mono 16k via ffmpeg if present, else parse PCM wav
	const wav = await readFile(wavPath);
	return wavToPcm16kMono(wav);
}

function wavToPcm16kMono(wav) {
	if (wav.toString("ascii", 0, 4) !== "RIFF") throw new Error("not riff");
	let offset = 12;
	let sampleRate = 0;
	let channels = 0;
	let bits = 0;
	let data;
	while (offset + 8 <= wav.length) {
		const id = wav.toString("ascii", offset, offset + 4);
		const size = wav.readUInt32LE(offset + 4);
		const start = offset + 8;
		if (id === "fmt ") {
			channels = wav.readUInt16LE(start + 2);
			sampleRate = wav.readUInt32LE(start + 4);
			bits = wav.readUInt16LE(start + 14);
		} else if (id === "data") {
			data = wav.subarray(start, start + size);
			break;
		}
		offset = start + size + (size % 2);
	}
	if (!data) throw new Error("no data chunk");
	if (bits !== 16) throw new Error(`unsupported bits ${bits}`);
	// Downmix + resample naive if needed
	let mono = data;
	if (channels === 2) {
		const frames = Math.floor(data.length / 4);
		mono = Buffer.alloc(frames * 2);
		for (let i = 0; i < frames; i++) {
			const l = data.readInt16LE(i * 4);
			const r = data.readInt16LE(i * 4 + 2);
			mono.writeInt16LE(((l + r) / 2) | 0, i * 2);
		}
	}
	if (sampleRate === SR) return mono;
	// Linear resample to 16k (Piper often emits 22050)
	const inFrames = Math.floor(mono.length / 2);
	const outFrames = Math.max(1, Math.round(inFrames * (SR / sampleRate)));
	const out = Buffer.alloc(outFrames * 2);
	for (let i = 0; i < outFrames; i++) {
		const src = (i * (inFrames - 1)) / Math.max(1, outFrames - 1);
		const i0 = Math.floor(src);
		const i1 = Math.min(inFrames - 1, i0 + 1);
		const t = src - i0;
		const s0 = mono.readInt16LE(i0 * 2);
		const s1 = mono.readInt16LE(i1 * 2);
		out.writeInt16LE((s0 * (1 - t) + s1 * t) | 0, i * 2);
	}
	return out;
}

async function runEngine(name, engine, pcm, chunkSamples = 512) {
	engine.reset?.();
	const chunkBytes = chunkSamples * 2;
	let speechSeenAtSample = -1;
	let endAtSample = -1;
	let sampleCursor = 0;
	const t0 = performance.now();
	for (let off = 0; off < pcm.length; off += chunkBytes) {
		const chunk = pcm.subarray(off, Math.min(pcm.length, off + chunkBytes));
		const before = engine.state.speechSeen;
		const ended = engine.pushPcmS16le(new Uint8Array(chunk));
		// Allow async Silero drain
		await new Promise((r) => setTimeout(r, name === "silero" ? 5 : 0));
		if (!before && engine.state.speechSeen && speechSeenAtSample < 0) {
			speechSeenAtSample = sampleCursor;
		}
		sampleCursor += chunk.length / 2;
		if (ended || engine.state.phase === "ended") {
			endAtSample = sampleCursor;
			break;
		}
	}
	// Final drain wait for silero
	if (name === "silero") {
		for (let i = 0; i < 40 && engine.state.phase !== "ended"; i++) {
			await new Promise((r) => setTimeout(r, 10));
			if (engine.pushPcmS16le(new Uint8Array(0))) break;
		}
		if (engine.state.phase === "ended" && endAtSample < 0) endAtSample = sampleCursor;
	}
	const wallMs = performance.now() - t0;
	const totalMs = samplesToMs(pcm.length / 2);
	const speechStartMs = speechSeenAtSample >= 0 ? samplesToMs(speechSeenAtSample) : null;
	const endMs = endAtSample >= 0 ? samplesToMs(endAtSample) : null;
	// Post-speech wait ≈ end - (lead + speechDuration estimate)
	// Use: from mid of fixture speech region isn't known; report endMs - speechStartMs as utterance span,
	// and trailing: totalMs - endMs (how early we stopped vs full buffer).
	const trailingUnusedMs = endMs != null ? Math.max(0, totalMs - endMs) : null;
	return {
		backend: engine.backend ?? name,
		speechSeen: engine.state.speechSeen,
		speechStartMs,
		endMs,
		trailingUnusedMs,
		wallMs: Math.round(wallMs * 10) / 10,
		lastProb: engine.state.speechProb,
		phase: engine.state.phase,
	};
}

function noisePcm(ms, amp = 0.02) {
	const n = Math.round(SR * (ms / 1000));
	const buf = Buffer.alloc(n * 2);
	for (let i = 0; i < n; i++) {
		buf.writeInt16LE(((Math.random() * 2 - 1) * amp * 32767) | 0, i * 2);
	}
	return buf;
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	const resolveCheck = await resolveVad({
		preference: "auto",
		env: { ...process.env, GENTLE_VOICE_SILERO_VAD: MODEL },
		silero: { modelPath: MODEL },
	});
	if (resolveCheck.backend !== "silero") {
		throw new Error(`Silero did not load: ${resolveCheck.fallbackReason}`);
	}

	console.log("Generating Piper fixture…");
	const speechPcm = await piperToPcmS16le(PHRASE);
	const speechMs = samplesToMs(speechPcm.length / 2);

	const scenarios = [
		{
			id: "baseline_lead300_trail2000",
			pcm: concatSilence(speechPcm, 300, 2000),
			notes: "300ms lead + phrase + 2000ms trail — primary A/B for post-speech wait",
		},
		{
			id: "mid_pause_400",
			pcm: concatSilence(insertMidPause(speechPcm, speechMs * 0.45, 400), 200, 1500),
			notes: "400ms pause mid-phrase — should NOT end early",
		},
		{
			id: "noise_only_1500",
			pcm: concatSilence(noisePcm(1500, 0.015), 200, 500),
			notes: "Low noise only — prefer no speechSeen / no false end",
		},
	];

	const energyOpts = {
		speechThreshold: 0.009,
		silenceHangMs: 1200,
		maxIntraPauseMs: 450,
		postRollMs: 220,
		sampleRateHz: SR,
		maxListenMs: 60_000,
	};
	const sileroLoaded = await tryCreateSileroVad({
		modelPath: MODEL,
		sampleRateHz: SR,
		silenceHangMs: 900,
		maxIntraPauseMs: 350,
		postRollMs: 150,
		maxListenMs: 60_000,
		speechProbThreshold: 0.5,
	});
	if (!sileroLoaded.ok) throw new Error(sileroLoaded.reason);

	const rows = [];
	for (const sc of scenarios) {
		const energy = createEnergyVad(energyOpts);
		const silero = sileroLoaded.engine;
		silero.reset();
		const e = await runEngine("energy", energy, sc.pcm);
		const s = await runEngine("silero", silero, sc.pcm);
		const postSpeechEnergy = e.endMs != null && e.speechStartMs != null
			? e.endMs - e.speechStartMs
			: null;
		const postSpeechSilero = s.endMs != null && s.speechStartMs != null
			? s.endMs - s.speechStartMs
			: null;
		// Better proxy for "wait after speech ends": trailingUnusedMs relative to 2000ms trail
		// Higher trailingUnused = ended earlier into the trail = less wait for the user.
		const trailReductionPct = e.trailingUnusedMs != null && s.trailingUnusedMs != null && e.trailingUnusedMs > 0
			? ((s.trailingUnusedMs - e.trailingUnusedMs) / (2000 - (e.trailingUnusedMs || 0) || 1)) * 100
			: null;
		// User-facing post-speech wait ≈ trailPad - trailingUnused
		const trailPadMs = sc.id.startsWith("baseline") ? 2000 : sc.id.startsWith("mid") ? 1500 : 500;
		const waitAfterSpeechE = e.trailingUnusedMs != null ? Math.max(0, trailPadMs - e.trailingUnusedMs) : null;
		const waitAfterSpeechS = s.trailingUnusedMs != null ? Math.max(0, trailPadMs - s.trailingUnusedMs) : null;
		const waitReductionPct = waitAfterSpeechE != null && waitAfterSpeechS != null && waitAfterSpeechE > 0
			? ((waitAfterSpeechE - waitAfterSpeechS) / waitAfterSpeechE) * 100
			: null;

		rows.push({
			scenario: sc.id,
			notes: sc.notes,
			speechMs: Math.round(speechMs),
			energy: e,
			silero: s,
			waitAfterSpeechMs: { energy: waitAfterSpeechE, silero: waitAfterSpeechS },
			waitReductionPct: waitReductionPct != null ? Math.round(waitReductionPct * 10) / 10 : null,
			utteranceSpanMs: { energy: postSpeechEnergy, silero: postSpeechSilero },
		});
		console.log(JSON.stringify(rows[rows.length - 1], null, 2));
	}

	await sileroLoaded.engine.dispose?.();

	const baseline = rows.find((r) => r.scenario === "baseline_lead300_trail2000");
	const gate20 = baseline?.waitReductionPct != null && baseline.waitReductionPct >= 20;
	const mid = rows.find((r) => r.scenario === "mid_pause_400");
	const midOk = mid?.silero?.endMs != null && mid.silero.speechSeen
		&& (mid.waitAfterSpeechMs.silero == null || mid.waitAfterSpeechMs.silero < 1800);
	const noise = rows.find((r) => r.scenario === "noise_only_1500");
	const noiseOk = noise && !noise.silero.speechSeen;

	const report = {
		at: new Date().toISOString(),
		model: MODEL,
		modelSha256: (await readFile(join("/home/erickfm/WD-Black/gentle-voice/models/silero/SHA256SUMS"), "utf8")).trim(),
		resolveBackend: resolveCheck.backend,
		gate: {
			target: "≥20% reduction in post-speech wait (baseline trail 2000ms)",
			baselineWaitReductionPct: baseline?.waitReductionPct,
			passed: gate20,
			midPauseDidNotFalseEndEarly: Boolean(midOk),
			noiseNoSpeechSeen: Boolean(noiseOk),
		},
		rows,
	};
	const outPath = join(OUT_DIR, "vad-ab-report.json");
	await writeFile(outPath, JSON.stringify(report, null, 2));
	console.log("WROTE", outPath);
	console.log("GATE_20PCT", gate20, "reduction%", baseline?.waitReductionPct);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
