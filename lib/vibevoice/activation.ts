/**
 * Installed, ready, and active are different.
 * Installed: pinned files and the private environment are present.
 * Ready: the worker process can start without loading the GPU model.
 * Active: this Pi session is using that engine. Ready to use requires Active.
 */

export type EngineLifecycle = "installed" | "ready" | "active";

export function formatVibeVoiceActivation(input: {
	readonly voice: string;
	readonly playback: "PCM" | "WAV";
	readonly active: boolean;
	readonly detail?: string;
}): string {
	if (!input.active) {
		return [
			"VibeVoice was installed, but it is not active.",
			input.detail ? `Detail: ${input.detail}` : "",
		].filter((line) => line !== "").join("\n");
	}
	return [
		"VibeVoice installed successfully!",
		"",
		"Engine: VibeVoice",
		`Voice: ${input.voice}`,
		`Playback: ${input.playback}`,
		"Status: Ready to use",
	].join("\n");
}

export function formatPiperActivation(input: {
	readonly voice: string;
	readonly active: boolean;
	readonly detail?: string;
}): string {
	if (!input.active) {
		return [
			"Piper was installed, but it is not active.",
			input.detail ? `Detail: ${input.detail}` : "",
		].filter((line) => line !== "").join("\n");
	}
	return [
		"Piper installed successfully!",
		"",
		"Engine: Piper",
		`Voice: ${input.voice}`,
		"Playback: WAV",
		"Status: Ready to use",
	].join("\n");
}

export function formatWhisperActivation(active: boolean, detail?: string): string {
	if (!active) {
		return [
			"Speech recognition was installed, but it is not active.",
			detail ? `Detail: ${detail}` : "",
		].filter((line) => line !== "").join("\n");
	}
	return [
		"Speech recognition is ready.",
		"",
		"Engine: Whisper",
		"Status: Ready to use",
	].join("\n");
}
