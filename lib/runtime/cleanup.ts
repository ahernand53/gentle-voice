/**
 * Safe private-data cleanup for Gentle Voice (remove-complete).
 * Never touches Voxtype, WD-Black, Kokoro lab trees, other Pi packages, or GS versions/runtime.
 *
 * Pi standalone may split data/config/cache across XDG roots — all authorized paths
 * come from resolveGentleVoiceStorage() and must contain a "gentle-voice" segment.
 */

import { lstat, rm } from "node:fs/promises";
import {
	isPathInside,
	isSafePrivateCleanupPath,
	normalizeStoragePath,
	planGentleVoiceDataCleanup,
	pathsEqual,
	resolveGentleVoiceStorage,
	type DataCleanupPlan,
	type GentleVoiceStorageResolution,
} from "./storage.ts";

export const CLEANUP_CONFIRM_TOKEN = "DELETE_GENTLE_VOICE_DATA" as const;

export interface CleanupExecutionResult {
	readonly ok: boolean;
	readonly deleted: readonly string[];
	readonly skipped: readonly string[];
	readonly errors: readonly string[];
	readonly plan: DataCleanupPlan;
}

async function isSymlink(path: string): Promise<boolean> {
	try {
		const st = await lstat(path);
		return st.isSymbolicLink();
	} catch {
		return false;
	}
}

/** True when a path segment is exactly gentle-voice (not voxtype, not WD-Black, …). */
export function pathHasGentleVoiceSegment(path: string): boolean {
	const parts = normalizeStoragePath(path).split(/[/\\]/).filter(Boolean);
	return parts.some((p) => p === "gentle-voice");
}

/**
 * A plan path is executable only if it is one of the planned directories
 * (or nested under the storage root / another planned root that itself is gentle-voice).
 */
export function isAuthorizedCleanupTarget(
	target: string,
	plan: DataCleanupPlan,
): { ok: true } | { ok: false; reason: string } {
	const t = normalizeStoragePath(target);
	const planned = new Set(plan.directories.map(normalizeStoragePath));
	if (!planned.has(t) && !isPathInside(plan.storageRoot, t)) {
		return { ok: false, reason: "not in cleanup plan and not under storageRoot" };
	}
	if (!isSafePrivateCleanupPath(t, plan.storageRoot)) {
		return { ok: false, reason: "refuses shared/third-party or non-private path" };
	}
	if (!pathHasGentleVoiceSegment(t)) {
		return { ok: false, reason: "path lacks gentle-voice segment" };
	}
	return { ok: true };
}

/**
 * Delete only authorized plan paths.
 * Requires exact confirm token. Supports dryRun and keepModels.
 */
export async function executeGentleVoiceDataCleanup(options: {
	readonly confirm: string;
	readonly resolution?: GentleVoiceStorageResolution;
	readonly dryRun?: boolean;
	/** Preserve modelsDir (STT models + TTS voices) for a later reinstall. */
	readonly keepModels?: boolean;
}): Promise<CleanupExecutionResult> {
	const resolution = options.resolution ?? resolveGentleVoiceStorage();
	const plan = planGentleVoiceDataCleanup(resolution, {
		keepModels: options.keepModels === true,
	});
	const deleted: string[] = [];
	const skipped: string[] = [];
	const errors: string[] = [];

	if (!plan.allowed) {
		return { ok: false, deleted, skipped, errors: [...plan.reasonsDenied], plan };
	}
	if (options.confirm !== CLEANUP_CONFIRM_TOKEN) {
		return {
			ok: false,
			deleted,
			skipped: [...plan.directories],
			errors: [
				`confirm token mismatch — pass exact "${CLEANUP_CONFIRM_TOKEN}" after reviewing the plan`,
			],
			plan,
		};
	}

	// Deepest first so children go before parents when both are listed.
	const ordered = [...plan.directories].sort((a, b) => b.length - a.length);

	for (const raw of ordered) {
		const target = normalizeStoragePath(raw);
		const auth = isAuthorizedCleanupTarget(target, plan);
		if (!auth.ok) {
			skipped.push(target);
			errors.push(`${auth.reason}: ${target}`);
			continue;
		}
		if (await isSymlink(target)) {
			skipped.push(target);
			errors.push(`refused symlink: ${target}`);
			continue;
		}
		if (options.dryRun) {
			skipped.push(target);
			continue;
		}
		try {
			await rm(target, { recursive: true, force: true });
			deleted.push(target);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// Missing path is fine (idempotent).
			if (/ENOENT/i.test(msg)) {
				skipped.push(target);
				continue;
			}
			errors.push(`${target}: ${msg}`);
		}
	}

	return {
		ok: errors.length === 0,
		deleted,
		skipped,
		errors,
		plan,
	};
}

export function formatCleanupPlan(plan: DataCleanupPlan): string {
	const lines = [
		`cleanup.allowed=${plan.allowed}`,
		`cleanup.hostKind=${plan.hostKind}`,
		`cleanup.storageRoot=${plan.storageRoot}`,
		`cleanup.keepModels=${plan.keepModels}`,
		`cleanup.note=${plan.note}`,
		...plan.reasonsDenied.map((r) => `cleanup.denied=${r}`),
		"cleanup.paths:",
		...plan.directories.map((d) => `  - ${d}`),
		`cleanup.confirmToken=${CLEANUP_CONFIRM_TOKEN}`,
	];
	return lines.join("\n");
}

export function forbiddenExternalRoots(): readonly string[] {
	return ["WD-Black", "voxtype", "kokoro", ".gentle-shell/versions", ".gentle-shell/runtime"];
}

/** Re-export for callers that only need equality helpers. */
export { pathsEqual, isPathInside, normalizeStoragePath };
