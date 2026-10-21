/**
 * When the barge microphone may open.
 * WORKING (orchestrator / tools) stays closed.
 * NARRATING, SYNTHESIZING, VOICE_LOADING and SPEAKING are the voice pipeline.
 */

import type { VoicePhase } from "../contracts.ts";

export function voiceInterruptWindow(input: {
	readonly phase: VoicePhase;
	/** Second LLM call after the orchestrator has settled. */
	readonly narrating: boolean;
	/** TTS is generating or loading. Chrome may say SYNTHESIZING before phase is speaking. */
	readonly synthesizing: boolean;
}): boolean {
	if (input.phase === "speaking") return true;
	if (input.phase === "awaiting_agent" && input.narrating) return true;
	if (input.phase === "awaiting_agent" && input.synthesizing) return false;
	return false;
}
