/**
 * Lab launch preflight — fail closed, never install anything.
 * Distinguishes GENTLE_SHELL_NO_AUTO_SETUP (gentle-ai first-run) from
 * ensureEngramCompanion (policy pin install on every bundled launch).
 */

import { access, constants, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type LabMode = "experimental-gs" | "installed-gs-voice-only";

export interface PreflightPaths {
	readonly labHome: string;
	readonly experimentalGs: string;
	readonly voiceExtension: string;
	readonly launcherConfig: string;
	readonly modelsRoot: string;
}

export interface PreflightIssue {
	readonly severity: "error" | "warning";
	readonly code: string;
	readonly message: string;
}

export interface PreflightReport {
	readonly ok: boolean;
	readonly mode: LabMode;
	readonly issues: readonly PreflightIssue[];
	readonly engramCompanionPresent: boolean;
	readonly piPrettyResolvable: boolean;
	readonly codemodeOptOutPresent: boolean;
	readonly noAutoSetup: boolean;
	readonly notes: readonly string[];
}

async function readable(path: string): Promise<boolean> {
	try {
		await access(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

async function executable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export async function isPiPrettyResolvable(experimentalGs: string): Promise<boolean> {
	try {
		const req = createRequire(join(experimentalGs, "package.json"));
		req.resolve("@heyhuynhgiabuu/pi-pretty");
		return true;
	} catch {
		return false;
	}
}

export async function readLabSettings(labHome: string): Promise<{
	packages: unknown[];
	extensions: unknown[];
	raw: string | undefined;
}> {
	const path = join(labHome, "settings.json");
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as { packages?: unknown; extensions?: unknown };
		return {
			packages: Array.isArray(parsed.packages) ? parsed.packages : [],
			extensions: Array.isArray(parsed.extensions) ? parsed.extensions : [],
			raw,
		};
	} catch {
		return { packages: [], extensions: [], raw: undefined };
	}
}

export function engramCompanionPinned(packages: readonly unknown[]): boolean {
	return packages.some((entry) => {
		const source = typeof entry === "string" ? entry : (entry as { source?: string })?.source;
		return typeof source === "string" && /^npm:gentle-engram(?:@|$)/.test(source);
	});
}

export async function engramStartupPolicyOk(labHome: string): Promise<boolean> {
	const meta = join(labHome, "npm", "node_modules", "gentle-engram", "package.json");
	try {
		const raw = await readFile(meta, "utf8");
		const parsed = JSON.parse(raw) as { engram?: { startupPolicy?: number } };
		return parsed.engram?.startupPolicy === 1;
	} catch {
		return false;
	}
}

export function hasBuiltinCodemodeOptOut(extensions: readonly unknown[]): boolean {
	return extensions.some(
		(e) => typeof e === "string" && (e === "-builtin:codemode" || e.replace(/^[+!-]/, "") === "builtin:codemode" && e.startsWith("-")),
	);
}

/**
 * Would bundled ensureEngramCompanion attempt `pi install npm:gentle-engram@…`?
 * True when pin missing or metadata lacks startupPolicy=1.
 */
export async function wouldInstallEngramCompanion(labHome: string): Promise<boolean> {
	const { packages } = await readLabSettings(labHome);
	if (!engramCompanionPinned(packages)) return true;
	return !(await engramStartupPolicyOk(labHome));
}

export async function runLabPreflight(options: {
	readonly paths: PreflightPaths;
	readonly mode: LabMode;
	readonly env?: NodeJS.ProcessEnv;
	readonly allowCompanionInstall?: boolean;
}): Promise<PreflightReport> {
	const env = options.env ?? process.env;
	const issues: PreflightIssue[] = [];
	const notes: string[] = [];
	const { paths, mode } = options;

	const noAutoSetup = env.GENTLE_SHELL_NO_AUTO_SETUP === "1";
	if (!noAutoSetup) {
		issues.push({
			severity: "error",
			code: "NO_AUTO_SETUP_MISSING",
			message: "GENTLE_SHELL_NO_AUTO_SETUP must be 1 (blocks gentle-ai first-run setup only).",
		});
	} else {
		notes.push(
			"GENTLE_SHELL_NO_AUTO_SETUP=1 does NOT block ensureEngramCompanion (policy pin install).",
		);
	}

	for (const [label, path] of [
		["labHome", paths.labHome],
		["voiceExtension", paths.voiceExtension],
		["launcherConfig", paths.launcherConfig],
	] as const) {
		if (!(await readable(path))) {
			issues.push({ severity: "error", code: "PATH_MISSING", message: `${label} missing/unreadable: ${path}` });
		}
	}

	if (!(await readable(paths.experimentalGs))) {
		issues.push({
			severity: "error",
			code: "EXPERIMENTAL_GS_MISSING",
			message: `experimental GS missing: ${paths.experimentalGs}`,
		});
	}

	const settings = await readLabSettings(paths.labHome);
	const companionPresent =
		engramCompanionPinned(settings.packages) && (await engramStartupPolicyOk(paths.labHome));
	const wouldInstall = await wouldInstallEngramCompanion(paths.labHome);
	if (wouldInstall && !options.allowCompanionInstall) {
		issues.push({
			severity: "error",
			code: "ENGRAM_COMPANION_WOULD_INSTALL",
			message:
				"Bundled gentle-shell would run `pi install npm:gentle-engram@0.4.2` into the lab home. " +
				"Refuse launch. Seed lab companion metadata or set GENTLE_VOICE_LAB_ALLOW_COMPANION_INSTALL=1 after review.",
		});
	} else if (wouldInstall) {
		issues.push({
			severity: "warning",
			code: "ENGRAM_COMPANION_INSTALL_ALLOWED",
			message: "Companion install allowed by env; will mutate lab agent home only.",
		});
	} else {
		notes.push("gentle-engram companion already present in lab home (no install expected).");
	}

	const piPrettyResolvable = await isPiPrettyResolvable(paths.experimentalGs);
	if (mode === "experimental-gs" && !piPrettyResolvable) {
		issues.push({
			severity: "error",
			code: "PI_PRETTY_UNRESOLVED",
			message:
				`@heyhuynhgiabuu/pi-pretty not resolvable from ${paths.experimentalGs}. ` +
				"Root cause: experimental repo has the dependency declared but node_modules was never installed. " +
				"Fix: authorize `pnpm install` inside the experimental gentle-shell repo (local only). " +
				"Or relaunch with GENTLE_VOICE_LAB_MODE=installed-gs-voice-only (uses installed GS + voice -e only).",
		});
	}

	const codemodeOptOutPresent = hasBuiltinCodemodeOptOut(settings.extensions);
	if (!codemodeOptOutPresent) {
		issues.push({
			severity: "error",
			code: "CODEMODE_OPTOUT_MISSING",
			message:
				'Lab settings.json missing "-builtin:codemode". Expected GS behavior: quiet-tools registers compact codemode and Pi warns unless builtin is opted out in this home\'s settings.',
		});
	}

	if (env.GENTLE_SHELL_CONFIG && !(await readable(env.GENTLE_SHELL_CONFIG))) {
		issues.push({
			severity: "error",
			code: "LAB_CONFIG_MISSING",
			message: `GENTLE_SHELL_CONFIG not readable: ${env.GENTLE_SHELL_CONFIG}`,
		});
	}

	const ok = !issues.some((i) => i.severity === "error");
	return {
		ok,
		mode,
		issues,
		engramCompanionPresent: companionPresent,
		piPrettyResolvable,
		codemodeOptOutPresent,
		noAutoSetup,
		notes,
	};
}

export function formatPreflightReport(report: PreflightReport): string {
	const lines = [
		`preflight ok=${report.ok} mode=${report.mode}`,
		`noAutoSetup=${report.noAutoSetup} engramPresent=${report.engramCompanionPresent} piPretty=${report.piPrettyResolvable} codemodeOptOut=${report.codemodeOptOutPresent}`,
		...report.notes.map((n) => `note: ${n}`),
		...report.issues.map((i) => `${i.severity}: [${i.code}] ${i.message}`),
	];
	return lines.join("\n");
}

/** Build the recommended lab settings extensions/packages patch (lab home only). */
export function recommendedLabSettingsPatch(current: {
	packages: unknown[];
	extensions: unknown[];
}): { packages: unknown[]; extensions: string[] } {
	const packages = [...current.packages];
	if (!engramCompanionPinned(packages)) {
		packages.push("npm:gentle-engram@0.4.2");
	}
	const extensions = current.extensions.filter((e): e is string => typeof e === "string");
	if (!hasBuiltinCodemodeOptOut(extensions)) {
		extensions.push("-builtin:codemode");
	}
	return { packages, extensions };
}

export function defaultLabPaths(home = "/home/erickfm"): PreflightPaths {
	return {
		labHome: join(home, "D-SSD/personal/gs-lab/agent"),
		experimentalGs: join(home, "D-SSD/personal/projects/gentle-shell"),
		voiceExtension: join(home, "D-SSD/personal/projects/gentle-voice/extensions/voice.ts"),
		launcherConfig: join(home, "D-SSD/personal/gs-lab/launcher-config.json"),
		modelsRoot: join(home, "WD-Black/gentle-voice/models"),
	};
}

// Keep URL import unused-check happy in strip-types environments that tree-shake oddly.
void pathToFileURL;
void stat;
void executable;
