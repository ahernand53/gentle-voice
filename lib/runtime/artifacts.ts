/**
 * Pinned downloadable artifacts for first-run preparation.
 * SHA-256 verified against official GitHub / Hugging Face releases (recomputed locally).
 * Downloads require interactive consent — no lab env vars required.
 */

import type { VoicePlatform } from "../contracts.ts";

export type ArtifactKind =
	| "stt-binary-archive"
	| "stt-model"
	| "tts-binary-archive"
	| "tts-voice"
	| "tts-voice-config";

export type CpuArch = "x64" | "arm64";

export interface RuntimeArtifact {
	readonly id: string;
	readonly kind: ArtifactKind;
	readonly platform: VoicePlatform;
	readonly arch: CpuArch;
	readonly displayName: string;
	readonly license: string;
	readonly version: string;
	readonly origin: string;
	readonly url: string;
	readonly sha256: string;
	readonly estimatedBytes: number;
	/** Path relative to Gentle Voice data dir after install. */
	readonly relativePath: string;
	/** Archive member / extract rules. */
	readonly archive?: {
		readonly format: "tar.gz" | "zip";
		/** Binary path inside extracted tree (posix separators). */
		readonly binaryMember: string;
		/** Final relative path for the executable under dataDir. */
		readonly installBinaryAs: string;
	};
	readonly notes: string;
}

const WHISPER_TAG = "b5454";
const PIPER_TAG = "2023.11.14-2";

