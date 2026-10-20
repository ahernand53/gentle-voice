/**
 * VibeVoice prep — fail-closed, no downloads.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createVibeVoiceTtsAdapter,
	probeVibeVoiceReadiness,
	VIBEVOICE_MODEL_SAFETENSORS_BYTES,
	VIBEVOICE_PREFERRED_VOICE,
} from "../lib/adapters/vibevoice-tts.ts";

test("probe: missing home → not ready", () => {
	const r = probeVibeVoiceReadiness({
		GENTLE_VOICE_VIBEVOICE_HOME: join(tmpdir(), "gv-vv-missing-" + Date.now()),
		HOME: tmpdir(),
	});
	assert.equal(r.ready, false);
	assert.equal(r.reason, "home_missing");
});

test("probe: scaffold marker without authorized → awaiting", () => {
	const home = mkdtempSync(join(tmpdir(), "gv-vv-"));
	writeFileSync(
		join(home, "INSTALL_PENDING.json"),
		JSON.stringify({ authorized: false, status: "awaiting_user_authorization" }),
	);
	const r = probeVibeVoiceReadiness({ GENTLE_VOICE_VIBEVOICE_HOME: home, HOME: tmpdir() });
	assert.equal(r.ready, false);
	assert.equal(r.reason, "awaiting_user_authorization");
	assert.equal(r.voice, VIBEVOICE_PREFERRED_VOICE);
});

test("probe: authorized but wrong model size → not ready", () => {
	const home = mkdtempSync(join(tmpdir(), "gv-vv-"));
	mkdirSync(join(home, "models"), { recursive: true });
	mkdirSync(join(home, ".venv", "bin"), { recursive: true });
	writeFileSync(join(home, ".venv", "bin", "python"), "#!/bin/true\n", { mode: 0o755 });
	writeFileSync(join(home, "models", "model.safetensors"), "tiny");
	writeFileSync(
		join(home, "INSTALL_PENDING.json"),
		JSON.stringify({ authorized: true, status: "installed" }),
	);
	const r = probeVibeVoiceReadiness({ GENTLE_VOICE_VIBEVOICE_HOME: home, HOME: tmpdir() });
	assert.equal(r.ready, false);
	assert.match(r.reason, /model_size_mismatch/);
	assert.equal(VIBEVOICE_MODEL_SAFETENSORS_BYTES, 2_035_332_888);
});

test("adapter synthesize fails closed before install", async () => {
	const home = mkdtempSync(join(tmpdir(), "gv-vv-"));
	const prev = process.env.GENTLE_VOICE_VIBEVOICE_HOME;
	process.env.GENTLE_VOICE_VIBEVOICE_HOME = home;
	try {
		const tts = createVibeVoiceTtsAdapter();
		assert.equal(tts.id, "vibevoice");
		await assert.rejects(
			() => tts.synthesize("hola", { signal: new AbortController().signal }),
			/not ready|awaiting_user_authorization|home_missing/,
		);
	} finally {
		if (prev === undefined) delete process.env.GENTLE_VOICE_VIBEVOICE_HOME;
		else process.env.GENTLE_VOICE_VIBEVOICE_HOME = prev;
	}
});
