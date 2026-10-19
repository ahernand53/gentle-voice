/**
 * Platform audio backend contracts.
 * Capture/playback stay behind these ids so Linux PipeWire/Pulse is never
 * hard-wired into the core session — Windows WASAPI and macOS AVFoundation
 * plug in behind the same CaptureAdapter / PlaybackAdapter interfaces.
 */

import type { VoicePlatform } from "../contracts.ts";

export type CaptureBackendId =
	| "stub"
	| "linux-pipewire"
	| "linux-pulse"
	| "win-wasapi"
	| "darwin-coreaudio"
	| "darwin-avfoundation";

export type PlaybackBackendId =
	| "stub"
	| "linux-pipewire"
	| "linux-pulse"
	| "win-wasapi"
	| "darwin-coreaudio"
	| "darwin-avfoundation";

export interface AudioBackendSpec {
	readonly id: CaptureBackendId | PlaybackBackendId;
	readonly role: "capture" | "playback";
	readonly platforms: readonly VoicePlatform[];
	readonly displayName: string;
	/** True only after a real adapter exists and was exercised on that OS. */
	readonly verifiedOn: readonly VoicePlatform[];
	readonly notes: string;
}

export const AUDIO_BACKEND_CATALOG: readonly AudioBackendSpec[] = Object.freeze([
	Object.freeze({
		id: "stub" as const,
		role: "capture" as const,
		platforms: ["linux", "win32", "darwin", "unsupported"] as const,
		displayName: "Stub capture",
		verifiedOn: ["linux"] as const,
		notes: "Phase 1C default — no microphone.",
	}),
	Object.freeze({
		id: "linux-pipewire" as const,
		role: "capture" as const,
		platforms: ["linux"] as const,
		displayName: "PipeWire (pw-record / portal)",
		verifiedOn: ["linux"] as const,
		notes: "Linux lab: pw-record + energy VAD (experimental, not universal distro claim).",
	}),
	Object.freeze({
		id: "linux-pulse" as const,
		role: "capture" as const,
		platforms: ["linux"] as const,
		displayName: "PulseAudio (parecord)",
		verifiedOn: [] as const,
		notes: "Fallback Linux capture; not implemented yet.",
	}),
	Object.freeze({
		id: "win-wasapi" as const,
		role: "capture" as const,
		platforms: ["win32"] as const,
		displayName: "WASAPI",
		verifiedOn: [] as const,
		notes: "Planned Windows capture; untested until Windows run.",
	}),
	Object.freeze({
		id: "darwin-coreaudio" as const,
		role: "capture" as const,
		platforms: ["darwin"] as const,
		displayName: "CoreAudio",
		verifiedOn: [] as const,
		notes: "Planned macOS capture; untested until macOS run.",
	}),
	Object.freeze({
		id: "darwin-avfoundation" as const,
		role: "capture" as const,
		platforms: ["darwin"] as const,
		displayName: "AVFoundation",
		verifiedOn: [] as const,
		notes: "Alternate macOS capture path; untested.",
	}),
	Object.freeze({
		id: "stub" as const,
		role: "playback" as const,
		platforms: ["linux", "win32", "darwin", "unsupported"] as const,
		displayName: "Stub playback",
		verifiedOn: ["linux"] as const,
		notes: "Phase 1C default — no speaker I/O.",
	}),
	Object.freeze({
		id: "linux-pipewire" as const,
		role: "playback" as const,
		platforms: ["linux"] as const,
		displayName: "PipeWire (pw-play)",
		verifiedOn: ["linux"] as const,
		notes: "Phase 2B: pw-play WAV playback implemented on Linux lab.",
	}),
	Object.freeze({
		id: "linux-pulse" as const,
		role: "playback" as const,
		platforms: ["linux"] as const,
		displayName: "PulseAudio (paplay)",
		verifiedOn: [] as const,
		notes: "Fallback Linux playback; not implemented yet.",
	}),
	Object.freeze({
		id: "win-wasapi" as const,
		role: "playback" as const,
		platforms: ["win32"] as const,
		displayName: "WASAPI",
		verifiedOn: [] as const,
		notes: "Planned Windows playback; untested until Windows run.",
	}),
	Object.freeze({
		id: "darwin-coreaudio" as const,
		role: "playback" as const,
		platforms: ["darwin"] as const,
		displayName: "CoreAudio",
		verifiedOn: [] as const,
		notes: "Planned macOS playback; untested until macOS run.",
	}),
	Object.freeze({
		id: "darwin-avfoundation" as const,
		role: "playback" as const,
		platforms: ["darwin"] as const,
		displayName: "AVFoundation",
		verifiedOn: [] as const,
		notes: "Alternate macOS playback; untested.",
	}),
]);

export function preferredCaptureBackends(platform: VoicePlatform): readonly CaptureBackendId[] {
	switch (platform) {
		case "linux":
			return ["linux-pipewire", "linux-pulse", "stub"];
		case "win32":
			return ["win-wasapi", "stub"];
		case "darwin":
			return ["darwin-avfoundation", "darwin-coreaudio", "stub"];
		default:
			return ["stub"];
	}
}

export function preferredPlaybackBackends(platform: VoicePlatform): readonly PlaybackBackendId[] {
	switch (platform) {
		case "linux":
			return ["linux-pipewire", "linux-pulse", "stub"];
		case "win32":
			return ["win-wasapi", "stub"];
		case "darwin":
			return ["darwin-avfoundation", "darwin-coreaudio", "stub"];
		default:
			return ["stub"];
	}
}

/** Phase 2B: PipeWire capture + playback implemented on Linux. */
export function isAudioBackendImplemented(id: CaptureBackendId | PlaybackBackendId): boolean {
	return id === "stub" || id === "linux-pipewire";
}
