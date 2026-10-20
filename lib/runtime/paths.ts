/**
 * Portable runtime directories for Gentle Voice.
 * Never writes into the project cwd where the user launched Pi.
 * Never uses developer-specific absolute paths.
 *
 * Host-aware resolution lives in `storage.ts` (`resolveGentleVoiceStorage`).
 * This module re-exports the layout type and a thin wrapper for callers.
 */

import type { VoicePlatform } from "../contracts.ts";
import {
	resolveGentleVoiceStorage,
	type GentleVoiceRuntimeLayout,
	type StorageHostKind,
} from "./storage.ts";

export type { GentleVoiceRuntimeLayout, StorageHostKind };

function platformOf(p: NodeJS.Platform = process.platform): VoicePlatform {
	if (p === "linux") return "linux";
	if (p === "win32") return "win32";
	if (p === "darwin") return "darwin";
	return "unsupported";
}

/**
 * Resolve runtime layout for the current host.
 * Env overrides (GENTLE_VOICE_*) always win when set.
 * Inside Gentle Shell isolated/bundled sessions, storage is under the GS prefix
 * (never ambient XDG paths), unless an explicit override is set.
 */
export function resolveRuntimeLayout(
	env: NodeJS.ProcessEnv = process.env,
	platform: VoicePlatform = platformOf(),
): GentleVoiceRuntimeLayout {
	const resolved = resolveGentleVoiceStorage({ env, platform });
	const { diagnostics: _diagnostics, ...layout } = resolved;
	return layout;
}
