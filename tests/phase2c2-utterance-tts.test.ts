/**
 * Phase 2C.2 — primary-answer utterance policy, TTS normalize, A/B compare (no LLM tokens).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildFinalUtterance,
	isPrimaryResultSentence,
	selectSpokenSentences,
} from "../lib/final-utterance.ts";
import {
	normalizeForTts,
	numberToSpanishWords,
} from "../lib/tts/normalize-for-tts.ts";
import {
	AB_COMPARE_PHRASES,
	createAbCompareSession,
	listInstalledTtsSlots,
	piperSlotFromAdapter,
	researchOnlyProviders,
	scoreLastTrial,
} from "../lib/tts/ab-compare.ts";
import { createStubTtsAdapter } from "../lib/adapters/stubs.ts";
import { TTS_PROVIDER_RESEARCH_CATALOG } from "../lib/tts/profiles.ts";

test("2C.2: numeric lead answer is never dropped for apple example", () => {
	const body =
		"2 + 2 es 4. Si tenés dos manzanas y les sumás otras dos, terminás con cuatro manzanas en total.";
	const spoken = selectSpokenSentences(body, { maxSentences: 2, maxChars: 400 });
	assert.match(spoken, /2\s*\+\s*2\s+es\s+4/i);
	assert.match(spoken, /manzanas/i);

	const result = buildFinalUtterance({
		message: { role: "assistant", content: [{ type: "text", text: body }] },
		outcome: "completed",
		maxSentences: 2,
		maxChars: 400,
	});
	assert.equal(result.speak, true);
	assert.match(result.text, /dos más dos son cuatro/i);
	assert.match(result.text, /manzanas/i);
});

test("2C.2: yes/no primary preserved", () => {
	const body = "Sí. El deploy puede seguir después de revisar el checklist de seguridad.";
	const result = buildFinalUtterance({
		message: { role: "assistant", content: [{ type: "text", text: body }] },
		outcome: "completed",
		maxSentences: 2,
		maxChars: 300,
	});
	assert.equal(result.speak, true);
	assert.match(result.text, /^Sí/i);
});

test("2C.2: warning still preferred among long preamble", () => {
	const body = [
		"I inspected several files in the repository and considered a few options along the way.",
		"There was also a long discussion about formatting preferences that is not actionable.",
		"Warning: do not deploy with the debug flag enabled.",
		"In summary, the login bug is fixed and tests are green.",
	].join(" ");
	const spoken = selectSpokenSentences(body, { maxSentences: 2, maxChars: 400 });
	assert.match(spoken, /Warning/i);
	assert.match(spoken, /summary|fixed|green/i);
});

test("2C.2: error outcome speaks summary", () => {
	const result = buildFinalUtterance({
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Error: no se pudo abrir el archivo de configuración." }],
		},
		outcome: "error",
	});
	assert.equal(result.speak, true);
	assert.equal(result.reason, "error_summary");
	assert.match(result.text, /error|configuración/i);
});

test("2C.2: extensive reply keeps short lead + conclusion", () => {
	const body =
		"Listo. " +
		"Primero revisé el servicio de autenticación y los logs de la puerta de enlace. ".repeat(4) +
		"En resumen, el token expirado era la causa.";
	const spoken = selectSpokenSentences(body, { maxSentences: 2, maxChars: 280 });
	assert.match(spoken, /Listo/i);
	assert.match(spoken, /resumen|token/i);
});

test("2C.2: code dump without primary → unfaithful skip", () => {
	const code = "```\n" + "function x(){ return 1 }\n".repeat(40) + "```\n" +
		"```\n" + "const y = 2\n".repeat(40) + "```";
	const result = buildFinalUtterance({
		message: { role: "assistant", content: [{ type: "text", text: code }] },
		outcome: "completed",
	});
	assert.equal(result.speak, false);
	assert.equal(result.reason, "unfaithful_skip_show_full");
});

test("2C.2: multiple conclusions keep chronological order", () => {
	const body =
		"Conclusion: auth is fixed. Also done: cache warmed. Warning: rotate the secret tonight.";
	const spoken = selectSpokenSentences(body, { maxSentences: 3, maxChars: 400 });
	const iAuth = spoken.indexOf("auth");
	const iWarn = spoken.toLowerCase().indexOf("warning");
	assert.ok(iAuth >= 0 && iWarn > iAuth);
});

test("2C.2: short sentence is not discarded for length alone", () => {
	assert.equal(isPrimaryResultSentence("2 + 2 es 4.", 0), true);
	const spoken = selectSpokenSentences("OK. Long filler about unrelated topics continues here forever and ever.", {
		maxSentences: 2,
		maxChars: 200,
	});
	assert.match(spoken, /^OK/i);
});

test("2C.2: normalizeForTts expands arithmetic and digits", () => {
	assert.equal(numberToSpanishWords(4), "cuatro");
	assert.match(normalizeForTts("2 + 2 es 4"), /dos más dos son cuatro/i);
	assert.match(normalizeForTts("HTTP 500"), /quinientos/i);
	assert.match(normalizeForTts("usa 10%"), /diez por ciento/i);
});

test("2C.2: A/B phrases fixed; research voices not selectable", async () => {
	assert.ok(AB_COMPARE_PHRASES.length >= 4);
	assert.ok(AB_COMPARE_PHRASES.every((p) => p.length > 0));
	const stub = createStubTtsAdapter({
		availability: { status: "ready" },
		audio: { bytes: new Uint8Array(8), sampleRateHz: 22_050, channels: 1, format: "raw" },
	});
	const slots = await listInstalledTtsSlots([piperSlotFromAdapter(stub)]);
	assert.equal(slots.length, 1);
	const research = researchOnlyProviders(new Set(slots.map((s) => s.info.id)));
	assert.ok(research.some((r) => r.id.startsWith("kokoro")));
	assert.ok(TTS_PROVIDER_RESEARCH_CATALOG.some((p) => p.id === "kokoro-ef-dora"));

	let session = createAbCompareSession(slots, slots[0]!.info.id);
	session = {
		...session,
		trials: [{
			phraseIndex: 0,
			phrase: AB_COMPARE_PHRASES[0]!,
			providerId: slots[0]!.info.id,
			displayName: slots[0]!.info.displayName,
			synthesizeMs: 12,
			audioBytes: 8,
			sampleRateHz: 22_050,
		}],
	};
	session = scoreLastTrial(session, slots[0]!.info.id, 0, 3);
	assert.equal(session.trials[0]!.naturalness, 3);
});
