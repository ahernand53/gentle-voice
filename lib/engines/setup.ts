/**
 * First-run setup orchestration (detect → mode → plan).
 * Does not persist to disk unless caller writes config explicitly.
 */

import type { DetectionReport, EngineId, FirstRunSetupState, InstallPlan, SetupMode } from "./contracts.ts";
import { detectionFingerprint, detectEngines, type EngineProbe } from "./detect.ts";
import { buildInstallPlan } from "./install-plan.ts";
import { readHardwareProfile, type HardwareProbe } from "./hardware.ts";
import type { HardwareProfile } from "./contracts.ts";
import type { VoicePlatform } from "../contracts.ts";

export interface SetupSession {
	readonly report: DetectionReport;
	readonly hardware: HardwareProfile;
	readonly fingerprint: string;
	readonly suggestedMode: SetupMode;
}

export function suggestSetupMode(report: DetectionReport): SetupMode {
	switch (report.scenario) {
		case "B_both_recommended":
			return "reuse";
		case "D_alternatives":
			return "reuse";
		case "A_none":
		case "C_partial":
		case "E_incompatible":
			return "recommended";
		default:
			return "recommended";
	}
}

export async function beginSetup(options?: {
	platform?: VoicePlatform;
	probe?: EngineProbe;
	hardwareProbe?: HardwareProbe;
}): Promise<SetupSession> {
	const report = await detectEngines({
		...(options?.platform ? { platform: options.platform } : {}),
		...(options?.probe ? { probe: options.probe } : {}),
	});
	const hardware = readHardwareProfile({
		...(options?.platform ? { platform: options.platform } : {}),
		...(options?.hardwareProbe ? { probe: options.hardwareProbe } : {}),
	});
	const fingerprint = detectionFingerprint(report);
	return {
		report,
		hardware,
		fingerprint,
		suggestedMode: suggestSetupMode(report),
	};
}

export function planFromSetup(session: SetupSession, options: {
	mode: SetupMode;
	installRoot: string;
	language?: string;
	sttEngineId?: string;
	ttsEngineId?: string;
}): InstallPlan {
	return buildInstallPlan({
		report: session.report,
		mode: options.mode,
		installRoot: options.installRoot,
		hardware: session.hardware,
		...(options.language ? { language: options.language } : {}),
		...(options.sttEngineId ? { sttEngineId: options.sttEngineId } : {}),
		...(options.ttsEngineId ? { ttsEngineId: options.ttsEngineId } : {}),
	});
}

/** Skip re-prompt when fingerprint matches completed setup. */
export function shouldRepromptSetup(state: FirstRunSetupState, fingerprint: string): boolean {
	if (!state.completed) return true;
	if (!state.detectedFingerprint) return true;
	return state.detectedFingerprint !== fingerprint;
}

export function completeSetupState(session: SetupSession, options: {
	mode: SetupMode;
	sttEngineId: string;
	ttsEngineId: string;
	installRoot?: string;
}): FirstRunSetupState {
	return {
		completed: true,
		mode: options.mode,
		sttEngineId: options.sttEngineId as EngineId,
		ttsEngineId: options.ttsEngineId as EngineId,
		detectedFingerprint: session.fingerprint,
		...(options.installRoot ? { installRoot: options.installRoot } : {}),
	};
}
