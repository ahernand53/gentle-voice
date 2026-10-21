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

/**
 * Default lab lexicon — Gentle Voice / Shell + frequent stack mishears.
 * Conservative: only high-confidence Whisper hallucinations / spellings.
 * Do NOT add short ambiguous tokens (e.g. bare "Sea") that could alter Spanish.
 */
export const DEFAULT_STT_CORRECTION_RULES: readonly SttCorrectionRule[] = Object.freeze([
	{ from: "Jendred Voice", to: "Gentle Voice", reason: "product_name" },
	{ from: "Jendred Shell", to: "Gentle Shell", reason: "product_name" },
	{ from: "Gender Voice", to: "Gentle Voice", reason: "product_name" },
	{ from: "Gender Shell", to: "Gentle Shell", reason: "product_name" },
	// C# — observed lab mishears (ggml-small ES)
	{ from: "C-Charm", to: "C#", reason: "tech_stack" },
	{ from: "C Charm", to: "C#", reason: "tech_stack" },
	{ from: "C-charm", to: "C#", reason: "tech_stack" },
	{ from: "Sicharm", to: "C#", reason: "tech_stack" },
	{ from: "Si Charm", to: "C#", reason: "tech_stack" },
	{ from: "C Sharp", to: "C#", reason: "tech_stack" },
	{ from: "C sharp", to: "C#", reason: "tech_stack" },
	{ from: "C-Sharp", to: "C#", reason: "tech_stack" },
	{ from: "C-sharp", to: "C#", reason: "tech_stack" },
	{ from: "Csharp", to: "C#", reason: "tech_stack" },
	{ from: "CSharp", to: "C#", reason: "tech_stack" },
	// .NET family
	{ from: "dot net", to: ".NET", reason: "tech_stack" },
	{ from: "Dot Net", to: ".NET", reason: "tech_stack" },
	{ from: "dotnet", to: ".NET", reason: "tech_stack" },
	{ from: "ASP net", to: "ASP.NET", reason: "tech_stack" },
	{ from: "ASP Net", to: "ASP.NET", reason: "tech_stack" },
	{ from: "asp.net", to: "ASP.NET", reason: "tech_stack" },
	// Databases
	{ from: "Postgres SQL", to: "PostgreSQL", reason: "tech_stack" },
	{ from: "PostgresSQL", to: "PostgreSQL", reason: "tech_stack" },
	{ from: "Postgress SQL", to: "PostgreSQL", reason: "tech_stack" },
	{ from: "postgre SQL", to: "PostgreSQL", reason: "tech_stack" },
	{ from: "Postgre SQL", to: "PostgreSQL", reason: "tech_stack" },
	{ from: "SQL server", to: "SQL Server", reason: "tech_stack" },
	{ from: "Sequel Server", to: "SQL Server", reason: "tech_stack" },
	// PostgreSQL — observed ES ggml-small mishears. Bare "Postgres" stays:
	// that is a valid name, not a misspelling we are allowed to rewrite.
	{ from: "Pobosgres SQL", to: "PostgreSQL", reason: "tech_stack" },
	{ from: "Pobosgres", to: "PostgreSQL", reason: "tech_stack" },
	{ from: "Pobogres", to: "PostgreSQL", reason: "tech_stack" },
	{ from: "Posgresql", to: "PostgreSQL", reason: "tech_stack" },
	{ from: "Posgres SQL", to: "PostgreSQL", reason: "tech_stack" },
	// Front / runtimes — phrases only. "Angulares" is Spanish; do not map it.
	{ from: "ASP.NET Core", to: "ASP.NET Core", reason: "tech_stack" },
	{ from: "ASP Net Core", to: "ASP.NET Core", reason: "tech_stack" },
	{ from: "ASP.net Core", to: "ASP.NET Core", reason: "tech_stack" },
	{ from: "Type Script", to: "TypeScript", reason: "tech_stack" },
	{ from: "Java Script", to: "JavaScript", reason: "tech_stack" },
	{ from: "Node JS", to: "Node.js", reason: "tech_stack" },
	{ from: "Node.JS", to: "Node.js", reason: "tech_stack" },
	{ from: "Nodejs", to: "Node.js", reason: "tech_stack" },
	{ from: "Git Hub", to: "GitHub", reason: "tech_stack" },
	{ from: "Cubernetes", to: "Kubernetes", reason: "tech_stack" },
	{ from: "Kubernets", to: "Kubernetes", reason: "tech_stack" },
	{ from: "Doquer", to: "Docker", reason: "tech_stack" },
	{ from: "Dóquer", to: "Docker", reason: "tech_stack" },
	{ from: "Cursor Agent", to: "Cursor Agent", reason: "product_name" },
	{ from: "Anionic", to: "Ionic", reason: "tech_stack" },
	{ from: "Xamarine", to: "Xamarin", reason: "tech_stack" },
	{ from: "Xamarín", to: "Xamarin", reason: "tech_stack" },
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

/** Whole phrase only. `\b` fails on `#` and on accented letters. */
function phrasePattern(from: string): RegExp {
	const body = escapeRegExp(from).replace(/\\ /g, "\\s+");
	return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "giu");
}

/**
 * Apply literal phrase replacements (case-insensitive), longest `from` first
 * so "Jendred Voice" wins over a hypothetical shorter rule.
 * Sync and local: no second model, no LLM. Unknown text stays as Whisper wrote it.
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
		const next = corrected.replace(phrasePattern(rule.from), rule.to);
		if (next === corrected) continue;
		corrected = next;
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
