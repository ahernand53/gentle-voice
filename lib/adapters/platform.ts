/**
 * Platform adapter registry.
 * Capture/playback stay stubs until authorized audio backends land.
 * Optional Piper TTS / Whisper STT can be injected; defaults remain stubs
 * so the extension never spawns engines without explicit wiring.
 */

import type {
	CaptureAdapter,
	PlaybackAdapter,
	SttAdapter,
	TtsAdapter,
	VoicePlatform,
} from "../contracts.ts";
import { detectVoicePlatform } from "../config.ts";
import { createPlatformStubBundle } from "./stubs.ts";
import {
	preferredCaptureBackends,
	preferredPlaybackBackends,
	isAudioBackendImplemented,
} from "./audio-backends.ts";

export interface VoiceAdapterBundle {
	readonly platform: VoicePlatform;
	readonly capture: CaptureAdapter;
	readonly stt: SttAdapter;
	readonly tts: TtsAdapter;
	readonly playback: PlaybackAdapter;
	readonly plannedCaptureBackends: readonly string[];
	readonly plannedPlaybackBackends: readonly string[];
}

/**
 * Resolve adapters for the current (or injected) platform.
 * Always returns a bundle; availability() on each adapter reports degraded/unavailable.
 */
export function resolveVoiceAdapters(options?: {
	platform?: VoicePlatform;
	capture?: CaptureAdapter;
	stt?: SttAdapter;
	tts?: TtsAdapter;
	playback?: PlaybackAdapter;
}): VoiceAdapterBundle {
	const platform = options?.platform ?? detectVoicePlatform();
	const stubs = createPlatformStubBundle(platform);
	const capturePlan = preferredCaptureBackends(platform);
	const playbackPlan = preferredPlaybackBackends(platform);
	return {
		platform,
		capture: options?.capture ?? stubs.capture,
		stt: options?.stt ?? stubs.stt,
		tts: options?.tts ?? stubs.tts,
		playback: options?.playback ?? stubs.playback,
		plannedCaptureBackends: capturePlan.filter((id) => !isAudioBackendImplemented(id) || id === "stub"),
		plannedPlaybackBackends: playbackPlan.filter((id) => !isAudioBackendImplemented(id) || id === "stub"),
	};
}

export async function probeAdapterBundle(bundle: VoiceAdapterBundle): Promise<{
	platform: VoicePlatform;
	capture: string;
	stt: string;
	tts: string;
	playback: string;
}> {
	const [capture, stt, tts, playback] = await Promise.all([
		bundle.capture.availability(),
		bundle.stt.availability(),
		bundle.tts.availability(),
		bundle.playback.availability(),
	]);
	const label = (a: { status: string; reason?: string }) =>
		a.status === "ready" ? "ready" : `${a.status}:${a.reason ?? "unknown"}`;
	return {
		platform: bundle.platform,
		capture: label(capture),
		stt: label(stt),
		tts: label(tts),
		playback: label(playback),
	};
}
