/**
 * Shows the install checklist and activates the engine in the current session.
 * Activation does not play audio.
 */

import { explainVibeVoiceSetup } from "../runtime/onboarding-choice.ts";
import { formatVibeVoiceActivation } from "./activation.ts";
import { installProgressWidget, type InstallStep } from "./install-progress.ts";
import { beginVibeVoiceInstall, publishVibeVoiceInstallMessage } from "./install-session.ts";
import type { OnboardingResult, VibeVoiceInstallProgress } from "./onboarding.ts";

export const VIBEVOICE_INSTALL_WIDGET_KEY = "gentle-voice-install";

export interface InstallDriveHost {
	notify(message: string, level?: "info" | "warning" | "error"): void;
	setStatus?(key: string, text: string | undefined): void;
	setWidget?(
		key: string,
		content: unknown,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
	activateEngine?(): Promise<{ ttsId?: string; sttKind?: string; pcmSupported: boolean }>;
}

function paint(host: InstallDriveHost, steps: readonly InstallStep[], status: string): void {
	host.setStatus?.(VIBEVOICE_INSTALL_WIDGET_KEY, status);
	host.setWidget?.(VIBEVOICE_INSTALL_WIDGET_KEY, installProgressWidget(steps), { placement: "aboveEditor" });
}

function clearInstallChrome(host: InstallDriveHost): void {
	host.setStatus?.(VIBEVOICE_INSTALL_WIDGET_KEY, undefined);
	host.setWidget?.(VIBEVOICE_INSTALL_WIDGET_KEY, undefined);
}

export async function driveVibeVoiceInstall(
	host: InstallDriveHost,
	input: Parameters<typeof beginVibeVoiceInstall>[0],
): Promise<OnboardingResult> {
	let steps: readonly InstallStep[] = [];
	host.notify("Installing VibeVoice...", "info");
	host.setStatus?.(VIBEVOICE_INSTALL_WIDGET_KEY, "Installing VibeVoice...");
	const result = await beginVibeVoiceInstall({
		...input,
		onProgress: (progress: VibeVoiceInstallProgress) => {
			steps = progress.steps;
			paint(host, steps, progress.message);
			input.onProgress?.(progress);
		},
	});
	if (result.status === "installed" || result.status === "reused") {
		const running = steps.map((step) => step.id === "activate" ? { ...step, state: "running" as const } : step);
		paint(host, running, "Activating VibeVoice");
		const live = await host.activateEngine?.();
		const active = Boolean(live?.ttsId?.includes("vibevoice"));
		const playback = active && live?.pcmSupported ? "PCM" as const : "WAV" as const;
		const detail = !active
			? live?.ttsId ? `active engine: ${live.ttsId}` : "the session is not using VibeVoice"
			: result.detail;
		const done = running.map((step) => step.id === "activate"
			? { ...step, state: active ? "completed" as const : "failed" as const }
			: step);
		paint(host, done, "Activating VibeVoice");
		const message = formatVibeVoiceActivation({
			voice: result.voice,
			playback,
			active,
			...(detail ? { detail } : {}),
		});
		publishVibeVoiceInstallMessage(message, active ? "installed" : "failed", done);
		host.notify(message, active ? "info" : "warning");
		clearInstallChrome(host);
		return result;
	}
	if (result.status === "cancelled") {
		publishVibeVoiceInstallMessage("Installation cancelled.", "cancelled");
		host.notify("Installation cancelled.", "warning");
		clearInstallChrome(host);
		return result;
	}
	const detail = result.detail
		? `\nDetail:\n${result.detail.trim().split(/\r?\n/).slice(-6).join("\n")}`
		: "";
	host.notify(`${explainVibeVoiceSetup(result.status, result.reason)}${detail}`, "warning");
	host.setStatus?.(VIBEVOICE_INSTALL_WIDGET_KEY, undefined);
	return result;
}
