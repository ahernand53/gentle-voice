/**
 * Esc → Up recovery: voice submit must reach editor history; Esc restores draft.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createEditorHistoryBinding,
	isLoneEscape,
	restorePromptAfterVoiceEscape,
} from "../lib/editor-history.ts";
import type { VoiceHostCommandContext } from "../lib/contracts.ts";

test("isLoneEscape: Esc yes; ArrowUp CSI/SS3 no", () => {
	assert.equal(isLoneEscape("\x1b"), true);
	assert.equal(isLoneEscape("\x1b\x1b"), true);
	assert.equal(isLoneEscape("\x1b[A"), false);
	assert.equal(isLoneEscape("\x1bOA"), false);
	assert.equal(isLoneEscape("\x1b[1;1A"), false);
	assert.equal(isLoneEscape("a"), false);
});

test("restorePromptAfterVoiceEscape fills empty editor; preserves non-empty", () => {
	let editor = "";
	const ctx = {
		ui: {
			notify() {},
			setEditorText(text: string) {
				editor = text;
			},
			getEditorText() {
				return editor;
			},
		},
	} as VoiceHostCommandContext;

	assert.equal(restorePromptAfterVoiceEscape(ctx, ["", "  hola voz  ", "otro"]), true);
	assert.equal(editor, "hola voz");

	assert.equal(restorePromptAfterVoiceEscape(ctx, ["no tocar"]), false);
	assert.equal(editor, "hola voz");
});

test("createEditorHistoryBinding pushes via ui.addToHistory when present", () => {
	const history: string[] = [];
	const ctx = {
		ui: {
			notify() {},
			addToHistory(text: string) {
				history.unshift(text.trim());
			},
		},
	} as VoiceHostCommandContext;

	const binding = createEditorHistoryBinding();
	binding.tryBind(ctx);
	assert.equal(binding.bound, true);
	assert.equal(binding.push("primera línea de voz"), true);
	assert.deepEqual(history, ["primera línea de voz"]);
	assert.equal(binding.push("primera línea de voz"), true); // host dedupes if it wants; we still call
});

test("createEditorHistoryBinding wraps setEditorComponent to capture addToHistory", () => {
	const history: string[] = [];
	const liveEditor = {
		addToHistory(text: string) {
			const t = text.trim();
			if (!t) return;
			if (history[0] === t) return;
			history.unshift(t);
		},
	};
	let factory: ((tui: unknown, theme: unknown, kb: unknown) => typeof liveEditor) | undefined = () => liveEditor;

	const ctx = {
		ui: {
			notify() {},
			getEditorComponent() {
				return factory;
			},
			setEditorComponent(next: typeof factory) {
				factory = next;
				// Simulate Pi recreating the editor immediately
				factory?.(null, null, null);
			},
		},
	} as VoiceHostCommandContext;

	const binding = createEditorHistoryBinding();
	binding.tryBind(ctx);
	assert.equal(binding.bound, true);
	assert.equal(binding.push("recover me after Esc"), true);
	assert.deepEqual(history, ["recover me after Esc"]);
});
