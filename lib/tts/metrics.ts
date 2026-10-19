/**
 * TTS / playback metrics collection helpers (Phase 2B.1).
 * Ready for lab benches; does not spawn engines by itself.
 */

import type { TtsProviderMetrics } from "./providers.ts";

export interface SpeakBenchSample extends TtsProviderMetrics {
	readonly profileId?: string;
	readonly providerId?: string;
	readonly phraseChars: number;
	readonly mutedSkipped: boolean;
	readonly orphanProcesses: number;
	readonly recordedAt: string;
}

export function emptySpeakBench(phraseChars: number): SpeakBenchSample {
	return {
		phraseChars,
		mutedSkipped: false,
		orphanProcesses: 0,
		recordedAt: new Date().toISOString(),
	};
}

/** Format a sample as a single log line for gs-lab/logs. */
export function formatSpeakBenchLine(sample: SpeakBenchSample): string {
	const parts = [
		sample.recordedAt,
		`provider=${sample.providerId ?? "?"}`,
		`profile=${sample.profileId ?? "?"}`,
		`synthMs=${sample.synthesizeMs ?? "-"}`,
		`ttfbMs=${sample.timeToPlaybackStartMs ?? "-"}`,
		`rssKb=${sample.peakRssKb ?? "-"}`,
		`modelB=${sample.modelBytes ?? "-"}`,
		`durSec=${sample.audioDurationSec ?? "-"}`,
		`audioB=${sample.audioBytes ?? "-"}`,
		`mos=${sample.userQualityScore ?? "-"}`,
		`mutedSkip=${sample.mutedSkipped ? 1 : 0}`,
		`orphans=${sample.orphanProcesses}`,
	];
	return parts.join(" ");
}
