/**
 * Repair a partial Pi uninstall: settings.json still lists npm:gentle-voice
 * while the npm root no longer has the dependency.
 *
 * Pure helpers — never writes ~/.pi unless the caller passes that path explicitly.
 */

export interface PiSettingsLike {
	packages?: unknown;
	[key: string]: unknown;
}

export interface SettingsRepairPlan {
	readonly changed: boolean;
	readonly removed: readonly string[];
	readonly kept: readonly string[];
	readonly nextPackages: readonly string[];
}

/** Match Pi package specs that load Gentle Voice (npm, git, or relative path). */
export function isGentleVoicePackageSpec(spec: string): boolean {
	const s = spec.trim();
	if (s === "npm:gentle-voice" || s === "gentle-voice") return true;
	if (/^npm:gentle-voice(?:@|$)/.test(s)) return true;
	if (/^git:.*gentle-voice/i.test(s)) return true;
	// Lab relative / absolute path to the repo (settings may list checkout)
	if (/(^|[\\/])gentle-voice\/?$/.test(s)) return true;
	return false;
}

/**
 * Compute next packages[] without Gentle Voice entries.
 * Does not touch other packages.
 */
export function planRemoveGentleVoiceFromSettings(
	settings: PiSettingsLike,
): SettingsRepairPlan {
	const raw = Array.isArray(settings.packages) ? settings.packages : [];
	const kept: string[] = [];
	const removed: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		if (isGentleVoicePackageSpec(item)) removed.push(item);
		else kept.push(item);
	}
	return {
		changed: removed.length > 0,
		removed,
		kept,
		nextPackages: kept,
	};
}

export function applyRemoveGentleVoiceFromSettings(
	settings: PiSettingsLike,
): { settings: PiSettingsLike; plan: SettingsRepairPlan } {
	const plan = planRemoveGentleVoiceFromSettings(settings);
	if (!plan.changed) return { settings, plan };
	return {
		settings: { ...settings, packages: [...plan.nextPackages] },
		plan,
	};
}

/**
 * Detect partial uninstall given settings packages and npm package.json deps.
 */
export function detectPartialGentleVoiceUninstall(input: {
	readonly settingsPackages: readonly string[];
	readonly npmDependencyNames: readonly string[];
}): {
	readonly registeredInSettings: boolean;
	readonly presentInNpmDeps: boolean;
	readonly partial: boolean;
} {
	const registeredInSettings = input.settingsPackages.some(isGentleVoicePackageSpec);
	const presentInNpmDeps = input.npmDependencyNames.includes("gentle-voice");
	return {
		registeredInSettings,
		presentInNpmDeps,
		partial: registeredInSettings && !presentInNpmDeps,
	};
}
