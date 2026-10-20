/**
 * Phase 3.5 follow-up — multi-root cleanup (Pi XDG + GS) + partial settings repair.
 * Never touches real ~/.pi or WD-Black.
 */
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile, symlink, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	CLEANUP_CONFIRM_TOKEN,
	executeGentleVoiceDataCleanup,
	isAuthorizedCleanupTarget,
	pathHasGentleVoiceSegment,
} from "../lib/runtime/cleanup.ts";
import {
	applyRemoveGentleVoiceFromSettings,
	detectPartialGentleVoiceUninstall,
	planRemoveGentleVoiceFromSettings,
} from "../lib/runtime/partial-uninstall-repair.ts";
import {
	planGentleVoiceDataCleanup,
	resolveGentleVoiceStorage,
} from "../lib/runtime/storage.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("3.5b Pi standalone plan includes XDG data+config+cache gentle-voice roots", () => {
	const home = "/tmp/gv-pi-xdg-home";
	const r = resolveGentleVoiceStorage({
		env: {
			HOME: home,
			XDG_DATA_HOME: `${home}/.local/share`,
			XDG_CONFIG_HOME: `${home}/.config`,
			XDG_CACHE_HOME: `${home}/.cache`,
		},
		platform: "linux",
	});
	assert.equal(r.hostKind, "pi-standalone");
	const plan = planGentleVoiceDataCleanup(r);
	assert.equal(plan.allowed, true);
	const blob = plan.directories.join("\n");
	assert.match(blob, /\.local\/share\/gentle-voice/);
	assert.match(blob, /\.config\/gentle-voice/);
	assert.match(blob, /\.cache\/gentle-voice/);
	assert.ok(plan.directories.every(pathHasGentleVoiceSegment));
});

test("3.5b GS isolated plan nests under prefix/gentle-voice only", () => {
	const home = "/tmp/gv-gs-home";
	const agent = `${home}/.gentle-shell/agent`;
	const r = resolveGentleVoiceStorage({
		env: {
			HOME: home,
			PI_CODING_AGENT_DIR: agent,
			GENTLE_SHELL_USER_PI_HOME: `${home}/.pi/agent`,
		},
		platform: "linux",
	});
	assert.equal(r.hostKind, "gs-isolated");
	const plan = planGentleVoiceDataCleanup(r);
	assert.equal(plan.allowed, true);
	assert.ok(plan.directories.every((d) => d.includes(".gentle-shell/gentle-voice") || d.includes("gentle-voice")));
	assert.ok(!plan.directories.some((d) => d.includes(".gentle-shell/versions")));
	assert.ok(!plan.directories.some((d) => d.includes("voxtype")));
});

test("3.5b execute deletes Pi XDG config+cache siblings (not only dataDir)", async () => {
	const base = await mkdtemp(join(tmpdir(), "gv-xdg-clean-"));
	const data = join(base, ".local", "share", "gentle-voice");
	const config = join(base, ".config", "gentle-voice");
	const cache = join(base, ".cache", "gentle-voice");
	const voxtype = join(base, ".local", "share", "voxtype");
	await mkdir(join(data, "models"), { recursive: true });
	await mkdir(config, { recursive: true });
	await mkdir(join(cache, "tmp"), { recursive: true });
	await mkdir(voxtype, { recursive: true });
	await writeFile(join(data, "models", "m.bin"), "m");
	await writeFile(join(config, "config.json"), "{}");
	await writeFile(join(cache, "tmp", "x"), "x");
	await writeFile(join(voxtype, "keep.bin"), "keep");

	const resolution = resolveGentleVoiceStorage({
		env: {
			HOME: base,
			XDG_DATA_HOME: join(base, ".local", "share"),
			XDG_CONFIG_HOME: join(base, ".config"),
			XDG_CACHE_HOME: join(base, ".cache"),
		},
		platform: "linux",
	});
	const plan = planGentleVoiceDataCleanup(resolution);
	assert.ok(isAuthorizedCleanupTarget(config, plan).ok);
	assert.ok(isAuthorizedCleanupTarget(cache, plan).ok);

	const result = await executeGentleVoiceDataCleanup({
		confirm: CLEANUP_CONFIRM_TOKEN,
		resolution,
	});
	assert.equal(result.ok, true);
	assert.ok(result.deleted.some((d) => d.endsWith("gentle-voice") || d.includes("gentle-voice")));
	await access(join(voxtype, "keep.bin"), constants.R_OK);
});

