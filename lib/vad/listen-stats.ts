/**
 * Live listen facts. Numbers only — never audio and never a transcript.
 */

export interface ListenStats {
	readonly stage: "capturing" | "voice" | "waiting_end";
	readonly device: string;
	readonly backend: string;
	readonly chunks: number;
	readonly peak: number;
	readonly rms: number;
	readonly durationMs: number;
	readonly speechProb?: number;
	readonly voicedMs: number;
	readonly speechSeen: boolean;
	readonly phase: string;
	readonly whisper: "not_called";
	readonly inferenceError?: string;
}

export function formatListenHint(stats: ListenStats): string {
	const stage = stats.stage === "waiting_end"
		? "Waiting for end of speech"
		: stats.stage === "voice"
			? "Voice detected"
			: "Capturing audio";
	const prob = stats.speechProb === undefined ? "" : ` prob ${stats.speechProb.toFixed(2)}`;
	const error = stats.inferenceError ? ` error ${stats.inferenceError}` : "";
	return [
		stage,
		stats.device,
		stats.backend,
		`chunks ${stats.chunks}`,
		`peak ${stats.peak.toFixed(3)}`,
		`rms ${stats.rms.toFixed(3)}`,
		`voiced ${Math.round(stats.voicedMs)}ms`,
		`${stats.durationMs}ms`,
		`whisper ${stats.whisper}`,
	].join(" · ") + prob + error;
}
