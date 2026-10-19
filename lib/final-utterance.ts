/**
 * Deterministic final-utterance policy — no second LLM.
 * Prefers primary answers (numeric / yes-no / short lead) + warnings/conclusions.
 * Never drops a short first sentence solely for being brief.
 */

import type {
	AssistantContentPart,
	AssistantMessageLike,
	FinalUtteranceInput,
	FinalUtteranceResult,
} from "./contracts.ts";
import { markdownToSpeakable } from "./tts/markdown-for-tts.ts";
import { normalizeForTts } from "./tts/normalize-for-tts.ts";

const WARNING_CUES = [
	/\b(warning|warn|caution|careful|danger|destructive|irreversible)\b/i,
	/\b(advertencia|cuidado|peligro|destructiv[oa]|irreversible)\b/i,
	/\b(failed|failure|error|cannot|can't|unable)\b/i,
	/\b(fall[oó]|error|no (se )?pudo|imposible)\b/i,
] as const;

const CONCLUSION_CUES = [
	/^(in (summary|conclusion)|summary|conclusion|therefore|so,|overall)\b/i,
	/^(en (resumen|conclusi[oó]n)|resumiendo|por lo tanto|entonces,|en definitiva)\b/i,
	/\b(done|completed|finished|ready|fixed|resolved)\b/i,
	/\b(listo|terminad[oa]|completad[oa]|corregid[oa]|resuelt[oa])\b/i,
] as const;

const YES_NO_LEAD = /^(sí|si|no|yes|nope|correcto|incorrecto|afirmativo|negativo)\b/i;

/** Direct primary answer: math/result, yes/no, or very short lead sentence. */
export function isPrimaryResultSentence(sentence: string, index: number): boolean {
	const s = sentence.trim();
	if (!s) return false;
	// Never treat code / fences as a "primary spoken answer".
	if (/```/.test(s) || /^[\s`|/{}()[<;]/.test(s) || /[{};=<>]{2,}/.test(s)) return false;
	if (YES_NO_LEAD.test(s)) return true;
	// Digits / arithmetic / "es N" / "son N" — no bare letter "x" as multiply.
	if (/\d/.test(s) && /(\+|−|(?<![A-Za-z])-(?![A-Za-z])|=|×|\*|\/|es\b|son\b|igual)/i.test(s)) {
		return true;
	}
	if (/^\d{1,4}\s*[.!]?\s*$/.test(s)) return true;
	if (/\b(es|son|equals?)\s+\d+/i.test(s) && s.length <= 80) return true;
	// First sentence that is short and assertive (not a rambling preamble).
	if (index === 0 && s.length <= 72 && !/^(I |I'm |Let me |Looking |Based on |Voy a |Déjame |Mirando )/i.test(s)) {
		const words = s.split(/\s+/).length;
		if (words <= 14) return true;
	}
	return false;
}

function isTextPart(part: AssistantContentPart): part is { type: "text"; text: string } {
	return part.type === "text" && typeof (part as { text?: unknown }).text === "string";
}

function isToolCallPart(part: AssistantContentPart): boolean {
	return part.type === "toolCall";
}

function isThinkingPart(part: AssistantContentPart): boolean {
	return part.type === "thinking";
}

/** Join assistant text parts; ignore thinking and toolCall (never narrate internals). */
export function extractAssistantPlainText(message: AssistantMessageLike | null | undefined): string {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const part of message.content) {
		if (isThinkingPart(part) || isToolCallPart(part)) continue;
		if (isTextPart(part)) {
			const t = part.text.trim();
			if (t) parts.push(t);
		}
	}
	return parts.join("\n").trim();
}

function splitSentences(text: string): string[] {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return [];
	const raw = normalized.match(/[^.!?…]+[.!?…]*/g) ?? [normalized];
	return raw.map((s) => s.trim()).filter(Boolean);
}

function scoreSentence(sentence: string, index: number, total: number): number {
	let score = 0;
	const primary = isPrimaryResultSentence(sentence, index);
	if (primary) score += 12;
	for (const re of WARNING_CUES) {
		if (re.test(sentence)) score += 8;
	}
	for (const re of CONCLUSION_CUES) {
		if (re.test(sentence)) score += 5;
	}
	// Prefer later sentences as natural conclusions when no cue matches —
	// but never let that outweigh a primary lead answer.
	if (!primary) score += (index / Math.max(total - 1, 1)) * 2;
	// Light penalty for pure code-looking lines.
	if (/^[\s`|/{[<]/.test(sentence) || /```/.test(sentence)) score -= 4;
	// Do NOT penalize short sentences — that dropped "2 + 2 es 4".
	return score;
}

/**
 * Select speakable text: always keep reliable primary answers, then
 * warnings/conclusions, restore chronological order, soft char budget.
 */
export function selectSpokenSentences(
	text: string,
	options: { maxSentences: number; maxChars: number },
): string {
	const sentences = splitSentences(text);
	if (sentences.length === 0) return "";

	const maxN = Math.max(1, options.maxSentences);
	const ranked = sentences
		.map((sentence, index) => ({
			sentence,
			index,
			score: scoreSentence(sentence, index, sentences.length),
			primary: isPrimaryResultSentence(sentence, index),
		}))
		.sort((a, b) => b.score - a.score || a.index - b.index);

	const pickedIdx = new Set<number>();

	// Force-include primary results (especially the lead answer) before ranking fill.
	for (const item of ranked) {
		if (item.primary && pickedIdx.size < maxN) pickedIdx.add(item.index);
	}
	// If first sentence looks like a primary and somehow missed, still keep it.
	if (sentences[0] && isPrimaryResultSentence(sentences[0], 0)) {
		pickedIdx.add(0);
	}

	for (const item of ranked) {
		if (pickedIdx.size >= maxN) break;
		pickedIdx.add(item.index);
	}

	const picked = [...pickedIdx]
		.sort((a, b) => a - b)
		.map((i) => ({ sentence: sentences[i]!, index: i }));

	const out: string[] = [];
	let used = 0;
	for (const item of picked) {
		const nextLen = used === 0 ? item.sentence.length : used + 1 + item.sentence.length;
		if (out.length > 0 && nextLen > options.maxChars) {
			// Never drop an already-chosen primary lead to fit an explanation.
			if (item.index === 0 && isPrimaryResultSentence(item.sentence, 0) && out.length === 0) {
				out.push(trimAtWordBoundary(item.sentence, options.maxChars));
			}
			break;
		}
		if (out.length === 0 && item.sentence.length > options.maxChars) {
			out.push(trimAtWordBoundary(item.sentence, options.maxChars));
			break;
		}
		out.push(item.sentence);
		used = nextLen;
	}
	return out.join(" ").trim();
}

function trimAtWordBoundary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const slice = text.slice(0, maxChars);
	const sp = slice.lastIndexOf(" ");
	const cut = sp > maxChars * 0.5 ? slice.slice(0, sp) : slice;
	return `${cut.trimEnd()}…`;
}

export function buildFinalUtterance(input: FinalUtteranceInput): FinalUtteranceResult {
	const maxSentences = input.maxSentences ?? 3;
	const maxChars = input.maxChars ?? 480;

	if (input.outcome === "aborted") {
		return { speak: false, text: "", reason: "run_aborted" };
	}

	// Tool-only assistant turns: content had toolCalls and no text.
	const content = input.message?.content ?? [];
	const hasTools = content.some(isToolCallPart);
	const hasText = content.some(isTextPart);
	if (hasTools && !hasText) {
		return { speak: false, text: "", reason: "tool_only_turn" };
	}

	const plain = extractAssistantPlainText(input.message);
	if (!plain) {
		return { speak: false, text: "", reason: "no_assistant_text" };
	}

	const spoken = selectSpokenSentences(plain, { maxSentences, maxChars });
	if (!spoken) {
		return { speak: false, text: "", reason: "empty_after_filter" };
	}

	// If we cannot form a faithful brief without inventing, skip speech (UI shows full text).
	if (!isFaithfulSpokenSummary(plain, spoken)) {
		return {
			speak: false,
			text: plain,
			reason: "unfaithful_skip_show_full",
		};
	}

	// Spoken path only: strip Markdown markers, then expand digits/symbols.
	const forTts = normalizeForTts(markdownToSpeakable(spoken), "es");

	if (input.outcome === "error") {
		return { speak: true, text: forTts, reason: "error_summary" };
	}

	return { speak: true, text: forTts, reason: "final_summary" };
}

function hasCue(text: string, cues: readonly RegExp[]): boolean {
	return cues.some((re) => re.test(text));
}

/**
 * Prefer silence over hallucinated brevity: long code dumps or rambling without
 * conclusion/warning cues should not be clipped into a fake "summary".
 */
export function isFaithfulSpokenSummary(plain: string, spoken: string): boolean {
	const fenceCount = (plain.match(/```/g) ?? []).length;
	if (fenceCount >= 2 && !hasCue(spoken, WARNING_CUES) && !hasCue(spoken, CONCLUSION_CUES)) {
		// Exception: primary numeric/yes-no answer still speakable even beside code.
		const first = splitSentences(plain)[0] ?? "";
		if (!isPrimaryResultSentence(first, 0)) return false;
	}
	// Very long reply compressed to a tiny fraction with no cues → likely unfaithful.
	if (
		plain.length > 900
		&& spoken.length < plain.length * 0.12
		&& !hasCue(spoken, WARNING_CUES)
		&& !hasCue(spoken, CONCLUSION_CUES)
	) {
		const first = splitSentences(plain)[0] ?? "";
		if (!isPrimaryResultSentence(first, 0) && !isPrimaryResultSentence(spoken, 0)) {
			return false;
		}
	}
	return true;
}
