/**
 * Persistent VibeVoice install checklist.
 * States change only when the installer observes them. Nothing here is timed.
 */

import { createCompactVoiceLeaf, type CompactWidgetLeaf, type VoiceThemeLike } from "../visual/compact-widget.ts";

export const VIBEVOICE_INSTALL_STEP_ORDER = [
	{ id: "weights", label: "Downloading model" },
	{ id: "source", label: "Downloading source" },
	{ id: "python", label: "Preparing Python environment" },
	{ id: "dependencies", label: "Installing dependencies" },
	{ id: "spanish", label: "Installing Spanish voice" },
	{ id: "engine", label: "Verifying voice engine" },
	{ id: "activate", label: "Activating VibeVoice" },
] as const;

export type InstallStepId = (typeof VIBEVOICE_INSTALL_STEP_ORDER)[number]["id"];

export type InstallStepState = "pending" | "running" | "completed" | "failed" | "reused" | "skipped";

export interface InstallStep {
	readonly id: InstallStepId;
	readonly label: string;
	readonly state: InstallStepState;
}

const STATE_WORD: Record<InstallStepState, string> = {
	pending: "Pending",
	running: "Running",
	completed: "Completed",
	failed: "Failed",
	reused: "Reused",
	skipped: "Skipped",
};

const STATE_MARK: Record<InstallStepState, string> = {
	pending: "[ ]",
	running: "[>]",
	completed: "[x]",
	failed: "[!]",
	reused: "[=]",
	skipped: "[-]",
};

export function createInstallChecklist(): {
	snapshot(): InstallStep[];
	mark(id: InstallStepId, state: InstallStepState): InstallStep[];
} {
	const steps: Array<{ id: InstallStepId; label: string; state: InstallStepState }> = VIBEVOICE_INSTALL_STEP_ORDER.map((step) => ({
		id: step.id,
		label: step.label,
		state: "pending",
	}));
	return {
		snapshot: () => steps.map((step) => ({ ...step })),
		mark(id, state) {
			const found = steps.find((step) => step.id === id);
			if (found) found.state = state;
			return this.snapshot();
		},
	};
}

export function formatInstallStep(step: InstallStep): string {
	return `${STATE_MARK[step.state]} ${step.label}  ${STATE_WORD[step.state]}`;
}

export function formatInstallView(steps: readonly InstallStep[]): string[] {
	return ["Installing VibeVoice...", ...steps.map(formatInstallStep)];
}

/** Compact Pi widget. string[] pads to the full terminal width, so this returns a leaf. */
export function installProgressWidget(
	steps: readonly InstallStep[],
): (ui: unknown, theme: VoiceThemeLike) => CompactWidgetLeaf {
	const lines = formatInstallView(steps);
	return (_ui, theme) => createCompactVoiceLeaf(lines.map((line, index) => {
		if (index === 0 || line.includes(" Running")) return theme.fg("accent", line);
		if (line.includes(" Failed")) return theme.fg("error", line);
		if (line.includes(" Pending")) return theme.fg("dim", line);
		return theme.fg("muted", line);
	}));
}
