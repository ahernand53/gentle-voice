/**
 * Phase 3.4 — Gentle Shell isolation storage resolution.
 * Uses temporary HOME / prefixes only; never touches real Pi or GS installs.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseVoiceArgs } from "../lib/commands.ts";
import { resolveRuntimeLayout } from "../lib/runtime/paths.ts";
import {
	isPathInside,
	planGentleVoiceDataCleanup,
	resolveGentleVoiceStorage,
} from "../lib/runtime/storage.ts";

function posix(p: string): string {
	return p.replace(/\\/g, "/");
}

function sentinelEnv(root: string): NodeJS.ProcessEnv {
	return {
		HOME: root,
		USERPROFILE: root,
		XDG_DATA_HOME: join(root, ".local", "share"),
		XDG_CONFIG_HOME: join(root, ".config"),
		XDG_CACHE_HOME: join(root, ".cache"),
		LOCALAPPDATA: join(root, "AppData", "Local"),
		APPDATA: join(root, "AppData", "Roaming"),
	};
}

test("3.4 Case A: Pi standalone keeps XDG (ignores unrelated .gentle-shell on disk path in HOME only via env absence)", () => {
	const home = "/tmp/gv-pi-home";
	const r = resolveGentleVoiceStorage({
		env: {
			...sentinelEnv(home),
			// No GS session vars — even if user has ~/.gentle-shell on disk, we must not switch.
		},
		platform: "linux",
	});
	assert.equal(r.hostKind, "pi-standalone");
	assert.equal(posix(r.storageRoot), `${home}/.local/share/gentle-voice`);
	assert.equal(posix(r.configDir), `${home}/.config/gentle-voice`);
	assert.equal(posix(r.cacheDir), `${home}/.cache/gentle-voice`);
});

test("3.4 Case B: GS bundled → <prefix>/gentle-voice/", () => {
	const prefix = "/tmp/gs-prefix-bundled";
	const agent = join(prefix, "agent");
	const r = resolveGentleVoiceStorage({
		env: {
			...sentinelEnv("/tmp/user"),
			GENTLE_SHELL_PREFIX: prefix,
			PI_CODING_AGENT_DIR: agent,
			GENTLE_PI_AGENT_HOME: agent,
			GENTLE_SHELL_USER_PI_HOME: "/tmp/user/.pi/agent",
		},
		platform: "linux",
	});
	assert.equal(r.hostKind, "gs-bundled");
	assert.equal(posix(r.storageRoot), `${prefix}/gentle-voice`);
	assert.equal(posix(r.binDir), `${prefix}/gentle-voice/bin`);
	assert.equal(posix(r.modelsDir), `${prefix}/gentle-voice/models`);
	assert.equal(posix(r.configDir), `${prefix}/gentle-voice/config`);
	assert.equal(posix(r.cacheDir), `${prefix}/gentle-voice/cache`);
	assert.equal(posix(r.tmpDir), `${prefix}/gentle-voice/cache/tmp`);
	assert.equal(posix(r.logsDir), `${prefix}/gentle-voice/logs`);
	assert.ok(!posix(r.storageRoot).includes(".local/share"));
	assert.ok(!posix(r.storageRoot).includes(".config/gentle-voice"));
});

test("3.4 Case B: GS isolated default ~/.gentle-shell/agent → sibling gentle-voice", () => {
	const home = "/tmp/user-gs";
	const agent = join(home, ".gentle-shell", "agent");
	const r = resolveGentleVoiceStorage({
		env: {
			...sentinelEnv(home),
			PI_CODING_AGENT_DIR: agent,
			GENTLE_PI_AGENT_HOME: agent,
			GENTLE_SHELL_USER_PI_HOME: join(home, ".pi", "agent"),
		},
		platform: "linux",
	});
	assert.equal(r.hostKind, "gs-isolated");
	assert.equal(posix(r.storageRoot), `${home}/.gentle-shell/gentle-voice`);
	assert.equal(posix(r.gsPrefix!), `${home}/.gentle-shell`);
});

test("3.4 Case C: GS --link uses portable layout (not GS prefix)", () => {
	const home = "/tmp/user-link";
	const piAgent = join(home, ".pi", "agent");
	const prefix = join(home, ".gentle-shell");
	const r = resolveGentleVoiceStorage({
		env: {
			...sentinelEnv(home),
			GENTLE_SHELL_PREFIX: prefix,
			PI_CODING_AGENT_DIR: piAgent,
			GENTLE_PI_AGENT_HOME: piAgent,
			GENTLE_SHELL_USER_PI_HOME: piAgent,
		},
		platform: "linux",
	});
	assert.equal(r.hostKind, "gs-link");
	assert.equal(posix(r.storageRoot), `${home}/.local/share/gentle-voice`);
	assert.ok(!posix(r.storageRoot).startsWith(posix(prefix)));
});

test("3.4 Case D: GS --home custom nests under agent home", () => {
	const custom = "/tmp/custom-gs-home";
	const r = resolveGentleVoiceStorage({
		env: {
			...sentinelEnv("/tmp/user"),
			PI_CODING_AGENT_DIR: custom,
			GENTLE_PI_AGENT_HOME: custom,
			GENTLE_SHELL_USER_PI_HOME: "/tmp/user/.pi/agent",
			GENTLE_SHELL_HOME: custom,
		},
		platform: "linux",
	});
	assert.equal(r.hostKind, "gs-custom-home");
	assert.equal(posix(r.storageRoot), `${custom}/gentle-voice`);
});

test("3.4 Case E: explicit GENTLE_VOICE_HOME wins and nests cache", () => {
	const root = "/tmp/gv-override";
	const r = resolveGentleVoiceStorage({
		env: {
			...sentinelEnv("/tmp/user"),
			GENTLE_VOICE_HOME: root,
			GENTLE_VOICE_CACHE: "/tmp/lab-cache-elsewhere",
			GENTLE_SHELL_PREFIX: "/tmp/gs-prefix",
			PI_CODING_AGENT_DIR: "/tmp/gs-prefix/agent",
			GENTLE_SHELL_USER_PI_HOME: "/tmp/user/.pi/agent",
		},
		platform: "linux",
	});
	assert.equal(r.hostKind, "override");
	assert.equal(posix(r.storageRoot), root);
	assert.equal(posix(r.cacheDir), `${root}/cache`);
	assert.ok(r.activeOverrides.includes("GENTLE_VOICE_HOME"));
	assert.ok(!r.cacheDir.includes("lab-cache"));
});

test("3.4 HOME temporal: two installs coexist without cross-write", async () => {
	const base = await mkdtemp(join(tmpdir(), "gv-coexist-"));
	const piHome = join(base, "pi-user");
	const gsPrefix = join(base, "gs-prefix");
	const sentinelPi = join(piHome, ".local", "share", "SENTINEL_PI");
	const sentinelGs = join(gsPrefix, "SENTINEL_GS");
	await mkdir(join(piHome, ".local", "share"), { recursive: true });
	await mkdir(gsPrefix, { recursive: true });
	await writeFile(sentinelPi, "pi");
	await writeFile(sentinelGs, "gs");

	const pi = resolveGentleVoiceStorage({
		env: sentinelEnv(piHome),
		platform: "linux",
	});
	const gs = resolveGentleVoiceStorage({
		env: {
			...sentinelEnv(piHome),
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
	assert.ok(isPathInside(join(piHome, ".local", "share"), pi.storageRoot));
	assert.ok(isPathInside(gsPrefix, gs.storageRoot));
	assert.ok(!isPathInside(gsPrefix, pi.storageRoot));
	assert.ok(!posix(gs.storageRoot).includes(".local/share"));
});

test("3.4 resolveRuntimeLayout matches storage for GS isolated", () => {
	const agent = "/home/u/.gentle-shell/agent";
	const layout = resolveRuntimeLayout(
		{
			HOME: "/home/u",
			PI_CODING_AGENT_DIR: agent,
			GENTLE_SHELL_USER_PI_HOME: "/home/u/.pi/agent",
		},
		"linux",
	);
	assert.equal(layout.hostKind, "gs-isolated");
	assert.equal(posix(layout.home), "/home/u/.gentle-shell/gentle-voice");
});

test("3.4 cleanup plan refuses GS versions/runtime and allows gentle-voice root", () => {
	const prefix = "/tmp/gs-clean";
	const r = resolveGentleVoiceStorage({
		env: {
			HOME: "/tmp/u",
			GENTLE_SHELL_PREFIX: prefix,
			PI_CODING_AGENT_DIR: join(prefix, "agent"),
			GENTLE_SHELL_USER_PI_HOME: "/tmp/u/.pi/agent",
		},
		platform: "linux",
	});
	const plan = planGentleVoiceDataCleanup(r);
	assert.equal(plan.allowed, true);
	assert.ok(plan.directories.some((d) => d.endsWith("gentle-voice") || d.includes(`${sepish(prefix)}gentle-voice`)));
	assert.ok(!plan.directories.some((d) => d.includes(`${sepish(prefix)}versions`)));
	assert.ok(!plan.directories.some((d) => d.includes(`${sepish(prefix)}runtime`)));
});

function sepish(p: string): string {
	return p.endsWith("/") ? p : `${p}/`;
}

test("3.4 storage subcommand parses", () => {
	assert.equal(parseVoiceArgs("storage").command, "storage");
});

test("3.4 no ambient XDG write targets when GS bundled (paths are under prefix)", () => {
	const prefix = "/tmp/gs-no-xdg";
	const user = "/tmp/xdg-user";
	const r = resolveGentleVoiceStorage({
		env: {
			...sentinelEnv(user),
			GENTLE_SHELL_PREFIX: prefix,
			PI_CODING_AGENT_DIR: join(prefix, "agent"),
			GENTLE_SHELL_USER_PI_HOME: join(user, ".pi", "agent"),
		},
		platform: "linux",
	});
	const forbidden = [
		join(user, ".local", "share", "gentle-voice"),
		join(user, ".config", "gentle-voice"),
		join(user, ".cache", "gentle-voice"),
		join(user, ".pi", "agent"),
	];
	for (const f of forbidden) {
		assert.ok(!pathsEqualLoose(r.storageRoot, f), `must not use ${f}`);
		assert.ok(!isPathInside(f, r.binDir));
	}
});

function pathsEqualLoose(a: string, b: string): boolean {
	return posix(a) === posix(b);
}
