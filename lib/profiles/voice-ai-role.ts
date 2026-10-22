/**
 * Production seed for the `voice-ai` role.
 *
 * The role is added empty. Model and thinking are chosen later in `/gentle:models`.
 * A missing profiles file is never created. An existing `voice-ai` entry is never overwritten.
 * The write stays on this host's Gentle AI store and does not fall through to the other product.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
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
	readonly agentPath: string;
	readonly agentCreated: boolean;
}

/** Listed by `/gentle:models`. No model and no thinking: those are saved by that panel. */
export const VOICE_AI_AGENT_MARKDOWN = `---
name: voice-ai
description: Gentle Voice narration role. Assign the model and effort in /gentle:models. This is not a task agent.
tools: []
---

This file exists so /gentle:models can assign the voice-ai narrator. It does not run tasks.
`;

export interface VoiceAiModelsAssignment {
	readonly present: boolean;
	readonly model?: string;
	readonly thinking?: string;
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

/** Agent home `/gentle:models` scans. Gentle Shell sets `GENTLE_PI_AGENT_HOME`. */
export function resolveHostAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.GENTLE_PI_AGENT_HOME?.trim() || env.PI_CODING_AGENT_DIR?.trim();
	if (explicit && isAbsolute(explicit)) return explicit;
	return join(homeDir(env), ".pi", "agent");
}

export function voiceAiAgentPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(resolveHostAgentDir(env), "agents", "voice-ai.md");
}

/**
 * Create the agent file when it is missing. An existing file is left alone so a
 * model saved by `/gentle:models` is not wiped.
 */
export function ensureVoiceAiAgent(env: NodeJS.ProcessEnv = process.env): { path: string; created: boolean } {
	const path = voiceAiAgentPath(env);
	if (existsSync(path)) return { path, created: false };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, VOICE_AI_AGENT_MARKDOWN, { mode: 0o644 });
	return { path, created: true };
}

/** Assignment `/gentle:models` writes beside `profiles.json`. */
export function readVoiceAiModelsAssignment(
	configHome: string,
): VoiceAiModelsAssignment {
	const path = join(configHome, "models.json");
	if (!existsSync(path)) return { present: false };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(raw) || !Object.prototype.hasOwnProperty.call(raw, VOICE_AI_ROLE_NAME)) {
			return { present: false };
		}
		const entry = raw[VOICE_AI_ROLE_NAME];
		if (!isRecord(entry)) return { present: true };
		const model = typeof entry.model === "string" ? entry.model.trim() : "";
		const thinking = typeof entry.thinking === "string" ? entry.thinking.trim() : "";
		return {
			present: true,
			...(model ? { model } : {}),
			...(thinking ? { thinking } : {}),
		};
	} catch {
		return { present: false };
	}
}

function assignmentBody(assignment: VoiceAiModelsAssignment): Record<string, string> {
	return {
		...(assignment.model ? { model: assignment.model } : {}),
		...(assignment.thinking ? { thinking: assignment.thinking } : {}),
	};
}

function detectIndent(text: string): string {
	const match = text.match(/\n([ \t]+)"/);
	return match?.[1] ?? "  ";
}

/**
 * Add `"voice-ai": {}` to every profile that does not already have the role.
 * Does not create the profiles file and does not invent a model.
 * When `/gentle:models` has already saved a voice-ai assignment, that assignment
 * is copied onto the role so the profile matches the panel.
 */
export function ensureVoiceAiRoles(env: NodeJS.ProcessEnv = process.env): EnsureVoiceAiRolesResult {
	const agent = ensureVoiceAiAgent(env);
	const path = resolveHostProfilesFile(env);
	const base = { path, agentPath: agent.path, agentCreated: agent.created };
	if (!existsSync(path)) return { ...base, status: "missing", added: [] };

	let text: string;
	let raw: unknown;
	try {
		text = readFileSync(path, "utf8");
		raw = JSON.parse(text) as unknown;
	} catch {
		return { ...base, status: "invalid", added: [], reason: "unreadable" };
	}

	if (!isRecord(raw) || raw.kind !== PROFILES_KIND || raw.version !== PROFILES_VERSION || !isRecord(raw.profiles)) {
		return { ...base, status: "invalid", added: [], reason: "not a profiles file" };
	}

	const added: string[] = [];
	let synced = false;
	const assignment = readVoiceAiModelsAssignment(dirname(path));
	const saved = assignment.present ? assignmentBody(assignment) : undefined;
	for (const [name, profile] of Object.entries(raw.profiles)) {
		if (!isRecord(profile)) continue;
		if (!Object.prototype.hasOwnProperty.call(profile, VOICE_AI_ROLE_NAME)) {
			profile[VOICE_AI_ROLE_NAME] = saved ?? {};
			added.push(name);
			continue;
		}
		if (!saved) continue;
		if (JSON.stringify(profile[VOICE_AI_ROLE_NAME]) === JSON.stringify(saved)) continue;
		profile[VOICE_AI_ROLE_NAME] = saved;
		synced = true;
	}

	if (added.length === 0 && !synced) return { ...base, status: "unchanged", added };

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
	return { ...base, status: "updated", added };
}
