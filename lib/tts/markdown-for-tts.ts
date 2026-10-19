/**
 * Strip Markdown markers for spoken TTS only.
 * Does not invent content. Preserves technical tokens (C#, code identifiers).
 * Visible Pi reply stays untouched — call this only on the spoken string.
 */

/** Fence block → short spoken placeholder (language-agnostic). */
function replaceFencedCode(text: string): string {
	return text.replace(/```[\w.-]*\r?\n[\s\S]*?```/g, " bloque de código. ");
}

function replaceInlineCode(text: string): string {
	// Keep inner code text (may include C#); drop backticks only.
	return text.replace(/`([^`]+)`/g, "$1");
}

function replaceLinks(text: string): string {
	// [label](url) → label
	return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
}

function replaceImages(text: string): string {
	return text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1");
}

function replaceHeadings(text: string): string {
	return text.replace(/^#{1,6}\s+/gm, "");
}

function replaceEmphasis(text: string): string {
	// Bold/italic markers — keep inner text. Order: *** then ** then * then __ then _
	return text
		.replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "$1")
		.replace(/___([^_]+)___/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, "$1");
}

function replaceLists(text: string): string {
	return text
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/^\s*\d+\.\s+/gm, "");
}

function replaceBlockquotes(text: string): string {
	return text.replace(/^\s*>\s?/gm, "");
}

function replaceHorizontalRules(text: string): string {
	return text.replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, " ");
}

/**
 * Convert Markdown-ish assistant text into speakable prose.
 * Safe for C# / operators inside words; does not strip `#` mid-token after headings gone.
 */
export function markdownToSpeakable(text: string): string {
	let s = text.replace(/\r\n/g, "\n");
	s = replaceFencedCode(s);
	s = replaceImages(s);
	s = replaceLinks(s);
	s = replaceInlineCode(s);
	s = replaceHeadings(s);
	s = replaceBlockquotes(s);
	s = replaceHorizontalRules(s);
	s = replaceLists(s);
	s = replaceEmphasis(s);
	// Stray lone formatting leftovers (not part of identifiers)
	s = s.replace(/(^|\s)[*_]{1,3}(\s|$)/g, "$1$2");
	s = s.replace(/\s{2,}/g, " ").replace(/\n{2,}/g, ". ").replace(/\n/g, " ").trim();
	return s;
}
