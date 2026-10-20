/**
 * Safe private-data cleanup for Gentle Voice (remove-complete).
 * Never touches Voxtype, WD-Black, Kokoro lab trees, other Pi packages, or GS versions/runtime.
 */

import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	isPathInside,
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

/**
 * Delete only paths that are inside the authorized storage root.
 * Requires exact confirm token. Dry-run when confirm mismatches.
 */
export async function executeGentleVoiceDataCleanup(options: {
	readonly confirm: string;
	readonly resolution?: GentleVoiceStorageResolution;
	readonly dryRun?: boolean;
}): Promise<CleanupExecutionResult> {
	const resolution = options.resolution ?? resolveGentleVoiceStorage();
	const plan = planGentleVoiceDataCleanup(resolution);
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

	const root = normalizeStoragePath(plan.storageRoot);
	// Delete deepest paths first so parents remain until children are gone.
	const ordered = [...plan.directories].sort((a, b) => b.length - a.length);

	for (const raw of ordered) {
		const target = normalizeStoragePath(raw);
		if (!isPathInside(root, target) && !pathsEqual(root, target)) {
			skipped.push(target);
			errors.push(`refused outside storage root: ${target}`);
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
			errors.push(`${target}: ${err instanceof Error ? err.message : String(err)}`);
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
		`cleanup.note=${plan.note}`,
		...plan.reasonsDenied.map((r) => `cleanup.denied=${r}`),
		"cleanup.paths:",
		...plan.directories.map((d) => `  - ${d}`),
		`cleanup.confirmToken=${CLEANUP_CONFIRM_TOKEN}`,
	];
	return lines.join("\n");
}

/** Paths that must never appear in a cleanup plan (defense in depth / docs). */
export function forbiddenExternalRoots(): readonly string[] {
	return [
		join("WD-Black"),
		"voxtype",
		"kokoro",
		".gentle-shell/versions",
		".gentle-shell/runtime",
	];
}
