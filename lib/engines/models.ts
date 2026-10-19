/**
 * Default model selection for recommended engines.
 * Spanish supported from v1. Avoids oversized models on low-RAM hosts.
 */

import type { HardwareProfile, ModelRecommendation } from "./contracts.ts";
import { RECOMMENDED_STT, RECOMMENDED_TTS } from "./contracts.ts";

const GiB = 1024 * 1024 * 1024;

export interface ModelCatalogEntry {
	readonly engineId: typeof RECOMMENDED_STT | typeof RECOMMENDED_TTS;
	readonly modelId: string;
	readonly languageTags: readonly string[];
	readonly estimatedBytes: number;
	/** Minimum RAM hint to prefer this model. */
	readonly minRamBytes: number;
	readonly quality: "tiny" | "base" | "small" | "medium";
}

/** Curated catalog — not downloaded in phase 1. */
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = Object.freeze([
	Object.freeze({
		engineId: RECOMMENDED_STT,
		modelId: "whisper/ggml-tiny.bin",
		languageTags: Object.freeze(["en", "es", "multilingual"]),
		estimatedBytes: 75 * 1024 * 1024,
		minRamBytes: 2 * GiB,
		quality: "tiny" as const,
	}),
	Object.freeze({
		engineId: RECOMMENDED_STT,
		modelId: "whisper/ggml-base.bin",
		languageTags: Object.freeze(["en", "es", "multilingual"]),
		estimatedBytes: 142 * 1024 * 1024,
		minRamBytes: 4 * GiB,
		quality: "base" as const,
	}),
	Object.freeze({
		engineId: RECOMMENDED_STT,
		modelId: "whisper/ggml-small.bin",
		languageTags: Object.freeze(["en", "es", "multilingual"]),
		estimatedBytes: 466 * 1024 * 1024,
		minRamBytes: 8 * GiB,
		quality: "small" as const,
	}),
	Object.freeze({
		engineId: RECOMMENDED_TTS,
		modelId: "piper/es_ES-sharvard-medium.onnx",
		languageTags: Object.freeze(["es"]),
		estimatedBytes: 63 * 1024 * 1024,
		minRamBytes: 2 * GiB,
		quality: "medium" as const,
	}),
	Object.freeze({
		engineId: RECOMMENDED_TTS,
		modelId: "piper/en_US-lessac-medium.onnx",
		languageTags: Object.freeze(["en"]),
		estimatedBytes: 63 * 1024 * 1024,
		minRamBytes: 2 * GiB,
		quality: "medium" as const,
	}),
]);

function preferLanguage(tags: readonly string[], language: string): boolean {
	const lang = language.toLowerCase();
	if (lang === "auto" || lang === "es" || lang.startsWith("es-")) {
		return tags.includes("es") || tags.includes("multilingual");
	}
	if (lang === "en" || lang.startsWith("en-")) {
		return tags.includes("en") || tags.includes("multilingual");
	}
	return tags.includes("multilingual") || tags.length > 0;
}

/**
 * Pick STT + TTS models for the recommended stack given hardware + language.
 */
export function recommendDefaultModels(options: {
	hardware: HardwareProfile;
	language?: string;
}): { stt: ModelRecommendation; tts: ModelRecommendation } {
	const language = options.language ?? "es";
	const ram = options.hardware.ramBytes;

	const sttCandidates = MODEL_CATALOG
		.filter((m) => m.engineId === RECOMMENDED_STT && preferLanguage(m.languageTags, language))
		.filter((m) => ram >= m.minRamBytes)
		.sort((a, b) => b.minRamBytes - a.minRamBytes);

	const sttPick = sttCandidates[0] ?? MODEL_CATALOG.find((m) => m.engineId === RECOMMENDED_STT && m.quality === "tiny")!;

	const preferEs = language === "auto" || language === "es" || language.toLowerCase().startsWith("es");
	const ttsPick = MODEL_CATALOG.find((m) =>
		m.engineId === RECOMMENDED_TTS
		&& (preferEs ? m.languageTags.includes("es") : m.languageTags.includes("en")),
	) ?? MODEL_CATALOG.find((m) => m.engineId === RECOMMENDED_TTS)!;

	return {
		stt: {
			engineId: RECOMMENDED_STT,
			modelId: sttPick.modelId,
			languageTags: sttPick.languageTags,
			estimatedBytes: sttPick.estimatedBytes,
			reason: `Selected ${sttPick.quality} Whisper model for ~${Math.round(ram / GiB)} GiB RAM (Spanish-capable).`,
		},
		tts: {
			engineId: RECOMMENDED_TTS,
			modelId: ttsPick.modelId,
			languageTags: ttsPick.languageTags,
			estimatedBytes: ttsPick.estimatedBytes,
			reason: preferEs
				? "Spanish Piper voice for first-run default."
				: "English Piper voice matching language preference.",
		},
	};
}

/** Model must belong to the engine it will run under. */
export function modelCompatibleWithEngine(modelId: string, engineId: string): boolean {
	const entry = MODEL_CATALOG.find((m) => m.modelId === modelId);
	if (!entry) {
		// Unknown custom path: require matching prefix convention.
		if (engineId === RECOMMENDED_STT) return modelId.includes("whisper") || modelId.endsWith(".bin");
		if (engineId === RECOMMENDED_TTS) return modelId.includes("piper") || modelId.endsWith(".onnx");
		return false;
	}
	return entry.engineId === engineId;
}
