/**
 * Clear readiness ladder for engines/adapters.
 * Never inflate "dry-run validated" into "operational" or "real audio proven".
 */

export type AdapterReadiness =
	| "detected"
	| "dry_run_validated"
	| "operational"
	| "real_audio_proven";

export interface AdapterReadinessReport {
	readonly id: string;
	readonly readiness: AdapterReadiness;
	readonly detail: string;
}

/** Phase 1C lab snapshot — update only with evidence. */
export const PHASE1C_ADAPTER_READINESS: readonly AdapterReadinessReport[] = Object.freeze([
	Object.freeze({
		id: "piper-tts",
		readiness: "dry_run_validated" as const,
		detail:
			"CLI + es_AR-daniela-high found; dry-run synthesize plans argv without spawn/playback. NOT operational until real synth succeeds.",
	}),
	Object.freeze({
		id: "whisper-cpp-stt",
		readiness: "detected" as const,
		detail:
			"Voxtype ggml-small.bin magic OK (reference-only). whisper-cli missing → not dry-run-validated for STT execute path.",
	}),
	Object.freeze({
		id: "capture",
		readiness: "detected" as const,
		detail: "Platform backend catalog declared; only stub implemented. No mic.",
	}),
	Object.freeze({
		id: "playback",
		readiness: "detected" as const,
		detail: "Platform backend catalog declared; only stub implemented. No speaker I/O.",
	}),
]);

export function isFullyOperational(r: AdapterReadiness): boolean {
	return r === "operational" || r === "real_audio_proven";
}