test("3.5b execute after simulated package removal via CLI from repo bin", async () => {
	const base = await mkdtemp(join(tmpdir(), "gv-cli-clean-"));
	const data = join(base, "share", "gentle-voice");
	await mkdir(join(data, "bin"), { recursive: true });
	await writeFile(join(data, "bin", "whisper-cli"), "x");
	// Simulate: package gone — only CLI from this repo checkout remains.
	const bin = join(repoRoot, "bin", "gentle-voice-cleanup.mjs");
	const cleanEnv = {
		...process.env,
		HOME: base,
		XDG_DATA_HOME: join(base, "share"),
		XDG_CONFIG_HOME: join(base, "cfg"),
		XDG_CACHE_HOME: join(base, "cache"),
		GENTLE_VOICE_HOME: data,
		// Scrub ambient lab overrides that may point at WD-Black on the developer machine
		GENTLE_VOICE_MODELS: "",
		GENTLE_VOICE_CACHE: "",
		GENTLE_VOICE_TMP: "",
		GENTLE_VOICE_LAB_ROOT: "",
		GENTLE_SHELL_PREFIX: "",
		PI_CODING_AGENT_DIR: "",
		GENTLE_PI_AGENT_HOME: "",
		GENTLE_SHELL_USER_PI_HOME: "",
		GENTLE_VOICE_LAB: "",
	};
	const dry = spawnSync(
		process.execPath,
		["--experimental-strip-types", bin],
		{ env: cleanEnv, encoding: "utf8" },
	);
	assert.equal(dry.status, 0, dry.stderr);
	assert.match(dry.stdout, /cleanup\.allowed=true/);
	assert.match(dry.stdout, /gentle-voice/);
	const pathLines = dry.stdout.split("\n").filter((l) => l.trim().startsWith("- "));
	assert.ok(pathLines.length > 0);
	assert.ok(
		pathLines.every((l) => !l.includes("WD-Black") && !/voxtype/i.test(l)),
		`plan paths must not list shared trees: ${pathLines.join(" | ")}`,
	);

	const run = spawnSync(
		process.execPath,
		["--experimental-strip-types", bin, "--confirm", CLEANUP_CONFIRM_TOKEN],
		{ env: cleanEnv, encoding: "utf8" },
	);
	assert.equal(run.status, 0, run.stderr + run.stdout);
	assert.match(run.stdout, /deleted /);
	try {
		await access(join(data, "bin", "whisper-cli"), constants.R_OK);
		assert.fail("whisper-cli should be gone");
	} catch {
		/* expected ENOENT */
	}
});

test("3.5b partial uninstall detection + settings repair (temp copy only)", async () => {
	const base = await mkdtemp(join(tmpdir(), "gv-settings-repair-"));
	const settingsPath = join(base, "settings.json");
	const settings = {
		packages: [
			"npm:pi-lens@4.3.0",
			"npm:gentle-voice",
			"npm:pi-btw",
		],
		theme: "dark",
	};
	await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

	const partial = detectPartialGentleVoiceUninstall({
		settingsPackages: settings.packages,
		npmDependencyNames: ["pi-lens", "pi-btw"], // no gentle-voice
	});
	assert.equal(partial.partial, true);

	const plan = planRemoveGentleVoiceFromSettings(settings);
	assert.deepEqual(plan.removed, ["npm:gentle-voice"]);
	assert.ok(plan.kept.includes("npm:pi-lens@4.3.0"));

	const bin = join(repoRoot, "bin", "gentle-voice-repair-settings.mjs");
	const dry = spawnSync(
		process.execPath,
		["--experimental-strip-types", bin, "--settings", settingsPath],
		{ encoding: "utf8" },
	);
	assert.equal(dry.status, 0, dry.stderr);
	assert.match(dry.stdout, /Dry-run/);
	const still = JSON.parse(await readFile(settingsPath, "utf8"));
	assert.ok(still.packages.includes("npm:gentle-voice"));

	const write = spawnSync(
		process.execPath,
		["--experimental-strip-types", bin, "--settings", settingsPath, "--write"],
		{ encoding: "utf8" },
	);
	assert.equal(write.status, 0, write.stderr);
	const after = JSON.parse(await readFile(settingsPath, "utf8"));
	assert.deepEqual(after.packages, ["npm:pi-lens@4.3.0", "npm:pi-btw"]);
	assert.equal(after.theme, "dark");
	await access(`${settingsPath}.bak-gentle-voice-repair`, constants.R_OK);

	const applied = applyRemoveGentleVoiceFromSettings(after);
	assert.equal(applied.plan.changed, false);
});

test("3.5b refuse symlink even when under gentle-voice", async () => {
	const base = await mkdtemp(join(tmpdir(), "gv-sym-"));
	const root = join(base, "gentle-voice");
	const precious = join(base, "shared-models");
	await mkdir(root, { recursive: true });
	await mkdir(precious, { recursive: true });
	await writeFile(join(precious, "keep"), "1");
	try {
		await symlink(precious, join(root, "models"));
	} catch {
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
	assert.ok(result.errors.some((e) => /symlink/i.test(e)));
	await access(join(precious, "keep"), constants.R_OK);
});
