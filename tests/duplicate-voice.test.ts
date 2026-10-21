import assert from "node:assert/strict";
import { test } from "node:test";
import { duplicateVoiceInstallWarning } from "../lib/runtime/duplicate-voice.ts";

test("npm gentle-voice plus a checkout --extension is a duplicate load", () => {
	const message = duplicateVoiceInstallWarning(
		["pi", "--extension", "/work/gentle-voice/extensions/voice.ts"],
		["npm:pi-lens", "npm:gentle-voice@latest"],
	);
	assert.match(message ?? "", /twice/);
	assert.equal(
		duplicateVoiceInstallWarning(["pi"], ["npm:gentle-voice@latest"]),
		undefined,
	);
	assert.equal(
		duplicateVoiceInstallWarning(
			["pi", "--extension", "/work/gentle-voice/extensions/voice.ts"],
			["npm:pi-lens"],
		),
		undefined,
	);
});
