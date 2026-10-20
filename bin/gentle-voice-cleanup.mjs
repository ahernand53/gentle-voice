#!/usr/bin/env -S node --experimental-strip-types
/**
 * Standalone Gentle Voice private-data cleanup.
 * Works after package removal if this binary remains available
 * (global npm bin, or `npx --package gentle-voice gentle-voice-cleanup`).
 *
 * Does NOT uninstall the Pi package entry from settings.json.
 * Does NOT touch Voxtype, WD-Black, Kokoro lab trees, or GS versions/runtime.
 */

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { executeGentleVoiceDataCleanup, formatCleanupPlan, CLEANUP_CONFIRM_TOKEN } = await import(
	pathToFileURL(join(here, "../lib/runtime/cleanup.ts")).href
);
const { resolveGentleVoiceStorage, planGentleVoiceDataCleanup } = await import(
	pathToFileURL(join(here, "../lib/runtime/storage.ts")).href
);

function usage() {
	console.log(`gentle-voice-cleanup — optional private data removal

Usage:
  gentle-voice-cleanup                         Show cleanup plan (dry-run)
  gentle-voice-cleanup --keep-models           Dry-run; preserve models/voices
  gentle-voice-cleanup --confirm ${CLEANUP_CONFIRM_TOKEN}
  gentle-voice-cleanup --keep-models --confirm ${CLEANUP_CONFIRM_TOKEN}

Environment: same GENTLE_VOICE_* / GENTLE_SHELL_* as the extension.
Never deletes Voxtype, WD-Black, other Pi packages, or GS versions/runtime.
`);
}

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
	usage();
	process.exit(0);
}

const keepModels = args.includes("--keep-models");

const confirmIdx = args.findIndex((a) => a === "--confirm" || a.startsWith("--confirm="));
let confirm = "";
if (confirmIdx >= 0) {
	const a = args[confirmIdx];
	confirm = a.includes("=") ? a.split("=").slice(1).join("=") : (args[confirmIdx + 1] ?? "");
}

const resolution = resolveGentleVoiceStorage();
const plan = planGentleVoiceDataCleanup(resolution, { keepModels });
console.log(formatCleanupPlan(plan));

if (!confirm) {
	console.log("\nNo delete performed. Re-run with --confirm after reviewing paths.");
	process.exit(0);
}

const result = await executeGentleVoiceDataCleanup({ confirm, resolution, keepModels });
for (const d of result.deleted) console.log(`deleted ${d}`);
for (const s of result.skipped) console.log(`skipped ${s}`);
for (const e of result.errors) console.error(`error ${e}`);
process.exit(result.ok ? 0 : 1);
