/**
 * Phase 3.6 — chrome theme accent + glyph spacing (no hardcoded pink).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	activityThemeRole,
	paintVoiceChromeHeader,
	paintVoiceWidgetLines,
	VOICE_BRAND,
	VOICE_GLYPH_GAP,
	voiceWidgetContent,
} from "../lib/visual/compact-widget.ts";
import {
	renderVoiceWidgetLine,
	snapshotVoiceChrome,
} from "../lib/widget-chrome.ts";
import { initialVoiceState } from "../lib/state-machine.ts";

const COMPACT_WIDGET_SRC = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "../lib/visual/compact-widget.ts"),
	"utf8",
);

function fakeTheme() {
	const roles: string[] = [];
	return {
		roles,
		theme: {
			fg: (c: string, t: string) => {
				roles.push(c);
				return `{${c}}${t}{/${c}}`;
			},
			bold: (t: string) => `*${t}*`,
		},
	};
}

test("widget line always inserts gap between glyph and Gentle Voice", () => {
	const line = renderVoiceWidgetLine(
		initialVoiceState({ enabled: true, muted: false, phase: "listening", mode: "conversation" }),
	);
	assert.ok(line);
	assert.equal(line!.startsWith(`🎙${VOICE_GLYPH_GAP}${VOICE_BRAND}`), true);
	assert.match(line!, /^🎙 {2}Gentle Voice │ LISTENING │ 🔊 ON$/);
	assert.doesNotMatch(line!, /^🎙Gentle/);
});

test("paint: mic + ON use accent role (not success) for LISTENING", () => {
	const { theme, roles } = fakeTheme();
	const plain = `🎙${VOICE_GLYPH_GAP}${VOICE_BRAND} │ LISTENING │ 🔊 ON`;
	const painted = paintVoiceChromeHeader(plain, "LISTENING", theme);
	assert.match(painted, /\{accent\}🎙/);
	assert.match(painted, /\{accent\}🔊 ON/);
	assert.doesNotMatch(painted, /\{success\}/);
	assert.ok(roles.includes("accent"));
	assert.ok(!roles.includes("success"), "ON must not use success — follows customize accent");
	assert.match(painted, /\{muted\}Gentle Voice/);
	assert.match(painted, /\{dim\} │ /);
});

test("paint: MUTED stays warning (semantic), not accent", () => {
	const { theme, roles } = fakeTheme();
	const plain = `🎙${VOICE_GLYPH_GAP}${VOICE_BRAND} │ READY │ 🔇 MUTED`;
	const painted = paintVoiceChromeHeader(plain, "MUTED", theme);
	assert.match(painted, /\{warning\}🔇 MUTED/);
	assert.ok(roles.includes("warning"));
});

test("paint: ERROR glyph uses error role", () => {
	const { theme } = fakeTheme();
	const plain = `⚠${VOICE_GLYPH_GAP}${VOICE_BRAND} │ ERROR │ 🔊 ON`;
	const painted = paintVoiceChromeHeader(plain, "ERROR", theme);
	assert.match(painted, /\{error\}⚠/);
	assert.match(painted, /\{accent\}🔊 ON/);
});

test("theme accent is a role name — never a hardcoded hex in painter", () => {
	assert.doesNotMatch(COMPACT_WIDGET_SRC, /#[0-9a-fA-F]{3,8}/);
	assert.doesNotMatch(COMPACT_WIDGET_SRC, /38;2;/);
	assert.doesNotMatch(COMPACT_WIDGET_SRC, /magenta|hotpink|ff69b4/i);
	assert.match(COMPACT_WIDGET_SRC, /fg\("accent"/);
});

test("factory paints ON with accent when theme provided", () => {
	const { theme, roles } = fakeTheme();
	const factory = voiceWidgetContent(
		[`🎙${VOICE_GLYPH_GAP}${VOICE_BRAND} │ LISTENING │ 🔊 ON`],
		"LISTENING",
	);
	assert.equal(typeof factory, "function");
	const leaf = (factory as Function)({}, theme) as { render: (w: number) => string[] };
	const [line] = leaf.render(80);
	assert.match(line!, /\{accent\}🔊 ON/);
	assert.ok(!roles.includes("success"));
});

test("disabled voice clears widget (OFF distinguishable from ON)", () => {
	const snap = snapshotVoiceChrome(
		initialVoiceState({ enabled: false, muted: false, phase: "idle", mode: "conversation" }),
	);
	assert.equal(snap.widgetContent, undefined);
	assert.equal(snap.statusText, undefined);
});

test("SPEAKING label is theme.fg(accent) on the raw word", () => {
	const calls: Array<{ role: string; text: string }> = [];
	let boldCalls = 0;
	const theme = {
		fg: (role: string, text: string) => {
			calls.push({ role, text });
			return `{${role}}${text}{/${role}}`;
		},
		bold: (text: string) => {
			boldCalls += 1;
			return `\x1b[1m${text}\x1b[22m`;
		},
	};
	const plain = renderVoiceWidgetLine(
		initialVoiceState({ enabled: true, muted: false, phase: "speaking", mode: "conversation" }),
	);
	assert.ok(plain);
	const painted = paintVoiceChromeHeader(plain!, "SPEAKING", theme);
	const label = calls.find((c) => c.text === "SPEAKING");
	assert.equal(label?.role, "accent");
	assert.equal(activityThemeRole("SPEAKING"), "accent");
	assert.match(painted, /\{accent\}SPEAKING\{\/accent\}/);
	assert.match(painted, /\{accent\}🔊/);
	assert.equal(boldCalls, 0, "SGR 1 must not sit inside the accent span");
	assert.doesNotMatch(painted, /\x1b\[1m/);
});

test("SYNTHESIZING and VOICE_LOADING use the same accent role", () => {
	assert.equal(activityThemeRole("SYNTHESIZING"), "accent");
	assert.equal(activityThemeRole("VOICE_LOADING"), "accent");
	assert.equal(activityThemeRole("LISTENING"), "accent");
	assert.equal(activityThemeRole("READY"), "muted");
	assert.equal(activityThemeRole("MUTED"), "warning");
	assert.equal(activityThemeRole("ERROR"), "error");
	const { theme } = fakeTheme();
	const synth = paintVoiceChromeHeader(
		`🔊${VOICE_GLYPH_GAP}${VOICE_BRAND} │ SYNTHESIZING │ 🔊 ON`,
		"SYNTHESIZING",
		theme,
	);
	const loading = paintVoiceChromeHeader(
		`🔊${VOICE_GLYPH_GAP}${VOICE_BRAND} │ VOICE_LOADING │ 🔊 ON`,
		"VOICE_LOADING",
		theme,
	);
	assert.match(synth, /\{accent\}SYNTHESIZING/);
	assert.match(loading, /\{accent\}VOICE_LOADING/);
	assert.match(synth, /\{accent\}🔊 ON/);
});

test("paintVoiceWidgetLines without theme returns plain (Pi fallback)", () => {
	const lines = paintVoiceWidgetLines(
		[`🎙${VOICE_GLYPH_GAP}${VOICE_BRAND} │ READY │ 🔊 ON`],
		"READY",
	);
	assert.equal(lines[0], `🎙${VOICE_GLYPH_GAP}${VOICE_BRAND} │ READY │ 🔊 ON`);
});
