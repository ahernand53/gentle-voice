/**
 * Simulated install planner. Phase 1 never downloads or writes binaries.
 * Consent + plan only; executeSimulatedInstall records intent for tests.
 */

import { join } from "node:path";
import { specById } from "./catalog.ts";
import type {
	DetectionReport,
	InstallComponentPlan,
	InstallPlan,
	ModelRecommendation,
	SetupMode,
	SimulatedInstallResult,
} from "./contracts.ts";
import { RECOMMENDED_STT, RECOMMENDED_TTS } from "./contracts.ts";
import { recommendDefaultModels } from "./models.ts";
import type { HardwareProfile } from "./contracts.ts";

export interface PlanInstallOptions {
	readonly report: DetectionReport;
	readonly mode: SetupMode;
	readonly installRoot: string;
	readonly hardware: HardwareProfile;
	readonly language?: string;
	/** Advanced: explicit engine ids (must be known). */
	readonly sttEngineId?: string;
	readonly ttsEngineId?: string;
	/** When false, plan is built but marked as requiring consent before any future real install. */
	readonly userConsent?: boolean;
}

function componentFor(
	engineId: typeof RECOMMENDED_STT | typeof RECOMMENDED_TTS,
	installRoot: string,
	model: ModelRecommendation,
): InstallComponentPlan {
	const spec = specById(engineId)!;
	return {
		engineId,
		role: spec.role,
		displayName: spec.displayName,
		origin: spec.downloadOrigin,
		estimatedBytes: spec.estimatedBinaryBytes + model.estimatedBytes,
		installRoot: join(installRoot, engineId),
		models: [
			{
				id: model.modelId,
				origin: `${spec.downloadOrigin} (model artifact — not fetched in phase 1)`,
				estimatedBytes: model.estimatedBytes,
				languageTags: model.languageTags,
			},
		],
	};
}

/**
 * Build an install plan for scenarios A/C (and optional D when user picks recommended).
 * Reuse modes produce empty component lists.
 */
export function buildInstallPlan(options: PlanInstallOptions): InstallPlan {
	const { report, mode, installRoot, hardware, language } = options;
	const models = recommendDefaultModels({ hardware, language: language ?? "es" });

	if (mode === "reuse") {
		return {
			mode,
			components: [],
			totalEstimatedBytes: 0,
			requiresConsent: false,
			summary: "Reuse compatible engines already on disk — no download.",
		};
	}

	const needStt = mode === "recommended"
		? !report.recommendedSttReady
		: Boolean(options.sttEngineId === RECOMMENDED_STT && !report.recommendedSttReady);
	const needTts = mode === "recommended"
		? !report.recommendedTtsReady
		: Boolean(options.ttsEngineId === RECOMMENDED_TTS && !report.recommendedTtsReady);

	// Advanced with alternatives: if user selected non-recommended, do not plan install for them.
	if (mode === "advanced") {
		const sttId = options.sttEngineId;
		const ttsId = options.ttsEngineId;
		const components: InstallComponentPlan[] = [];
		if (sttId === RECOMMENDED_STT && !report.recommendedSttReady) {
			components.push(componentFor(RECOMMENDED_STT, installRoot, models.stt));
		}
		if (ttsId === RECOMMENDED_TTS && !report.recommendedTtsReady) {
			components.push(componentFor(RECOMMENDED_TTS, installRoot, models.tts));
		}
		const total = components.reduce((n, c) => n + c.estimatedBytes, 0);
		return {
			mode,
			components,
			totalEstimatedBytes: total,
			requiresConsent: components.length > 0,
			summary: components.length === 0
				? "Advanced selection uses existing/alternative engines — nothing to install."
				: `Advanced plan would install: ${components.map((c) => c.displayName).join(", ")}.`,
		};
	}

	const components: InstallComponentPlan[] = [];
	if (needStt) components.push(componentFor(RECOMMENDED_STT, installRoot, models.stt));
	if (needTts) components.push(componentFor(RECOMMENDED_TTS, installRoot, models.tts));

	const total = components.reduce((n, c) => n + c.estimatedBytes, 0);
	return {
		mode,
		components,
		totalEstimatedBytes: total,
		requiresConsent: components.length > 0,
		summary: components.length === 0
			? "Recommended engines already present."
			: `Would install ${components.map((c) => c.displayName).join(" + ")} (~${Math.round(total / (1024 * 1024))} MiB) into ${installRoot} after consent.`,
	};
}

/**
 * Phase 1 “install”: records consent and returns simulated outcome.
 * Never touches the network or writes engine binaries.
 */
export function executeSimulatedInstall(plan: InstallPlan, options?: {
	userConsent?: boolean;
	failEngineId?: string;
}): SimulatedInstallResult {
	if (plan.components.length === 0) {
		return { ok: true, simulated: true, installed: [], skipped: [], errors: [] };
	}
	if (plan.requiresConsent && options?.userConsent !== true) {
		return {
			ok: false,
			simulated: true,
			installed: [],
			skipped: plan.components.map((c) => c.engineId),
			errors: ["consent_required"],
		};
	}
	const installed: string[] = [];
	const skipped: string[] = [];
	const errors: string[] = [];
	for (const c of plan.components) {
		if (options?.failEngineId === c.engineId) {
			skipped.push(c.engineId);
			errors.push(`simulated_failure:${c.engineId}`);
			continue;
		}
		installed.push(c.engineId);
	}
	return {
		ok: errors.length === 0,
		simulated: true,
		installed,
		skipped,
		errors,
	};
}

/** Format consent preview for UI / tests. */
export function formatInstallConsent(plan: InstallPlan): string {
	const lines = [
		"Gentle Voice install preview (SIMULATED — no download in phase 1)",
		plan.summary,
		"",
	];
	for (const c of plan.components) {
		lines.push(`- ${c.displayName} (${c.engineId})`);
		lines.push(`  origin: ${c.origin}`);
		lines.push(`  size≈ ${Math.round(c.estimatedBytes / (1024 * 1024))} MiB`);
		lines.push(`  path: ${c.installRoot}`);
		for (const m of c.models) {
			lines.push(`  model: ${m.id} (~${Math.round(m.estimatedBytes / (1024 * 1024))} MiB) langs=${m.languageTags.join(",")}`);
		}
	}
	return lines.join("\n");
}
