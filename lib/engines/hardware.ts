/**
 * Hardware profile for model selection. Injectable for tests (no side effects).
 */

import { cpus, totalmem } from "node:os";
import type { VoicePlatform } from "../contracts.ts";
import { detectVoicePlatform } from "../config.ts";
import type { HardwareProfile } from "./contracts.ts";

export interface HardwareProbe {
	ramBytes(): number;
	cpuCores(): number;
	arch(): string;
	hasGpuHint(): boolean;
	gpuLabel?: () => string | undefined;
}

/** Node-based probe. GPU is opt-in via env until a real enumerator exists. */
export function nodeHardwareProbe(
	env: NodeJS.ProcessEnv = process.env,
): HardwareProbe {
	return {
		ramBytes() {
			const override = env.GENTLE_VOICE_HW_RAM_BYTES;
			if (override && /^\d+$/.test(override)) return Number(override);
			return totalmem();
		},
		cpuCores() {
			const override = env.GENTLE_VOICE_HW_CPU_CORES;
			if (override && /^\d+$/.test(override)) return Number(override);
			return Math.max(1, cpus()?.length ?? 1);
		},
		arch() {
			return env.GENTLE_VOICE_HW_ARCH?.trim() || process.arch;
		},
		hasGpuHint() {
			return env.GENTLE_VOICE_HW_GPU === "1" || env.GENTLE_VOICE_HW_GPU === "true";
		},
		gpuLabel() {
			return env.GENTLE_VOICE_HW_GPU_LABEL?.trim() || undefined;
		},
	};
}

export function staticHardwareProbe(profile: Partial<HardwareProfile> & Pick<HardwareProfile, "ramBytes">): HardwareProbe {
	return {
		ramBytes: () => profile.ramBytes,
		cpuCores: () => profile.cpuCores ?? 4,
		arch: () => profile.arch ?? "x64",
		hasGpuHint: () => profile.hasGpuHint ?? false,
		gpuLabel: () => profile.gpuLabel,
	};
}

export function readHardwareProfile(options?: {
	platform?: VoicePlatform;
	probe?: HardwareProbe;
}): HardwareProfile {
	const platform = options?.platform ?? detectVoicePlatform();
	const probe = options?.probe ?? nodeHardwareProbe();
	const label = probe.gpuLabel?.();
	return {
		platform,
		arch: probe.arch(),
		ramBytes: probe.ramBytes(),
		cpuCores: probe.cpuCores(),
		hasGpuHint: probe.hasGpuHint(),
		...(label ? { gpuLabel: label } : {}),
	};
}
