/**
 * Normalize Pi / Gentle Shell agent_settled payloads into a message + outcome.
 * Tolerant of several host shapes; never invents assistant text.
 */

import type { AssistantMessageLike } from "./contracts.ts";

export type AgentSettleOutcome = "completed" | "aborted" | "error";

export interface NormalizedAgentSettled {
	readonly message: AssistantMessageLike | null;
	readonly outcome: AgentSettleOutcome;
}

function asMessage(value: unknown): AssistantMessageLike | null {
	if (!value || typeof value !== "object") return null;
	const m = value as AssistantMessageLike;
	if (m.role && m.role !== "assistant") return null;
	return m;
}

function lastAssistantFromList(list: unknown): AssistantMessageLike | null {
	if (!Array.isArray(list)) return null;
	for (let i = list.length - 1; i >= 0; i--) {
		const candidate = asMessage(list[i]);
		if (candidate && (candidate.role === "assistant" || candidate.content)) {
			return { role: "assistant", content: candidate.content };
		}
	}
	return null;
}

export function normalizeAgentSettledEvent(event: unknown): NormalizedAgentSettled {
	if (event == null) {
		return { message: null, outcome: "completed" };
	}
	if (typeof event !== "object") {
		return { message: null, outcome: "completed" };
	}
	const e = event as Record<string, unknown>;

	let outcome: AgentSettleOutcome = "completed";
	if (e.aborted === true || e.outcome === "aborted") outcome = "aborted";
	else if (e.error === true || e.outcome === "error" || typeof e.error === "string") {
		outcome = "error";
	}

	const message =
		asMessage(e.message)
		?? asMessage(e.assistantMessage)
		?? asMessage(e.assistant)
		?? lastAssistantFromList(e.messages)
		?? lastAssistantFromList(e.history)
		?? null;

	return { message, outcome };
}
