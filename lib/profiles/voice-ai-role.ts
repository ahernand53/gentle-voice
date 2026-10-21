/**
 * Production seed for the `voice-ai` role.
 *
 * The role is added empty. Model and thinking are chosen later in `/gentle:models`.
 * A missing profiles file is never created. An existing `voice-ai` entry is never overwritten.
 * The write stays on this host's Gentle AI store and does not fall through to the other product.
 */

import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
	defaultGentleShellPrefixFromAgent,
	isDefaultGentleShellAgentDir,
	isPathInside,
	pathsEqual,
} from "../runtime/storage.ts";

export const VOICE_AI_ROLE_NAME = "voice-ai" as const;

const PROFILES_KIND = "gentle-pi.agent_model_profiles";
const PROFILES_VERSION = 1;

export type VoiceAiRoleStatus = "missing" | "invalid" | "unchanged" | "updated";

export interface EnsureVoiceAiRolesResult {
	readonly path: string;
	readonly status: VoiceAiRoleStatus;
	readonly added: readonly string[];
	readonly reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function homeDir(env: NodeJS.ProcessEnv): string {
	return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

function piProfilesFile(env: NodeJS.ProcessEnv): string {
	const explicit = env.GENTLE_PI_CONFIG_HOME?.trim();
	const dir = explicit && isAbsolute(explicit) ? explicit : join(homeDir(env), ".pi", "gentle-ai");
	return join(dir, "profiles.json");
}

/**
 * Profiles file for the host that is actually running.
 *
 * Bundled Gentle Shell: `<prefix>/config/gentle-ai/profiles.json`.
 * Isolated Gentle Shell: `GENTLE_SHELL_CONFIG_HOME`, or `<prefix>/gentle-ai` beside the agent dir.
 * Pi, and Gentle Shell `--link`: `~/.pi/gentle-ai/profiles.json`.
 */
export function resolveHostProfilesFile(env: NodeJS.ProcessEnv = process.env): string {
	const prefix = env.GENTLE_SHELL_PREFIX?.trim();
	const agent = env.GENTLE_PI_AGENT_HOME?.trim() || env.PI_CODING_AGENT_DIR?.trim();
	if (prefix && isAbsolute(prefix) && agent && isPathInside(prefix, agent)) {
		return join(prefix, "config", "gentle-ai", "profiles.json");
	}

	const userPi = env.GENTLE_SHELL_USER_PI_HOME?.trim();
	if (agent && userPi && pathsEqual(agent, userPi)) return piProfilesFile(env);

	const marker = env.GENTLE_SHELL_CONFIG_HOME?.trim();
	if (marker && isAbsolute(marker)) return join(marker, "profiles.json");

	if (agent && isDefaultGentleShellAgentDir(agent)) {
		const isolated = defaultGentleShellPrefixFromAgent(agent);
		if (isolated) return join(isolated, "gentle-ai", "profiles.json");
	}

	return piProfilesFile(env);
}

function detectIndent(text: string): string {
	const match = text.match(/\n([ \t]+)"/);
	return match?.[1] ?? "  ";
}

/**
 * Add `"voice-ai": {}` to every profile that does not already have the role.
 * Does not create the file, does not invent profiles, and does not set model or thinking.
 */
export function ensureVoiceAiRoles(env: NodeJS.ProcessEnv = process.env): EnsureVoiceAiRolesResult {
	const path = resolveHostProfilesFile(env);
	if (!existsSync(path)) return { path, status: "missing", added: [] };

	let text: string;
	let raw: unknown;
	try {
		text = readFileSync(path, "utf8");
		raw = JSON.parse(text) as unknown;
	} catch {
		return { path, status: "invalid", added: [], reason: "unreadable" };
	}

	if (!isRecord(raw) || raw.kind !== PROFILES_KIND || raw.version !== PROFILES_VERSION || !isRecord(raw.profiles)) {
		return { path, status: "invalid", added: [], reason: "not a profiles file" };
	}

	const added: string[] = [];
	for (const [name, profile] of Object.entries(raw.profiles)) {
		if (!isRecord(profile)) continue;
		if (Object.prototype.hasOwnProperty.call(profile, VOICE_AI_ROLE_NAME)) continue;
		profile[VOICE_AI_ROLE_NAME] = {};
		added.push(name);
	}

	if (added.length === 0) return { path, status: "unchanged", added };

	const mode = statSync(path).mode & 0o777;
	const next = `${JSON.stringify(raw, null, detectIndent(text))}\n`;
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, next, { mode });
	try {
		renameSync(tmp, path);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			/* the original profiles file is unchanged */
		}
		throw error;
	}
	return { path, status: "updated", added };
}
