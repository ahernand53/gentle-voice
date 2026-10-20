/**
 * Preferred voice shortcuts: Ctrl+Alt+Space (conversation toggle), Ctrl+Alt+E (edit).
 * Product mode registers when the host exposes registerShortcut unless explicitly disabled.
 * Lab env gates remain available for experimental probing — they are not required for product.
 */

import type { VoiceHostApi, VoiceHostContext } from "./contracts.ts";
import {
	PREFERRED_SHORTCUT,
	PREFERRED_SHORTCUT_LABEL,
	type ShortcutAvailability,
} from "./engines/contracts.ts";

export { PREFERRED_SHORTCUT, PREFERRED_SHORTCUT_LABEL };

export const PRODUCT_SHORTCUT_CHORDS = Object.freeze([
	"ctrl+alt+space",
	"ctrl+alt+e",
] as const);

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

export function allowlistShortcutProbe(allowed: readonly string[]): ShortcutProbe {
	const set = new Set(allowed.map((s) => s.toLowerCase()));
	return {
		isAvailable: (shortcut) => set.has(shortcut.toLowerCase()),
	};
}

/**
 * Product shortcut gate (phase 3.5+).
 * Enabled by default for the preferred chords.
 * Disable with GENTLE_VOICE_DISABLE_SHORTCUTS=1.
 * Does not require GENTLE_VOICE_LAB / LAB_SHORTCUT / SHORTCUT_VERIFIED.
 * Does not read/write Hyprland or Ghostty configs — registration is host-API only.
 * "Available" here means "allowed to register with Pi", not "OS delivered the key".
 */
export function productShortcutProbeFromEnv(
	env: NodeJS.ProcessEnv = process.env,
	allowed: readonly string[] = PRODUCT_SHORTCUT_CHORDS,
): ShortcutProbe {
	if (env.GENTLE_VOICE_DISABLE_SHORTCUTS === "1") return deniedShortcutProbe();
	return allowlistShortcutProbe(allowed);
}

/**
 * Lab-only enable gate (legacy / experimental). Requires ALL of:
 * - GENTLE_VOICE_LAB=1
 * - GENTLE_VOICE_LAB_SHORTCUT=1
 * Never reads/writes global Hyprland/Ghostty configs.
 */
export function labShortcutProbeFromEnv(
	env: NodeJS.ProcessEnv = process.env,
	allowed: readonly string[] = PRODUCT_SHORTCUT_CHORDS,
): ShortcutProbe {
	const lab = env.GENTLE_VOICE_LAB === "1";
	const enable = env.GENTLE_VOICE_LAB_SHORTCUT === "1";
	if (!lab || !enable) return deniedShortcutProbe();
	return allowlistShortcutProbe(allowed);
}

/**
 * Default probe for the extension: product unless tests inject one.
 * SHORTCUT_VERIFIED is ignored for enablement (status may still report the env bit).
 */
export function defaultVoiceShortcutProbe(
	env: NodeJS.ProcessEnv = process.env,
): ShortcutProbe {
	return productShortcutProbeFromEnv(env);
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
		description: "Gentle Voice conversation toggle (listen/stop)",
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
