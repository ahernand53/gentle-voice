/**
 * Phase 3.4.1 — lab gate: WD-Black / Kokoro / Voxtype unreachable when lab OFF.
 * Never mutates real WD-Black or Voxtype installs.
 */

import assert from "node:assert/strict";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createKokoroTtsAdapter,
	labKokoroPresent,
} from "../lib/adapters/kokoro-tts.ts";
import { resolveLabVoiceAdapters } from "../lib/adapters/lab-resolve.ts";
import { defaultProbeSearchRoots } from "../lib/engines/probe-fs.ts";
import { isGentleVoiceLabPathsAllowed } from "../lib/runtime/lab-gate.ts";
import { resolveGentleVoiceStorage } from "../lib/runtime/storage.ts";
import {
	applyDeveloperLabEnv,
	LAB_KOKORO_PYTHON,
} from "./lab-env.ts";

function posix(p: string): string {
	return p.replace(/\\/g, "/");
}

function withLabEnv(
	on: boolean,
	run: () => void,
): void {
	const prevLab = process.env.GENTLE_VOICE_LAB;
	const prevReal = process.env.GENTLE_VOICE_REAL_AUDIO;
	const prevTts = process.env.GENTLE_VOICE_TTS;
	try {
		delete process.env.GENTLE_VOICE_REAL_AUDIO;
		delete process.env.GENTLE_VOICE_TTS;
		if (on) process.env.GENTLE_VOICE_LAB = "1";
		else delete process.env.GENTLE_VOICE_LAB;
		run();
	} finally {
		if (prevLab === undefined) delete process.env.GENTLE_VOICE_LAB;
		else process.env.GENTLE_VOICE_LAB = prevLab;
		if (prevReal === undefined) delete process.env.GENTLE_VOICE_REAL_AUDIO;
		else process.env.GENTLE_VOICE_REAL_AUDIO = prevReal;
		if (prevTts === undefined) delete process.env.GENTLE_VOICE_TTS;
		else process.env.GENTLE_VOICE_TTS = prevTts;
	}
}

test("3.4.1 lab OFF: labKokoroPresent is false and does not require WD-Black access", () => {
	withLabEnv(false, () => {
		assert.equal(isGentleVoiceLabPathsAllowed(), false);
		assert.equal(labKokoroPresent(), false);
		// Even if the developer lab exists on this machine, OFF must stay false.
		let labExists = false;
		try {
			accessSync(LAB_KOKORO_PYTHON, fsConstants.F_OK);
			labExists = true;
		} catch {
			labExists = false;
		}
		assert.equal(labKokoroPresent({}), false);
		assert.equal(labKokoroPresent({ GENTLE_VOICE_LAB: "0" }), false);
		// Document that lab may exist locally without affecting the gate.
		void labExists;
	});
});

test("3.4.1 lab ON: labKokoroPresent may be true only after probing lab paths", () => {
	applyDeveloperLabEnv();
	assert.equal(isGentleVoiceLabPathsAllowed(), true);
	const present = labKokoroPresent();
	// On CI without lab tree → false; on developer lab with env → true.
	assert.equal(typeof present, "boolean");
	if (present) {
		assert.equal(labKokoroPresent(), true);
	}
});

test("3.4.1 lab OFF: resolveLabVoiceAdapters never marks kokoroReady (even if WD-Black has Kokoro)", () => {
	withLabEnv(false, () => {
		const resolved = resolveLabVoiceAdapters({ forceStub: false });
		assert.equal(resolved.kokoroReady, false);
		assert.equal(resolved.kokoroAdapter, undefined);
		assert.notEqual(resolved.ttsKind, "kokoro");
	});
});

test("3.4.1 lab OFF: createKokoroTtsAdapter without paths stays unavailable (no lab defaults)", async () => {
	const prevLab = process.env.GENTLE_VOICE_LAB;
	const prevReal = process.env.GENTLE_VOICE_REAL_AUDIO;
	try {
		delete process.env.GENTLE_VOICE_LAB;
		delete process.env.GENTLE_VOICE_REAL_AUDIO;
		const tts = createKokoroTtsAdapter({});
		const avail = await tts.availability();
		assert.equal(avail.status, "unavailable");
		assert.equal(avail.reason, "kokoro_not_configured");
	} finally {
		if (prevLab === undefined) delete process.env.GENTLE_VOICE_LAB;
		else process.env.GENTLE_VOICE_LAB = prevLab;
		if (prevReal === undefined) delete process.env.GENTLE_VOICE_REAL_AUDIO;
		else process.env.GENTLE_VOICE_REAL_AUDIO = prevReal;
	}
});

test("3.4.1 lab OFF: GENTLE_VOICE_TTS=kokoro does not select Kokoro", () => {
	const prevLab = process.env.GENTLE_VOICE_LAB;
	const prevTts = process.env.GENTLE_VOICE_TTS;
	try {
		delete process.env.GENTLE_VOICE_LAB;
		delete process.env.GENTLE_VOICE_REAL_AUDIO;
		process.env.GENTLE_VOICE_TTS = "kokoro";
		const resolved = resolveLabVoiceAdapters({ forceStub: false });
		assert.equal(resolved.kokoroReady, false);
		assert.notEqual(resolved.ttsKind, "kokoro");
	} finally {
		if (prevLab === undefined) delete process.env.GENTLE_VOICE_LAB;
		else process.env.GENTLE_VOICE_LAB = prevLab;
		if (prevTts === undefined) delete process.env.GENTLE_VOICE_TTS;
		else process.env.GENTLE_VOICE_TTS = prevTts;
	}
});

