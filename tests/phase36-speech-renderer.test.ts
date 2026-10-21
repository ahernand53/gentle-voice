import assert from "node:assert/strict";
import { test } from "node:test";
import { renderForSpeech, softenPathsAndUrls } from "../lib/tts/speech-renderer.ts";

test("3.6 natural mode does not spell Unix path slashes", () => {
	const written = "Estoy en /mnt/D-SSD/personal/gs-lab.";
	const { spoken, transforms } = renderForSpeech(written, {
		mode: "natural",
		cwd: "/mnt/D-SSD/personal/gs-lab",
		language: "es",
	});
	assert.match(spoken, /directorio de trabajo/i);
	assert.ok(!/barra/i.test(spoken));
	assert.ok(!spoken.includes("/mnt"));
	assert.ok(transforms.some((t) => t.startsWith("path:")));
	// Written reply unchanged by contract of caller — renderer returns separately
	assert.equal(written, "Estoy en /mnt/D-SSD/personal/gs-lab.");
});

test("3.6 unknown path becomes pantalla phrase", () => {
	const { spoken } = renderForSpeech("Lee /tmp/foo/bar.txt por favor.", {
		mode: "natural",
		cwd: "/home/other",
	});
	assert.match(spoken, /ruta indicada en pantalla/i);
	assert.ok(!spoken.includes("/tmp"));
});

test("3.6 github URL becomes friendly phrase", () => {
	const { spoken } = renderForSpeech(
		"Revisa https://github.com/efolchmontiel/gentle-voice ahora.",
		{ mode: "natural" },
	);
	assert.match(spoken, /gentle-voice/i);
	assert.match(spoken, /GitHub/i);
	assert.ok(!spoken.includes("https://"));
});

test("3.6 verbatim still avoids slash spelling", () => {
	const { text } = softenPathsAndUrls("ruta /a/b/c ok", {}, "verbatim");
	assert.ok(!text.includes("/a/"));
	assert.match(text, /a b c/);
});

test("3.6 command softens with comando prefix", () => {
	const { spoken } = renderForSpeech("Ejecuta el flujo. Usa npm test luego.", {
		mode: "natural",
	});
	assert.match(spoken, /comando npm test/i);
});
