/**
 * Lab-only: ensure `voice-ai` exists as a **role** inside the OpenSource profile
 * (Profile routing list), NOT as a sibling top-level profile.
 *
 * Does NOT change `active`, `orchestrator`, or any other role bodies.
 * Removes a mistaken top-level `voice-ai` profile if present (prior wrong seed).
 *
 * Note: primary chat still uses the profile **orchestrator**. Gentle Voice may
 * use this role for a **second** tools-less narration inference (Voice AI) —
 * never as the main chat model. See docs/voice-ai.md.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Role key inside OpenSource (appears under Profile routing). */
export const VOICE_AI_ROLE_NAME = "voice-ai" as const;

/** @deprecated Old mistaken top-level profile name — removed on ensure. */
export const VOICE_AI_PROFILE_NAME = VOICE_AI_ROLE_NAME;

/** Host profile that owns the voice-ai role (lab default). */
export const VOICE_AI_HOST_PROFILE_DEFAULT = "OpenSource" as const;

/** NaN Builders MiMo — adaptive reasoning. */
export const VOICE_AI_MODEL_ID = "nan/mimo-v2.6-flash" as const;

export const VOICE_AI_THINKING = "low" as const;

export const VOICE_AI_ROLE_ENTRY = Object.freeze({
	model: VOICE_AI_MODEL_ID,
	thinking: VOICE_AI_THINKING,
});

const PROFILES_KIND = "gentle-pi.agent_model_profiles";
const PROFILES_VERSION = 1;

export type RoutingEntry = { model?: string; thinking?: string };
export type ProfileConfig = Record<string, RoutingEntry>;

export interface LabProfilesFile {
	kind: typeof PROFILES_KIND;
	version: typeof PROFILES_VERSION;
	active?: string;
	profiles: Record<string, ProfileConfig>;
}

export function resolveLabGentleConfigHome(env: NodeJS.ProcessEnv = process.env): string {
	const piHome = env.GENTLE_PI_CONFIG_HOME?.trim();
	if (piHome) return piHome;
	const shellHome = env.GENTLE_SHELL_CONFIG_HOME?.trim();
	if (shellHome) return shellHome;
	return join(env.HOME ?? "/tmp", ".pi", "gentle-ai");
}

export function resolveProfilesHomeForLabSeed(env: NodeJS.ProcessEnv = process.env): {
	readonly configHome: string;
	readonly shared: boolean;
} {
	const explicitPi = env.GENTLE_PI_CONFIG_HOME?.trim();
	if (explicitPi) return { configHome: explicitPi, shared: false };
	const sharedHome = join(env.HOME ?? "/tmp", ".pi", "gentle-ai");
	return { configHome: sharedHome, shared: true };
}

export function profilesJsonPath(configHome: string): string {
	return join(configHome, "profiles.json");
}

export function hostProfileName(env: NodeJS.ProcessEnv = process.env): string {
	return env.GENTLE_VOICE_AI_HOST_PROFILE?.trim() || VOICE_AI_HOST_PROFILE_DEFAULT;
}

export function emptyLabProfilesFile(): LabProfilesFile {
	return {
		kind: PROFILES_KIND,
		version: PROFILES_VERSION,
		profiles: {},
	};
}

export function readLabProfilesFile(path: string): LabProfilesFile {
	if (!existsSync(path)) return emptyLabProfilesFile();
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<LabProfilesFile>;
		if (raw.kind !== PROFILES_KIND || raw.version !== PROFILES_VERSION) {
			return emptyLabProfilesFile();
		}
		return {
			kind: PROFILES_KIND,
			version: PROFILES_VERSION,
			...(typeof raw.active === "string" ? { active: raw.active } : {}),
			profiles: raw.profiles && typeof raw.profiles === "object" ? { ...raw.profiles } : {},
		};
	} catch {
		return emptyLabProfilesFile();
	}
}

