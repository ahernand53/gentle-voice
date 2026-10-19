/**
 * Assemble stable speakable units from streaming text deltas.
 * Strategy B (2D.5): group 2–3 short sentences (or ~140+ chars) for more
 * natural prosody, while still flushing early on long single sentences.
 * Does not invent content. Ignores thinking/tools (caller feeds text only).
 */

import { markdownToSpeakable } from "./markdown-for-tts.ts";
import { normalizeForTts } from "./normalize-for-tts.ts";

const SENTENCE_END = /([.!?…])(?:\s+|$)/;

export interface AssembledUnit {
	readonly id: string;
	readonly raw: string;
	readonly speakable: string;
}

export interface SentenceAssemblerOptions {
	/** Min chars before forcing a flush without terminal punctuation. */
	readonly softFlushChars?: number;
	readonly language?: string;
	/**
	 * Prefer emitting at least this many sentences per TTS unit (naturalness).
	 * Short replies still flush with fewer on final flush().
	 */
	readonly minSentencesPerUnit?: number;
	/** Or emit sooner when grouped speakable reaches this length. */
	readonly minCharsPerUnit?: number;
	/** Always emit a single very long sentence alone (avoid huge first wait). */
	readonly longSentenceChars?: number;
}

/**
 * Incremental sentence buffer. Push deltas; pull completed speak units.
 * Final flush() releases any trailing stable text.
 */
export class SentenceAssembler {
	#buf = "";
	#emitted = 0;
	#seq = 0;
	#softFlushChars: number;
	#language: string;
	#minSentences: number;
	#minChars: number;
	#longSentenceChars: number;
	/** Completed sentences waiting to be grouped into a speak unit. */
	#pending: string[] = [];
	#emittedConcat = "";
	#spokenConcat = "";

	constructor(options: SentenceAssemblerOptions = {}) {
		this.#softFlushChars = options.softFlushChars ?? 280;
		this.#language = options.language ?? "es";
		this.#minSentences = Math.max(1, options.minSentencesPerUnit ?? 2);
		this.#minChars = options.minCharsPerUnit ?? 140;
		this.#longSentenceChars = options.longSentenceChars ?? 200;
	}

	get buffered(): string {
		return this.#buf;
	}

	get spokenConcat(): string {
		return this.#spokenConcat;
	}

	get emittedConcat(): string {
		return this.#emittedConcat;
	}

	pushDelta(delta: string): AssembledUnit[] {
		if (!delta) return [];
		this.#buf += delta;
		this.#pullSentencesIntoPending(false);
		return this.#drainGroups(false);
	}

	flush(): AssembledUnit[] {
		this.#pullSentencesIntoPending(true);
		return this.#drainGroups(true);
	}

	reset(): void {
		this.#buf = "";
		this.#emitted = 0;
		this.#pending = [];
		this.#emittedConcat = "";
		this.#spokenConcat = "";
	}

