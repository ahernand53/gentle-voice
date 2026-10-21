/**
 * Centralized Gentle Voice TUI chrome (widget + status).
 * Single source of truth so command handlers cannot desync labels.
 * Phase 2D: visual activity labels + optional real-PCM wave line.
 */

import type { VoicePhase } from "./contracts.ts";
import type { VoiceMachineState } from "./state-machine.ts";
import { VOICE_BRAND, VOICE_GLYPH_GAP } from "./visual/compact-widget.ts";
import type { VisualSpeakStage } from "./visual/visual-meter.ts";

/**
 * User-facing activity label (TUI). Maps machine phases + visual overlays.
 * SPEECH_DETECTED / SYNTHESIZING come from real meter events, not fiction.
 */
export type VoiceChromeActivity =
	| "READY"
	| "ARMING"
	| "LISTENING"
	| "SPEECH_DETECTED"
	| "TRANSCRIBING"
	| "WORKING"
	| "NARRATING"
	| "VOICE_LOADING"
	| "SYNTHESIZING"
	| "SPEAKING"
	| "MUTED"
	| "PAUSED"
	| "ERROR";

export const VOICE_WIDGET_KEY = "gentle-voice-mic";
export const VOICE_STATUS_KEY = "gentle-voice";

/** Optional live visual overlay from VisualMeter (never invents amplitude). */
export interface VoiceChromeVisual {
	readonly speakStage?: VisualSpeakStage;
	readonly speechDetected?: boolean;
	/** Unicode bars from real PCM; omit when animations off or no activity. */
	readonly waveLine?: string;
	/** When true and speaking without reliable scrub, show simple activity. */
	readonly simpleSpeakingActivity?: boolean;
	readonly paused?: boolean;
	/** Terminal columns hint for narrow layout. */
	readonly terminalColumns?: number;
	/**
	 * Mic capture requested but first PCM not yet seen.
	 * Must not display as operational LISTENING.
	 */
	readonly micReady?: boolean;
	/**
	 * Provisional (incremental) or committed transcript for chrome.
	 * Partials must never be submitted to Pi — display only.
	 */
	readonly transcriptPreview?: string;
	/**
	 * partial = provisional ASR (prefix …)
	 * final = committed STT (prefix ✓)
	 * decoding = whisper busy; no stale words — neutral marker only
	 */
	readonly transcriptPreviewKind?: "partial" | "final" | "decoding";
	/** Second LLM call is preparing speakable text. Written reply is already visible. */
	readonly narrating?: boolean;
}

export function chromeActivityFromPhase(phase: VoicePhase): VoiceChromeActivity {
	switch (phase) {
		case "idle":
			return "READY";
		case "listening":
			return "LISTENING";
		case "transcribing":
			return "TRANSCRIBING";
		case "awaiting_agent":
			return "WORKING";
		case "speaking":
			return "SPEAKING";
		case "error":
			return "ERROR";
		default: {
			const _exhaustive: never = phase;
			return _exhaustive;
		}
	}
}

/**
 * Resolve display activity from machine phase + live visual meter.
 * MUTED as activity when muted and idle (mute also always shown on audio chip).
 * Never maps WORKING to SPEAKING — agent processing ≠ playback.
 */
export function resolveChromeActivity(
	state: VoiceMachineState,
	visual?: VoiceChromeVisual,
): VoiceChromeActivity {
	if (visual?.paused) return "PAUSED";
	if (state.phase === "error") return "ERROR";

	const speakStage = visual?.speakStage ?? "idle";
	if (
		state.phase === "speaking"
		|| speakStage === "loading_voice"
		|| speakStage === "synthesizing"
		|| speakStage === "speaking"
	) {
		if (speakStage === "loading_voice") return "VOICE_LOADING";
		if (speakStage === "synthesizing") return "SYNTHESIZING";
		if (speakStage === "speaking" || state.phase === "speaking") return "SPEAKING";
	}

	if (state.phase === "awaiting_agent" && visual?.narrating) return "NARRATING";

	if (state.phase === "listening") {
		// LISTENING only when mic is actually producing samples.
		if (visual?.micReady === false) return "ARMING";
		if (visual?.speechDetected) return "SPEECH_DETECTED";
		return "LISTENING";
	}

	if (state.muted && state.phase === "idle") return "MUTED";

	return chromeActivityFromPhase(state.phase);
}

export function chromeAudioLabel(muted: boolean): string {
	// ON uses theme accent at paint time; MUTED stays semantic (warning).
	return muted ? "🔇 MUTED" : "🔊 ON";
}

export function chromeGlyph(activity: VoiceChromeActivity): string {
	switch (activity) {
		case "SPEAKING":
		case "SYNTHESIZING":
		case "VOICE_LOADING":
			return "🔊";
		case "MUTED":
		case "PAUSED":
			return "🔇";
		case "ERROR":
			return "⚠";
		default:
			return "🎙";
	}
}

