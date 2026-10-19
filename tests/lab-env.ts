/**
 * Developer-lab gate for tests that require WD-Black / Voxtype / gs-lab paths.
 * CI and clean machines must skip those tests — never mkdir under /home/erickfm.
 */

import { existsSync } from "node:fs";
import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { TestContext } from "node:test";

export const LAB_ROOT = "/home/erickfm/WD-Black/gentle-voice";
export const LAB_HOME = "/home/erickfm";

/** True only when this machine actually has the developer lab tree. */
export function developerLabPresent(): boolean {
	if (process.env.GENTLE_VOICE_CI_LAB === "1") {
		return existsSync(LAB_ROOT);
	}
	if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
		return false;
	}
	return existsSync(LAB_ROOT);
}

/** node:test skip option — falsy when lab is available. */
export const skipWithoutLab: false | string = developerLabPresent()
	? false
	: "developer lab paths not present (CI/portable)";

/** Soft skip inside a test body. */
export function skipIfNoLab(t: TestContext): boolean {
	if (developerLabPresent()) return false;
	t.skip(skipWithoutLab || "developer lab paths not present");
	return true;
}

/** Append a line to a temp lab log — never touches /home/erickfm on CI. */
export async function appendLabLog(fileName: string, line: string): Promise<void> {
	const base = developerLabPresent()
		? "/home/erickfm/D-SSD/personal/gs-lab/logs"
		: join(tmpdir(), "gentle-voice-ci-logs");
	try {
		await mkdir(base, { recursive: true });
		await appendFile(join(base, fileName), `${new Date().toISOString()} ${line}\n`);
	} catch {
		/* logging must never fail tests */
	}
}

export function portableHome(): string {
	return process.env.HOME?.trim() || homedir();
}
