/**
 * Engine manager contracts (Phase 1).
 * Detection, install planning, and setup are simulated — no real downloads.
 */

import type { VoicePlatform } from "../contracts.ts";

/** Logical engine roles. */
export type EngineRole = "stt" | "tts";

/** Well-known engine ids. Recommended pair: whisper-cpp + piper. */
export type EngineId =
	| "whisper-cpp"
	| "piper"
	| "vosk"
	| "sherpa-onnx"
	| "espeak-ng"
	| "mimic3"
	| "unknown";

export const RECOMMENDED_STT: EngineId = "whisper-cpp";
export const RECOMMENDED_TTS: EngineId = "piper";
/** Human label for docs/UI. */
export const PREFERRED_SHORTCUT_LABEL = "Ctrl+Alt+Space";
/**
 * Pi `KeyId` for the preferred chord (`Key.ctrlAlt("space")`).
 * Register only this id — never invent an alternate binding.
 */
export const PREFERRED_SHORTCUT = "ctrl+alt+space" as const;

export type EngineKind = "recommended" | "alternative" | "incompatible";

export interface EngineSpec {
	readonly id: EngineId;
	readonly role: EngineRole;
	readonly kind: EngineKind;
	readonly displayName: string;
	/** Human-readable download origin for consent UI (not fetched in phase 1). */
	readonly downloadOrigin: string;
	/** Rough install size when Gentle Voice would manage the binary (bytes). */
	readonly estimatedBinaryBytes: number;
	readonly minVersion?: string;
	readonly notes?: string;
}

export type CompatibilityStatus =
	| "compatible"
	| "incompatible"
	| "unknown"
	| "missing";

export interface DetectedEngine {
	readonly spec: EngineSpec;
	readonly status: CompatibilityStatus;
	readonly path?: string;
	readonly version?: string;
	readonly models: readonly DetectedModel[];
	readonly problem?: string;
	/** true when found outside Gentle Voice managed roots (reuse, never modify). */
	readonly external: boolean;
}

export interface DetectedModel {
	readonly id: string;
	readonly path: string;
	readonly languageTags: readonly string[];
	readonly approxBytes?: number;
	readonly compatibleWith: EngineId;
}

export type SetupScenario =
	| "A_none"
	| "B_both_recommended"
	| "C_partial"
	| "D_alternatives"
	| "E_incompatible";

export interface DetectionReport {
	readonly platform: VoicePlatform;
	readonly scenario: SetupScenario;
	readonly stt: readonly DetectedEngine[];
	readonly tts: readonly DetectedEngine[];
	readonly recommendedSttReady: boolean;
	readonly recommendedTtsReady: boolean;
	readonly message: string;
}

export type SetupMode = "recommended" | "reuse" | "advanced";

export interface InstallComponentPlan {
	readonly engineId: EngineId;
	readonly role: EngineRole;
	readonly displayName: string;
	readonly origin: string;
	readonly estimatedBytes: number;
	readonly installRoot: string;
	readonly models: readonly {
		readonly id: string;
		readonly origin: string;
		readonly estimatedBytes: number;
		readonly languageTags: readonly string[];
	}[];
}

/**
 * Simulated install plan. Phase 1 never executes downloads —
 * `executeSimulatedInstall` only records consent + planned paths.
 */
export interface InstallPlan {
	readonly mode: SetupMode;
	readonly components: readonly InstallComponentPlan[];
	readonly totalEstimatedBytes: number;
	readonly requiresConsent: boolean;
	readonly summary: string;
}

export interface SimulatedInstallResult {
	readonly ok: boolean;
	readonly simulated: true;
	readonly installed: readonly string[];
	readonly skipped: readonly string[];
	readonly errors: readonly string[];
}

export interface HardwareProfile {
	readonly platform: VoicePlatform;
	readonly arch: string;
	readonly ramBytes: number;
	readonly cpuCores: number;
	readonly hasGpuHint: boolean;
	readonly gpuLabel?: string;
}

export interface ModelRecommendation {
	readonly engineId: EngineId;
	readonly modelId: string;
	readonly languageTags: readonly string[];
	readonly estimatedBytes: number;
	readonly reason: string;
}

export interface ShortcutAvailability {
	readonly preferred: typeof PREFERRED_SHORTCUT;
	readonly available: boolean;
	readonly registered: boolean;
	readonly reason: string;
}

export interface FirstRunSetupState {
	readonly completed: boolean;
	readonly mode?: SetupMode;
	readonly sttEngineId?: EngineId;
	readonly ttsEngineId?: EngineId;
	readonly installRoot?: string;
	readonly detectedFingerprint?: string;
}
