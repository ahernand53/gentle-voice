/**
 * Honest compatibility matrix.
 * "supported" only when clean install + real mic/speaker conversation passed.
 */

import type { VoicePlatform } from "../contracts.ts";

export type SupportLevel = "supported" | "experimental" | "planned" | "blocked" | "unsupported";

export interface CompatCell {
	readonly platform: VoicePlatform;
	readonly arch: "x64" | "arm64";
	readonly capture: SupportLevel;
	readonly playback: SupportLevel;
	readonly stt: SupportLevel;
	readonly tts: SupportLevel;
	readonly hostPi: SupportLevel;
	readonly hostGentleShell: SupportLevel;
	readonly notes: string;
}

export const COMPAT_MATRIX: readonly CompatCell[] = Object.freeze([
	Object.freeze({
		platform: "linux" as const,
		arch: "x64" as const,
		capture: "experimental" as const,
		playback: "experimental" as const,
		stt: "experimental" as const,
		tts: "experimental" as const,
		hostPi: "experimental" as const,
		hostGentleShell: "experimental" as const,
		notes:
			"PipeWire + pinned Whisper/Piper downloads. Lab conversation exercised; clean-HOME auto-download path implemented — re-verify after merge.",
	}),
	Object.freeze({
		platform: "linux" as const,
		arch: "arm64" as const,
		capture: "planned" as const,
		playback: "planned" as const,
		stt: "experimental" as const,
		tts: "experimental" as const,
		hostPi: "planned" as const,
		hostGentleShell: "planned" as const,
		notes: "Binaries pinned (ubuntu-arm64 + piper aarch64). Capture/playback smoke pending on ARM hardware.",
	}),
	Object.freeze({
		platform: "win32" as const,
		arch: "x64" as const,
		capture: "blocked" as const,
		playback: "blocked" as const,
		stt: "experimental" as const,
		tts: "experimental" as const,
		hostPi: "planned" as const,
		hostGentleShell: "planned" as const,
		notes:
			"Whisper/Piper Windows binaries pinned. WASAPI adapters not smoke-tested — do not claim conversation support.",
	}),
	Object.freeze({
		platform: "darwin" as const,
		arch: "arm64" as const,
		capture: "blocked" as const,
		playback: "blocked" as const,
		stt: "blocked" as const,
		tts: "experimental" as const,
		hostPi: "planned" as const,
		hostGentleShell: "planned" as const,
		notes:
			"Piper macOS arm64 pinned. Official whisper.cpp b5454 has no macOS CLI — STT auto-install blocked. CoreAudio untested.",
	}),
	Object.freeze({
		platform: "darwin" as const,
		arch: "x64" as const,
		capture: "blocked" as const,
		playback: "blocked" as const,
		stt: "blocked" as const,
		tts: "experimental" as const,
		hostPi: "planned" as const,
		hostGentleShell: "planned" as const,
		notes: "Piper macOS x64 pinned. Whisper CLI + CoreAudio pending.",
	}),
]);

export function formatCompatMarkdown(): string {
	const header =
		"| OS | Arch | Capture | Playback | STT | TTS | Pi | Gentle Shell | Notes |\n"
		+ "| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n";
	const rows = COMPAT_MATRIX.map(
		(c) =>
			`| ${c.platform} | ${c.arch} | ${c.capture} | ${c.playback} | ${c.stt} | ${c.tts} | ${c.hostPi} | ${c.hostGentleShell} | ${c.notes} |`,
	);
	return header + rows.join("\n");
}
