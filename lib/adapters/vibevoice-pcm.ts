/**
 * VibeVoice playback transport.
 * Default is PCM when the worker and pw-play float32 are available.
 * WAV stays available. Piper is a different engine and is not selected here.
 * Frames are float32 mono 24 kHz, little-endian, one JSONL message per chunk.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const VIBEVOICE_NATIVE_STREAM_ENV = "GENTLE_VOICE_VIBEVOICE_NATIVE_STREAM";
export const VIBEVOICE_PLAYBACK_KIND = "gentle-voice.vibevoice-playback" as const;

export type VibeVoicePlaybackPreference = "auto" | "pcm" | "wav";

export interface VibeVoicePlaybackChoice {
	readonly mode: "pcm" | "wav";
	readonly source: "env" | "preference" | "auto";
	readonly preference: VibeVoicePlaybackPreference;
	/** Set when PCM was requested but this host cannot play float32. */
	readonly fallbackReason?: "pcm_unsupported";
}

export function vibeVoicePlaybackPath(voiceHome: string): string {
	return join(voiceHome, "vibevoice-playback.json");
}

export function voiceHomeForPlayback(env: NodeJS.ProcessEnv = process.env): string {
	const home = env.GENTLE_VOICE_HOME?.trim();
	if (home) return home;
	return join(env.HOME ?? "/tmp", ".gentle-voice");
}

export function readVibeVoicePlaybackPreference(
	voiceHome: string,
): VibeVoicePlaybackPreference {
	try {
		const raw = JSON.parse(readFileSync(vibeVoicePlaybackPath(voiceHome), "utf8")) as {
			kind?: unknown;
			preference?: unknown;
		};
		if (raw.kind !== VIBEVOICE_PLAYBACK_KIND) return "auto";
		if (raw.preference === "pcm" || raw.preference === "wav" || raw.preference === "auto") {
			return raw.preference;
		}
		return "auto";
	} catch {
		return "auto";
	}
}

export function writeVibeVoicePlaybackPreference(
	voiceHome: string,
	preference: VibeVoicePlaybackPreference,
): void {
	const path = vibeVoicePlaybackPath(voiceHome);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify({
			kind: VIBEVOICE_PLAYBACK_KIND,
			preference,
			updatedAt: new Date().toISOString(),
		}, null, 2)}\n`,
		{ mode: 0o600 },
	);
}

/**
 * Env overrides the file.
 * `0|false|off|wav` forces WAV. `1|true|on|pcm` requests PCM.
 * Unset env uses the file. A missing file is `auto`.
 * `auto` and `pcm` use PCM only when `pcmSupported` is true; otherwise WAV.
 */
export function resolveVibeVoicePlayback(input: {
	readonly env?: NodeJS.ProcessEnv;
	readonly preference: VibeVoicePlaybackPreference;
	readonly pcmSupported: boolean;
}): VibeVoicePlaybackChoice {
	const raw = (input.env?.[VIBEVOICE_NATIVE_STREAM_ENV] ?? "").trim().toLowerCase();
	const forceWav = raw === "0" || raw === "false" || raw === "off" || raw === "wav";
	const forcePcm = raw === "1" || raw === "true" || raw === "on" || raw === "pcm";
	if (forceWav) {
		return { mode: "wav", source: "env", preference: input.preference };
	}
	const wantsPcm = forcePcm || input.preference === "pcm" || input.preference === "auto";
	const source = forcePcm ? "env" : input.preference === "auto" ? "auto" : "preference";
	if (!wantsPcm) {
		return { mode: "wav", source: "preference", preference: input.preference };
	}
	if (!input.pcmSupported) {
		return {
			mode: "wav",
			source,
			preference: input.preference,
			fallbackReason: "pcm_unsupported",
		};
	}
	return { mode: "pcm", source, preference: input.preference };
}

let pcmSupportCache: boolean | undefined;

export function clearPipewireFloat32Cache(): void {
	pcmSupportCache = undefined;
}

/** True when pw-play advertises raw float32. Cached for the process. */
export function pipewireFloat32PlaybackSupported(): boolean {
	if (pcmSupportCache !== undefined) return pcmSupportCache;
	const probe = process.env.GENTLE_VOICE_PCM_PROBE?.trim();
	if (probe === "0") {
		pcmSupportCache = false;
		return false;
	}
	if (probe === "1") {
		pcmSupportCache = true;
		return true;
	}
	try {
		const result = spawnSync("pw-play", ["--list-formats"], {
			encoding: "utf8",
			timeout: 2000,
		});
		pcmSupportCache = result.status === 0 && (result.stdout ?? "").includes("f32");
	} catch {
		pcmSupportCache = false;
	}
	return pcmSupportCache;
}

export function nativeVibeVoiceStreamEnabled(
	env: NodeJS.ProcessEnv = process.env,
	pcmSupported?: boolean,
): boolean {
	const supported = pcmSupported ?? pipewireFloat32PlaybackSupported();
	return resolveVibeVoicePlayback({
		env,
		preference: readVibeVoicePlaybackPreference(voiceHomeForPlayback(env)),
		pcmSupported: supported,
	}).mode === "pcm";
}

export interface VibeVoicePcmFrame {
	readonly seq: number;
	readonly pcm: Uint8Array;
	readonly sampleRateHz: number;
	readonly channels: number;
	readonly samples: number;
}

export type PcmDecode =
	| { readonly ok: true; readonly frame: VibeVoicePcmFrame; readonly nextSeq: number }
	| { readonly ok: false; readonly reason: string };

/** Reject a waveform that is not float32 in a sane amplitude range. */
export function decodeVibeVoicePcmLine(
	msg: Record<string, unknown>,
	expectedSeq: number,
): PcmDecode {
	if (msg.op !== "pcm") return { ok: false, reason: "not_pcm" };
	if (msg.dtype !== "float32" || msg.sample_rate !== 24_000 || msg.channels !== 1) {
		return { ok: false, reason: "format" };
	}
	if (msg.seq !== expectedSeq) return { ok: false, reason: "seq" };
	const b64 = msg.pcm_b64;
	if (typeof b64 !== "string" || b64.length === 0) return { ok: false, reason: "empty" };
	const samples = msg.samples;
	if (typeof samples !== "number" || !Number.isInteger(samples) || samples <= 0) {
		return { ok: false, reason: "samples" };
	}
	if (expectedSeq === 0) {
		const min = msg.min;
		const max = msg.max;
		if (typeof min !== "number" || typeof max !== "number") return { ok: false, reason: "amplitude" };
		if (Math.abs(min) > 4 || Math.abs(max) > 4) return { ok: false, reason: "amplitude" };
	}
	const pcm = Buffer.from(b64, "base64");
	if (pcm.byteLength !== samples * 4) return { ok: false, reason: "length" };
	return {
		ok: true,
		frame: {
			seq: expectedSeq,
			pcm: new Uint8Array(pcm),
			sampleRateHz: 24_000,
			channels: 1,
			samples,
		},
		nextSeq: expectedSeq + 1,
	};
}
