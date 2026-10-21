/**
 * Name of the current default capture source. No audio is recorded.
 */

import { execFile } from "node:child_process";

export async function describeDefaultInput(exec: typeof execFile = execFile): Promise<string> {
	try {
		const stdout = await new Promise<string>((resolve, reject) => {
			exec("wpctl", ["inspect", "@DEFAULT_AUDIO_SOURCE@"], { timeout: 1500 }, (error, out) => {
				if (error) reject(error);
				else resolve(out);
			});
		});
		const named = stdout.match(/\*\s+(?:node\.)?description\s*=\s*"([^"]+)"/)
			?? stdout.match(/node\.description = "([^"]+)"/)
			?? stdout.match(/node\.nick = "([^"]+)"/);
		return named?.[1]?.trim() || "default source";
	} catch {
		return "default source";
	}
}