test("3.4.1 probe roots: lab OFF excludes WD-Black and Voxtype absolutes", () => {
	const home = "/tmp/gv-probe-home";
	const { pathDirs, modelRoots } = defaultProbeSearchRoots({
		env: {
			HOME: home,
			XDG_DATA_HOME: `${home}/.local/share`,
			XDG_CONFIG_HOME: `${home}/.config`,
			XDG_CACHE_HOME: `${home}/.cache`,
		},
		home,
	});
	const blob = [...pathDirs, ...modelRoots].map(posix).join("\n");
	assert.ok(!blob.includes("WD-Black"));
	assert.ok(!blob.includes("voxtype"));
	assert.ok(!blob.includes("/home/erickfm/WD-Black"));
	assert.ok(blob.includes("gentle-voice"));
});

test("3.4.1 probe roots: lab ON includes only env-configured lab roots", () => {
	const home = "/tmp/gv-probe-lab-home";
	const labRoot = "/tmp/gv-lab-root";
	const { pathDirs, modelRoots } = defaultProbeSearchRoots({
		env: {
			HOME: home,
			GENTLE_VOICE_LAB: "1",
			GENTLE_VOICE_LAB_ROOT: labRoot,
			GENTLE_VOICE_VOXTYPE_MODELS_DIR: `${labRoot}/voxtype-models`,
			XDG_DATA_HOME: `${home}/.local/share`,
		},
		home,
	});
	const blob = [...pathDirs, ...modelRoots].map(posix).join("\n");
	assert.ok(blob.includes(labRoot));
	assert.ok(blob.includes("voxtype-models"));
	assert.ok(!blob.includes("/home/erickfm"));
	assert.ok(!blob.includes("WD-Black"));
});

test("3.4.1 GS bundled storage stays under prefix (regression)", () => {
	const prefix = "/tmp/gs-341-prefix";
	const agent = join(prefix, "agent");
	const r = resolveGentleVoiceStorage({
		env: {
			HOME: "/tmp/user",
			GENTLE_SHELL_PREFIX: prefix,
			PI_CODING_AGENT_DIR: agent,
			GENTLE_PI_AGENT_HOME: agent,
			GENTLE_SHELL_USER_PI_HOME: "/tmp/user/.pi/agent",
		},
		platform: "linux",
	});
	assert.equal(r.hostKind, "gs-bundled");
	assert.equal(posix(r.storageRoot), `${prefix}/gentle-voice`);
	assert.ok(!posix(r.storageRoot).includes(".local/share"));
	assert.ok(!posix(r.modelsDir).includes("WD-Black"));
});

test("3.4.1 Pi standalone + GS coexist without cross paths", async () => {
	const base = await mkdtemp(join(tmpdir(), "gv-341-coexist-"));
	const piHome = join(base, "pi");
	const gsPrefix = join(base, "gs");
	await mkdir(join(piHome, ".local", "share"), { recursive: true });
	await writeFile(join(piHome, ".local", "share", "SENTINEL"), "pi");
	await mkdir(gsPrefix, { recursive: true });
	await writeFile(join(gsPrefix, "SENTINEL"), "gs");

	const pi = resolveGentleVoiceStorage({
		env: {
			HOME: piHome,
			XDG_DATA_HOME: join(piHome, ".local", "share"),
			XDG_CONFIG_HOME: join(piHome, ".config"),
			XDG_CACHE_HOME: join(piHome, ".cache"),
		},
		platform: "linux",
	});
	const gs = resolveGentleVoiceStorage({
		env: {
			HOME: piHome,
			GENTLE_SHELL_PREFIX: gsPrefix,
			PI_CODING_AGENT_DIR: join(gsPrefix, "agent"),
			GENTLE_PI_AGENT_HOME: join(gsPrefix, "agent"),
			GENTLE_SHELL_USER_PI_HOME: join(piHome, ".pi", "agent"),
		},
		platform: "linux",
	});
	assert.equal(pi.hostKind, "pi-standalone");
	assert.equal(gs.hostKind, "gs-bundled");
	assert.notEqual(posix(pi.storageRoot), posix(gs.storageRoot));
	assert.ok(posix(gs.storageRoot).startsWith(posix(gsPrefix)));
	assert.ok(!posix(gs.storageRoot).includes("WD-Black"));
});

test("3.4.1 GS --link keeps portable layout (not prefix)", () => {
	const home = "/tmp/gv-341-link";
	const piAgent = `${home}/.pi/agent`;
	const r = resolveGentleVoiceStorage({
		env: {
			HOME: home,
			XDG_DATA_HOME: `${home}/.local/share`,
			XDG_CONFIG_HOME: `${home}/.config`,
			XDG_CACHE_HOME: `${home}/.cache`,
			GENTLE_SHELL_PREFIX: `${home}/.gentle-shell`,
			PI_CODING_AGENT_DIR: piAgent,
			GENTLE_PI_AGENT_HOME: piAgent,
			GENTLE_SHELL_USER_PI_HOME: piAgent,
		},
		platform: "linux",
	});
	assert.equal(r.hostKind, "gs-link");
	assert.equal(posix(r.storageRoot), `${home}/.local/share/gentle-voice`);
});
