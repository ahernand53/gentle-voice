/**
 * `/gentle:voice` argument parsing and help text.
 * Lab-only subcommands (test-speak) are never listed in public help and require
 * GENTLE_VOICE_LAB=1 — they are not part of VoiceCommandName / public package surface.
 */

import type { VoiceCommandName, VoiceMode } from "./contracts.ts";

export const VOICE_COMMAND = "gentle:voice" as const;

export const VOICE_SUBCOMMANDS: readonly VoiceCommandName[] = [
	"",
	"on",
	"off",
	"listen",
	"stop",
	"mute",
	"status",
	"config",
	"setup",
	"send",
	"draft",
	"edit",
] as const;

/** Lab-only — not in VoiceCommandName; gated by isGentleVoiceLabMode(). */
export const LAB_VOICE_SUBCOMMANDS = [
	"test-speak",
	"converse",
	"ab-compare",
	"ab-score",
	"tts",
] as const;
export type LabVoiceSubcommand = (typeof LAB_VOICE_SUBCOMMANDS)[number];

export function isGentleVoiceLabMode(): boolean {
	return process.env.GENTLE_VOICE_LAB === "1";
}

export interface ParsedVoiceArgs {
	readonly command: VoiceCommandName;
	readonly rest: string;
	readonly error?: string;
	/** Set only when lab mode accepts a lab subcommand. */
	readonly labCommand?: LabVoiceSubcommand;
}

export function parseVoiceArgs(raw: string): ParsedVoiceArgs {
	const trimmed = raw.trim();
	if (!trimmed) return { command: "", rest: "" };
	const [head = "", ...tail] = trimmed.split(/\s+/);
	const lower = head.toLowerCase();

	if ((LAB_VOICE_SUBCOMMANDS as readonly string[]).includes(lower)) {
		if (!isGentleVoiceLabMode()) {
			return {
				command: "",
				rest: trimmed,
				error: `Unknown subcommand "${head}". Try: on|off|listen|stop|mute|status|config|setup|send|draft|edit`,
			};
		}
		return {
			command: "",
			rest: tail.join(" "),
			labCommand: lower as LabVoiceSubcommand,
		};
	}

	const command = lower as VoiceCommandName;
	if (!VOICE_SUBCOMMANDS.includes(command)) {
		return {
			command: "",
			rest: trimmed,
			error: `Unknown subcommand "${head}". Try: on|off|listen|stop|mute|status|config|setup|send|draft|edit`,
		};
	}
	return { command, rest: tail.join(" ") };
}

export function parseModeFlag(rest: string): VoiceMode | undefined {
	const value = rest.trim().toLowerCase();
	if (value === "dictation" || value === "conversation" || value === "silent") return value;
	return undefined;
}

export function voiceHelpText(options?: { includeLab?: boolean }): string {
	const lines = [
		"Gentle Voice — local STT/TTS for Pi (phase 2C — review → explicit send → spoken reply).",
		"",
		"Usage:",
		"  /gentle:voice              Toggle enabled, or show status when already on",
		"  /gentle:voice on           Enable voice session",
		"  /gentle:voice off          Disable and cancel in-flight audio work",
		"  /gentle:voice listen       Start a listen window",
		"  /gentle:voice stop         Stop listen/speak and return to idle",
		"  /gentle:voice mute         Mute TTS (STT may continue)",
		"  /gentle:voice draft <text> Replace pending transcript before send",
		"  /gentle:voice send         Send pending transcript to the agent (explicit)",
		"  /gentle:voice edit         Load last voice submit into Pi editor (Ctrl+Alt+E)",
		"  /gentle:voice status       Show mode, mute, phase, adapter probes",
		"  /gentle:voice config       Show effective config / path resolution hints",
		"  /gentle:voice setup        First-run readiness (portable data dir; consent for downloads)",
	];
	if (options?.includeLab || isGentleVoiceLabMode()) {
		lines.push(
			"  /gentle:voice test-speak     [lab] Fixed phrase TTS+playback (no LLM)",
			"  /gentle:voice converse on|off [lab] Fluent VAD loop (opt-in; auto-send only if configured)",
			"  /gentle:voice ab-compare [n] [engine] [lab] Play fixed phrase n (piper|kokoro)",
			"  /gentle:voice ab-score <1-5>  [lab] Rate last A/B trial naturalness",
			"  /gentle:voice tts piper|kokoro [lab] Select installed TTS (does not change default permanently)",
		);
	}
	lines.push(
		"",
		"Modes (via config): dictation | conversation | silent",
		"autoSubmitTranscript defaults to false — review then /gentle:voice send.",
		"No default keyboard shortcut; Ctrl+Alt+Space stays fail-closed until verified.",
		"Does not narrate tools, subagents, thinking, or invent spoken summaries.",
	);
	return lines.join("\n");
}
