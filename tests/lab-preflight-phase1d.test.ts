/**
 * Phase 1D — lab preflight regression (no installs, no LLM).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	runLabPreflight,
	wouldInstallEngramCompanion,
	hasBuiltinCodemodeOptOut,
	engramCompanionPinned,
	recommendedLabSettingsPatch,
	isPiPrettyResolvable,
	defaultLabPaths,
} from "../lib/lab/preflight.ts";

test("real: NO_AUTO_SETUP alone does not imply companion will not install", async () => {
	// Empty temp home → would install companion
	const root = join(tmpdir(), `gv-lab-${Date.now()}`);
	const labHome = join(root, "agent");
	await mkdir(labHome, { recursive: true });
	await writeFile(join(labHome, "settings.json"), JSON.stringify({ packages: [] }));
	assert.equal(await wouldInstallEngramCompanion(labHome), true);
	await rm(root, { recursive: true, force: true });
});

test("real: gs-lab companion already present → wouldInstall false", async () => {
	const paths = defaultLabPaths();
	assert.equal(await wouldInstallEngramCompanion(paths.labHome), false);
});

test("real: experimental GS resolves pi-pretty after local pnpm install", async () => {
	const paths = defaultLabPaths();
	const ok = await isPiPrettyResolvable(paths.experimentalGs);
	assert.equal(ok, true);
});

test("simulated: codemode opt-out detection", () => {
	assert.equal(hasBuiltinCodemodeOptOut([]), false);
	assert.equal(hasBuiltinCodemodeOptOut(["-builtin:codemode"]), true);
	assert.equal(hasBuiltinCodemodeOptOut(["+builtin:codemode"]), false);
});

test("simulated: recommended patch adds codemode opt-out and engram pin", () => {
	const patch = recommendedLabSettingsPatch({ packages: [], extensions: [] });
	assert.ok(engramCompanionPinned(patch.packages));
	assert.ok(hasBuiltinCodemodeOptOut(patch.extensions));
});

test("real: preflight experimental-gs passes when pi-pretty + companion + codemode ready", async () => {
	const report = await runLabPreflight({
		paths: defaultLabPaths(),
		mode: "experimental-gs",
		env: {
			...process.env,
			GENTLE_SHELL_NO_AUTO_SETUP: "1",
			GENTLE_SHELL_CONFIG: defaultLabPaths().launcherConfig,
		},
		allowCompanionInstall: false,
	});
	assert.equal(report.ok, true, report.issues.map((i) => i.code).join(","));
	assert.equal(report.piPrettyResolvable, true);
	assert.equal(report.codemodeOptOutPresent, true);
	assert.equal(report.engramCompanionPresent, true);
});

test("simulated: preflight fails closed when pi-pretty unresolved", async () => {
	const report = await runLabPreflight({
		paths: {
			...defaultLabPaths(),
			experimentalGs: "/tmp/gv-no-such-gentle-shell",
		},
		mode: "experimental-gs",
		env: {
			...process.env,
			GENTLE_SHELL_NO_AUTO_SETUP: "1",
			GENTLE_SHELL_CONFIG: defaultLabPaths().launcherConfig,
		},
		allowCompanionInstall: false,
	});
	assert.equal(report.ok, false);
	assert.ok(
		report.issues.some((i) => i.code === "PI_PRETTY_UNRESOLVED" || i.code === "EXPERIMENTAL_GS_MISSING"),
	);
});

test("real: preflight installed-gs-voice-only can pass when companion+codemode ok", async () => {
	const report = await runLabPreflight({
		paths: defaultLabPaths(),
		mode: "installed-gs-voice-only",
		env: {
			...process.env,
			GENTLE_SHELL_NO_AUTO_SETUP: "1",
			GENTLE_SHELL_CONFIG: defaultLabPaths().launcherConfig,
		},
		allowCompanionInstall: false,
	});
	assert.equal(report.ok, true, formatIssues(report));
	assert.equal(report.noAutoSetup, true);
});

test("simulated: missing NO_AUTO_SETUP is an error", async () => {
	const report = await runLabPreflight({
		paths: defaultLabPaths(),
		mode: "installed-gs-voice-only",
		env: { ...process.env, GENTLE_SHELL_NO_AUTO_SETUP: "0", GENTLE_SHELL_CONFIG: defaultLabPaths().launcherConfig },
	});
	assert.equal(report.ok, false);
	assert.ok(report.issues.some((i) => i.code === "NO_AUTO_SETUP_MISSING"));
});

function formatIssues(report: { issues: readonly { code: string; message: string }[] }): string {
	return report.issues.map((i) => `${i.code}:${i.message}`).join(" | ");
}
