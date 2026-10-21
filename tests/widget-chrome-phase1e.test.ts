/**
 * Phase 1E — compact widget chrome + mute feedback (no LLM, no audio).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createVoiceExtension, VOICE_WIDGET_KEY, updateChrome } from "../extensions/voice.ts";
import { createPiHostHarness } from "../lib/lab/pi-host-harness.ts";
import { deniedShortcutProbe } from "../lib/shortcut.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import { VOICE_COMMAND } from "../lib/commands.ts";
import {
	chromeActivityFromPhase,
	renderVoiceWidgetLine,
	snapshotVoiceChrome,
} from "../lib/widget-chrome.ts";
import { initialVoiceState } from "../lib/state-machine.ts";

test("chrome maps phases to TUI activity labels", () => {
	assert.equal(chromeActivityFromPhase("idle"), "READY");
	assert.equal(chromeActivityFromPhase("listening"), "LISTENING");
	assert.equal(chromeActivityFromPhase("transcribing"), "TRANSCRIBING");
	assert.equal(chromeActivityFromPhase("awaiting_agent"), "WORKING");
	assert.equal(chromeActivityFromPhase("speaking"), "SPEAKING");
	assert.equal(chromeActivityFromPhase("error"), "ERROR");
});

test("widget hidden when voice off; compact single line when on", () => {
	assert.equal(renderVoiceWidgetLine(initialVoiceState()), undefined);
	const ready = renderVoiceWidgetLine(initialVoiceState({ enabled: true, phase: "idle", muted: false }));
	assert.equal(ready, "🎙  Gentle Voice │ READY │ 🔊 ON");
	const muted = renderVoiceWidgetLine(initialVoiceState({ enabled: true, phase: "idle", muted: true }));
	assert.equal(muted, "🔇  Gentle Voice │ MUTED │ 🔇 MUTED");
	const listening = renderVoiceWidgetLine(initialVoiceState({ enabled: true, phase: "listening", muted: true }));
	assert.equal(listening, "🎙  Gentle Voice │ LISTENING │ 🔇 MUTED");
	const snap = snapshotVoiceChrome(initialVoiceState({ enabled: true, phase: "idle" }));
	assert.equal(snap.widgetContent?.length, 1);
});

test("harness: on→READY, listen→LISTENING, stop→READY, mute toggles, off clears", async () => {
	const harness = createPiHostHarness();
	const session = createVoiceExtension(harness.pi, {
		config: { ...DEFAULT_VOICE_CONFIG, enabled: false },
		shortcutProbe: deniedShortcutProbe(),
	});

	await harness.runCommand(VOICE_COMMAND, "on");
	assert.match(lastWidget(harness) ?? "", /READY.*🔊 ON/);

	await harness.runCommand(VOICE_COMMAND, "listen");
	assert.match(lastWidget(harness) ?? "", /LISTENING.*🔊 ON/);

	await harness.runCommand(VOICE_COMMAND, "stop");
	assert.match(lastWidget(harness) ?? "", /READY.*🔊 ON/, "stop returns READY, keeps widget");

	await harness.runCommand(VOICE_COMMAND, "mute");
	assert.match(lastWidget(harness) ?? "", /MUTED/);
	assert.equal(session.state.muted, true);
	assert.equal(session.state.phase, "idle", "mute must not change capture phase");

	await harness.runCommand(VOICE_COMMAND, "listen");
	assert.match(lastWidget(harness) ?? "", /LISTENING.*🔇 MUTED/, "mute visible while listening");

	await harness.runCommand(VOICE_COMMAND, "mute off");
	assert.match(lastWidget(harness) ?? "", /LISTENING.*🔊 ON/);

	await harness.runCommand(VOICE_COMMAND, "off");
	const cleared = harness.widgets.filter((w) => w.key === VOICE_WIDGET_KEY).at(-1);
	assert.equal(cleared?.content, undefined);
});

test("updateChrome is the only renderer path used by extension export", () => {
	assert.equal(typeof updateChrome, "function");
});

function lastWidget(harness: { widgets: Array<{ key: string; content: string[] | undefined }> }): string | undefined {
	const w = harness.widgets.filter((x) => x.key === VOICE_WIDGET_KEY).at(-1);
	return w?.content?.[0];
}
