/**
 * Portable runtime directories for Gentle Voice.
 * Never writes into the project cwd where the user launched Pi.
 * Never uses developer-specific absolute paths.
 */

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { VoicePlatform } from "../contracts.ts";

function platformOf(p: NodeJS.Platform = process.platform): VoicePlatform {
	if (p === "linux") return "linux";
	if (p === "win32") return "win32";
	if (p === "darwin") return "darwin";
	return "unsupported";
}

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
}

/**
 * Resolve XDG / LocalAppData / Application Support layout.
 * Env overrides (GENTLE_VOICE_*) always win when set.
 */
export function resolveRuntimeLayout(
	env: NodeJS.ProcessEnv = process.env,
	platform: VoicePlatform = platformOf(),
): GentleVoiceRuntimeLayout {
	const homeOverride = env.GENTLE_VOICE_HOME?.trim();
	const modelsOverride = env.GENTLE_VOICE_MODELS?.trim();
	const cacheOverride = env.GENTLE_VOICE_CACHE?.trim();
	const tmpOverride = env.GENTLE_VOICE_TMP?.trim();

	const userHome = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
	let dataDir: string;
	let configDir: string;
	let cacheDir: string;

	if (homeOverride) {
		// Private install root: keep cache/tmp inside it so ambient lab
		// GENTLE_VOICE_CACHE (e.g. WD-Black) cannot leak across devices.
		dataDir = homeOverride;
		configDir = join(homeOverride, "config");
		const nestedCache = join(homeOverride, "cache");
		cacheDir =
			cacheOverride && cacheOverride.startsWith(homeOverride)
				? cacheOverride
				: nestedCache;
	} else if (platform === "win32") {
		const local = env.LOCALAPPDATA?.trim() || join(userHome, "AppData", "Local");
		const roaming = env.APPDATA?.trim() || join(userHome, "AppData", "Roaming");
		dataDir = join(local, "gentle-voice");
		configDir = join(roaming, "gentle-voice");
		cacheDir = cacheOverride || join(local, "gentle-voice", "cache");
	} else if (platform === "darwin") {
		dataDir = join(userHome, "Library", "Application Support", "gentle-voice");
		configDir = dataDir;
		cacheDir = cacheOverride || join(userHome, "Library", "Caches", "gentle-voice");
	} else {
		// linux + unsupported → XDG
		const xdgData = env.XDG_DATA_HOME?.trim() || join(userHome, ".local", "share");
		const xdgConfig = env.XDG_CONFIG_HOME?.trim() || join(userHome, ".config");
		const xdgCache = env.XDG_CACHE_HOME?.trim() || join(userHome, ".cache");
		dataDir = join(xdgData, "gentle-voice");
		configDir = join(xdgConfig, "gentle-voice");
		cacheDir = cacheOverride || join(xdgCache, "gentle-voice");
	}

	const home = homeOverride || dataDir;
	const modelsDir = modelsOverride || join(dataDir, "models");
	const binDir = join(dataDir, "bin");
	const tmpDir = tmpOverride || join(cacheDir, "tmp");
	const logsDir = join(dataDir, "logs");

	return {
		platform,
		home,
		configDir,
		configFile: env.GENTLE_VOICE_CONFIG?.trim() || join(configDir, "config.json"),
		dataDir,
		modelsDir,
		binDir,
		cacheDir,
		tmpDir: tmpDir || join(tmpdir(), "gentle-voice"),
		logsDir,
		stateFile: join(dataDir, "runtime-state.json"),
		readinessFile: join(dataDir, "readiness.json"),
	};
}
