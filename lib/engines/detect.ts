/**
 * Safe engine detection. Never modifies, deletes, or installs binaries.
 * Callers inject probes so unit tests never touch the real filesystem.
 */

import type { VoicePlatform } from "../contracts.ts";
import { detectVoicePlatform } from "../config.ts";
import { ENGINE_CATALOG, specById } from "./catalog.ts";
import type {
	CompatibilityStatus,
	DetectedEngine,
	DetectedModel,
	DetectionReport,
	EngineId,
	EngineSpec,
	SetupScenario,
} from "./contracts.ts";
import { RECOMMENDED_STT, RECOMMENDED_TTS } from "./contracts.ts";

export interface EngineProbeHit {
	readonly engineId: EngineId;
	readonly path: string;
	readonly version?: string;
	readonly models?: readonly DetectedModel[];
	readonly compatible?: boolean;
	readonly problem?: string;
	readonly external?: boolean;
}

/** Injectable discovery surface — real FS probes come in a later phase. */
export interface EngineProbe {
	listHits(): Promise<readonly EngineProbeHit[]> | readonly EngineProbeHit[];
}

function classifyStatus(hit: EngineProbeHit, spec: EngineSpec): CompatibilityStatus {
	if (spec.kind === "incompatible") return "incompatible";
	if (hit.compatible === false) return "incompatible";
	if (hit.compatible === true) return "compatible";
	return "unknown";
}

function toDetected(hit: EngineProbeHit): DetectedEngine | undefined {
	const spec = specById(hit.engineId);
	if (!spec) return undefined;
	const status = classifyStatus(hit, spec);
	const problem = hit.problem ?? (status === "incompatible" ? "version or ABI incompatible" : undefined);
	return {
		spec,
		status,
		path: hit.path,
		models: hit.models ?? [],
		external: hit.external ?? true,
		...(hit.version ? { version: hit.version } : {}),
		...(problem ? { problem } : {}),
	};
}

function pickReady(engines: readonly DetectedEngine[], id: EngineId): boolean {
	return engines.some((e) => e.spec.id === id && e.status === "compatible");
}

export function classifyScenario(stt: readonly DetectedEngine[], tts: readonly DetectedEngine[]): SetupScenario {
	const sttRec = pickReady(stt, RECOMMENDED_STT);
	const ttsRec = pickReady(tts, RECOMMENDED_TTS);
	const sttAnyCompat = stt.some((e) => e.status === "compatible");
	const ttsAnyCompat = tts.some((e) => e.status === "compatible");
	const sttIncompatOnly = stt.length > 0 && stt.every((e) => e.status === "incompatible") && !sttAnyCompat;
	const ttsIncompatOnly = tts.length > 0 && tts.every((e) => e.status === "incompatible") && !ttsAnyCompat;

	if (!sttAnyCompat && !ttsAnyCompat) {
		if (sttIncompatOnly || ttsIncompatOnly) return "E_incompatible";
		return "A_none";
	}
	if (sttRec && ttsRec) return "B_both_recommended";
	if ((sttRec && !ttsRec) || (!sttRec && ttsRec)) return "C_partial";
	if ((!sttRec && sttAnyCompat) || (!ttsRec && ttsAnyCompat)) return "D_alternatives";
	if (sttIncompatOnly || ttsIncompatOnly) return "E_incompatible";
	return "A_none";
}

function scenarioMessage(scenario: SetupScenario, sttRec: boolean, ttsRec: boolean): string {
	switch (scenario) {
		case "A_none":
			return "No compatible STT/TTS engines found. Offer recommended Whisper.cpp + Piper install (with consent).";
		case "B_both_recommended":
			return "Whisper.cpp and Piper detected and compatible — reuse without reinstall.";
		case "C_partial":
			return sttRec
				? "Whisper.cpp ready; Piper missing — offer install of Piper only."
				: "Piper ready; Whisper.cpp missing — offer install of Whisper.cpp only.";
		case "D_alternatives":
			return "Compatible alternative engines detected. User may reuse them or choose recommended Whisper.cpp + Piper.";
		case "E_incompatible":
			return "An engine was found but is incompatible. Do not modify it; recommend Whisper.cpp + Piper.";
		default:
			return "Unknown detection scenario.";
	}
}

/**
 * Empty probe — used when no discovery is configured (default phase 1 unit path).
 */
export function emptyEngineProbe(): EngineProbe {
	return { listHits: () => [] };
}

/**
 * Build a deterministic probe from explicit hits (tests / fixtures).
 */
export function staticEngineProbe(hits: readonly EngineProbeHit[]): EngineProbe {
	return { listHits: () => hits };
}

export async function detectEngines(options?: {
	platform?: VoicePlatform;
	probe?: EngineProbe;
}): Promise<DetectionReport> {
	const platform = options?.platform ?? detectVoicePlatform();
	const probe = options?.probe ?? emptyEngineProbe();
	const hits = await probe.listHits();
	const detected = hits.map(toDetected).filter((d): d is DetectedEngine => Boolean(d));

	const stt = detected.filter((d) => d.spec.role === "stt");
	const tts = detected.filter((d) => d.spec.role === "tts");
	const recommendedSttReady = pickReady(stt, RECOMMENDED_STT);
	const recommendedTtsReady = pickReady(tts, RECOMMENDED_TTS);
	const scenario = classifyScenario(stt, tts);

	return {
		platform,
		scenario,
		stt,
		tts,
		recommendedSttReady,
		recommendedTtsReady,
		message: scenarioMessage(scenario, recommendedSttReady, recommendedTtsReady),
	};
}

/** Fingerprint of detection for “do not re-ask setup” unless components change. */
export function detectionFingerprint(report: DetectionReport): string {
	const parts = [
		report.scenario,
		...report.stt.map((e) => `stt:${e.spec.id}:${e.status}:${e.path ?? ""}:${e.version ?? ""}`),
		...report.tts.map((e) => `tts:${e.spec.id}:${e.status}:${e.path ?? ""}:${e.version ?? ""}`),
	];
	return parts.join("|");
}

export { ENGINE_CATALOG };
