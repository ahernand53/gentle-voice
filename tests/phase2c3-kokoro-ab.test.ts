/**
 * Phase 2C.3 — Kokoro adapter presence, A/B phrases, utterance regression (no LLM tokens).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { access, constants } from "node:fs/promises";
import {
	AB_COMPARE_PHRASES,
	listInstalledTtsSlots,
	piperSlotFromAdapter,
} from "../lib/tts/ab-compare.ts";
import {
	createKokoroTtsAdapter,
	labKokoroPresent,
	LAB_KOKORO_MODEL,
	LAB_KOKORO_VOICES,
} from "../lib/adapters/kokoro-tts.ts";
import { createStubTtsAdapter } from "../lib/adapters/stubs.ts";
import { buildFinalUtterance } from "../lib/final-utterance.ts";
import { PREFERRED_SHORTCUT } from "../lib/engines/contracts.ts";
import {
	deniedShortcutProbe,
	labShortcutProbeFromEnv,
	maybeRegisterVoiceShortcut,
} from "../lib/shortcut.ts";
import { createPiHostHarness } from "../lib/lab/pi-host-harness.ts";

test("2C.3: A/B phrase battery matches authorized set", () => {
	assert.equal(AB_COMPARE_PHRASES.length, 5);
	assert.match(AB_COMPARE_PHRASES[0]!, /Gentle Voice/i);
	assert.match(AB_COMPARE_PHRASES[1]!, /Dos más dos/i);
	assert.match(AB_COMPARE_PHRASES[2]!, /Angular/i);
	assert.match(AB_COMPARE_PHRASES[3]!, /PostgreSQL/i);
	assert.match(AB_COMPARE_PHRASES[4]!, /permisos/i);
});

test("2C.3: regression — 2+2 primary in spoken+normalized text", () => {
	const body =
		"2 + 2 es 4. Si tenés dos manzanas y les sumás otras dos, terminás con cuatro manzanas en total.";
	const result = buildFinalUtterance({
		message: { role: "assistant", content: [{ type: "text", text: body }] },
		outcome: "completed",
		maxSentences: 2,
		maxChars: 400,
	});
	assert.equal(result.speak, true);
	assert.match(result.text, /dos más dos son cuatro/i);
});

test("2C.3: lab Kokoro artifacts present (hardware install)", async () => {
	assert.equal(labKokoroPresent(), true);
	await access(LAB_KOKORO_MODEL, constants.R_OK);
	await access(LAB_KOKORO_VOICES, constants.R_OK);
	const adapter = createKokoroTtsAdapter({ dryRun: true });
	const avail = await adapter.availability();
	assert.equal(avail.status, "ready");
});

test("2C.3: A/B listInstalled only ready adapters", async () => {
	const ready = createStubTtsAdapter({ availability: { status: "ready" } });
	const missing = createStubTtsAdapter({
		availability: { status: "unavailable", reason: "missing" },
	});
	const slots = await listInstalledTtsSlots([
		piperSlotFromAdapter(ready, { id: "piper-es-AR-daniela-high" }),
		{ info: {
			id: "kokoro-ef-dora",
			displayName: "Kokoro",
			engine: "kokoro",
			platforms: ["linux"],
			verifiedLocally: true,
			licenseHint: "Apache-2.0",
			notes: "test",
		}, adapter: missing },
	]);
	assert.equal(slots.length, 1);
	assert.equal(slots[0]!.info.id, "piper-es-AR-daniela-high");
});

test("2C.3: shortcut fail-closed without verified env", async () => {
	const harness = createPiHostHarness();
	const prevV = process.env.GENTLE_VOICE_SHORTCUT_VERIFIED;
	const prevL = process.env.GENTLE_VOICE_LAB_SHORTCUT;
	const prevLab = process.env.GENTLE_VOICE_LAB;
	try {
		delete process.env.GENTLE_VOICE_SHORTCUT_VERIFIED;
		delete process.env.GENTLE_VOICE_LAB_SHORTCUT;
		process.env.GENTLE_VOICE_LAB = "1";
		await maybeRegisterVoiceShortcut(harness.pi, {
			probe: labShortcutProbeFromEnv(),
			handler: () => {},
		});
		assert.equal(harness.shortcuts.has(PREFERRED_SHORTCUT), false);
	} finally {
		if (prevV === undefined) delete process.env.GENTLE_VOICE_SHORTCUT_VERIFIED;
		else process.env.GENTLE_VOICE_SHORTCUT_VERIFIED = prevV;
		if (prevL === undefined) delete process.env.GENTLE_VOICE_LAB_SHORTCUT;
		else process.env.GENTLE_VOICE_LAB_SHORTCUT = prevL;
		if (prevLab === undefined) delete process.env.GENTLE_VOICE_LAB;
		else process.env.GENTLE_VOICE_LAB = prevLab;
	}
});

test("2C.3: shortcut registers only when lab+verified env", async () => {
	const harness = createPiHostHarness();
	const prevV = process.env.GENTLE_VOICE_SHORTCUT_VERIFIED;
	const prevL = process.env.GENTLE_VOICE_LAB_SHORTCUT;
	const prevLab = process.env.GENTLE_VOICE_LAB;
	try {
		process.env.GENTLE_VOICE_LAB = "1";
		process.env.GENTLE_VOICE_LAB_SHORTCUT = "1";
		process.env.GENTLE_VOICE_SHORTCUT_VERIFIED = "1";
		const avail = await maybeRegisterVoiceShortcut(harness.pi, {
			probe: labShortcutProbeFromEnv(),
			handler: () => {},
		});
		assert.equal(avail.available, true);
		assert.equal(harness.shortcuts.has(PREFERRED_SHORTCUT), true);
	} finally {
		if (prevV === undefined) delete process.env.GENTLE_VOICE_SHORTCUT_VERIFIED;
		else process.env.GENTLE_VOICE_SHORTCUT_VERIFIED = prevV;
		if (prevL === undefined) delete process.env.GENTLE_VOICE_LAB_SHORTCUT;
		else process.env.GENTLE_VOICE_LAB_SHORTCUT = prevL;
		if (prevLab === undefined) delete process.env.GENTLE_VOICE_LAB;
		else process.env.GENTLE_VOICE_LAB = prevLab;
	}
});

test("2C.3: denied probe still blocks", async () => {
	const harness = createPiHostHarness();
	await maybeRegisterVoiceShortcut(harness.pi, {
		probe: deniedShortcutProbe(),
		handler: () => {},
	});
	assert.equal(harness.shortcuts.size, 0);
});
