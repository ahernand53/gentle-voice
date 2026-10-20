#!/usr/bin/env -S node --experimental-strip-types
/**
 * Remove Gentle Voice entries from a Pi settings.json copy.
 *
 * SAFETY: refuses to write unless --settings <path> is given AND --write is set.
 * Never defaults to ~/.pi/agent/settings.json.
 *
 * Usage:
 *   gentle-voice-repair-settings --settings /tmp/copy/settings.json
 *   gentle-voice-repair-settings --settings /tmp/copy/settings.json --write
 */

import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { applyRemoveGentleVoiceFromSettings, planRemoveGentleVoiceFromSettings } = await import(
	pathToFileURL(join(here, "../lib/runtime/partial-uninstall-repair.ts")).href
);

function usage() {
	console.log(`gentle-voice-repair-settings — fix partial Pi unregister

Usage:
  gentle-voice-repair-settings --settings <path-to-settings.json>
  gentle-voice-repair-settings --settings <path> --write

Without --write: dry-run only (prints plan).
Does NOT modify ~/.pi unless you pass that path explicitly with --write.
`);
}

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help") || args.length === 0) {
	usage();
	process.exit(args.length === 0 ? 1 : 0);
}

const settingsIdx = args.indexOf("--settings");
if (settingsIdx < 0 || !args[settingsIdx + 1]) {
	console.error("error: --settings <path> is required (no implicit ~/.pi)");
	process.exit(1);
}
const settingsPath = args[settingsIdx + 1];
const doWrite = args.includes("--write");

const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
const plan = planRemoveGentleVoiceFromSettings(raw);
console.log(`settings=${settingsPath}`);
console.log(`changed=${plan.changed}`);
console.log(`removed=${JSON.stringify(plan.removed)}`);
console.log(`keptCount=${plan.kept.length}`);

if (!plan.changed) {
	console.log("Nothing to repair.");
	process.exit(0);
}

if (!doWrite) {
	console.log("Dry-run only. Re-run with --write to apply (after reviewing).");
	process.exit(0);
}

const backup = `${settingsPath}.bak-gentle-voice-repair`;
copyFileSync(settingsPath, backup);
const { settings } = applyRemoveGentleVoiceFromSettings(raw);
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`wrote=${settingsPath}`);
console.log(`backup=${backup}`);