export interface EnsureVoiceAiProfileResult {
	readonly path: string;
	readonly configHome: string;
	readonly hostProfile: string;
	readonly created: boolean;
	readonly updated: boolean;
	readonly removedTopLevelProfile: boolean;
	readonly model: string;
	readonly thinking: string;
	readonly refused?: boolean;
	readonly reason?: string;
}

/**
 * Upsert OpenSource.voice-ai role (MiMo). Preserve orchestrator + all other roles.
 * Strip mistaken top-level profiles.voice-ai if it exists.
 */
export function ensureVoiceAiProfile(
	env: NodeJS.ProcessEnv = process.env,
): EnsureVoiceAiProfileResult {
	if (env.GENTLE_VOICE_LAB !== "1") {
		return {
			path: "",
			configHome: "",
			hostProfile: hostProfileName(env),
			created: false,
			updated: false,
			removedTopLevelProfile: false,
			model: VOICE_AI_MODEL_ID,
			thinking: VOICE_AI_THINKING,
			refused: true,
			reason: "GENTLE_VOICE_LAB required",
		};
	}

	const { configHome, shared } = resolveProfilesHomeForLabSeed(env);
	const path = profilesJsonPath(configHome);
	const host = hostProfileName(env);

	if (shared && env.GENTLE_VOICE_LAB_ALLOW_SHARED_PROFILES !== "1") {
		return {
			path,
			configHome,
			hostProfile: host,
			created: false,
			updated: false,
			removedTopLevelProfile: false,
			model: VOICE_AI_MODEL_ID,
			thinking: VOICE_AI_THINKING,
			refused: true,
			reason: "refused_shared_profiles_home — set GENTLE_VOICE_LAB_ALLOW_SHARED_PROFILES=1",
		};
	}

	const file = readLabProfilesFile(path);
	const hostConfig = file.profiles[host];
	if (!hostConfig) {
		return {
			path,
			configHome,
			hostProfile: host,
			created: false,
			updated: false,
			removedTopLevelProfile: false,
			model: VOICE_AI_MODEL_ID,
			thinking: VOICE_AI_THINKING,
			refused: true,
			reason: `host profile missing: ${host}`,
		};
	}

	const existingRole = hostConfig[VOICE_AI_ROLE_NAME];
	const same = existingRole?.model === VOICE_AI_MODEL_ID
		&& (existingRole.thinking === VOICE_AI_THINKING || existingRole.thinking === undefined);
	// Prior mistake: voice-ai as sibling profile under profiles{} (not a role inside OpenSource).
	const hadTopLevel = host !== VOICE_AI_ROLE_NAME
		&& Object.prototype.hasOwnProperty.call(file.profiles, VOICE_AI_ROLE_NAME);

	if (same && existingRole && !hadTopLevel) {
		return {
			path,
			configHome,
			hostProfile: host,
			created: false,
			updated: false,
			removedTopLevelProfile: false,
			model: VOICE_AI_MODEL_ID,
			thinking: VOICE_AI_THINKING,
		};
	}

	const created = !existingRole;
	const nextHost: ProfileConfig = {
		...hostConfig,
		[VOICE_AI_ROLE_NAME]: { ...VOICE_AI_ROLE_ENTRY },
	};

	const nextProfiles: Record<string, ProfileConfig> = {
		...file.profiles,
		[host]: nextHost,
	};
	let removedTopLevelProfile = false;
	if (hadTopLevel) {
		delete nextProfiles[VOICE_AI_ROLE_NAME];
		removedTopLevelProfile = true;
	}

	const next: LabProfilesFile = {
		kind: PROFILES_KIND,
		version: PROFILES_VERSION,
		...(file.active !== undefined ? { active: file.active } : {}),
		profiles: nextProfiles,
	};

	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });

	return {
		path,
		configHome,
		hostProfile: host,
		created,
		updated: !created || removedTopLevelProfile,
		removedTopLevelProfile,
		model: VOICE_AI_MODEL_ID,
		thinking: VOICE_AI_THINKING,
	};
}
