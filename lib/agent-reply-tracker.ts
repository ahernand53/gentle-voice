/**
 * Correlate Pi 1.2 lifecycle events with a Gentle Voice submit turn.
 *
 * Pi contracts (pi-coding-agent >=1.2):
 * - agent_settled → { type, aborted } ONLY — no message payload
 * - turn_end → { message, outcome, ... } per turn
 * - agent_end → { messages } full run transcript
 * - agent_before_settle → boundary state (contextMessages) — optional backup
 *
 * Never invents assistant text. Diagnostics omit prompt/response bodies by default.
 */

import type { AssistantMessageLike } from "./contracts.ts";
import type { AgentSettleOutcome } from "./agent-settled.ts";
import { extractAssistantPlainText } from "./final-utterance.ts";

export interface ReplyDiagEvent {
	readonly at: string;
	readonly kind: string;
	/** Non-sensitive counters / reasons only. */
	readonly detail: Record<string, string | number | boolean | undefined>;
}

export interface SettledSpeakPlan {
	readonly message: AssistantMessageLike | null;
	readonly outcome: AgentSettleOutcome;
	readonly source: "turn_end" | "agent_end" | "before_settle" | "session_entries" | "none";
	readonly skipReason?: string;
	readonly fingerprint?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function asAssistantMessage(value: unknown): AssistantMessageLike | null {
	if (!isRecord(value)) return null;
	const role = value.role;
	if (role !== undefined && role !== "assistant") return null;
	const content = value.content;
	if (!Array.isArray(content) && content !== undefined) return null;
	return {
		role: "assistant",
		content: Array.isArray(content) ? (content as AssistantMessageLike["content"]) : [],
	};
}

export function fingerprintMessage(message: AssistantMessageLike | null): string {
	if (!message?.content) return "";
	const parts: string[] = [];
	for (const part of message.content) {
		if (!part || typeof part !== "object") continue;
		const p = part as { type?: string; text?: string };
		if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
	}
	const joined = parts.join("\n").trim();
	// Length + simple hash — no body stored in diagnostics.
	let h = 0;
	for (let i = 0; i < joined.length; i++) h = (h * 31 + joined.charCodeAt(i)) | 0;
	return `${joined.length}:${h.toString(16)}`;
}

/** Last assistant that has user-facing text. A trailing tool-only message does not hide it. */
export function lastAssistantFromMessages(list: unknown): AssistantMessageLike | null {
	if (!Array.isArray(list)) return null;
	let toolOnly: AssistantMessageLike | null = null;
	for (let i = list.length - 1; i >= 0; i--) {
		const msg = asAssistantMessage(list[i]);
		if (!msg) continue;
		if (extractAssistantPlainText(msg)) return msg;
		if (!toolOnly) toolOnly = msg;
	}
	return toolOnly;
}

/** Read last assistant from Pi sessionManager.getEntries() message entries. */
export function lastAssistantFromSessionEntries(entries: unknown): AssistantMessageLike | null {
	if (!Array.isArray(entries)) return null;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!isRecord(entry) || entry.type !== "message") continue;
		const msg = asAssistantMessage(entry.message);
		if (!msg) continue;
		if (extractAssistantPlainText(msg)) return msg;
	}
	return null;
}

export class AgentReplyTracker {
	#voiceTurnId: string | undefined;
	#awaitingReply = false;
	#cached: AssistantMessageLike | null = null;
	#cachedSource: SettledSpeakPlan["source"] = "none";
	#spokenFingerprint: string | undefined;
	#diag: ReplyDiagEvent[] = [];

	get awaitingReply(): boolean {
		return this.#awaitingReply;
	}

	get diagnostics(): readonly ReplyDiagEvent[] {
		return this.#diag;
	}

	clearDiagnostics(): void {
		this.#diag = [];
	}

	#log(kind: string, detail: ReplyDiagEvent["detail"] = {}): void {
		this.#diag.push({ at: new Date().toISOString(), kind, detail });
		if (this.#diag.length > 40) this.#diag.shift();
	}

