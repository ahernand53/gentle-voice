/**
 * Whether an assistant message may be spoken.
 * Structural only: role, content part types, and the settle outcome.
 * Words such as "RDD", "done", or "error" do not decide eligibility.
 */

import { extractAssistantPlainText } from "../final-utterance.ts";
import type { AssistantMessageLike } from "../contracts.ts";

export type FinalSpeechKind =
	| "final_answer"
	| "approval_required"
	| "tool_output"
	| "cancelled"
	| "unknown";

export interface FinalSpeechDecision {
	readonly kind: FinalSpeechKind;
	readonly speak: boolean;
	/** User-facing text. Empty when nothing may be spoken. */
	readonly text: string;
	readonly reason: string;
}

export const APPROVAL_NOTICE = "El agente necesita tu autorización para continuar.";

const UI_PROMPT_KINDS = new Set(["select", "confirm", "input", "editor", "custom"]);

export function classifyAssistantForSpeech(
	message: AssistantMessageLike | null | undefined,
	outcome: "completed" | "aborted" | "error" | undefined,
): FinalSpeechDecision {
	if (outcome === "aborted") {
		return { kind: "cancelled", speak: false, text: "", reason: "run_aborted" };
	}
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
		return { kind: "unknown", speak: false, text: "", reason: "no_assistant_message" };
	}
	const text = extractAssistantPlainText(message);
	if (text) {
		return { kind: "final_answer", speak: true, text, reason: "assistant_text" };
	}
	const hasTool = message.content.some((part) => part?.type === "toolCall");
	const hasThinking = message.content.some((part) => part?.type === "thinking");
	if (hasTool || hasThinking) {
		return { kind: "tool_output", speak: false, text: "", reason: "no_user_text" };
	}
	return { kind: "unknown", speak: false, text: "", reason: "empty_assistant" };
}

/**
 * Pi `ui_prompt_start`. The spoken line is fixed.
 * Title, command text, and paths are not read into the notice.
 */
export function classifyUiPrompt(event: unknown): FinalSpeechDecision {
	if (!event || typeof event !== "object") {
		return { kind: "unknown", speak: false, text: "", reason: "not_a_prompt" };
	}
	const kind = (event as { kind?: unknown }).kind;
	const type = (event as { type?: unknown }).type;
	if (type !== undefined && type !== "ui_prompt_start") {
		return { kind: "unknown", speak: false, text: "", reason: "not_a_prompt" };
	}
	if (typeof kind !== "string" || !UI_PROMPT_KINDS.has(kind)) {
		return { kind: "unknown", speak: false, text: "", reason: "prompt_kind_unknown" };
	}
	return {
		kind: "approval_required",
		speak: true,
		text: APPROVAL_NOTICE,
		reason: `ui_prompt:${kind}`,
	};
}
