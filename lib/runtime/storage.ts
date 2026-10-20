/**
 * Central storage resolution for Gentle Voice.
 *
 * Host detection is env-only (what Gentle Shell / Pi injects into the process).
 * Never scans the disk for a ~/.gentle-shell install to decide isolation.
 * Never treats "process looks like gentle-shell" as proof of isolation.
 */

import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { VoicePlatform } from "../contracts.ts";

export type StorageHostKind =
	| "pi-standalone"
	| "gs-bundled"
	| "gs-isolated"
	| "gs-link"
	| "gs-custom-home"
	| "override";

export interface GentleVoiceRuntimeLayout {
	readonly platform: VoicePlatform;
	readonly home: string;
	readonly configDir: string;
	readonly configFile: string;
	readonly dataDir: string;
	readonly modelsDir: string;
	readonly binDir: string;
	readonly cacheDir: string;
	readonly tmpDir: string;
	readonly logsDir: string;
	readonly stateFile: string;
	readonly readinessFile: string;
	readonly hostKind: StorageHostKind;
	readonly storageRoot: string;
	readonly agentHome?: string;
	readonly gsPrefix?: string;
	readonly activeOverrides: readonly string[];
}

export interface GentleVoiceStorageResolution extends GentleVoiceRuntimeLayout {
	readonly diagnostics: readonly string[];
}

export interface ResolveStorageInput {
	readonly env?: NodeJS.ProcessEnv;
	readonly platform?: VoicePlatform;
}

const GS_PREFIX_ENV = "GENTLE_SHELL_PREFIX";
const GS_HOME_ENV = "GENTLE_SHELL_HOME";
const USER_PI_HOME_ENV = "GENTLE_SHELL_USER_PI_HOME";
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const GENTLE_PI_AGENT_HOME_ENV = "GENTLE_PI_AGENT_HOME";

function platformOf(p: NodeJS.Platform = process.platform): VoicePlatform {
	if (p === "linux") return "linux";
	if (p === "win32") return "win32";
	if (p === "darwin") return "darwin";
	return "unsupported";
}

function trimEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
	const v = env[key]?.trim();
	return v && v.length > 0 ? v : undefined;
}

/** Normalize for equality / containment checks (no realpath — env-only). */
export function normalizeStoragePath(path: string): string {
	const resolved = normalize(resolve(path));
	if (resolved.length > 1 && (resolved.endsWith("/") || resolved.endsWith("\\"))) {
		return resolved.slice(0, -1);
	}
	return resolved;
}

export function pathsEqual(a: string, b: string): boolean {
	return normalizeStoragePath(a) === normalizeStoragePath(b);
}

