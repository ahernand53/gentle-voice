/**
 * Compact aboveEditor widget — content-sized, GS theme roles.
 * Pi's string[] path wraps Text(line, 1, 0) which pads every line to full
 * terminal width (looks like a huge waybar). This factory returns a leaf that
 * does NOT pad, and paints with the same theme tokens GS customize uses.
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

export function activityThemeRole(activity: VoiceChromeActivity): string {
	switch (activity) {
		case "ERROR":
			return "error";
		case "SPEAKING":
		case "SYNTHESIZING":
			return "accent";
		case "SPEECH_DETECTED":
		case "LISTENING":
			return "accent";
		case "ARMING":
		case "WORKING":
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
 * Paint chrome lines with GS theme roles (accent / muted / dim / warning).
 * Falls back to plain text when theme is missing.
 */
export function paintVoiceWidgetLines(
	lines: readonly string[],
	activity: VoiceChromeActivity,
	theme?: VoiceThemeLike,
): string[] {
	if (!theme?.fg) return [...lines];
	const role = activityThemeRole(activity);
	const fg = theme.fg.bind(theme);
	return lines.map((line, i) => {
		if (i === 0) {
			// Header: accent activity, dim separators, muted audio chip
			return line
				.replace(/│/g, (m) => fg("dim", m))
				.replace(
					new RegExp(`(${activity})`),
					(_m, a: string) => fg(role, theme.bold?.(a) ?? a),
				)
				.replace(/(🔊 ON)/, (m) => fg("success", m))
				.replace(/(🔇 MUTED)/, (m) => fg("warning", m))
				.replace(/^(🎙|🔊|🔇|⚠)/, (m) => fg(role, m));
		}
		// Wave / activity line
		if (line === "⋯" || line === "● ● ●") return fg("dim", line);
		return fg("accent", line);
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
