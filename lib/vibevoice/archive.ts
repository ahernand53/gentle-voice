/**
 * Extract members from a tar archive into a destination we choose.
 * Absolute paths, ".." segments, and symlinks are rejected.
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

export interface ArchiveMemberQuery {
	readonly basename: string;
	/** Posix suffix inside the archive, for example `demo/voices/streaming_model/sp-Spk0_woman.pt`. */
	readonly pathSuffix?: string;
}

interface ListedMember {
	readonly type: string;
	readonly name: string;
}

function runTar(args: readonly string[], signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolveRun, reject) => {
		const child = spawn("tar", [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		const onAbort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.once("error", (error) => {
			signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.once("exit", (code) => {
			signal?.removeEventListener("abort", onAbort);
			resolveRun({
				code: code ?? 1,
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8"),
			});
		});
	});
}

const GNU_TAR_LISTING = /^([a-zA-Z-])\S*\s+\S+\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.+)$/;
const BSD_TAR_LISTING = /^([a-zA-Z-])\S*\s+\d+\s+\S+\s+\S+\s+\d+\s+[A-Z][a-z]{2}\s+\d{1,2}\s+(?:\d{2}:\d{2}(?:\s+\d{4})?|\d{4})\s+(.+)$/;

/** Verbose `tar -tv` rows. GNU date order and BSD libarchive order are both accepted. */
export function parseTarListing(stdout: string): ListedMember[] {
	const members: ListedMember[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const match = line.match(GNU_TAR_LISTING) ?? line.match(BSD_TAR_LISTING);
		if (!match) continue;
		const name = match[2]!.replace(/ -> .*$/, "");
		members.push({ type: match[1]!, name });
	}
	return members;
}

function safeName(entry: string): boolean {
	if (!entry || entry.startsWith("/") || entry.includes("\0")) return false;
	const parts = entry.split("/");
	return parts.every((part) => part !== ".." && part !== "");
}

function matchesQuery(entry: string, query: ArchiveMemberQuery): boolean {
	if (!safeName(entry) || entry.endsWith("/")) return false;
	if (basename(entry) !== query.basename) return false;
	if (!query.pathSuffix) return true;
	const suffix = query.pathSuffix.replace(/\\/g, "/").replace(/^\/+/, "");
	return entry === suffix || entry.endsWith(`/${suffix}`);
}

async function listMembers(archive: string, signal?: AbortSignal): Promise<ListedMember[]> {
	const listed = await runTar(["-tvzf", archive], signal);
	if (listed.code !== 0) throw new Error("archive_list_failed");
	const fromStdout = parseTarListing(listed.stdout);
	if (fromStdout.length > 0) return fromStdout;
	const fromStderr = parseTarListing(listed.stderr);
	if (fromStderr.length > 0) return fromStderr;
	if (listed.stdout.trim() || listed.stderr.trim()) throw new Error("archive_list_unparsed");
	return [];
}

function assertNoSymlink(member: ListedMember): void {
	if (member.type === "l" || member.type === "h") {
		throw new Error(`archive_symlink:${member.name}`);
	}
}

export async function extractTarMember(
	archive: string,
	member: string | ArchiveMemberQuery,
	destination: string,
	signal?: AbortSignal,
): Promise<void> {
	const query: ArchiveMemberQuery = typeof member === "string" ? { basename: member } : member;
	const listed = await listMembers(archive, signal);
	const matches = listed.filter((entry) => matchesQuery(entry.name, query));
	if (matches.length !== 1) {
		const present = listed
			.filter((entry) => !entry.name.endsWith("/"))
			.map((entry) => entry.name)
			.slice(0, 8);
		throw new Error(`archive_member_missing:${query.basename}:${present.join(",")}`);
	}
	const chosen = matches[0]!;
	assertNoSymlink(chosen);
	await mkdir(dirname(destination), { recursive: true });
	await new Promise<void>((resolveRun, reject) => {
		const child = spawn("tar", ["-xOf", archive, chosen.name], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
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
	const info = await lstat(destination);
	if (info.isSymbolicLink()) {
		await rm(destination, { force: true });
		throw new Error("archive_symlink");
	}
}

/** Extract a single top-level repo directory into `destinationDir`. */
export async function extractRepoArchive(
	archive: string,
	destinationDir: string,
	signal?: AbortSignal,
): Promise<void> {
	const listed = await listMembers(archive, signal);
	const names = listed.map((entry) => entry.name).filter((name) => name.length > 0);
	for (const entry of listed) {
		if (!safeName(entry.name.replace(/\/$/, ""))) throw new Error(`archive_path_rejected:${entry.name}`);
		if (entry.type === "l" || entry.type === "h") throw new Error(`archive_symlink:${entry.name}`);
	}
	const tops = new Set(names.map((name) => name.split("/")[0]!).filter(Boolean));
	if (tops.size !== 1) throw new Error("archive_root_ambiguous");
	await mkdir(destinationDir, { recursive: true });
	const extracted = await runTar(
		["-xzf", archive, "-C", destinationDir, "--strip-components=1", "--no-same-owner"],
		signal,
	);
	if (extracted.code !== 0) throw new Error("archive_extract_failed");
	await rejectSymlinks(destinationDir);
}

async function rejectSymlinks(root: string): Promise<void> {
	const { readdir } = await import("node:fs/promises");
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop()!;
		const entries = await readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			const path = join(current, entry.name);
			if (entry.isSymbolicLink()) {
				await rm(root, { recursive: true, force: true });
				throw new Error(`archive_symlink:${path.split(sep).pop()}`);
			}
			if (entry.isDirectory()) pending.push(path);
		}
	}
}
