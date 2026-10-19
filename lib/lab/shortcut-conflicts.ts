/**
 * Read-only scan of host configs for Ctrl+Alt+Space conflicts.
 * Never modifies Hyprland / Ghostty / Omarchy bindings.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { PREFERRED_SHORTCUT, PREFERRED_SHORTCUT_LABEL } from "../engines/contracts.ts";

export interface ShortcutConflictEvidence {
	readonly preferredLabel: string;
	readonly preferredKeyId: typeof PREFERRED_SHORTCUT;
	readonly sources: readonly {
		readonly path: string;
		readonly found: boolean;
		readonly notes: string;
	}[];
	readonly osConflictSuspected: boolean;
	readonly piKeyIdValid: boolean;
	readonly recommendation: string;
}

const CONFLICT_PATTERNS = [
	/ctrl\s*\+\s*alt\s*\+\s*space/i,
	/ctrl\+alt\+space/i,
	/CTRL\s*,?\s*ALT\s*,?\s*SPACE/i,
	/bind\s*=\s*.*CTRL.*ALT.*SPACE/i,
	/keybind\s*=\s*.*ctrl\+alt\+space/i,
];

async function scanFile(path: string): Promise<{ found: boolean; notes: string }> {
	try {
		const text = await readFile(path, "utf8");
		const hits = CONFLICT_PATTERNS.filter((re) => re.test(text));
		if (hits.length === 0) {
			return { found: false, notes: "no Ctrl+Alt+Space pattern matched" };
		}
		return { found: true, notes: `matched ${hits.length} pattern(s) — review manually; do not auto-bind` };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { found: false, notes: "file absent" };
		return { found: false, notes: `unreadable (${code ?? "error"})` };
	}
}

export async function collectShortcutConflictEvidence(options?: {
	home?: string;
}): Promise<ShortcutConflictEvidence> {
	const home = options?.home ?? homedir();
	const candidates = [
		join(home, ".config", "hypr", "bindings.lua"),
		join(home, ".config", "hypr", "hyprland.conf"),
		join(home, ".config", "hypr", "hyprland.lua"),
		join(home, ".config", "ghostty", "config"),
		join(home, ".config", "omarchy", "hyprland.conf"),
	];

	const sources = [];
	for (const path of candidates) {
		const result = await scanFile(path);
		sources.push({ path, ...result });
	}

	const osConflictSuspected = sources.some((s) => s.found);
	// Pi KeyId grammar: ctrl+alt+space is valid (Key.ctrlAlt("space")).
	const piKeyIdValid = PREFERRED_SHORTCUT === "ctrl+alt+space";

	return {
		preferredLabel: PREFERRED_SHORTCUT_LABEL,
		preferredKeyId: PREFERRED_SHORTCUT,
		sources,
		osConflictSuspected,
		piKeyIdValid,
		recommendation: osConflictSuspected || !piKeyIdValid
			? "Keep shortcut disabled until live TUI verification proves availability."
			: "No config-file conflict found; still require live TUI probe before registering (fail closed).",
	};
}
