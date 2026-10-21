/**
 * Compact aboveEditor widget — content-sized, GS theme roles.
 * Pi's string[] path wraps Text(line, 1, 0) which pads every line to full
 * terminal width (looks like a huge waybar). This factory returns a leaf that
 * does NOT pad, and paints with the same theme tokens GS customize uses.
 *
 * Theme roles come from Pi/GS `theme.fg(role, text)` — never hardcode hex/ANSI
 * for accent. `/gentle:customize` accent flows through the `accent` role.
 */

import type { VoiceChromeActivity } from "../widget-chrome.ts";

export interface VoiceThemeLike {
	fg(color: string, text: string): string;
	bg?(color: string, text: string): string;
	bold?(text: string): string;
}

/** Minimal Pi TUI leaf — no full-width padding. */
export interface CompactWidgetLeaf {
	render(width: number): string[];
	invalidate?(): void;
	dispose?(): void;
}

/** Room after the mic glyph. One space sits inside the emoji cell. */
export const VOICE_GLYPH_GAP = "  ";

export const VOICE_BRAND = "Gentle Voice";

export function activityThemeRole(activity: VoiceChromeActivity): string {
	switch (activity) {
		case "ERROR":
			return "error";
		case "SPEAKING":
		case "SYNTHESIZING":
		case "VOICE_LOADING":
		case "SPEECH_DETECTED":
		case "LISTENING":
			return "accent";
		case "ARMING":
		case "WORKING":
		case "NARRATING":
		case "TRANSCRIBING":
			return "toolTitle";
		case "MUTED":
		case "PAUSED":
			return "warning";
		case "READY":
		default:
			return "muted";
	}
}

/**
 * Paint one chrome header with theme roles.
 * - Leading glyph (🎙/🔊/🔇/⚠): activity role (accent when listening/speaking)
 * - Brand: muted
 * - Separators: dim
 * - Activity label: activity role via theme.fg only
 * - 🔊 ON: accent (same as mic — follows /gentle:customize)
 * - 🔇 MUTED: warning (semantic, not accent)
 *
 * Do not wrap the label in theme.bold(). chalk.bold emits SGR 1 inside the
 * accent span, and that intensity bit paints a different color than the glyph.
 *
 * Never uses hardcoded pink/RGB — only theme.fg roles.
 */
export function paintVoiceChromeHeader(
	header: string,
	activity: VoiceChromeActivity,
	theme: VoiceThemeLike,
): string {
	const fg = theme.fg.bind(theme);
	const role = activityThemeRole(activity);
	const dim = (t: string) => fg("dim", t);
	const muted = (t: string) => fg("muted", t);

	// Structured parse: `<glyph><gap>Gentle Voice │ ACTIVITY │ AUDIO`
	// or narrow: `<glyph><gap>ACTIVITY[ 🔇]`
	const sep = " │ ";
	if (header.includes(sep)) {
		const parts = header.split(sep);
		if (parts.length >= 3) {
			const left = parts[0] ?? "";
			const act = parts[1] ?? "";
			const audio = parts.slice(2).join(sep);
			const glyphMatch = left.match(/^(🎙|🔊|🔇|⚠)([\s\u00A0\u2009]*)(.*)$/u);
			const glyph = glyphMatch?.[1] ?? "";
			const gap = glyphMatch?.[2] && glyphMatch[2].length > 0
				? glyphMatch[2]
				: VOICE_GLYPH_GAP;
			const brand = (glyphMatch?.[3] ?? left).trimStart() || VOICE_BRAND;

			const audioPainted = /^🔊\s*ON$/u.test(audio.trim())
				? fg("accent", audio)
				: /^🔇\s*MUTED$/u.test(audio.trim())
					? fg("warning", audio)
					: /^🔇\s*OFF$/u.test(audio.trim())
						? fg("muted", audio)
						: muted(audio);

			return [
				glyph ? fg(role, glyph) : "",
				gap,
				muted(brand),
				dim(sep),
				fg(role, act),
				dim(sep),
				audioPainted,
			].join("");
		}
	}

	// Narrow / fallback: paint leading glyph + activity token
	return header
		.replace(/│/gu, (m) => dim(m))
		.replace(
			new RegExp(`(${activity})`),
			(_m, a: string) => fg(role, a),
		)
		.replace(/(🔊\s*ON)/u, (m) => fg("accent", m))
		.replace(/(🔇\s*MUTED)/u, (m) => fg("warning", m))
		.replace(/(🔇\s*OFF)/u, (m) => fg("muted", m))
		.replace(/^(🎙|🔊|🔇|⚠)/u, (m) => fg(role, m));
}

/**
 * Paint chrome lines with GS theme roles (accent / muted / dim / warning).
 * Falls back to plain text when theme is missing.
 */
export function paintVoiceWidgetLines(
	lines: readonly string[],
	activity: VoiceChromeActivity,
	theme?: VoiceThemeLike,
): string[] {
	if (!theme?.fg) return [...lines];
	return lines.map((line, i) => {
		if (i === 0) {
			return paintVoiceChromeHeader(line, activity, theme);
		}
		// Wave / activity line
		if (line === "⋯" || line === "● ● ●") return theme.fg("dim", line);
		return theme.fg("accent", line);
	});
}

export function createCompactVoiceLeaf(paintedLines: readonly string[]): CompactWidgetLeaf {
	const lines = paintedLines.length > 0 ? [...paintedLines] : [""];
	return {
		render(_width: number) {
			// Intentionally ignore parent width — do not pad to full terminal.
			return lines;
		},
		invalidate() {},
	};
}

/**
 * Build setWidget content: factory for TUI (themed + compact), string[] fallback.
 */
export function voiceWidgetContent(
	plainLines: string[] | undefined,
	activity: VoiceChromeActivity,
): string[] | undefined | ((ui: unknown, theme: VoiceThemeLike) => CompactWidgetLeaf | undefined) {
	if (plainLines === undefined) return undefined;
	return (_ui: unknown, theme: VoiceThemeLike) => {
		const painted = paintVoiceWidgetLines(plainLines, activity, theme);
		return createCompactVoiceLeaf(painted);
	};
}
