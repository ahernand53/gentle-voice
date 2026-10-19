/**
 * Honest compatibility matrix.
 * "supported" only when smoke-tested with real audio on that OS.
 */

import type { VoicePlatform } from "../contracts.ts";

export type SupportLevel = "supported" | "experimental" | "planned" | "unsupported";

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
		notes: "PipeWire + Whisper + Piper/Kokoro exercised in developer lab (CachyOS/Omarchy). Not a universal Linux claim.",
	}),
	Object.freeze({
		platform: "linux" as const,
		arch: "arm64" as const,
		capture: "planned" as const,
		playback: "planned" as const,
		stt: "planned" as const,
		tts: "planned" as const,
		hostPi: "planned" as const,
		hostGentleShell: "planned" as const,
		notes: "Needs ARM64 binary + smoke tests.",
	}),
	Object.freeze({
		platform: "win32" as const,
		arch: "x64" as const,
		capture: "planned" as const,
		playback: "planned" as const,
		stt: "planned" as const,
		tts: "planned" as const,
		hostPi: "planned" as const,
		hostGentleShell: "planned" as const,
		notes: "WASAPI adapters not implemented; do not claim Windows support.",
	}),
	Object.freeze({
		platform: "darwin" as const,
		arch: "arm64" as const,
		capture: "planned" as const,
		playback: "planned" as const,
		stt: "planned" as const,
		tts: "planned" as const,
		hostPi: "planned" as const,
		hostGentleShell: "planned" as const,
		notes: "CoreAudio adapters not implemented; TCC mic permission path undocumented until smoke test.",
	}),
	Object.freeze({
		platform: "darwin" as const,
		arch: "x64" as const,
		capture: "planned" as const,
		playback: "planned" as const,
		stt: "planned" as const,
		tts: "planned" as const,
		hostPi: "planned" as const,
		hostGentleShell: "planned" as const,
		notes: "Intel macOS secondary; only if upstream binaries exist.",
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
