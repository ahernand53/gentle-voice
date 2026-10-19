/**
 * ElevenLabs optional TTS — DESIGN ONLY (Phase 2D.2).
 * Not wired. No network. No credentials. No MCP-per-reply path.
 *
 * Integration recommendation (see respuesta.md):
 * - Direct HTTPS TTS API from the voice extension process (streaming PCM/MP3).
 * - NOT an LLM tool/MCP call per agent reply (avoids token waste + tool latency).
 * - Hard monthly character budget; auto-disable → Kokoro/Piper fallback.
 */

export const ELEVENLABS_PROVIDER_ID = "elevenlabs-tts" as const;

export interface ElevenLabsQuotaConfig {
	/** Hard cap characters / calendar month (local counter). */
	readonly monthlyCharBudget: number;
	/** Soft warn threshold 0–1 of budget. */
	readonly warnAtRatio: number;
	/** When true, refuse cloud TTS after budget; use local fallback. */
	readonly autoDisableOnExhaustion: boolean;
	readonly fallbackEngine: "kokoro" | "piper";
}

export const DEFAULT_ELEVENLABS_QUOTA: ElevenLabsQuotaConfig = Object.freeze({
	monthlyCharBudget: 8_000, // leave headroom under free 10k shared credits
	warnAtRatio: 0.8,
	autoDisableOnExhaustion: true,
	fallbackEngine: "kokoro",
});

export interface ElevenLabsDesignNotes {
	readonly freeTierCreditsPerMonth: number;
	readonly apiNotMcpPerReply: true;
	readonly privacy: "cloud_egress_required";
	readonly status: "not_installed";
}

/** Static research snapshot — no live API. */
export function elevenLabsDesignNotes(): ElevenLabsDesignNotes {
	return {
		freeTierCreditsPerMonth: 10_000,
		apiNotMcpPerReply: true,
		privacy: "cloud_egress_required",
		status: "not_installed",
	};
}

/** Pure budget math for future adapter (unit-tested, no I/O). */
export function wouldExceedBudget(
	usedChars: number,
	nextChars: number,
	budget: number,
): boolean {
	return usedChars + Math.max(0, nextChars) > budget;
}
