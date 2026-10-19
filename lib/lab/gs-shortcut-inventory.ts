/**
 * Known Gentle Shell / Pi extension shortcuts (experimental repo defaults).
 * Read-only inventory for Ctrl+Alt+Space conflict analysis — no config writes.
 */

import { PREFERRED_SHORTCUT, PREFERRED_SHORTCUT_LABEL } from "../engines/contracts.ts";

export interface KnownShortcut {
	readonly keyId: string;
	readonly source: string;
	readonly notes: string;
}

/** Defaults observed in gentle-shell experimental tree (2026-10 lab). */
export const GS_DEFAULT_SHORTCUTS: readonly KnownShortcut[] = Object.freeze([
	{ keyId: "ctrl+shift+r", source: "history/index.ts", notes: "prompt history" },
	{ keyId: "ctrl+shift+a", source: "lib/agents-keys.ts", notes: "agents collapse" },
	{ keyId: "alt+a", source: "lib/agents-keys.ts", notes: "agents view" },
	{ keyId: "alt+s", source: "lib/agents-keys.ts", notes: "agents stop" },
	{ keyId: "ctrl+shift+t", source: "gentle-todo.ts", notes: "todo collapse" },
	{ keyId: "alt+k", source: "lib/command-palette.ts", notes: "/gentle:commands" },
	{ keyId: "alt+u", source: "gentle-shell.ts", notes: "usage card" },
	{ keyId: "alt+g", source: "gentle-shell.ts", notes: "changes shortcut" },
]);

export interface ShortcutInventoryReport {
	readonly preferred: typeof PREFERRED_SHORTCUT;
	readonly preferredLabel: typeof PREFERRED_SHORTCUT_LABEL;
	readonly conflictsWithGsDefaults: boolean;
	readonly matchingGs: readonly KnownShortcut[];
	readonly recommendation: string;
}

export function inventoryPreferredAgainstGs(
	known: readonly KnownShortcut[] = GS_DEFAULT_SHORTCUTS,
): ShortcutInventoryReport {
	const preferred = PREFERRED_SHORTCUT;
	const matchingGs = known.filter((k) => k.keyId.toLowerCase() === preferred.toLowerCase());
	const conflictsWithGsDefaults = matchingGs.length > 0;
	return {
		preferred,
		preferredLabel: PREFERRED_SHORTCUT_LABEL,
		conflictsWithGsDefaults,
		matchingGs,
		recommendation: conflictsWithGsDefaults
			? "Conflict with a GS default — keep Gentle Voice shortcut disabled."
			: "No GS default uses ctrl+alt+space; still require live TUI proof before lab enable.",
	};
}