/** True when `child` is `parent` or a path under `parent` (string-level; no symlink follow). */
export function isPathInside(parent: string, child: string): boolean {
	const p = normalizeStoragePath(parent);
	const c = normalizeStoragePath(child);
	if (p === c) return true;
	const rel = relative(p, c);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function userHome(env: NodeJS.ProcessEnv): string {
	return trimEnv(env, "HOME") || trimEnv(env, "USERPROFILE") || homedir();
}

export function effectiveAgentHome(env: NodeJS.ProcessEnv): string | undefined {
	return trimEnv(env, GENTLE_PI_AGENT_HOME_ENV) || trimEnv(env, PI_AGENT_DIR_ENV);
}

/**
 * Default Gentle Shell isolated agent layout: `<prefix>/.gentle-shell/agent`
 * or any `.../.gentle-shell/agent` (posix/win separators).
 */
export function isDefaultGentleShellAgentDir(agentHome: string): boolean {
	const n = normalizeStoragePath(agentHome);
	const parts = n.split(/[/\\]/).filter(Boolean);
	if (parts.length < 2) return false;
	return parts[parts.length - 1] === "agent" && parts[parts.length - 2] === ".gentle-shell";
}

export function defaultGentleShellPrefixFromAgent(agentHome: string): string | undefined {
	if (!isDefaultGentleShellAgentDir(agentHome)) return undefined;
	return dirname(normalizeStoragePath(agentHome));
}

function buildNestedLayout(
	platform: VoicePlatform,
	storageRoot: string,
	hostKind: StorageHostKind,
	opts: {
		agentHome?: string;
		gsPrefix?: string;
		activeOverrides: readonly string[];
		modelsOverride?: string;
		cacheOverride?: string;
		tmpOverride?: string;
		configOverride?: string;
	},
): GentleVoiceRuntimeLayout {
	const dataDir = storageRoot;
	const configDir = join(storageRoot, "config");
	const nestedCache = join(storageRoot, "cache");
	// Nested / GS / HOME override: never leak an external lab cache (EXDEV).
	const cacheDir =
		opts.cacheOverride && isPathInside(storageRoot, opts.cacheOverride)
			? opts.cacheOverride
			: nestedCache;

	const modelsDir = opts.modelsOverride || join(dataDir, "models");
	const binDir = join(dataDir, "bin");
	const tmpDir = opts.tmpOverride || join(cacheDir, "tmp");
	const logsDir = join(dataDir, "logs");

	return {
		platform,
		home: storageRoot,
		configDir,
		configFile: opts.configOverride || join(configDir, "config.json"),
		dataDir,
		modelsDir,
		binDir,
		cacheDir,
		tmpDir: tmpDir || join(tmpdir(), "gentle-voice"),
		logsDir,
		stateFile: join(dataDir, "runtime-state.json"),
		readinessFile: join(dataDir, "readiness.json"),
		hostKind,
		storageRoot,
		agentHome: opts.agentHome,
		gsPrefix: opts.gsPrefix,
		activeOverrides: opts.activeOverrides,
	};
}

function buildPortableLayout(
	platform: VoicePlatform,
	env: NodeJS.ProcessEnv,
	hostKind: StorageHostKind,
	opts: {
		agentHome?: string;
		gsPrefix?: string;
		activeOverrides: readonly string[];
		modelsOverride?: string;
		cacheOverride?: string;
		tmpOverride?: string;
		configOverride?: string;
	},
): GentleVoiceRuntimeLayout {
	const home = userHome(env);
	let dataDir: string;
	let configDir: string;
	let cacheDir: string;

	if (platform === "win32") {
		const local = trimEnv(env, "LOCALAPPDATA") || join(home, "AppData", "Local");
		const roaming = trimEnv(env, "APPDATA") || join(home, "AppData", "Roaming");
		dataDir = join(local, "gentle-voice");
		configDir = join(roaming, "gentle-voice");
		cacheDir = opts.cacheOverride || join(local, "gentle-voice", "cache");
	} else if (platform === "darwin") {
		dataDir = join(home, "Library", "Application Support", "gentle-voice");
		configDir = dataDir;
		cacheDir = opts.cacheOverride || join(home, "Library", "Caches", "gentle-voice");
	} else {
		const xdgData = trimEnv(env, "XDG_DATA_HOME") || join(home, ".local", "share");
		const xdgConfig = trimEnv(env, "XDG_CONFIG_HOME") || join(home, ".config");
		const xdgCache = trimEnv(env, "XDG_CACHE_HOME") || join(home, ".cache");
		dataDir = join(xdgData, "gentle-voice");
		configDir = join(xdgConfig, "gentle-voice");
		cacheDir = opts.cacheOverride || join(xdgCache, "gentle-voice");
	}

	const modelsDir = opts.modelsOverride || join(dataDir, "models");
	const binDir = join(dataDir, "bin");
	const tmpDir = opts.tmpOverride || join(cacheDir, "tmp");
	const logsDir = join(dataDir, "logs");

	return {
		platform,
		home: dataDir,
		configDir,
		configFile: opts.configOverride || join(configDir, "config.json"),
		dataDir,
		modelsDir,
		binDir,
		cacheDir,
		tmpDir: tmpDir || join(tmpdir(), "gentle-voice"),
		logsDir,
		stateFile: join(dataDir, "runtime-state.json"),
		readinessFile: join(dataDir, "readiness.json"),
		hostKind,
		storageRoot: dataDir,
		agentHome: opts.agentHome,
		gsPrefix: opts.gsPrefix,
		activeOverrides: opts.activeOverrides,
	};
}

/**
 * Resolve where Gentle Voice may read/write private data for this process.
 *
 * Preference (Case B): `<gentle-shell-prefix>/gentle-voice/{bin,models,config,cache,tmp,logs}`
 * when the host is GS bundled/isolated under a GS-owned prefix.
 */
export function resolveGentleVoiceStorage(
	input: ResolveStorageInput = {},
): GentleVoiceStorageResolution {
	const env = input.env ?? process.env;
	const platform = input.platform ?? platformOf();
	const diagnostics: string[] = [];
	const activeOverrides: string[] = [];

	const homeOverride = trimEnv(env, "GENTLE_VOICE_HOME");
	const modelsOverride = trimEnv(env, "GENTLE_VOICE_MODELS");
	const cacheOverride = trimEnv(env, "GENTLE_VOICE_CACHE");
	const tmpOverride = trimEnv(env, "GENTLE_VOICE_TMP");
	const configOverride = trimEnv(env, "GENTLE_VOICE_CONFIG");

	if (homeOverride) activeOverrides.push("GENTLE_VOICE_HOME");
	if (modelsOverride) activeOverrides.push("GENTLE_VOICE_MODELS");
	if (cacheOverride) activeOverrides.push("GENTLE_VOICE_CACHE");
	if (tmpOverride) activeOverrides.push("GENTLE_VOICE_TMP");
	if (configOverride) activeOverrides.push("GENTLE_VOICE_CONFIG");

	const agentHome = effectiveAgentHome(env);
	const userPiHome = trimEnv(env, USER_PI_HOME_ENV);
	const gsPrefixEnv = trimEnv(env, GS_PREFIX_ENV);
	const gsHomeEnv = trimEnv(env, GS_HOME_ENV);

	if (homeOverride) {
		diagnostics.push("explicit GENTLE_VOICE_HOME wins over host detection");
		const layout = buildNestedLayout(platform, normalizeStoragePath(homeOverride), "override", {
			agentHome,
			gsPrefix: gsPrefixEnv,
			activeOverrides,
			modelsOverride,
			cacheOverride,
			tmpOverride,
			configOverride,
		});
		return { ...layout, diagnostics };
	}

	// Case C — --link: agent home equals the user's Pi home carried by GS.
	if (agentHome && userPiHome && pathsEqual(agentHome, userPiHome)) {
		diagnostics.push("gs-link: PI agent home equals GENTLE_SHELL_USER_PI_HOME → portable Pi layout");
		const layout = buildPortableLayout(platform, env, "gs-link", {
			agentHome,
			activeOverrides,
			modelsOverride,
			cacheOverride,
			tmpOverride,
			configOverride,
		});
		return { ...layout, diagnostics };
	}

	// Case B — bundled: absolute GENTLE_SHELL_PREFIX and agent home inside it.
	if (
		gsPrefixEnv &&
		isAbsolute(gsPrefixEnv) &&
		agentHome &&
		isPathInside(gsPrefixEnv, agentHome)
	) {
		const prefix = normalizeStoragePath(gsPrefixEnv);
		const storageRoot = join(prefix, "gentle-voice");
		diagnostics.push(`gs-bundled: GENTLE_SHELL_PREFIX=${prefix}; storage=${storageRoot}`);
		const layout = buildNestedLayout(platform, storageRoot, "gs-bundled", {
			agentHome,
			gsPrefix: prefix,
			activeOverrides,
			modelsOverride,
			cacheOverride,
			tmpOverride,
			configOverride,
		});
		return { ...layout, diagnostics };
	}

	// Case B — default isolated: .../.gentle-shell/agent → sibling gentle-voice/
	if (agentHome && isDefaultGentleShellAgentDir(agentHome)) {
		const prefix = defaultGentleShellPrefixFromAgent(agentHome)!;
		const storageRoot = join(prefix, "gentle-voice");
		diagnostics.push(`gs-isolated: default agent under .gentle-shell; storage=${storageRoot}`);
		const layout = buildNestedLayout(platform, storageRoot, "gs-isolated", {
			agentHome,
			gsPrefix: prefix,
			activeOverrides,
			modelsOverride,
			cacheOverride,
			tmpOverride,
			configOverride,
		});
		return { ...layout, diagnostics };
	}

	// Case D — custom --home / GENTLE_SHELL_HOME: nest under the effective agent home.
	// Evidence of GS ownership for this session: USER_PI_HOME set and agent ≠ user Pi,
	// or GENTLE_SHELL_HOME matches agent home.
	const looksLikeGsSession =
		Boolean(userPiHome && agentHome && !pathsEqual(agentHome, userPiHome)) ||
		Boolean(gsHomeEnv && agentHome && pathsEqual(gsHomeEnv, agentHome));

	if (agentHome && looksLikeGsSession) {
		const storageRoot = join(normalizeStoragePath(agentHome), "gentle-voice");
		diagnostics.push(
			`gs-custom-home: storage nested under effective agent home (${storageRoot})`,
		);
		const layout = buildNestedLayout(platform, storageRoot, "gs-custom-home", {
			agentHome,
			gsPrefix: gsPrefixEnv && isAbsolute(gsPrefixEnv) ? normalizeStoragePath(gsPrefixEnv) : undefined,
			activeOverrides,
			modelsOverride,
			cacheOverride,
			tmpOverride,
			configOverride,
		});
		return { ...layout, diagnostics };
	}

	// Case A — Pi independiente (or no GS session signals).
	diagnostics.push("pi-standalone: portable XDG / LocalAppData / Application Support layout");
	const layout = buildPortableLayout(platform, env, "pi-standalone", {
		agentHome,
		activeOverrides,
		modelsOverride,
		cacheOverride,
		tmpOverride,
		configOverride,
	});
	return { ...layout, diagnostics };
}

/** Forbidden roots for cleanup (never delete). */
const FORBIDDEN_CLEANUP_BASENAMES = new Set([
	"",
	".",
	"..",
	"/",
	"home",
	"Users",
	"etc",
	"usr",
	"var",
	"tmp",
	"Windows",
	"System32",
]);

export interface DataCleanupPlan {
	readonly allowed: boolean;
	readonly storageRoot: string;
	readonly hostKind: StorageHostKind;
	readonly directories: readonly string[];
	readonly reasonsDenied: readonly string[];
	readonly note: string;
}

/**
 * Plan optional private-data cleanup. Never deletes; caller must confirm.
 * Refuses targets outside the resolved storage root / GS prefix.
 */
export function planGentleVoiceDataCleanup(
	resolution: GentleVoiceStorageResolution = resolveGentleVoiceStorage(),
): DataCleanupPlan {
	const root = normalizeStoragePath(resolution.storageRoot);
	const reasonsDenied: string[] = [];
	const base = root.split(/[/\\]/).pop() ?? "";

	if (!root || root === sep || FORBIDDEN_CLEANUP_BASENAMES.has(base)) {
		reasonsDenied.push("storage root looks like a system or empty path");
	}
	if (!base.includes("gentle-voice") && resolution.hostKind !== "override") {
		reasonsDenied.push("storage root basename is not gentle-voice (safety)");
	}
	if (resolution.gsPrefix && !isPathInside(resolution.gsPrefix, root)) {
		reasonsDenied.push("storage root is outside the authorized Gentle Shell prefix");
	}
	if (resolution.hostKind.startsWith("gs-") && resolution.gsPrefix) {
		const versions = join(resolution.gsPrefix, "versions");
		const runtime = join(resolution.gsPrefix, "runtime");
		if (isPathInside(versions, root) || pathsEqual(versions, root)) {
			reasonsDenied.push("refuses to target GS versions/");
		}
		if (isPathInside(runtime, root) || pathsEqual(runtime, root)) {
			reasonsDenied.push("refuses to target GS runtime/");
		}
	}

	const directories = [
		root,
		resolution.binDir,
		resolution.modelsDir,
		resolution.configDir,
		resolution.cacheDir,
		resolution.tmpDir,
		resolution.logsDir,
	];

	const allowed = reasonsDenied.length === 0;
	return {
		allowed,
		storageRoot: root,
		hostKind: resolution.hostKind,
		directories: [...new Set(directories.map(normalizeStoragePath))],
		reasonsDenied,
		note: allowed
			? "Dry-run only. Deleting these paths removes STT/TTS binaries, models, voices, cache and Gentle Voice config. It does not uninstall the npm package from Pi/GS."
			: "Cleanup refused — see reasonsDenied.",
	};
}

export function formatStorageDiagnostics(resolution: GentleVoiceStorageResolution): string {
	const lines = [
		`hostKind=${resolution.hostKind}`,
		`storageRoot=${resolution.storageRoot}`,
		`agentHome=${resolution.agentHome ?? "(none)"}`,
		`gsPrefix=${resolution.gsPrefix ?? "(none)"}`,
		`dataDir=${resolution.dataDir}`,
		`configDir=${resolution.configDir}`,
		`modelsDir=${resolution.modelsDir}`,
		`binDir=${resolution.binDir}`,
		`cacheDir=${resolution.cacheDir}`,
		`tmpDir=${resolution.tmpDir}`,
		`logsDir=${resolution.logsDir}`,
		`configFile=${resolution.configFile}`,
		`overrides=${resolution.activeOverrides.length ? resolution.activeOverrides.join(",") : "(none)"}`,
		...resolution.diagnostics.map((d) => `diag: ${d}`),
	];
	return lines.join("\n");
}
