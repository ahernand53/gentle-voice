/**
 * Local, bounded STT post-corrections for known product / stack terms.
 * Never mutates the Voxtype model. Prefer exact phrase replacements over
 * global regexes that could alter valid words.
 */

export interface SttCorrectionRule {
	/** Case-insensitive source phrase (literal, not regex). */
	readonly from: string;
	readonly to: string;
	readonly reason: string;
}

/** Default lab lexicon — Gentle Voice / Shell + common stack names. */
export const DEFAULT_STT_CORRECTION_RULES: readonly SttCorrectionRule[] = Object.freeze([
	{ from: "Jendred Voice", to: "Gentle Voice", reason: "product_name" },
	{ from: "Jendred Shell", to: "Gentle Shell", reason: "product_name" },
	{ from: "Gender Voice", to: "Gentle Voice", reason: "product_name" },
	{ from: "Gender Shell", to: "Gentle Shell", reason: "product_name" },
	{ from: "Postgres SQL", to: "PostgreSQL", reason: "tech_stack" },
	{ from: "PostgresSQL", to: "PostgreSQL", reason: "tech_stack" },
	{ from: "C Sharp", to: "C#", reason: "tech_stack" },
	{ from: "C sharp", to: "C#", reason: "tech_stack" },
	{ from: "C-Sharp", to: "C#", reason: "tech_stack" },
]);

/**
 * Whisper.cpp `--prompt` seed for Spanish lab sessions.
 *
 * IMPORTANT: On silence, whisper.cpp often *echoes* the prompt as a transcript.
 * Lab incident: auto-submit of "C#, Angular, PostgreSQL" matched the old
 * comma-list prompt. Keep this short, product-only, and never a tech shopping list.
 * Stack spellings (C#, PostgreSQL, …) stay in post-correction rules only.
 */
export const DEFAULT_WHISPER_INITIAL_PROMPT = "Gentle Voice. Gentle Shell.";

export interface SttCorrectionResult {
	readonly original: string;
	readonly corrected: string;
	readonly applied: readonly { from: string; to: string; reason: string }[];
	readonly changed: boolean;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Apply literal phrase replacements (case-insensitive), longest `from` first
 * so "Jendred Voice" wins over a hypothetical shorter rule.
 */
export function applySttCorrections(
	text: string,
	rules: readonly SttCorrectionRule[] = DEFAULT_STT_CORRECTION_RULES,
): SttCorrectionResult {
	const original = text;
	let corrected = text;
	const applied: { from: string; to: string; reason: string }[] = [];
	const ordered = [...rules].sort((a, b) => b.from.length - a.from.length);

	for (const rule of ordered) {
		const re = new RegExp(escapeRegExp(rule.from), "gi");
		if (!re.test(corrected)) continue;
		corrected = corrected.replace(re, rule.to);
		applied.push({ from: rule.from, to: rule.to, reason: rule.reason });
	}

	return {
		original,
		corrected,
		applied,
		changed: corrected !== original,
	};
}

export function formatCorrectionDiff(result: SttCorrectionResult): string {
	if (!result.changed) {
		return `STT (unchanged):\n${result.corrected}`;
	}
	const rules = result.applied.map((a) => `${a.from}→${a.to}`).join("; ");
	return [
		`STT original:\n${result.original}`,
		`STT corrected (${rules}):\n${result.corrected}`,
	].join("\n");
}
