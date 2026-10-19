/**
 * CLI entry for gs-lab/launch-voice-lab.sh preflight.
 * Usage: node --experimental-strip-types run-preflight-cli.ts <mode> <allowCompanion 0|1>
 */
import {
	defaultLabPaths,
	formatPreflightReport,
	runLabPreflight,
	type LabMode,
} from "./preflight.ts";

const mode = (process.argv[2] ?? "experimental-gs") as LabMode;
const allowCompanionInstall = process.argv[3] === "1";

const report = await runLabPreflight({
	paths: defaultLabPaths(),
	mode,
	env: process.env,
	allowCompanionInstall,
});
console.log(formatPreflightReport(report));
process.exit(report.ok ? 0 : 3);
