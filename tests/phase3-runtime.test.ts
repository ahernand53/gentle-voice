/**
 * Phase 3 / 3.1 — portable paths, first-run plan, checksum, download helpers.
 * Network downloads only in explicit opt-in tests (skipped by default).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sha256Buffer, checksumMatches } from "../lib/runtime/checksum.ts";
import { resolveRuntimeLayout } from "../lib/runtime/paths.ts";
import { buildFirstRunPlan, verifyArtifactFile } from "../lib/runtime/first-run.ts";
import { formatCompatMarkdown, COMPAT_MATRIX } from "../lib/runtime/compat-matrix.ts";
import { artifactsFor, detectArch } from "../lib/runtime/artifacts.ts";
import { parseVoiceArgs } from "../lib/commands.ts";
import { verifySha256 } from "../lib/runtime/download.ts";

test("3 paths: linux XDG layout under HOME", () => {
	const layout = resolveRuntimeLayout(
		{
			HOME: "/tmp/gv-home-test",
			XDG_DATA_HOME: "/tmp/gv-home-test/.local/share",
			XDG_CONFIG_HOME: "/tmp/gv-home-test/.config",
			XDG_CACHE_HOME: "/tmp/gv-home-test/.cache",
		},
		"linux",
	);
	assert.equal(layout.dataDir, "/tmp/gv-home-test/.local/share/gentle-voice");
	assert.equal(layout.configDir, "/tmp/gv-home-test/.config/gentle-voice");
	assert.match(layout.modelsDir, /models$/);
	assert.match(layout.binDir, /bin$/);
});

test("3 paths: win32 LocalAppData", () => {
	const layout = resolveRuntimeLayout(
		{
			USERPROFILE: "C:\\Users\\test",
			LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
			APPDATA: "C:\\Users\\test\\AppData\\Roaming",
		},
		"win32",
	);
	assert.match(layout.dataDir.replace(/\\/g, "/"), /Local\/gentle-voice$/);
	assert.match(layout.configDir.replace(/\\/g, "/"), /Roaming\/gentle-voice$/);
});

test("3 paths: darwin Application Support", () => {
	const layout = resolveRuntimeLayout({ HOME: "/Users/test" }, "darwin");
	assert.equal(
		layout.dataDir,
		"/Users/test/Library/Application Support/gentle-voice",
	);
	assert.match(layout.cacheDir, /Caches\/gentle-voice$/);
});

test("3.1 artifacts: linux x64 catalog is fully pinned", () => {
	const arts = artifactsFor("linux", "x64");
	assert.ok(arts.length >= 5);
	for (const a of arts) {
		assert.ok(a.url, a.id);
		assert.equal(a.sha256.length, 64, a.id);
	}
});

test("3.1 first-run: isolated home reports needs_consent when artifacts missing", async () => {
	const root = await mkdtemp(join(tmpdir(), "gv-firstrun-"));
	const plan = await buildFirstRunPlan({
		GENTLE_VOICE_HOME: root,
		HOME: root,
	});
	assert.ok(plan.missing.length > 0);
	assert.equal(plan.status, "needs_consent");
	assert.ok(plan.estimatedDownloadBytes > 0);
});

test("3 checksum helpers", async () => {
	const hex = sha256Buffer(Buffer.from("gentle-voice"));
	assert.equal(hex.length, 64);
	assert.equal(checksumMatches(hex, hex.toUpperCase()), true);
	const root = await mkdtemp(join(tmpdir(), "gv-sha-"));
	const file = join(root, "x.bin");
	await writeFile(file, "abc");
	assert.equal(await verifyArtifactFile(file, ""), false);
	await verifySha256(file, sha256Buffer(Buffer.from("abc")));
});

test("3 compat matrix never marks win32/darwin conversation as supported", () => {
	for (const cell of COMPAT_MATRIX) {
		if (cell.platform === "win32" || cell.platform === "darwin") {
			assert.notEqual(cell.capture, "supported");
			assert.notEqual(cell.playback, "supported");
			assert.ok(cell.capture === "blocked" || cell.capture === "planned");
		}
	}
	assert.match(formatCompatMarkdown(), /linux/);
});

test("3 parseVoiceArgs setup", () => {
	assert.equal(parseVoiceArgs("setup").command, "setup");
});

test("3 first-run dirs created under private home only", async () => {
	const root = await mkdtemp(join(tmpdir(), "gv-layout-"));
	await mkdir(join(root, "models"), { recursive: true });
	const layout = resolveRuntimeLayout({ GENTLE_VOICE_HOME: root }, "linux");
	assert.equal(layout.home, root);
	assert.ok(layout.modelsDir.startsWith(root));
});

test("3.2 paths: GENTLE_VOICE_HOME nests cache (ignores external lab CACHE)", () => {
	const root = "/tmp/gv-private-home";
	const layout = resolveRuntimeLayout(
		{
			GENTLE_VOICE_HOME: root,
			GENTLE_VOICE_CACHE: "/home/erickfm/WD-Black/gentle-voice/cache",
			HOME: "/tmp/other",
		},
		"linux",
	);
	assert.equal(layout.cacheDir, `${root}/cache`);
	assert.ok(!layout.cacheDir.includes("WD-Black"));
});

test("3.1 detectArch", () => {
	assert.ok(["x64", "arm64", "other"].includes(detectArch()));
});