/**
 * Compact widget header. Empty → clear widget (Voice OFF).
 */
export function renderVoiceWidgetLine(
	state: VoiceMachineState,
	visual?: VoiceChromeVisual,
): string | undefined {
	if (!state.enabled) return undefined;
	const activity = resolveChromeActivity(state, visual);
	const audio = chromeAudioLabel(state.muted);
	const glyph = chromeGlyph(activity);
	const narrow = (visual?.terminalColumns ?? 80) < 48;
	// Always insert VOICE_GLYPH_GAP so emoji never glues to the following text.
	if (narrow) {
		return `${glyph}${VOICE_GLYPH_GAP}${activity}${state.muted ? " 🔇" : ""}`;
	}
	return `${glyph}${VOICE_GLYPH_GAP}${VOICE_BRAND} │ ${activity} │ ${audio}`;
}

function renderWaveOrActivity(
	state: VoiceMachineState,
	visual: VoiceChromeVisual | undefined,
	activity: VoiceChromeActivity,
): string | undefined {
	if (!visual) return undefined;
	if (state.muted) return undefined;

	if (activity === "SYNTHESIZING" || activity === "VOICE_LOADING" || activity === "NARRATING") {
		return "⋯";
	}

	if (activity === "SPEAKING" && visual.simpleSpeakingActivity) {
		return "● ● ●";
	}

	if (activity === "ARMING") {
		return "⋯";
	}

	if (
		activity === "LISTENING"
		|| activity === "SPEECH_DETECTED"
		|| activity === "SPEAKING"
	) {
		return visual.waveLine;
	}

	return undefined;
}

function renderTranscriptPreview(visual?: VoiceChromeVisual): string | undefined {
	const kind = visual?.transcriptPreviewKind;
	if (kind === "decoding") {
		// Neutral — never reuse frozen words while whisper is still busy.
		return "⋯ escuchando";
	}
	const text = visual?.transcriptPreview?.trim();
	if (!text) return undefined;
	const narrow = (visual?.terminalColumns ?? 80) < 48;
	const max = narrow ? 36 : 72;
	const clipped = text.length > max ? `${text.slice(0, max - 1)}…` : text;
	if (kind === "final") {
		return `✓ ${clipped}`;
	}
	// Explicit provisional marker — never looks like a committed send.
	return `… ${clipped}`;
}

export function renderVoiceWidgetContent(
	state: VoiceMachineState,
	visual?: VoiceChromeVisual,
): string[] | undefined {
	const line = renderVoiceWidgetLine(state, visual);
	if (line === undefined) return undefined;
	const activity = resolveChromeActivity(state, visual);
	const lines = [line];
	const wave = renderWaveOrActivity(state, visual, activity);
	if (wave && wave.trim().length > 0) {
		lines.push(wave);
	}
	const preview = renderTranscriptPreview(visual);
	if (preview) {
		lines.push(preview);
	}
	return lines;
}

/** Short status-bar text (optional Pi setStatus). */
export function renderVoiceStatusText(
	state: VoiceMachineState,
	visual?: VoiceChromeVisual,
): string | undefined {
	if (!state.enabled) return undefined;
	const activity = resolveChromeActivity(state, visual);
	const base = state.muted ? `voice ${activity} muted` : `voice ${activity}`;
	if (visual?.transcriptPreviewKind === "decoding") {
		return `${base} · stt…`;
	}
	if (visual?.transcriptPreviewKind === "partial" && visual.transcriptPreview?.trim()) {
		return `${base} · parcial`;
	}
	if (visual?.transcriptPreviewKind === "final" && visual.transcriptPreview?.trim()) {
		return `${base} · final`;
	}
	return base;
}

export interface VoiceChromeSnapshot {
	readonly widgetKey: typeof VOICE_WIDGET_KEY;
	readonly statusKey: typeof VOICE_STATUS_KEY;
	readonly widgetContent: string[] | undefined;
	readonly statusText: string | undefined;
	readonly placement: "aboveEditor";
	readonly activity: VoiceChromeActivity;
}

export function snapshotVoiceChrome(
	state: VoiceMachineState,
	visual?: VoiceChromeVisual,
): VoiceChromeSnapshot {
	const activity = state.enabled
		? resolveChromeActivity(state, visual)
		: "READY";
	return {
		widgetKey: VOICE_WIDGET_KEY,
		statusKey: VOICE_STATUS_KEY,
		widgetContent: renderVoiceWidgetContent(state, visual),
		statusText: renderVoiceStatusText(state, visual),
		placement: "aboveEditor",
		activity,
	};
}
