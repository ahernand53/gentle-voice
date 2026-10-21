/**
 * Lightweight fidelity checks — NOT semantic equivalence.
 * On failure, prefer deterministic Speech Renderer text.
 */

export interface FidelityCheckResult {
	readonly ok: boolean;
	readonly notes: readonly string[];
}

/** Extract number-like tokens (including decimals and simple dates). */
export function extractCriticalTokens(text: string): Set<string> {
	const tokens = new Set<string>();
	const numberRe = /\b\d+(?:[.,]\d+)?(?:\s*(?:ms|s|kb|mb|gb|%))?\b/gi;
	for (const m of text.matchAll(numberRe)) {
		tokens.add(m[0]!.replace(/\s+/g, "").toLowerCase());
	}
	const pathRe = /(?:\/[\w.-]+){2,}/g;
	for (const m of text.matchAll(pathRe)) {
		tokens.add(m[0]!.toLowerCase());
	}
	const cmdRe = /\b(?:npm|git|docker|systemctl|curl|wget)\s+[^\n]{1,40}/gi;
	for (const m of text.matchAll(cmdRe)) {
		tokens.add(m[0]!.trim().toLowerCase().slice(0, 48));
	}
	return tokens;
}

const NEGATION_MARKERS = [
	/\bno\b/gi,
	/\bnunca\b/gi,
	/\bni\b/gi,
	/\bsin\b/gi,
	/\bnever\b/gi,
	/\bnot\b/gi,
	/\bdon't\b/gi,
	/\bdoesn't\b/gi,
	/\bcannot\b/gi,
	/\bcan't\b/gi,
];

function negationCount(text: string): number {
	let n = 0;
	for (const re of NEGATION_MARKERS) {
		const copy = new RegExp(re.source, re.flags);
		n += [...text.matchAll(copy)].length;
	}
	return n;
}

/**
 * Conservative gate. Empty / tiny narration fails.
 * Missing critical numbers/paths from source → fail.
 * Large drop in negation markers → fail.
 */
export function checkNarrationFidelity(
	source: string,
	narration: string,
): FidelityCheckResult {
	const notes: string[] = [];
	const spoken = narration.trim();
	if (!spoken) {
		return { ok: false, notes: ["empty narration"] };
	}
	if (spoken.length < 8 && source.trim().length > 40) {
		return { ok: false, notes: ["narration too short vs source"] };
	}

	const srcTokens = extractCriticalTokens(source);
	const narTokens = extractCriticalTokens(spoken);
	let missing = 0;
	for (const tok of srcTokens) {
		if (tok.length < 2) continue;
		// Skip very common small integers that appear in lists.
		if (/^\d{1,2}$/.test(tok)) continue;
		if (!narTokens.has(tok) && !spoken.toLowerCase().includes(tok)) {
			missing += 1;
			if (notes.length < 6) notes.push(`missing token: ${tok}`);
		}
	}
	// Allow a few drops for reformulation; fail if many critical tokens vanish.
	const criticalBudget = Math.max(2, Math.floor(srcTokens.size * 0.35));
	if (missing > criticalBudget && srcTokens.size >= 3) {
		notes.push(`too many missing critical tokens (${missing})`);
		return { ok: false, notes };
	}

	const srcNeg = negationCount(source);
	const narNeg = negationCount(spoken);
	if (srcNeg >= 2 && narNeg === 0) {
		notes.push("negations dropped");
		return { ok: false, notes };
	}

	return { ok: true, notes };
}
