/**
 * Static engine catalog. Recommended = whisper-cpp + piper (validated target, not universal supremacy claim).
 */

import type { EngineSpec } from "./contracts.ts";
import { RECOMMENDED_STT, RECOMMENDED_TTS } from "./contracts.ts";

export const ENGINE_CATALOG: readonly EngineSpec[] = Object.freeze([
	Object.freeze({
		id: RECOMMENDED_STT,
		role: "stt" as const,
		kind: "recommended" as const,
		displayName: "Whisper.cpp",
		downloadOrigin: "https://github.com/ggerganov/whisper.cpp",
		estimatedBinaryBytes: 25 * 1024 * 1024,
		minVersion: "1.5.0",
		notes: "Official recommended STT adapter target for Gentle Voice.",
	}),
	Object.freeze({
		id: RECOMMENDED_TTS,
		role: "tts" as const,
		kind: "recommended" as const,
		displayName: "Piper",
		downloadOrigin: "https://github.com/rhasspy/piper",
		estimatedBinaryBytes: 40 * 1024 * 1024,
		minVersion: "1.2.0",
		notes: "Official recommended TTS adapter target for Gentle Voice.",
	}),
	Object.freeze({
		id: "vosk" as const,
		role: "stt" as const,
		kind: "alternative" as const,
		displayName: "Vosk",
		downloadOrigin: "https://alphacephei.com/vosk",
		estimatedBinaryBytes: 15 * 1024 * 1024,
		notes: "Alternative local STT via adapter (phase 1 detect-only).",
	}),
	Object.freeze({
		id: "sherpa-onnx" as const,
		role: "stt" as const,
		kind: "alternative" as const,
		displayName: "Sherpa-ONNX",
		downloadOrigin: "https://github.com/k2-fsa/sherpa-onnx",
		estimatedBinaryBytes: 30 * 1024 * 1024,
		notes: "Alternative local STT via adapter (phase 1 detect-only).",
	}),
	Object.freeze({
		id: "espeak-ng" as const,
		role: "tts" as const,
		kind: "alternative" as const,
		displayName: "eSpeak NG",
		downloadOrigin: "https://github.com/espeak-ng/espeak-ng",
		estimatedBinaryBytes: 8 * 1024 * 1024,
		notes: "Alternative local TTS via adapter (phase 1 detect-only).",
	}),
	Object.freeze({
		id: "mimic3" as const,
		role: "tts" as const,
		kind: "alternative" as const,
		displayName: "Mimic 3",
		downloadOrigin: "https://github.com/MycroftAI/mimic3",
		estimatedBinaryBytes: 50 * 1024 * 1024,
		notes: "Alternative local TTS via adapter (phase 1 detect-only).",
	}),
]);

export function specById(id: string): EngineSpec | undefined {
	return ENGINE_CATALOG.find((s) => s.id === id);
}

export function specsForRole(role: "stt" | "tts"): readonly EngineSpec[] {
	return ENGINE_CATALOG.filter((s) => s.role === role);
}
