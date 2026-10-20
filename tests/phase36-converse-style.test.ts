/**
 * Phase 3.6 — converse-style + lab voice-ai profile (no second LLM).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	CONVERSE_STYLE_MARKER,
	injectConverseStyleIfEnabled,
	readConverseStyleState,
	writeConverseStyleState,
} from "../lib/converse-style.ts";
import { isGentleVoiceLabMode, parseVoiceArgs } from "../lib/commands.ts";
import {
	ensureVoiceAiProfile,
	VOICE_AI_MODEL_ID,
	VOICE_AI_PROFILE_NAME,
	VOICE_AI_THINKING,
} from "../lib/lab/voice-ai-profile.ts";
import { createPiHostHarness } from "../lib/lab/pi-host-harness.ts";
import { createVoiceExtension } from "../extensions/voice.ts";
import { VoiceSession } from "../lib/voice-session.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import {
	createStubCaptureAdapter,
	createStubPlaybackAdapter,
	createStubSttAdapter,
	createStubTtsAdapter,
} from "../lib/adapters/stubs.ts";
import { deniedShortcutProbe } from "../lib/shortcut.ts";

test("lab: converse-style and voice-ai-profile parse only with GENTLE_VOICE_LAB", () => {
	const prev = process.env.GENTLE_VOICE_LAB;
	try {
		delete process.env.GENTLE_VOICE_LAB;
		assert.ok(parseVoiceArgs("converse-style on").error);
		process.env.GENTLE_VOICE_LAB = "1";
		assert.equal(parseVoiceArgs("converse-style on").labCommand, "converse-style");
		assert.equal(parseVoiceArgs("converse-style on").rest, "on");
		assert.equal(parseVoiceArgs("voice-ai-profile").labCommand, "voice-ai-profile");
		assert.ok(isGentleVoiceLabMode());
	} finally {
		if (prev === undefined) delete process.env.GENTLE_VOICE_LAB;
		else process.env.GENTLE_VOICE_LAB = prev;
	}
});

test("converse-style: inject once into appendSystemPrompt; off skips", () => {
	const opts: { appendSystemPrompt?: string } = { appendSystemPrompt: "base" };
	assert.equal(injectConverseStyleIfEnabled(opts, false), false);
	assert.equal(opts.appendSystemPrompt, "base");
	assert.equal(injectConverseStyleIfEnabled(opts, true), true);
	assert.ok(opts.appendSystemPrompt?.includes(CONVERSE_STYLE_MARKER));
	assert.ok(opts.appendSystemPrompt?.includes("Español natural") || opts.appendSystemPrompt?.includes("español natural"));
	const len = opts.appendSystemPrompt!.length;
	injectConverseStyleIfEnabled(opts, true);
	assert.equal(opts.appendSystemPrompt!.length, len, "idempotent — no duplicate block");
});

test("converse-style: persist on/off under voice home", () => {
	const dir = mkdtempSync(join(tmpdir(), "gv-style-"));
	try {
		assert.equal(readConverseStyleState(dir).enabled, false);
		writeConverseStyleState(dir, true);
		assert.equal(readConverseStyleState(dir).enabled, true);
		writeConverseStyleState(dir, false);
		assert.equal(readConverseStyleState(dir).enabled, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("lab voice-ai: role inside OpenSource, not sibling profile", () => {
	const dir = mkdtempSync(join(tmpdir(), "gv-profiles-"));
	const prevLab = process.env.GENTLE_VOICE_LAB;
	const prevPi = process.env.GENTLE_PI_CONFIG_HOME;
	const prevAllow = process.env.GENTLE_VOICE_LAB_ALLOW_SHARED_PROFILES;
	try {
		process.env.GENTLE_VOICE_LAB = "1";
		process.env.GENTLE_PI_CONFIG_HOME = dir;
		delete process.env.GENTLE_VOICE_LAB_ALLOW_SHARED_PROFILES;
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "profiles.json"),
			JSON.stringify({
				kind: "gentle-pi.agent_model_profiles",
				version: 1,
				active: "OpenSource",
				profiles: {
					OpenSource: {
						orchestrator: { model: "nan/deepseek-v4-flash", thinking: "high" },
						"review-risk": { model: "nan/glm5.3-flash", thinking: "high" },
					},
					// Mistaken prior seed — must be removed.
					"voice-ai": {
						orchestrator: { model: VOICE_AI_MODEL_ID, thinking: VOICE_AI_THINKING },
					},
				},
			}),
		);
		const r1 = ensureVoiceAiProfile();
		assert.equal(r1.refused, undefined);
		assert.equal(r1.created, true);
		assert.equal(r1.removedTopLevelProfile, true);
		assert.equal(r1.hostProfile, "OpenSource");
		const raw = JSON.parse(readFileSync(r1.path, "utf8")) as {
			active?: string;
			profiles: Record<string, Record<string, { model?: string; thinking?: string }>>;
		};
		assert.equal(raw.active, "OpenSource");
		assert.equal(raw.profiles.OpenSource?.orchestrator?.model, "nan/deepseek-v4-flash");
		assert.equal(raw.profiles.OpenSource?.["review-risk"]?.model, "nan/glm5.3-flash");
		assert.equal(raw.profiles.OpenSource?.["voice-ai"]?.model, VOICE_AI_MODEL_ID);
		assert.equal(raw.profiles.OpenSource?.["voice-ai"]?.thinking, VOICE_AI_THINKING);
		assert.equal(raw.profiles["voice-ai"], undefined, "must not remain as sibling profile");

		const r2 = ensureVoiceAiProfile();
		assert.equal(r2.created, false);
		assert.equal(r2.updated, false);
	} finally {
		if (prevLab === undefined) delete process.env.GENTLE_VOICE_LAB;
		else process.env.GENTLE_VOICE_LAB = prevLab;
		if (prevPi === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = prevPi;
		if (prevAllow === undefined) delete process.env.GENTLE_VOICE_LAB_ALLOW_SHARED_PROFILES;
		else process.env.GENTLE_VOICE_LAB_ALLOW_SHARED_PROFILES = prevAllow;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("lab voice-ai profile: refuse without LAB", () => {
	const prev = process.env.GENTLE_VOICE_LAB;
	try {
		delete process.env.GENTLE_VOICE_LAB;
		const r = ensureVoiceAiProfile();
		assert.equal(r.refused, true);
	} finally {
		if (prev === undefined) delete process.env.GENTLE_VOICE_LAB;
		else process.env.GENTLE_VOICE_LAB = prev;
	}
});

test("extension: before_agent_start injects when converse-style on", async () => {
	const prevLab = process.env.GENTLE_VOICE_LAB;
	const prevHome = process.env.GENTLE_VOICE_HOME;
	const dir = mkdtempSync(join(tmpdir(), "gv-style-ext-"));
	try {
		process.env.GENTLE_VOICE_LAB = "1";
		process.env.GENTLE_VOICE_HOME = dir;
		writeConverseStyleState(dir, true);

		const harness = createPiHostHarness();
		const session = new VoiceSession({
			config: { ...DEFAULT_VOICE_CONFIG, enabled: true },
			capture: createStubCaptureAdapter(),
			stt: createStubSttAdapter(),
			tts: createStubTtsAdapter({ latencyMs: 1 }),
			playback: createStubPlaybackAdapter({ durationMs: 1 }),
		});
		createVoiceExtension(harness.pi, {
			session,
			forceStubAdapters: true,
			shortcutProbe: deniedShortcutProbe(),
		});

		const opts = { appendSystemPrompt: "" };
		harness.fire("before_agent_start", { systemPromptOptions: opts });
		assert.ok(opts.appendSystemPrompt.includes(CONVERSE_STYLE_MARKER));

		writeConverseStyleState(dir, false);
		const opts2 = { appendSystemPrompt: "" };
		harness.fire("before_agent_start", { systemPromptOptions: opts2 });
		assert.equal(opts2.appendSystemPrompt.includes(CONVERSE_STYLE_MARKER), false);
	} finally {
		if (prevLab === undefined) delete process.env.GENTLE_VOICE_LAB;
		else process.env.GENTLE_VOICE_LAB = prevLab;
		if (prevHome === undefined) delete process.env.GENTLE_VOICE_HOME;
		else process.env.GENTLE_VOICE_HOME = prevHome;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("converse vs converse-style: distinct commands", () => {
	const prev = process.env.GENTLE_VOICE_LAB;
	try {
		process.env.GENTLE_VOICE_LAB = "1";
		assert.equal(parseVoiceArgs("converse on").command, "converse");
		assert.equal(parseVoiceArgs("converse-style on").labCommand, "converse-style");
		assert.notEqual(
			parseVoiceArgs("converse on").command,
			parseVoiceArgs("converse-style on").labCommand,
		);
	} finally {
		if (prev === undefined) delete process.env.GENTLE_VOICE_LAB;
		else process.env.GENTLE_VOICE_LAB = prev;
	}
});
