/**
 * Pi editor prompt history (Up/Down arrows).
 *
 * Typed Enter goes through InteractiveMode → editor.addToHistory().
 * Extension `sendUserMessage()` does NOT — so Esc → Up cannot recover a
 * voice-submitted line unless we push it ourselves.
 *
 * Pi ExtensionContext.ui does not expose addToHistory. We bind once by wrapping
 * setEditorComponent on session_start (before renderInitialMessages repopulates
 * history from the session file).
 */

import type { VoiceHostCommandContext } from "./contracts.ts";

type EditorFactory = (
	tui: unknown,
	theme: unknown,
	keybindings: unknown,
) => { addToHistory?(text: string): void };

type UiWithEditorFactory = VoiceHostCommandContext["ui"] & {
	addToHistory?(text: string): void;
	getEditorComponent?(): EditorFactory | undefined;
	setEditorComponent?(factory: EditorFactory | undefined): void;
};

export type EditorHistoryBinding = {
	/** Attempt to capture live editor.addToHistory (idempotent). */
	tryBind(ctx: VoiceHostCommandContext | undefined): void;
	/** Push a submitted prompt into the live editor history (Up/Down). */
	push(text: string): boolean;
	/** True once we hold a live addToHistory (or direct ui.addToHistory). */
	readonly bound: boolean;
};

/**
 * Bind to the host editor's addToHistory.
 * Safe to call from session_start (Pi then re-populates history from the session).
 */
export function createEditorHistoryBinding(): EditorHistoryBinding {
	let addToHistory: ((text: string) => void) | undefined;
	let wrapAttempted = false;

	return {
		tryBind(ctx) {
			if (!ctx || addToHistory) return;
			const ui = ctx.ui as UiWithEditorFactory;

			if (typeof ui.addToHistory === "function") {
				addToHistory = (t) => ui.addToHistory!(t);
				return;
			}

			if (wrapAttempted) return;
			wrapAttempted = true;

			const get = ui.getEditorComponent;
			const set = ui.setEditorComponent;
			if (typeof get !== "function" || typeof set !== "function") return;

			const prev = get.call(ui);
			if (!prev) return;

			set.call(ui, (tui, theme, keybindings) => {
				const editor = prev(tui, theme, keybindings);
				if (typeof editor.addToHistory === "function") {
					addToHistory = (t) => editor.addToHistory!(t);
				}
				return editor;
			});
		},
		push(text) {
			const trimmed = text.trim();
			if (!trimmed || !addToHistory) return false;
			addToHistory(trimmed);
			return true;
		},
		get bound() {
			return Boolean(addToHistory);
		},
	};
}

/**
 * After Esc cancels voice, restore the recoverable prompt into an empty editor
 * so the user can edit/re-send even if history bind failed.
 */
export function restorePromptAfterVoiceEscape(
	ctx: VoiceHostCommandContext,
	candidates: readonly (string | undefined)[],
): boolean {
	if (typeof ctx.ui.setEditorText !== "function") return false;
	const existing = (ctx.ui.getEditorText?.() ?? "").trim();
	if (existing) return false;
	for (const c of candidates) {
		const text = c?.trim();
		if (text) {
			ctx.ui.setEditorText(text);
			return true;
		}
	}
	return false;
}

/** Lone Esc (not CSI arrows / function keys). */
export function isLoneEscape(data: string): boolean {
	if (!data || data.charCodeAt(0) !== 0x1b) return false;
	// Lone Esc, or Esc Esc. CSI (\x1b[…) and SS3 (\x1bO…) must pass through.
	if (data.length > 1 && data[1] !== "\x1b") return false;
	return true;
}