	remainderForFinal(finalPlain: string): string {
		const want = normalizeForTts(markdownToSpeakable(finalPlain), this.#language).trim();
		const already = this.#emittedConcat.trim() || this.#spokenConcat.trim();
		if (!want) return "";
		if (!already) return want;
		if (already.includes(want) || overlapRatio(already, want) >= 0.72) {
			return "";
		}
		if (want.startsWith(already)) {
			return want.slice(already.length).trim();
		}
		const prefix = commonPrefixLength(already, want);
		if (prefix >= Math.min(40, Math.floor(already.length * 0.5))) {
			return want.slice(prefix).trim();
		}
		if (want.length > already.length + 40 && !already.includes(want.slice(0, 48))) {
			return want.slice(already.length).trim() || "";
		}
		return "";
	}

	markEmitted(speakable: string): void {
		if (!speakable) return;
		this.#emittedConcat = `${this.#emittedConcat} ${speakable}`.replace(/\s+/g, " ").trim();
	}

	markSpoken(speakable: string): void {
		if (!speakable) return;
		this.#spokenConcat = `${this.#spokenConcat} ${speakable}`.replace(/\s+/g, " ").trim();
	}

	#pullSentencesIntoPending(force: boolean): void {
		let guard = 0;
		while (guard++ < 32) {
			const match = SENTENCE_END.exec(this.#buf);
			if (match && match.index !== undefined) {
				const end = match.index + match[1]!.length;
				const raw = this.#buf.slice(0, end).trim();
				this.#buf = this.#buf.slice(end).replace(/^\s+/, "");
				if (raw && !isPreambleCrumb(raw)) this.#pending.push(raw);
				continue;
			}
			if (force) {
				const raw = this.#buf.trim();
				this.#buf = "";
				if (raw && !isPreambleCrumb(raw)) this.#pending.push(raw);
			} else if (this.#buf.trim().length >= this.#softFlushChars) {
				const trimmed = this.#buf.trim();
				const breakAt = Math.max(trimmed.lastIndexOf(" "), trimmed.lastIndexOf(","));
				if (breakAt > 40) {
					const raw = trimmed.slice(0, breakAt).trim();
					this.#buf = trimmed.slice(breakAt).replace(/^\s+/, "");
					if (raw && !isPreambleCrumb(raw)) this.#pending.push(raw);
					continue;
				}
			}
			break;
		}
	}

	#drainGroups(force: boolean): AssembledUnit[] {
		const out: AssembledUnit[] = [];
		while (this.#pending.length > 0) {
			const ready = this.#groupReady(force);
			if (!ready) break;
			const raw = this.#pending.splice(0, ready).join(" ").trim();
			const unit = this.#toUnit(raw);
			if (unit) out.push(unit);
		}
		return out;
	}

	#groupReady(force: boolean): number {
		if (this.#pending.length === 0) return 0;
		if (force) return this.#pending.length;
		const first = this.#pending[0]!;
		if (first.length >= this.#longSentenceChars) return 1;
		let chars = 0;
		let n = 0;
		for (const s of this.#pending) {
			chars += s.length;
			n += 1;
			if (n >= this.#minSentences || chars >= this.#minChars) return n;
			if (n >= 3) return n;
		}
		return 0;
	}

	#toUnit(raw: string): AssembledUnit | undefined {
		if (!raw || raw.length < 2) return undefined;
		const speakable = normalizeForTts(markdownToSpeakable(raw), this.#language).trim();
		if (!speakable || speakable.length < 2) return undefined;
		this.#seq += 1;
		this.#emitted += 1;
		this.markEmitted(speakable);
		return {
			id: `u${this.#seq}`,
			raw,
			speakable,
		};
	}
}

function isPreambleCrumb(raw: string): boolean {
	return /^(ok|okay|sí|si|vale|bien|hmm+|uh+|um+)\.?$/i.test(raw.trim());
}

function commonPrefixLength(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a[i] === b[i]) i += 1;
	return i;
}

function overlapRatio(haystack: string, needle: string): number {
	const tokens = needle
		.toLowerCase()
		.split(/\s+/)
		.filter((t) => t.length > 3);
	if (tokens.length === 0) return 0;
	const h = haystack.toLowerCase();
	let hit = 0;
	for (const t of tokens) {
		if (h.includes(t)) hit += 1;
	}
	return hit / tokens.length;
}

/** Extract text_delta string from Pi message_update payload (duck-typed). */
export function extractTextDeltaFromMessageUpdate(event: unknown): string | undefined {
	if (!event || typeof event !== "object") return undefined;
	const e = event as {
		assistantMessageEvent?: { type?: string; delta?: string };
		type?: string;
	};
	const ame = e.assistantMessageEvent;
	if (ame?.type === "text_delta" && typeof ame.delta === "string") return ame.delta;
	return undefined;
}

/** True when assistantMessageEvent is thinking_* or toolcall_* (skip). */
export function isNonSpeakableAssistantEvent(event: unknown): boolean {
	if (!event || typeof event !== "object") return false;
	const t = (event as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type;
	if (!t) return false;
	return t.startsWith("thinking_") || t.startsWith("toolcall_");
}
