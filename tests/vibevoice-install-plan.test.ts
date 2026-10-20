import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVoiceArgs } from "../lib/commands.ts";
import { createPiperTtsAdapter } from "../lib/adapters/piper-tts.ts";
import {
	VIBEVOICE_INSTALL_CONSENT_TOKEN,
	executeVibeVoiceInstall,
	planVibeVoiceInstall,
} from "../lib/vibevoice/install-plan.ts";
import { VIBEVOICE_PREFERRED_VOICE } from "../lib/adapters/vibevoice-tts.ts";

const hardware = { nvidiaPresent: true, vramTotalMb: 8192, freeDiskMb: 20000 };
const target = "/tmp/gv-vibevoice-plan";

test("vibevoice plan asks for consent and keeps the Spanish voice plus PCM", () => {
	const plan = planVibeVoiceInstall({ targetDir: target, hardware, alreadyInstalled: false });
	assert.equal(plan.status, "needs_consent");
	assert.equal(plan.voice, VIBEVOICE_PREFERRED_VOICE);
	assert.equal(plan.voice, "sp-Spk0_woman");
	assert.equal(plan.playback, "pcm");
	assert.equal(plan.downloads.some((step) => step.id === "weights"), true);
	assert.equal(plan.license.some((line) => line.includes("English-trained")), true);
});

test("vibevoice plan does not touch an engine that is already installed", () => {
	const plan = planVibeVoiceInstall({ targetDir: target, hardware, alreadyInstalled: true });
	assert.equal(plan.status, "already_installed");
	assert.equal(plan.downloads.length > 0, true);
});

test("vibevoice plan blocks a machine without NVIDIA or disk", () => {
	const cpu = planVibeVoiceInstall({
		targetDir: target,
		hardware: { nvidiaPresent: false, freeDiskMb: 20000 },
		alreadyInstalled: false,
	});
	assert.equal(cpu.status, "blocked");
	assert.equal(cpu.reasons.includes("gpu_required"), true);
	const small = planVibeVoiceInstall({
		targetDir: target,
		hardware: { nvidiaPresent: true, vramTotalMb: 2048, freeDiskMb: 1000 },
		alreadyInstalled: false,
	});
	assert.equal(small.status, "blocked");
	assert.deepEqual(small.reasons, ["vram_below_4gb", "disk_below_12gb"]);
});

test("vibevoice execute refuses without consent and never runs against an existing engine", async () => {
	const calls: string[] = [];
	const download = async (step: { origin: string }) => {
		calls.push(step.origin);
	};
	const ready = planVibeVoiceInstall({ targetDir: target, hardware, alreadyInstalled: true });
	const kept = await executeVibeVoiceInstall(ready, {
		consentToken: VIBEVOICE_INSTALL_CONSENT_TOKEN,
		download,
	});
	assert.equal(kept.executed, false);
	assert.equal(kept.reason, "already_installed");
	const pending = planVibeVoiceInstall({ targetDir: target, hardware, alreadyInstalled: false });
	const refused = await executeVibeVoiceInstall(pending, { download });
	assert.equal(refused.reason, "consent_required");
	const unwired = await executeVibeVoiceInstall(pending, { consentToken: VIBEVOICE_INSTALL_CONSENT_TOKEN });
	assert.equal(unwired.reason, "download_not_wired");
	assert.deepEqual(calls, []);
});

test("vibevoice execute calls the injected download only after consent", async () => {
	const calls: string[] = [];
	const plan = planVibeVoiceInstall({ targetDir: target, hardware, alreadyInstalled: false });
	const result = await executeVibeVoiceInstall(plan, {
		consentToken: VIBEVOICE_INSTALL_CONSENT_TOKEN,
		download: async (step) => {
			calls.push(step.id);
		},
	});
	assert.equal(result.executed, true);
	assert.deepEqual(calls, ["code", "weights", "spanish-voice"]);
});

test("vibevoice-setup is public and piper remains a selectable command", () => {
	const setup = parseVoiceArgs("vibevoice-setup");
	assert.equal(setup.error, undefined);
	assert.equal(setup.command, "vibevoice-setup");
	const piper = parseVoiceArgs("tts piper");
	assert.equal(piper.error, undefined);
	assert.equal(piper.command, "tts");
	assert.equal(piper.rest, "piper");
	assert.equal(typeof createPiperTtsAdapter, "function");
});
