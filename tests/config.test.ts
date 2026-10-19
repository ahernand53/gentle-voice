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

test("resolveVoicePaths prefers env over config; falls back to portable layout", () => {
	const config = {
		...DEFAULT_VOICE_CONFIG,
		paths: { models: "from-config" },
	};
	const empty = resolveVoicePaths(config, {});
	assert.ok(empty.home && empty.home.length > 0, "portable home fallback");
	assert.equal(empty.models, "from-config");
	assert.ok(empty.cache && empty.tmp);

	const env = resolveVoicePaths(config, {
		GENTLE_VOICE_MODELS: "/portable/models",
		GENTLE_VOICE_HOME: "/portable/home",
	});
	assert.equal(env.models, "/portable/models");
	assert.equal(env.home, "/portable/home");
	assert.match(env.configFile ?? "", /config\.json$/);
});

test("detectVoicePlatform maps node platforms", () => {
	assert.equal(detectVoicePlatform("linux"), "linux");
	assert.equal(detectVoicePlatform("win32"), "win32");
	assert.equal(detectVoicePlatform("darwin"), "darwin");
	assert.equal(detectVoicePlatform("freebsd"), "unsupported");
});
