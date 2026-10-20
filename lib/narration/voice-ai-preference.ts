/**
 * Voice AI on/off preference — Gentle Voice home only.
 * Never writes Gentle Shell profiles or ~/.pi settings.
 *
 * unset  — converse mode may enable narration automatically
 * on     — explicit; stays on after converse off
 * off    — explicit; converse must NOT turn it back on
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const VOICE_AI_PREFERENCE_KIND = "gentle-voice.voice-ai-preference" as const;

export type VoiceAiPreference = "unset" | "on" | "off";

export type VoiceAiActivationSource =
	| "explicit-on"
	| "explicit-off"
	| "automatic"
	| "env-on"
	| "env-off";

export interface VoiceAiActivation {
	readonly enabled: boolean;
	readonly source: VoiceAiActivationSource;
	readonly preference: VoiceAiPreference;
}

export function voiceAiPreferencePath(voiceHome: string): string {
	return join(voiceHome, "voice-ai-preference.json");
}

export function resolveVoiceHomeForPreference(env: NodeJS.ProcessEnv = process.env): string {
	const home = env.GENTLE_VOICE_HOME?.trim();
	if (home) return home;
	return join(env.HOME ?? "/tmp", ".gentle-voice");
}

export function readVoiceAiPreference(
	voiceHome: string,
): VoiceAiPreference {
	try {
		const raw = JSON.parse(readFileSync(voiceAiPreferencePath(voiceHome), "utf8")) as {
			kind?: unknown;
			preference?: unknown;
		};
		if (raw.kind !== VOICE_AI_PREFERENCE_KIND) return "unset";
		if (raw.preference === "on" || raw.preference === "off") return raw.preference;
		return "unset";
	} catch {
		return "unset";
	}
}

export function writeVoiceAiPreference(
	voiceHome: string,
	preference: Exclude<VoiceAiPreference, "unset">,
): void {
	const path = voiceAiPreferencePath(voiceHome);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify({
			kind: VOICE_AI_PREFERENCE_KIND,
			preference,
			updatedAt: new Date().toISOString(),
		}, null, 2)}\n`,
		{ mode: 0o600 },
	);
}

/**
 * Precedence:
 * 1. Stored explicit on/off (user command) — beats env and converse.
 * 2. GENTLE_VOICE_AI=1|0 when preference is still unset (process lock).
 * 3. Unset + conversational mode → automatic on.
 * 4. Unset + not conversational → off (no extra LLM on a normal chat).
 */
export function resolveVoiceAiActivation(input: {
	readonly preference: VoiceAiPreference;
	readonly fluentConversation: boolean;
	readonly env?: NodeJS.ProcessEnv;
}): VoiceAiActivation {
	if (input.preference === "off") {
		return { enabled: false, source: "explicit-off", preference: "off" };
	}
	if (input.preference === "on") {
		return { enabled: true, source: "explicit-on", preference: "on" };
	}
	const flag = (input.env ?? process.env).GENTLE_VOICE_AI?.trim().toLowerCase();
	if (flag === "0" || flag === "false" || flag === "off") {
		return { enabled: false, source: "env-off", preference: "unset" };
	}
	if (flag === "1" || flag === "true" || flag === "on") {
		return { enabled: true, source: "env-on", preference: "unset" };
	}
	return {
		enabled: input.fluentConversation,
		source: "automatic",
		preference: "unset",
	};
}
