import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_VOICE_CONFIG,
	VOICE_CONFIG_SCHEMA,
	detectVoicePlatform,
	resolveVoicePaths,
	validateVoiceConfig,
} from "../lib/config.ts";

test("default config validates", () => {
	const result = validateVoiceConfig(DEFAULT_VOICE_CONFIG);
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.config.schema, VOICE_CONFIG_SCHEMA);
});

test("rejects wrong schema", () => {
	const result = validateVoiceConfig({ ...DEFAULT_VOICE_CONFIG, schema: "nope" });
	assert.equal(result.ok, false);
});

test("rejects invalid mode", () => {
	const result = validateVoiceConfig({
		...DEFAULT_VOICE_CONFIG,
		behavior: { ...DEFAULT_VOICE_CONFIG.behavior, mode: "shout" },
	});
	assert.equal(result.ok, false);
});

test("resolveVoicePaths prefers env over config and never invents home", () => {
	const config = {
		...DEFAULT_VOICE_CONFIG,
		paths: { models: "from-config" },
	};
	const empty = resolveVoicePaths(config, {});
	assert.equal(empty.home, undefined);
	assert.equal(empty.models, "from-config");

	const env = resolveVoicePaths(config, {
		GENTLE_VOICE_MODELS: "/portable/models",
		GENTLE_VOICE_HOME: "/portable/home",
	});
	assert.equal(env.models, "/portable/models");
	assert.equal(env.home, "/portable/home");
	assert.equal(env.configFile, "/portable/home/config.json");
});

test("detectVoicePlatform maps node platforms", () => {
	assert.equal(detectVoicePlatform("linux"), "linux");
	assert.equal(detectVoicePlatform("win32"), "win32");
	assert.equal(detectVoicePlatform("darwin"), "darwin");
	assert.equal(detectVoicePlatform("freebsd"), "unsupported");
});
