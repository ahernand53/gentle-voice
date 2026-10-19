/**
 * Downloadable artifact catalog for first-run preparation.
 * URLs are advisory until a release pins checksums after license review.
 * No download runs unless consent + GENTLE_VOICE_ALLOW_DOWNLOADS=1.
 */

import type { VoicePlatform } from "../contracts.ts";

export type ArtifactKind = "stt-binary" | "stt-model" | "tts-binary" | "tts-voice";

export interface RuntimeArtifact {
	readonly id: string;
	readonly kind: ArtifactKind;
	readonly platforms: readonly VoicePlatform[];
	readonly arches: readonly ("x64" | "arm64")[];
	readonly displayName: string;
	readonly license: string;
	readonly origin: string;
	/** Relative path under modelsDir or binDir. */
	readonly relativePath: string;
	readonly estimatedBytes: number;
	/**
	 * Empty until a release pins a verified SHA-256.
	 * Downloads are refused when sha256 is empty.
	 */
	readonly sha256: string;
	readonly url: string;
	readonly notes: string;
}

/**
 * Default local stack: Whisper.cpp + Piper (portable binaries preferred over Kokoro/Python).
 * Kokoro remains an optional lab voice when present; not the portable default.
 */
export const RUNTIME_ARTIFACTS: readonly RuntimeArtifact[] = Object.freeze([
	Object.freeze({
		id: "whisper-cli",
		kind: "stt-binary" as const,
		platforms: ["linux", "win32", "darwin"] as const,
		arches: ["x64", "arm64"] as const,
		displayName: "Whisper.cpp CLI",
		license: "MIT (whisper.cpp)",
		origin: "https://github.com/ggerganov/whisper.cpp",
		relativePath: "bin/whisper-cli",
		estimatedBytes: 25 * 1024 * 1024,
		sha256: "",
		url: "",
		notes: "Pin official release asset + sha256 before enabling downloads.",
	}),
	Object.freeze({
		id: "whisper-base-q5",
		kind: "stt-model" as const,
		platforms: ["linux", "win32", "darwin"] as const,
		arches: ["x64", "arm64"] as const,
		displayName: "Whisper ggml-base (multilingual)",
		license: "MIT (model weights per OpenAI Whisper / ggml ports)",
		origin: "https://huggingface.co/ggerganov/whisper.cpp",
		relativePath: "models/whisper/ggml-base.bin",
		estimatedBytes: 150 * 1024 * 1024,
		sha256: "",
		url: "",
		notes: "Default size target for es+en; small/medium selectable later. No auto-download until sha256 pinned.",
	}),
	Object.freeze({
		id: "piper-bin",
		kind: "tts-binary" as const,
		platforms: ["linux", "win32", "darwin"] as const,
		arches: ["x64", "arm64"] as const,
		displayName: "Piper TTS",
		license: "MIT (piper)",
		origin: "https://github.com/rhasspy/piper",
		relativePath: "bin/piper",
		estimatedBytes: 40 * 1024 * 1024,
		sha256: "",
		url: "",
		notes: "Prefer static/official release binaries. Pin sha256 before downloads.",
	}),
	Object.freeze({
		id: "piper-es-voice",
		kind: "tts-voice" as const,
		platforms: ["linux", "win32", "darwin"] as const,
		arches: ["x64", "arm64"] as const,
		displayName: "Piper Spanish voice (placeholder slot)",
		license: "Voice-specific (verify before redistribute)",
		origin: "https://github.com/rhasspy/piper-voices",
		relativePath: "models/piper/es_ES-placeholder.onnx",
		estimatedBytes: 60 * 1024 * 1024,
		sha256: "",
		url: "",
		notes: "Pick a redistributable Spanish voice + json companion; license audit required before pin.",
	}),
]);

export function artifactsFor(
	platform: VoicePlatform,
	arch: "x64" | "arm64",
): readonly RuntimeArtifact[] {
	return RUNTIME_ARTIFACTS.filter(
		(a) => a.platforms.includes(platform) && a.arches.includes(arch),
	);
}

export function totalEstimatedBytes(artifacts: readonly RuntimeArtifact[]): number {
	return artifacts.reduce((n, a) => n + a.estimatedBytes, 0);
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
	if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
	return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
