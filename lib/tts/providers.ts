/**
 * Interchangeable TTS provider contracts (Phase 2B.1).
 * Implementations may wrap Piper today; future engines plug in without
 * changing VoiceSession. No downloads happen from this module.
 */

import type { AdapterAvailability, AudioChunk, TtsAdapter } from "../contracts.ts";

/** Named quality tier — mapped to concrete engines/voices by Lab/config. */
export type TtsQualityProfileId = "light" | "balanced" | "natural";

export interface TtsProviderInfo {
	readonly id: string;
	readonly displayName: string;
	readonly engine: "piper" | "espeak-ng" | "sherpa-onnx" | "kokoro" | "vibevoice" | "other";
	readonly platforms: readonly ("linux" | "win32" | "darwin")[];
	/** Verified on this machine in-lab; false = research-only claim. */
	readonly verifiedLocally: boolean;
	readonly licenseHint: string;
	readonly notes: string;
}

export interface TtsProviderMetrics {
	readonly synthesizeMs?: number;
	readonly timeToPlaybackStartMs?: number;
	readonly peakRssKb?: number;
	readonly modelBytes?: number;
	readonly audioDurationSec?: number;
	readonly audioBytes?: number;
	readonly sampleRateHz?: number;
	/** 1–5 user MOS-style score when collected. */
	readonly userQualityScore?: number;
}

export interface TtsProvider extends TtsAdapter {
	readonly info: TtsProviderInfo;
	readonly lastMetrics: TtsProviderMetrics | undefined;
}

export interface TtsQualityProfile {
	readonly id: TtsQualityProfileId;
	readonly label: string;
	readonly goal: string;
	/** Preferred provider ids in order (first available wins when wired). */
	readonly preferredProviders: readonly string[];
	readonly maxModelBytesHint?: number;
	readonly notes: string;
}

/** Wrap an existing TtsAdapter as a named provider (metrics optional). */
export function wrapTtsAdapterAsProvider(
	adapter: TtsAdapter,
	info: TtsProviderInfo,
	getMetrics?: () => TtsProviderMetrics | undefined,
): TtsProvider {
	return {
		id: adapter.id,
		info,
		get lastMetrics() {
			return getMetrics?.();
		},
		availability: () => adapter.availability(),
		synthesize: (text, opts) => adapter.synthesize(text, opts),
	};
}

export async function probeProvider(provider: TtsProvider): Promise<{
	availability: AdapterAvailability;
	info: TtsProviderInfo;
}> {
	return {
		availability: await provider.availability(),
		info: provider.info,
	};
}

/** Empty chunk helper for dry probes. */
export const EMPTY_TTS_CHUNK: AudioChunk = Object.freeze({
	bytes: new Uint8Array(0),
	sampleRateHz: 22_050,
	channels: 1,
	format: "wav" as const,
});