/** Official pinned catalog — empty url/sha means not offered for that platform. */
export const RUNTIME_ARTIFACTS: readonly RuntimeArtifact[] = Object.freeze([
	// ——— Whisper.cpp CLI ———
	Object.freeze({
		id: "whisper-cli-linux-x64",
		kind: "stt-binary-archive" as const,
		platform: "linux" as const,
		arch: "x64" as const,
		displayName: "Whisper.cpp CLI (Ubuntu x64)",
		license: "MIT (whisper.cpp)",
		version: WHISPER_TAG,
		origin: "https://github.com/ggerganov/whisper.cpp/releases/tag/b5454",
		url: `https://github.com/ggerganov/whisper.cpp/releases/download/${WHISPER_TAG}/whisper-bin-ubuntu-x64.tar.gz`,
		sha256: "a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c",
		estimatedBytes: 25 * 1024 * 1024,
		relativePath: "vendor/whisper",
		archive: {
			format: "tar.gz" as const,
			binaryMember: "whisper-bin-ubuntu-x64/whisper-cli",
			installBinaryAs: "bin/whisper-cli",
		},
		notes: "Official prebuilt whisper-cli + shared libs (extract whole tree under vendor/whisper).",
	}),
	Object.freeze({
		id: "whisper-cli-linux-arm64",
		kind: "stt-binary-archive" as const,
		platform: "linux" as const,
		arch: "arm64" as const,
		displayName: "Whisper.cpp CLI (Ubuntu arm64)",
		license: "MIT (whisper.cpp)",
		version: WHISPER_TAG,
		origin: "https://github.com/ggerganov/whisper.cpp/releases/tag/b5454",
		url: `https://github.com/ggerganov/whisper.cpp/releases/download/${WHISPER_TAG}/whisper-bin-ubuntu-arm64.tar.gz`,
		sha256: "6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149",
		estimatedBytes: 25 * 1024 * 1024,
		relativePath: "vendor/whisper",
		archive: {
			format: "tar.gz" as const,
			binaryMember: "whisper-bin-ubuntu-arm64/whisper-cli",
			installBinaryAs: "bin/whisper-cli",
		},
		notes: "Official prebuilt arm64 whisper-cli.",
	}),
	Object.freeze({
		id: "whisper-cli-win-x64",
		kind: "stt-binary-archive" as const,
		platform: "win32" as const,
		arch: "x64" as const,
		displayName: "Whisper.cpp CLI (Windows x64)",
		license: "MIT (whisper.cpp)",
		version: WHISPER_TAG,
		origin: "https://github.com/ggerganov/whisper.cpp/releases/tag/b5454",
		url: `https://github.com/ggerganov/whisper.cpp/releases/download/${WHISPER_TAG}/whisper-bin-x64.zip`,
		sha256: "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb",
		estimatedBytes: 30 * 1024 * 1024,
		relativePath: "vendor/whisper",
		archive: {
			format: "zip" as const,
			binaryMember: "whisper-cli.exe",
			installBinaryAs: "bin/whisper-cli.exe",
		},
		notes: "Official Windows CPU build. Smoke-test required before claiming support.",
	}),
	// ——— Whisper model ———
	Object.freeze({
		id: "whisper-ggml-base-q5_1",
		kind: "stt-model" as const,
		platform: "linux" as const,
		arch: "x64" as const,
		displayName: "Whisper ggml-base-q5_1 (multilingual)",
		license: "MIT (OpenAI Whisper weights via ggml port)",
		version: "ggml-base-q5_1",
		origin: "https://huggingface.co/ggerganov/whisper.cpp",
		url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin",
		sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
		estimatedBytes: 59_707_625,
		relativePath: "models/whisper/ggml-base-q5_1.bin",
		notes: "Shared model for all platforms (duplicated catalog rows via modelForAll).",
	}),
	// ——— Piper ———
	Object.freeze({
		id: "piper-linux-x64",
		kind: "tts-binary-archive" as const,
		platform: "linux" as const,
		arch: "x64" as const,
		displayName: "Piper TTS (Linux x86_64)",
		license: "MIT (piper)",
		version: PIPER_TAG,
		origin: `https://github.com/rhasspy/piper/releases/tag/${PIPER_TAG}`,
		url: `https://github.com/rhasspy/piper/releases/download/${PIPER_TAG}/piper_linux_x86_64.tar.gz`,
		sha256: "a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992",
		estimatedBytes: 26_460_462,
		relativePath: "vendor/piper",
		archive: {
			format: "tar.gz" as const,
			binaryMember: "piper/piper",
			installBinaryAs: "bin/piper",
		},
		notes: "Includes espeak-ng data + phonemize libs inside archive.",
	}),
	Object.freeze({
		id: "piper-linux-arm64",
		kind: "tts-binary-archive" as const,
		platform: "linux" as const,
		arch: "arm64" as const,
		displayName: "Piper TTS (Linux aarch64)",
		license: "MIT (piper)",
		version: PIPER_TAG,
		origin: `https://github.com/rhasspy/piper/releases/tag/${PIPER_TAG}`,
		url: `https://github.com/rhasspy/piper/releases/download/${PIPER_TAG}/piper_linux_aarch64.tar.gz`,
		sha256: "fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb",
		estimatedBytes: 26_004_717,
		relativePath: "vendor/piper",
		archive: {
			format: "tar.gz" as const,
			binaryMember: "piper/piper",
			installBinaryAs: "bin/piper",
		},
		notes: "Official aarch64 build.",
	}),
	Object.freeze({
		id: "piper-darwin-arm64",
		kind: "tts-binary-archive" as const,
		platform: "darwin" as const,
		arch: "arm64" as const,
		displayName: "Piper TTS (macOS Apple Silicon)",
		license: "MIT (piper)",
		version: PIPER_TAG,
		origin: `https://github.com/rhasspy/piper/releases/tag/${PIPER_TAG}`,
		url: `https://github.com/rhasspy/piper/releases/download/${PIPER_TAG}/piper_macos_aarch64.tar.gz`,
		sha256: "6b1eb03b3735946cb35216e063e7eebcc33a6bbf5dd96ec0217959bf1cdcb0cc",
		estimatedBytes: 19_146_957,
		relativePath: "vendor/piper",
		archive: {
			format: "tar.gz" as const,
			binaryMember: "piper/piper",
			installBinaryAs: "bin/piper",
		},
		notes: "Piper ready; Whisper.cpp official macOS CLI not in b5454 — STT blocked until binary source pinned.",
	}),
	Object.freeze({
		id: "piper-darwin-x64",
		kind: "tts-binary-archive" as const,
		platform: "darwin" as const,
		arch: "x64" as const,
		displayName: "Piper TTS (macOS Intel)",
		license: "MIT (piper)",
		version: PIPER_TAG,
		origin: `https://github.com/rhasspy/piper/releases/tag/${PIPER_TAG}`,
		url: `https://github.com/rhasspy/piper/releases/download/${PIPER_TAG}/piper_macos_x64.tar.gz`,
		sha256: "ced85c0a3df13945b1e623b878a48fdc2854d5c485b4b67f62857cf551deaf8b",
		estimatedBytes: 19_146_927,
		relativePath: "vendor/piper",
		archive: {
			format: "tar.gz" as const,
			binaryMember: "piper/piper",
			installBinaryAs: "bin/piper",
		},
		notes: "Intel macOS Piper. Whisper CLI pin pending.",
	}),
	Object.freeze({
		id: "piper-win-x64",
		kind: "tts-binary-archive" as const,
		platform: "win32" as const,
		arch: "x64" as const,
		displayName: "Piper TTS (Windows amd64)",
		license: "MIT (piper)",
		version: PIPER_TAG,
		origin: `https://github.com/rhasspy/piper/releases/tag/${PIPER_TAG}`,
		url: `https://github.com/rhasspy/piper/releases/download/${PIPER_TAG}/piper_windows_amd64.zip`,
		sha256: "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea",
		estimatedBytes: 22_477_236,
		relativePath: "vendor/piper",
		archive: {
			format: "zip" as const,
			binaryMember: "piper/piper.exe",
			installBinaryAs: "bin/piper.exe",
		},
		notes: "Official Windows zip.",
	}),
	// ——— Spanish voice (Argentina high — already used in lab) ———
	Object.freeze({
		id: "piper-voice-es-ar-daniela-high",
		kind: "tts-voice" as const,
		platform: "linux" as const,
		arch: "x64" as const,
		displayName: "Piper voice es_AR-daniela-high",
		license: "CC-BY-SA-4.0 (OpenSLR 61 / MODEL_CARD)",
		version: "high",
		origin: "https://huggingface.co/rhasspy/piper-voices",
		url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_AR/daniela/high/es_AR-daniela-high.onnx",
		sha256: "7ceb1fc0dab349418c5b54a639ae9ee595212d7c9ea422220d8419163d5cc985",
		estimatedBytes: 114_199_011,
		relativePath: "models/piper/es_AR-daniela-high.onnx",
		notes: "Dataset OpenSLR 61 Attribution-ShareAlike 4.0. Shared across platforms via modelForAll.",
	}),
	Object.freeze({
		id: "piper-voice-es-ar-daniela-high-json",
		kind: "tts-voice-config" as const,
		platform: "linux" as const,
		arch: "x64" as const,
		displayName: "Piper voice config es_AR-daniela-high",
		license: "CC-BY-SA-4.0 (companion to voice)",
		version: "high",
		origin: "https://huggingface.co/rhasspy/piper-voices",
		url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_AR/daniela/high/es_AR-daniela-high.onnx.json",
		sha256: "aedbf69647e1d754c62ecf8e0366ca5f16af3e768e3c6b5329af6eb6bde3852b",
		estimatedBytes: 7_248,
		relativePath: "models/piper/es_AR-daniela-high.onnx.json",
		notes: "Required JSON sidecar for Piper.",
	}),
]);

const SHARED_MODEL_IDS = new Set([
	"whisper-ggml-base-q5_1",
	"piper-voice-es-ar-daniela-high",
	"piper-voice-es-ar-daniela-high-json",
]);

export function detectArch(raw: string = process.arch): CpuArch | "other" {
	if (raw === "x64" || raw === "x86_64") return "x64";
	if (raw === "arm64" || raw === "aarch64") return "arm64";
	return "other";
}

/** Artifacts applicable to this OS/arch, expanding shared model rows. */
export function artifactsFor(platform: VoicePlatform, arch: CpuArch): RuntimeArtifact[] {
	const out: RuntimeArtifact[] = [];
	for (const a of RUNTIME_ARTIFACTS) {
		if (SHARED_MODEL_IDS.has(a.id)) {
			out.push({ ...a, platform, arch });
			continue;
		}
		if (a.platform === platform && a.arch === arch) out.push(a);
	}
	return out;
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
