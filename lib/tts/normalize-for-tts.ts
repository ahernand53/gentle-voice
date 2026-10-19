/**
 * Deterministic TTS text normalization — no LLM.
 * Expands digits/symbols for Spanish speech while preserving meaning.
 * Does not invent content or change dialect (voseo stays voseo).
 */

const ONES = [
	"cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve",
	"diez", "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete",
	"dieciocho", "diecinueve",
] as const;

const TENS = [
	"", "", "veinte", "treinta", "cuarenta", "cincuenta",
	"sesenta", "setenta", "ochenta", "noventa",
] as const;

const HUNDREDS = [
	"", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos",
	"seiscientos", "setecientos", "ochocientos", "novecientos",
] as const;

/** Cardinal 0–999 in Spanish (masculine "uno"). */
export function numberToSpanishWords(n: number): string {
	if (!Number.isFinite(n) || n < 0 || n > 999 || !Number.isInteger(n)) {
		return String(n);
	}
	if (n < 20) return ONES[n]!;
	if (n < 30) {
		if (n === 20) return "veinte";
		return `veinti${ONES[n - 20]!}`;
	}
	if (n < 100) {
		const t = Math.floor(n / 10);
		const o = n % 10;
		return o === 0 ? TENS[t]! : `${TENS[t]} y ${ONES[o]}`;
	}
	if (n === 100) return "cien";
	const h = Math.floor(n / 100);
	const rest = n % 100;
	return rest === 0 ? HUNDREDS[h]! : `${HUNDREDS[h]} ${numberToSpanishWords(rest)}`;
}

function expandIntegerToken(raw: string): string {
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0 || n > 999) return raw;
	return numberToSpanishWords(n);
}

/**
 * Expand a simple arithmetic fragment like "2 + 2 es 4" → spoken Spanish.
 * Conservative: only rewrites well-formed digit/symbol patterns.
 */
function expandArithmeticPhrase(text: string): string {
	// N + N es/son/= N  → "N más N son N" (plural result phrasing)
	return text
		.replace(
			/\b(\d{1,3})\s*\+\s*(\d{1,3})\s*(?:es|son|=)\s*(\d{1,3})\b/gi,
			(_m, a: string, b: string, c: string) =>
				`${expandIntegerToken(a)} más ${expandIntegerToken(b)} son ${expandIntegerToken(c)}`,
		)
		.replace(
			/\b(\d{1,3})\s*-\s*(\d{1,3})\s*(?:es|son|=)\s*(\d{1,3})\b/gi,
			(_m, a: string, b: string, c: string) =>
				`${expandIntegerToken(a)} menos ${expandIntegerToken(b)} es ${expandIntegerToken(c)}`,
		)
		.replace(
			/\b(\d{1,3})\s*\*\s*(\d{1,3})\s*(?:es|son|=)\s*(\d{1,3})\b/gi,
			(_m, a: string, b: string, c: string) =>
				`${expandIntegerToken(a)} por ${expandIntegerToken(b)} es ${expandIntegerToken(c)}`,
		)
		.replace(/\b(\d{1,3})\s*\+\s*(\d{1,3})\b/g, (_m, a: string, b: string) =>
			`${expandIntegerToken(a)} más ${expandIntegerToken(b)}`)
		.replace(/\b(\d{1,3})\s*-\s*(\d{1,3})\b/g, (_m, a: string, b: string) =>
			`${expandIntegerToken(a)} menos ${expandIntegerToken(b)}`)
		.replace(/\b(\d{1,3})\s*=\s*(\d{1,3})\b/g, (_m, a: string, b: string) =>
			`${expandIntegerToken(a)} es ${expandIntegerToken(b)}`);
}

/** Standalone digits and common symbols for Spanish TTS. */
function expandRemainingTokens(text: string): string {
	return text
		.replace(/%/g, " por ciento")
		.replace(/\b(\d{1,3})\b/g, (m) => expandIntegerToken(m))
		.replace(/\s{2,}/g, " ")
		.trim();
}

/**
 * Prepare spoken text for TTS. Idempotent for already-expanded text.
 * Does not translate prose or invent facts.
 */
export function normalizeForTts(text: string, language = "es"): string {
	const trimmed = text.replace(/\s+/g, " ").trim();
	if (!trimmed) return "";
	if (language !== "es" && !language.startsWith("es")) {
		// Non-Spanish: leave digits; only light symbol spacing.
		return trimmed.replace(/\s{2,}/g, " ").trim();
	}
	return expandRemainingTokens(expandArithmeticPhrase(trimmed));
}
