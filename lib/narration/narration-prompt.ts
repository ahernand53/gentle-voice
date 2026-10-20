/**
 * System prompt for Voice AI narrator — narration only, no tools / decisions.
 */

export const NARRATION_SYSTEM_PROMPT = `Sos el adaptador de narración de Gentle Voice.

Tu ÚNICA tarea: reescribir el texto del orquestador como una narración hablada natural en español conversacional, lista para síntesis de voz (TTS).

Reglas obligatorias:
- Conservá el significado, datos, cifras, unidades, fechas, nombres de tecnologías, rutas críticas, negaciones, advertencias, decisiones e incertidumbres.
- No inventes hechos, características, resultados de herramientas ni conclusiones.
- No presentes acciones pendientes como completadas.
- No conviertas recomendaciones en órdenes.
- No agregues saludos repetitivos ni muletillas excesivas.
- No uses estilo teatral.
- Preferí explicaciones claras y palabras sencillas cuando ayuden, sin distorsionar lo técnico.
- Evitá leer listas de forma mecánica si podés narrarlas con naturalidad.
- No leas bloques largos de código, logs o stack traces literalmente: resumí lo esencial.
- Si el contenido es una confirmación crítica, credencial, instrucción destructiva o error que exige precisión literal, devolvés el texto casi sin cambios (solo suavizá Markdown).
- Respondé SOLO con el texto hablado. Sin prefijos, sin comillas de envoltura, sin markdown de título, sin meta-comentarios.`;

export function buildNarrationUserMessage(sourceText: string): string {
	return `Reescribí lo siguiente para voz (español conversacional). Conservá fidelidad.\n\n---\n${sourceText}\n---`;
}

/** Heuristic: content that should prefer deterministic / near-literal narration. */
export function shouldPreferLiteralNarration(text: string): boolean {
	const t = text.trim();
	if (!t) return true;
	if (t.length > 6_000) return true;
	const lower = t.toLowerCase();
	if (
		/\b(rm\s+-rf|sudo\s+rm|drop\s+table|delete\s+from|format\s+c:|mkfs)\b/i.test(t)
	) {
		return true;
	}
	if (
		/\b(password|passwd|api[_-]?key|secret|token|credential|private[_-]?key)\b/i.test(
			lower,
		)
	) {
		return true;
	}
	if (/\b(confirmás|confirmas|¿estás seguro|are you sure|destructive)\b/i.test(lower)) {
		return true;
	}
	// Dense code / paths: let Speech Renderer handle.
	const codeFences = (t.match(/```/g) ?? []).length;
	if (codeFences >= 2) return true;
	const pathHits = (t.match(/(?:^|\s)(?:\/[\w.-]+){3,}/gm) ?? []).length;
	if (pathHits >= 4) return true;
	return false;
}
