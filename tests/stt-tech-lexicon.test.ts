/**
 * Conservative tech lexicon — must fix known mishears without rewriting Spanish prose.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_STT_CORRECTION_RULES,
	DEFAULT_WHISPER_INITIAL_PROMPT,
	applySttCorrections,
} from "../lib/stt/corrections.ts";

test("tech lexicon maps C# / PostgreSQL / .NET mishears", () => {
	const samples: Array<[string, string]> = [
		["probamos C-Charm con Postgres SQL", "probamos C# con PostgreSQL"],
		["uso Sicharm y ASP Net", "uso C# y ASP.NET"],
		["dot net y SQL server", ".NET y SQL Server"],
		["Xamarine e Ionic", "Xamarin e Ionic"],
	];
	for (const [raw, want] of samples) {
		const r = applySttCorrections(raw);
		assert.equal(r.corrected, want, raw);
		assert.equal(r.changed, true);
	}
});

test("tech lexicon does not rewrite unrelated Spanish", () => {
	const prose = "El género literario es amplio y el mar es calmado.";
	const r = applySttCorrections(prose);
	assert.equal(r.corrected, prose);
	assert.equal(r.changed, false);
});

test("whisper prompt stays product-only (no tech shopping list)", () => {
	assert.equal(DEFAULT_WHISPER_INITIAL_PROMPT.includes("C#"), false);
	assert.equal(DEFAULT_WHISPER_INITIAL_PROMPT.includes("PostgreSQL"), false);
	assert.equal(DEFAULT_WHISPER_INITIAL_PROMPT.includes("Angular"), false);
	assert.match(DEFAULT_WHISPER_INITIAL_PROMPT, /Gentle Voice/);
});

test("longest rule wins for overlapping phrases", () => {
	assert.ok(DEFAULT_STT_CORRECTION_RULES.some((r) => r.from === "C-Charm"));
	const r = applySttCorrections("C Sharp y C-Charm");
	assert.equal(r.corrected, "C# y C#");
});

test("observed PostgreSQL mishears, including punctuation and repeats", () => {
	const samples: Array<[string, string]> = [
		["¿Qué es Pobosgres?", "¿Qué es PostgreSQL?"],
		["¿Cuál es la diferencia entre Pobosgres y SQL?", "¿Cuál es la diferencia entre PostgreSQL y SQL?"],
		["El backend utiliza Postgres SQL.", "El backend utiliza PostgreSQL."],
		["pobosgres y pobosgres", "PostgreSQL y PostgreSQL"],
		["PostgreSQL no, Posgresql sí", "PostgreSQL no, PostgreSQL sí"],
	];
	for (const [raw, want] of samples) {
		assert.equal(applySttCorrections(raw).corrected, want, raw);
	}
});

test("stack phrases the user will speak, once Whisper already split them", () => {
	const samples: Array<[string, string]> = [
		["Revisa mi aplicación en C Sharp.", "Revisa mi aplicación en C#."],
		["Tengo un problema con ASP Net Core.", "Tengo un problema con ASP.NET Core."],
		["Necesito actualizar Angular.", "Necesito actualizar Angular."],
		["Quiero revisar un proyecto de Type Script.", "Quiero revisar un proyecto de TypeScript."],
		["el runtime es Node JS", "el runtime es Node.js"],
		["subí el repo a Git Hub", "subí el repo a GitHub"],
		["despliegue en Cubernetes", "despliegue en Kubernetes"],
		["la imagen de Doquer", "la imagen de Docker"],
	];
	for (const [raw, want] of samples) {
		const r = applySttCorrections(raw);
		assert.equal(r.corrected, want, raw);
	}
});

test("negative and ambiguous phrases stay as Whisper wrote them", () => {
	const untouched = [
		"",
		"   ",
		"El género literario es amplio y el mar es calmado.",
		"los ángulos angulares del techo",
		"figuras triangulares",
		"uso Postgres, no PostgreSQL",
		"PostgREST expone la tabla",
		"el cursor del mouse",
		"un agent cualquiera",
		"vi la sequel de la película",
		"git status",
		"Angular ya está bien",
	];
	for (const raw of untouched) {
		const r = applySttCorrections(raw);
		assert.equal(r.corrected, raw, raw);
		assert.equal(r.changed, false);
	}
});

test("correction is local and does not add a model round-trip", () => {
	const started = Date.now();
	for (let i = 0; i < 200; i++) {
		applySttCorrections("¿Qué es Pobosgres? Revisa C Sharp y ASP Net Core en Type Script.");
	}
	assert.ok(Date.now() - started < 50, "lexicon must stay in-process");
});
