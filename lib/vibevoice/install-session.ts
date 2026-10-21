/**
 * One VibeVoice install at a time. Diagnostic commands read this snapshot
 * instead of waiting for pip to finish.
 */

import type { InstallStep } from "./install-progress.ts";
import {
	runVibeVoiceOnboarding,
	VIBEVOICE_PHASE_TEXT,
	type OnboardingResult,
	type VibeVoiceInstallPhase,
	type VibeVoiceInstallProgress,
} from "./onboarding.ts";

export type VibeVoiceInstallSnapshotPhase = VibeVoiceInstallPhase | "idle" | "cancelled" | "failed" | "installed";

export interface VibeVoiceInstallSnapshot {
	readonly running: boolean;
	readonly phase: VibeVoiceInstallSnapshotPhase;
	readonly message: string;
	readonly detail?: string;
	readonly steps: readonly InstallStep[];
}

interface InstallState {
	running: boolean;
	phase: VibeVoiceInstallSnapshotPhase;
	message: string;
	detail?: string;
	steps: InstallStep[];
	abort?: AbortController;
	promise?: Promise<OnboardingResult>;
}

let current: InstallState = { running: false, phase: "idle", message: "", steps: [] };

export function vibeVoiceInstallSnapshot(): VibeVoiceInstallSnapshot {
	return {
		running: current.running,
		phase: current.phase,
		message: current.message,
		steps: current.steps,
		...(current.detail ? { detail: current.detail } : {}),
	};
}

export function publishVibeVoiceInstallMessage(
	message: string,
	phase: VibeVoiceInstallSnapshotPhase,
	steps?: readonly InstallStep[],
): void {
	current.message = message;
	current.phase = phase;
	if (steps) current.steps = steps.map((step) => ({ ...step }));
}

export function commandSkipsInstallWait(command: string | undefined, rest: string): boolean {
	if (command === "status") return true;
	const head = rest.trim().split(/\s+/, 1)[0] ?? "";
	return command === "vibevoice-setup" && (head === "plan" || head === "cancel" || head === "status");
}

export function cancelVibeVoiceInstall(): boolean {
	if (!current.running || !current.abort) return false;
	current.abort.abort();
	current.message = "Installation cancelled.";
	return true;
}

export function beginVibeVoiceInstall(
	input: Parameters<typeof runVibeVoiceOnboarding>[0],
): Promise<OnboardingResult> {
	if (current.running && current.promise) return current.promise;
	const abort = new AbortController();
	if (input.signal?.aborted) abort.abort();
	else input.signal?.addEventListener("abort", () => abort.abort(), { once: true });
	let resolveOuter: (result: OnboardingResult) => void = () => undefined;
	let rejectOuter: (error: unknown) => void = () => undefined;
	const outer = new Promise<OnboardingResult>((resolve, reject) => {
		resolveOuter = resolve;
		rejectOuter = reject;
	});
	current = {
		running: true,
		phase: "starting",
		message: VIBEVOICE_PHASE_TEXT.starting,
		steps: [],
		abort,
		promise: outer,
	};
	void runVibeVoiceOnboarding({
		...input,
		signal: abort.signal,
		onProgress: (progress: VibeVoiceInstallProgress) => {
			current.phase = progress.phase;
			current.message = progress.message;
			current.steps = progress.steps.map((step) => ({ ...step }));
			input.onProgress?.(progress);
		},
	}).then((result) => {
		current.running = false;
		current.detail = result.detail;
		if (result.status === "cancelled") {
			current.phase = "cancelled";
			current.message = "Installation cancelled.";
		} else if (result.status === "installed" || result.status === "reused") {
			current.phase = "installed";
			current.message = "VibeVoice files verified.";
		} else {
			current.phase = "failed";
			current.message = result.reason;
		}
		resolveOuter(result);
	}, (error: unknown) => {
		current.running = false;
		current.phase = "failed";
		current.message = error instanceof Error ? error.message : "failed";
		rejectOuter(error);
	});
	return outer;
}

/** Test isolation. Production installs keep the module state. */
export function resetVibeVoiceInstallState(): void {
	current.abort?.abort();
	current = { running: false, phase: "idle", message: "", steps: [] };
}
