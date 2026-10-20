/**
 * Barge-in preference — Gentle Voice home only.
 * unset  — on only while a conversation session is active
 * on     — explicit; survives converse off
 * off    — explicit; converse / Ctrl+Alt+Space must not turn it back on
 *
 * Older files stored `{ enabled: boolean }`. Those map to explicit on/off.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const BARGE_IN_PREFERENCE_KIND = "gentle-voice.barge-in-preference" as const;

export type BargePreference = "unset" | "on" | "off";

export type BargeActivationSource = "explicit-on" | "explicit-off" | "automatic";

export interface BargeActivation {
	readonly enabled: boolean;
	readonly source: BargeActivationSource;
	readonly preference: BargePreference;
}

export function bargeInPreferencePath(voiceHome: string): string {
	return join(voiceHome, "barge-in-preference.json");
}

export function resolveVoiceHomeForBarge(env: NodeJS.ProcessEnv = process.env): string {
	const home = env.GENTLE_VOICE_HOME?.trim();
	if (home) return home;
	return join(env.HOME ?? "/tmp", ".gentle-voice");
}

export function readBargePreference(voiceHome: string): BargePreference {
	try {
		const raw = JSON.parse(readFileSync(bargeInPreferencePath(voiceHome), "utf8")) as {
			kind?: unknown;
			preference?: unknown;
			enabled?: unknown;
		};
		if (raw.kind !== BARGE_IN_PREFERENCE_KIND) return "unset";
		if (raw.preference === "on" || raw.preference === "off") return raw.preference;
		if (raw.enabled === true) return "on";
		if (raw.enabled === false) return "off";
		return "unset";
	} catch {
		return "unset";
	}
}

export function writeBargePreference(
	voiceHome: string,
	preference: Exclude<BargePreference, "unset">,
): void {
	const path = bargeInPreferencePath(voiceHome);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify({
			kind: BARGE_IN_PREFERENCE_KIND,
			preference,
			updatedAt: new Date().toISOString(),
		}, null, 2)}\n`,
		{ mode: 0o600 },
	);
}

/**
 * 1. Explicit off wins over conversation mode.
 * 2. Explicit on stays on even after converse ends (the monitor still only runs while speaking).
 * 3. Unset + conversation session → automatic.
 * 4. Unset + not conversing → off. No background capture.
 */
export function resolveBargeActivation(input: {
	readonly preference: BargePreference;
	readonly fluentConversation: boolean;
}): BargeActivation {
	if (input.preference === "off") {
		return { enabled: false, source: "explicit-off", preference: "off" };
	}
	if (input.preference === "on") {
		return { enabled: true, source: "explicit-on", preference: "on" };
	}
	return {
		enabled: input.fluentConversation,
		source: "automatic",
		preference: "unset",
	};
}
