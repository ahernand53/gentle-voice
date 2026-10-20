/**
 * Phase 3.5 — product conversation + shortcuts without LAB; cleanup safety.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, symlink, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { constants } from "node:fs";
import {
	conversationAutoSubmitEnabled,
	createVoiceExtension,
} from "../extensions/voice.ts";
import { createPiHostHarness } from "../lib/lab/pi-host-harness.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import { VoiceSession } from "../lib/voice-session.ts";
import {
	createStubCaptureAdapter,
	createStubPlaybackAdapter,
	createStubSttAdapter,
	createStubTtsAdapter,
} from "../lib/adapters/stubs.ts";
import {
	defaultVoiceShortcutProbe,
	productShortcutProbeFromEnv,
	PREFERRED_SHORTCUT,
} from "../lib/shortcut.ts";
import { parseVoiceArgs, voiceHelpText } from "../lib/commands.ts";
import {
	CLEANUP_CONFIRM_TOKEN,
	executeGentleVoiceDataCleanup,
} from "../lib/runtime/cleanup.ts";
import { resolveGentleVoiceStorage } from "../lib/runtime/storage.ts";

test("3.5 product shortcuts register without LAB env", async () => {
	const prev = process.env.GENTLE_VOICE_DISABLE_SHORTCUTS;
	delete process.env.GENTLE_VOICE_DISABLE_SHORTCUTS;
	delete process.env.GENTLE_VOICE_LAB;
	delete process.env.GENTLE_VOICE_LAB_SHORTCUT;
	delete process.env.GENTLE_VOICE_SHORTCUT_VERIFIED;
	try {
		const probe = productShortcutProbeFromEnv({});
		assert.equal(await probe.isAvailable("ctrl+alt+space"), true);
		assert.equal(await probe.isAvailable("ctrl+alt+e"), true);
		assert.equal(await defaultVoiceShortcutProbe({}).isAvailable("ctrl+alt+space"), true);

		const harness = createPiHostHarness();
		const session = new VoiceSession({
			config: {
				...DEFAULT_VOICE_CONFIG,
				enabled: false,
				behavior: {
					...DEFAULT_VOICE_CONFIG.behavior,
					fluentConversation: false,
					autoSubmitTranscript: false,
					echoSettleMs: 0,
				},
			},
			capture: createStubCaptureAdapter(),
			stt: createStubSttAdapter({ text: "hola" }),
			tts: createStubTtsAdapter(),
			playback: createStubPlaybackAdapter({ durationMs: 5 }),
			submitTranscript: () => {},
		});
		createVoiceExtension(harness.pi, {
			session,
			forceStubAdapters: true,
			shortcutProbe: productShortcutProbeFromEnv({}),
		});
		await new Promise((r) => setImmediate(r));
		assert.ok(harness.shortcuts.has(PREFERRED_SHORTCUT));
		assert.ok(harness.shortcuts.has("ctrl+alt+e"));
	} finally {
		if (prev === undefined) delete process.env.GENTLE_VOICE_DISABLE_SHORTCUTS;
		else process.env.GENTLE_VOICE_DISABLE_SHORTCUTS = prev;
	}
});

test("3.5 DISABLE_SHORTCUTS keeps fail-closed", async () => {
	assert.equal(
		await productShortcutProbeFromEnv({ GENTLE_VOICE_DISABLE_SHORTCUTS: "1" }).isAvailable(
			"ctrl+alt+space",
		),
		false,
	);
});

test("3.5 Ctrl+Alt+Space starts conversation with autoSubmit without LAB", async () => {
	delete process.env.GENTLE_VOICE_LAB;
	delete process.env.GENTLE_VOICE_LAB_AUTO_SUBMIT;
	delete process.env.GENTLE_VOICE_DISABLE_AUTO_SUBMIT;

	assert.equal(conversationAutoSubmitEnabled({}), true);
	assert.equal(conversationAutoSubmitEnabled({ GENTLE_VOICE_DISABLE_AUTO_SUBMIT: "1" }), false);

	const harness = createPiHostHarness();
	let submits = 0;
	const session = new VoiceSession({
		config: {
			...DEFAULT_VOICE_CONFIG,
			enabled: false,
			behavior: {
				...DEFAULT_VOICE_CONFIG.behavior,
				fluentConversation: false,
				autoSubmitTranscript: false,
				echoSettleMs: 0,
			},
		},
		capture: createStubCaptureAdapter({
			audio: {
				bytes: new Uint8Array(64),
				sampleRateHz: 16_000,
				channels: 1,
				format: "pcm_s16le",
			},
		}),
		stt: createStubSttAdapter({ text: "hola mundo" }),
		tts: createStubTtsAdapter(),
		playback: createStubPlaybackAdapter({ durationMs: 5 }),
		submitTranscript: () => {
			submits += 1;
		},
	});
	createVoiceExtension(harness.pi, {
		session,
		forceStubAdapters: true,
		shortcutProbe: productShortcutProbeFromEnv({}),
	});
	await new Promise((r) => setImmediate(r));
	await harness.shortcuts.get(PREFERRED_SHORTCUT)!(harness.ctx);
	await session.flush();
	assert.equal(session.state.enabled, true);
	assert.equal(session.config.behavior.fluentConversation, true);
	assert.equal(session.config.behavior.autoSubmitTranscript, true);
	assert.equal(session.state.phase, "listening");
	void submits;
});

test("3.5 help is product-facing (no phase 2C)", () => {
	const text = voiceHelpText();
	assert.ok(!/phase 2C/i.test(text));
	assert.match(text, /converse on/);
	assert.match(text, /Ctrl\+Alt\+Space/);
	assert.match(text, /purge/);
});

test("3.5 parse converse and purge", () => {
	assert.equal(parseVoiceArgs("converse on").command, "converse");
	assert.equal(parseVoiceArgs("purge").command, "purge");
});

test("3.5 cleanup refuses wrong token and deletes only under storage root", async () => {
	const base = await mkdtemp(join(tmpdir(), "gv-clean-"));
	const root = join(base, "gentle-voice");
	await mkdir(join(root, "models"), { recursive: true });
	await writeFile(join(root, "models", "x.bin"), "x");
	const outside = join(base, "voxtype-models");
	await mkdir(outside, { recursive: true });
	await writeFile(join(outside, "keep.bin"), "keep");

	const resolution = resolveGentleVoiceStorage({
		env: { GENTLE_VOICE_HOME: root, HOME: base },
		platform: "linux",
	});

	const denied = await executeGentleVoiceDataCleanup({
		confirm: "nope",
		resolution,
	});
	assert.equal(denied.ok, false);
	await access(join(root, "models", "x.bin"), constants.R_OK);

	const ok = await executeGentleVoiceDataCleanup({
		confirm: CLEANUP_CONFIRM_TOKEN,
		resolution,
	});
	assert.equal(ok.ok, true);
	assert.ok(ok.deleted.some((d) => d.includes("gentle-voice")));
	await access(join(outside, "keep.bin"), constants.R_OK);
});

test("3.5 cleanup refuses symlink targets", async () => {
	const base = await mkdtemp(join(tmpdir(), "gv-symlink-"));
	const root = join(base, "gentle-voice");
	const realOutside = join(base, "precious");
	await mkdir(root, { recursive: true });
	await mkdir(realOutside, { recursive: true });
	await writeFile(join(realOutside, "secret"), "no");
	const link = join(root, "models");
	try {
		await symlink(realOutside, link);
	} catch {
		// Windows may lack symlink privilege — skip
		return;
	}
	const resolution = resolveGentleVoiceStorage({
		env: { GENTLE_VOICE_HOME: root, HOME: base },
		platform: "linux",
	});
	const result = await executeGentleVoiceDataCleanup({
		confirm: CLEANUP_CONFIRM_TOKEN,
		resolution,
	});
	assert.ok(result.errors.some((e) => /symlink/i.test(e)) || result.skipped.includes(link));
	await access(join(realOutside, "secret"), constants.R_OK);
});
