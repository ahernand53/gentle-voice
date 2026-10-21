/**
 * Per-component readiness. A finished VibeVoice install does not set the others.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveGentleVoiceStorage } from "./storage.ts";

export const CAPABILITIES_KIND = "gentle-voice.capabilities/v1" as const;

export interface VoiceCapabilities {
	readonly schema: typeof CAPABILITIES_KIND;
	readonly updatedAt: string;
	readonly ttsInstalled: boolean;
	readonly ttsReady: boolean;
	readonly ttsActive: boolean;
	readonly sttReady: boolean;
	readonly vadReady: boolean;
	readonly vadChoice: "silero" | "energy" | "missing" | "corrupt";
	readonly captureReady: boolean;
	readonly playbackReady: boolean;
	readonly conversationReady: boolean;
	readonly summary: string;
}

export function capabilitiesPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(resolveGentleVoiceStorage({ env }).dataDir, "capabilities.json");
}

export function readCapabilities(env: NodeJS.ProcessEnv = process.env): VoiceCapabilities | undefined {
	const path = capabilitiesPath(env);
	if (!existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as VoiceCapabilities;
		if (raw.schema !== CAPABILITIES_KIND) return undefined;
		return raw;
	} catch {
		return undefined;
	}
}

export async function writeCapabilities(
	env: NodeJS.ProcessEnv,
	caps: VoiceCapabilities,
): Promise<void> {
	const path = capabilitiesPath(env);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(caps, null, 2)}\n`, { mode: 0o600 });
}

export function formatCapabilities(caps: VoiceCapabilities): string[] {
	return [
		`ttsInstalled=${caps.ttsInstalled}`,
		`ttsReady=${caps.ttsReady}`,
		`ttsActive=${caps.ttsActive}`,
		`sttReady=${caps.sttReady}`,
		`vadReady=${caps.vadReady}`,
		`vadChoice=${caps.vadChoice}`,
		`captureReady=${caps.captureReady}`,
		`playbackReady=${caps.playbackReady}`,
		`conversationReady=${caps.conversationReady}`,
		caps.summary,
	];
}
