/**
 * Preferred voice shortcut: Ctrl+Alt+Space.
 * Register only after availability is verified. Never auto-pick a fallback chord.
 */

import type { VoiceHostApi, VoiceHostContext } from "./contracts.ts";
import {
	PREFERRED_SHORTCUT,
	PREFERRED_SHORTCUT_LABEL,
	type ShortcutAvailability,
} from "./engines/contracts.ts";

export { PREFERRED_SHORTCUT, PREFERRED_SHORTCUT_LABEL };

export interface ShortcutProbe {
	/**
	 * Return true only when the host can accept this chord without conflict.
	 * If unverifiable, return false (fail closed → keep disabled).
	 */
	isAvailable(shortcut: string): boolean | Promise<boolean>;
}

/** Fail-closed probe: unavailable unless explicitly allowed (tests / future host API). */
export function deniedShortcutProbe(): ShortcutProbe {
	return { isAvailable: () => false };
}

/**
 * Lab-only enable gate. Requires ALL of:
 * - GENTLE_VOICE_LAB=1
 * - GENTLE_VOICE_LAB_SHORTCUT=1
 * - explicit allowlist of the preferred chord
 * Never reads/writes global Hyprland/Ghostty configs.
 */
export function labShortcutProbeFromEnv(
	env: NodeJS.ProcessEnv = process.env,
	allowed: readonly string[] = ["ctrl+alt+space", "ctrl+alt+e"],
): ShortcutProbe {
	const lab = env.GENTLE_VOICE_LAB === "1";
	const enable = env.GENTLE_VOICE_LAB_SHORTCUT === "1";
	if (!lab || !enable) return deniedShortcutProbe();
	return allowlistShortcutProbe(allowed);
}

/**
 * Register an extra verified chord (e.g. Ctrl+Alt+E). Fail-closed via probe.
 */
export async function maybeRegisterExtraShortcut(
	pi: VoiceHostApi,
	options: {
		chord: string;
		description: string;
		handler: (ctx: VoiceHostContext) => Promise<void> | void;
		probe?: ShortcutProbe;
	},
): Promise<{ registered: boolean; reason: string }> {
	if (typeof pi.registerShortcut !== "function") {
		return { registered: false, reason: "host_missing_registerShortcut" };
	}
	const probe = options.probe ?? deniedShortcutProbe();
	const chord = options.chord.trim().toLowerCase();
	if (!(await probe.isAvailable(chord))) {
		return { registered: false, reason: "unavailable_or_unverified" };
	}
	pi.registerShortcut(chord, {
		description: options.description,
		handler: async (ctx) => {
			await options.handler(ctx);
		},
	});
	return { registered: true, reason: `registered:${chord}` };
}

export function allowlistShortcutProbe(allowed: readonly string[]): ShortcutProbe {
	const set = new Set(allowed.map((s) => s.toLowerCase()));
	return {
		isAvailable: (shortcut) => set.has(shortcut.toLowerCase()),
	};
}

/**
 * Evaluate preferred shortcut. Never registers an alternate chord.
 */
export async function evaluatePreferredShortcut(options?: {
	configuredShortcut?: string;
	probe?: ShortcutProbe;
	hostSupportsRegisterShortcut?: boolean;
}): Promise<ShortcutAvailability> {
	const preferred = PREFERRED_SHORTCUT;
	const hostOk = options?.hostSupportsRegisterShortcut !== false;
	const probe = options?.probe ?? deniedShortcutProbe();

	if (!hostOk) {
		return {
			preferred,
			available: false,
			registered: false,
			reason: "host_missing_registerShortcut",
		};
	}

	const configured = options?.configuredShortcut?.trim();
	if (configured && configured !== preferred) {
		// User overrode in config — still verify that exact chord; do not invent another.
		const ok = await probe.isAvailable(configured);
		return {
			preferred,
			available: ok,
			registered: false,
			reason: ok
				? `configured_override:${configured}`
				: `configured_override_unavailable:${configured}`,
		};
	}

	const available = await probe.isAvailable(preferred);
	if (!available) {
		return {
			preferred,
			available: false,
			registered: false,
			reason: "preferred_unavailable_or_unverified",
		};
	}

	return {
		preferred,
		available: true,
		registered: false,
		reason: "preferred_available",
	};
}

/**
 * Register preferred (or verified configured) shortcut. Returns whether registration happened.
 * Does not register when availability is false.
 */
export async function maybeRegisterVoiceShortcut(
	pi: VoiceHostApi,
	options: {
		handler: (ctx: VoiceHostContext) => Promise<void> | void;
		probe?: ShortcutProbe;
		configuredShortcut?: string;
	},
): Promise<ShortcutAvailability> {
	const supports = typeof pi.registerShortcut === "function";
	const availability = await evaluatePreferredShortcut({
		hostSupportsRegisterShortcut: supports,
		...(options.configuredShortcut ? { configuredShortcut: options.configuredShortcut } : {}),
		...(options.probe ? { probe: options.probe } : {}),
	});

	if (!availability.available || !supports) {
		return availability;
	}

	const chord = options.configuredShortcut?.trim() && options.configuredShortcut.trim() !== PREFERRED_SHORTCUT
		? options.configuredShortcut.trim()
		: PREFERRED_SHORTCUT;

	// Re-check the actual chord we will bind.
	const probe = options.probe ?? deniedShortcutProbe();
	if (!(await probe.isAvailable(chord))) {
		return {
			...availability,
			available: false,
			registered: false,
			reason: "bind_target_unavailable",
		};
	}

	pi.registerShortcut!(chord, {
		description: "Gentle Voice listen/stop",
		handler: async (ctx) => {
			await options.handler(ctx);
		},
	});

	return {
		...availability,
		registered: true,
		reason: `registered:${chord}`,
	};
}