	/** Call when Gentle Voice explicitly sends a transcript to the agent. */
	markVoiceSubmit(turnId: string): void {
		this.#voiceTurnId = turnId;
		this.#awaitingReply = true;
		this.#cached = null;
		this.#cachedSource = "none";
		this.#log("voice_submit", { turnId, fpPrev: this.#spokenFingerprint });
	}

	onTurnEnd(event: unknown): void {
		if (!this.#awaitingReply) return;
		if (!isRecord(event)) return;
		const msg = asAssistantMessage(event.message);
		if (!msg) {
			this.#log("turn_end_no_assistant", {
				turnIndex: typeof event.turnIndex === "number" ? event.turnIndex : undefined,
				outcome: typeof event.outcome === "string" ? event.outcome : undefined,
			});
			return;
		}
		if (!extractAssistantPlainText(msg) && this.#cached && extractAssistantPlainText(this.#cached)) {
			this.#log("turn_end_kept_prior_text", {
				turnIndex: typeof event.turnIndex === "number" ? event.turnIndex : undefined,
			});
			return;
		}
		this.#cached = msg;
		this.#cachedSource = "turn_end";
		this.#log("turn_end_cached", {
			fp: fingerprintMessage(msg),
			outcome: typeof event.outcome === "string" ? event.outcome : undefined,
		});
	}

	onAgentEnd(event: unknown): void {
		if (!this.#awaitingReply) return;
		if (!isRecord(event)) return;
		const msg = lastAssistantFromMessages(event.messages);
		if (!msg) {
			this.#log("agent_end_no_assistant", {
				count: Array.isArray(event.messages) ? event.messages.length : 0,
			});
			return;
		}
		this.#cached = msg;
		this.#cachedSource = "agent_end";
		this.#log("agent_end_cached", { fp: fingerprintMessage(msg) });
	}

	onBeforeSettle(event: unknown): void {
		if (!this.#awaitingReply || this.#cached) return;
		if (!isRecord(event)) return;
		const ctx = event.context;
		if (!isRecord(ctx)) return;
		const msg =
			lastAssistantFromMessages(ctx.contextMessages)
			?? lastAssistantFromMessages(ctx.llmMessages);
		if (!msg) return;
		this.#cached = msg;
		this.#cachedSource = "before_settle";
		this.#log("before_settle_cached", { fp: fingerprintMessage(msg) });
	}

	/**
	 * Prefer cached turn/agent message; optionally fall back to session entries.
	 * Dedupes identical fingerprints already spoken.
	 */
	consumeSettled(options: {
		aborted: boolean;
		sessionEntries?: unknown;
	}): SettledSpeakPlan {
		const outcome: AgentSettleOutcome = options.aborted ? "aborted" : "completed";
		if (!this.#awaitingReply) {
			this.#log("settled_ignored_not_awaiting", { aborted: options.aborted });
			return { message: null, outcome, source: "none", skipReason: "not_awaiting_voice_turn" };
		}

		let message = this.#cached;
		let source = this.#cachedSource;
		if (!message && options.sessionEntries !== undefined) {
			message = lastAssistantFromSessionEntries(options.sessionEntries);
			if (message) source = "session_entries";
		}

		this.#awaitingReply = false;
		this.#cached = null;
		this.#cachedSource = "none";

		if (options.aborted) {
			this.#log("settled_aborted", {});
			return { message: null, outcome: "aborted", source, skipReason: "aborted" };
		}
		if (!message) {
			this.#log("settled_no_message", { source });
			return { message: null, outcome, source: "none", skipReason: "no_assistant_message" };
		}

		const fp = fingerprintMessage(message);
		if (fp && fp === this.#spokenFingerprint) {
			this.#log("settled_duplicate", { fp });
			return { message, outcome, source, skipReason: "duplicate_fingerprint", fingerprint: fp };
		}
		this.#spokenFingerprint = fp;
		this.#log("settled_ready", { fp, source, voiceTurn: this.#voiceTurnId });
		return { message, outcome, source, fingerprint: fp };
	}
}
