/**
 * Auto-submit gates for fluent conversation — evidence-based, not ad-hoc phrase bans.
 * Blocks silence / prompt-echo hallucinations without rewriting valid speech.
 */

import type { CaptureSegmentMeta } from "../contracts.ts";
import { DEFAULT_WHISPER_INITIAL_PROMPT } from "./corrections.ts";

export type UtteranceRejectReason =
	| "no_capture_meta"
	| "no_speech_seen"
	| "rms_too_low"
	| "too_short"
	| "prompt_echo"
	| "empty_text"
	| "ok";

export interface UtteranceGateInput {
	readonly text: string;
	readonly captureMeta?: CaptureSegmentMeta;
	/** Whisper --prompt seed used for this turn (if any). */
	readonly whisperPrompt?: string;
	/** Min mean RMS to treat as real speech (default 0.004). */
	readonly minMeanRms?: number;
	/** Min peak RMS (default 0.01). */
	readonly minPeakRms?: number;
	/** Min duration with speech (ms). */
	readonly minDurationMs?: number;
}

export interface UtteranceGateResult {
	readonly accept: boolean;
	readonly reason: UtteranceRejectReason;
	/** Lab-safe diag line (no full transcript). */
	readonly diag: string;
}

function tokenize(s: string): string[] {
	return s
		.toLowerCase()
		.replace(/[#.,;:!?"'`]/g, " ")
		.split(/\s+/)
		.map((t) => t.trim())
		.filter((t) => t.length > 1);
}

/**
 * True when transcript is largely an echo of the Whisper initial prompt
 * (common silence hallucination). Evidence: lab ghost "C#, Angular, PostgreSQL"
 * matched DEFAULT_WHISPER_INITIAL_PROMPT tokens.
 */
export function isLikelyWhisperPromptEcho(
	transcript: string,
	prompt: string = DEFAULT_WHISPER_INITIAL_PROMPT,
): boolean {
	const textToks = tokenize(transcript);
	const promptToks = new Set(tokenize(prompt));
	if (textToks.length === 0 || promptToks.size === 0) return false;
	const hit = textToks.filter((t) => promptToks.has(t)).length;
	const ratio = hit / textToks.length;
	// Entire short utterance made of prompt tokens, or ≥80% overlap on ≤8 tokens.
	if (textToks.length <= 8 && ratio >= 0.8) return true;
	if (textToks.length <= 4 && hit >= 2 && ratio >= 0.66) return true;
	return false;
}

/**
 * Decide whether a transcript may auto-submit.
 * Reject → caller must NOT send; may fall back to manual review or silence.
 */
export function gateUtteranceForAutoSubmit(input: UtteranceGateInput): UtteranceGateResult {
	const text = input.text.trim();
	const meta = input.captureMeta;
	const minMean = input.minMeanRms ?? 0.004;
	const minPeak = input.minPeakRms ?? 0.01;
	const minDur = input.minDurationMs ?? 280;
	const prompt = input.whisperPrompt ?? DEFAULT_WHISPER_INITIAL_PROMPT;

	const baseDiag = meta
		? `cap=${meta.captureId.slice(0, 8)} speech=${meta.speechSeen} end=${meta.endReason} durMs=${meta.durationMs} peak=${meta.peakRms.toFixed(4)} mean=${meta.meanRms.toFixed(4)}`
		: "cap=none";

	if (!text) {
		return { accept: false, reason: "empty_text", diag: `${baseDiag} reject=empty_text` };
	}
	if (!meta) {
		// Stubs/tests without meta: allow only if not prompt echo (fail closed for fluent prod path via session requiring meta when available).
		if (isLikelyWhisperPromptEcho(text, prompt)) {
			return { accept: false, reason: "prompt_echo", diag: `${baseDiag} reject=prompt_echo chars=${text.length}` };
		}
		return { accept: true, reason: "ok", diag: `${baseDiag} accept=no_meta chars=${text.length}` };
	}
	if (!meta.speechSeen) {
		return { accept: false, reason: "no_speech_seen", diag: `${baseDiag} reject=no_speech_seen chars=${text.length}` };
	}
	if (meta.meanRms < minMean && meta.peakRms < minPeak) {
		return { accept: false, reason: "rms_too_low", diag: `${baseDiag} reject=rms_too_low chars=${text.length}` };
	}
	if (meta.durationMs < minDur) {
		return { accept: false, reason: "too_short", diag: `${baseDiag} reject=too_short chars=${text.length}` };
	}
	if (isLikelyWhisperPromptEcho(text, prompt)) {
		return { accept: false, reason: "prompt_echo", diag: `${baseDiag} reject=prompt_echo chars=${text.length}` };
	}
	return { accept: true, reason: "ok", diag: `${baseDiag} accept=ok chars=${text.length}` };
}
