/**
 * Extract one member from a tar archive into a destination we choose.
 * Members that climb out of the archive are ignored.
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";

function runTar(args: readonly string[], signal?: AbortSignal): Promise<{ code: number; stdout: string }> {
	return new Promise((resolveRun, reject) => {
		const child = spawn("tar", [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		const onAbort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.once("error", (error) => {
			signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.once("exit", (code) => {
			signal?.removeEventListener("abort", onAbort);
			resolveRun({ code: code ?? 1, stdout: Buffer.concat(chunks).toString("utf8") });
		});
	});
}

function safeMember(entry: string, memberBasename: string): boolean {
	if (entry.startsWith("/") || entry.includes("..")) return false;
	return basename(entry) === memberBasename;
}

export async function extractTarMember(
	archive: string,
	memberBasename: string,
	destination: string,
	signal?: AbortSignal,
): Promise<void> {
	const listed = await runTar(["-tzf", archive], signal);
	if (listed.code !== 0) throw new Error("archive_list_failed");
	const matches = listed.stdout.split(/\r?\n/).filter((entry) => safeMember(entry, memberBasename));
	if (matches.length !== 1) throw new Error(`archive_member_missing:${memberBasename}`);
	const member = matches[0]!;
	await mkdir(dirname(destination), { recursive: true });
	await new Promise<void>((resolveRun, reject) => {
		const child = spawn("tar", ["-xOf", archive, member], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
		const out = createWriteStream(destination, { mode: 0o600 });
		child.stdout.pipe(out);
		const onAbort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.once("error", (error) => {
			signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
		out.once("error", reject);
		child.once("exit", (code) => {
			signal?.removeEventListener("abort", onAbort);
			out.end(() => (code === 0 ? resolveRun() : reject(new Error("archive_extract_failed"))));
		});
	});
}
