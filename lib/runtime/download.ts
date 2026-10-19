/**
 * Consent-gated download + SHA-256 verify + extract into private data dir.
 * Uses system `tar` (Linux/macOS/Windows 10+). No sudo. No PATH mutation.
 */

import { createWriteStream } from "node:fs";
import { access, chmod, constants, copyFile, mkdir, rename, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { checksumMatches, sha256File } from "./checksum.ts";
import type { RuntimeArtifact } from "./artifacts.ts";
import type { GentleVoiceRuntimeLayout } from "./paths.ts";

export class DownloadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DownloadError";
	}
}

/** rename() fails with EXDEV across mount points — fall back to copy+unlink. */
async function moveFile(from: string, to: string): Promise<void> {
	try {
		await rename(from, to);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code !== "EXDEV") throw error;
		await copyFile(from, to);
		await rm(from, { force: true });
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function run(cmd: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let err = "";
		child.stderr?.on("data", (c) => {
			err += String(c);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new DownloadError(`${cmd} exited ${code}: ${err.slice(0, 400)}`));
		});
	});
}

export async function downloadToFile(url: string, dest: string): Promise<void> {
	await mkdir(dirname(dest), { recursive: true });
	const partial = `${dest}.partial`;
	await rm(partial, { force: true });
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok || !res.body) {
		throw new DownloadError(`HTTP ${res.status} for ${url}`);
	}
	const file = createWriteStream(partial);
	await pipeline(res.body as unknown as NodeJS.ReadableStream, file);
	await rename(partial, dest);
}

export async function verifySha256(path: string, expected: string): Promise<void> {
	const actual = await sha256File(path);
	if (!checksumMatches(actual, expected)) {
		throw new DownloadError(`SHA-256 mismatch for ${path}: got ${actual}, want ${expected}`);
	}
}

async function extractArchive(
	archivePath: string,
	format: "tar.gz" | "zip",
	destDir: string,
): Promise<void> {
	await mkdir(destDir, { recursive: true });
	if (format === "tar.gz") {
		await run("tar", ["-xzf", archivePath, "-C", destDir]);
		return;
	}
	await run("tar", ["-xf", archivePath, "-C", destDir]);
}

async function linkOrCopy(from: string, to: string): Promise<void> {
	await mkdir(dirname(to), { recursive: true });
	await rm(to, { force: true });
	try {
		if (process.platform === "win32") {
			await copyFile(from, to);
		} else {
			await symlink(from, to);
			await chmod(to, 0o755);
		}
	} catch {
		await copyFile(from, to);
		if (process.platform !== "win32") await chmod(to, 0o755);
	}
}

/**
 * Install one pinned artifact into the private layout.
 * Idempotent when the target already exists.
 */
export async function installArtifact(
	art: RuntimeArtifact,
	layout: GentleVoiceRuntimeLayout,
	onProgress?: (msg: string) => void,
): Promise<{ path: string }> {
	if (!art.url || !art.sha256) {
		throw new DownloadError(`Artifact ${art.id} is not pinned (missing url/sha256)`);
	}

	if (art.kind === "stt-model" || art.kind === "tts-voice" || art.kind === "tts-voice-config") {
		const finalPath = join(layout.dataDir, art.relativePath);
		if (await exists(finalPath)) {
			try {
				await verifySha256(finalPath, art.sha256);
				onProgress?.(`reuse ${art.id}`);
				return { path: finalPath };
			} catch {
				await rm(finalPath, { force: true });
			}
		}
		onProgress?.(`download ${art.id}`);
		const staging = join(layout.cacheDir, "downloads", `${art.id}.bin`);
		await downloadToFile(art.url, staging);
		await verifySha256(staging, art.sha256);
		await mkdir(dirname(finalPath), { recursive: true });
		await moveFile(staging, finalPath);
		return { path: finalPath };
	}

	const arch = art.archive;
	if (!arch) throw new DownloadError(`Archive artifact ${art.id} missing archive metadata`);

	const binOut = join(layout.dataDir, arch.installBinaryAs);
	const vendor = join(layout.dataDir, art.relativePath);
	if (await exists(binOut) && (await exists(vendor))) {
		onProgress?.(`reuse ${art.id}`);
		return { path: binOut };
	}

	onProgress?.(`download ${art.id}`);
	const staging = join(
		layout.cacheDir,
		"downloads",
		`${art.id}${arch.format === "zip" ? ".zip" : ".tgz"}`,
	);
	await downloadToFile(art.url, staging);
	await verifySha256(staging, art.sha256);

	await rm(vendor, { recursive: true, force: true });
	await mkdir(vendor, { recursive: true });
	await extractArchive(staging, arch.format, vendor);

	const member = join(vendor, ...arch.binaryMember.split("/"));
	if (!(await exists(member))) {
		throw new DownloadError(`Missing member ${arch.binaryMember} after extract of ${art.id}`);
	}
	await linkOrCopy(member, binOut);
	if (process.platform !== "win32") await chmod(member, 0o755);
	await rm(staging, { force: true });
	return { path: binOut };
}
