#!/usr/bin/env node
/**
 * Print which Gentle Voice sources GS-Lab would load (launcher -e path).
 * Does not start Pi. Safe read-only probe.
 */
import { readFileSync, realpathSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const GV = "/home/erickfm/D-SSD/personal/projects/gentle-voice";
const LAB = "/home/erickfm/D-SSD/personal/gs-lab";
const ext = join(GV, "extensions/voice.ts");
const pkg = JSON.parse(readFileSync(join(GV, "package.json"), "utf8"));
let commit = "?";
try {
	commit = execSync("git rev-parse --short HEAD", { cwd: GV, encoding: "utf8" }).trim();
} catch { /* */ }
let settingsPkgs = [];
try {
	settingsPkgs = JSON.parse(readFileSync(join(LAB, "agent/settings.json"), "utf8")).packages ?? [];
} catch { /* */ }
const nm = join(LAB, "agent/npm/node_modules/gentle-voice");
console.log(JSON.stringify({
	gentleVoiceCheckout: realpathSync(GV),
	extensionLoadedByLauncher: realpathSync(ext),
	declaredVersion: pkg.version,
	gitCommit: commit,
	labAgentHome: join(LAB, "agent"),
	labVoiceHome: join(LAB, "voice-home"),
	labSettingsPackages: settingsPkgs,
	labNodeModulesGentleVoice: existsSync(nm) ? realpathSync(nm) : null,
	loadsPublishedNpmCopy: existsSync(nm),
	launcherUsesCheckoutDashE: true,
}, null, 2));
