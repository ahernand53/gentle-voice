/**
 * Network adapter for a later authorized install.
 * Importing this module does not download or start a GPU process.
 * The voice command constructs it only when GENTLE_VOICE_VIBEVOICE_ALLOW_NETWORK=1.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { extractRepoArchive, extractTarMember } from "./archive.ts";
import type { VibeVoiceArtifact } from "./manifest.ts";
import type { OnboardingIo } from "./onboarding.ts";

function engineRoot(destination: string, relativePath: string): string {
	const dest = resolve(destination);
	const rel = relativePath.split("/").join(sep);
	if (rel && dest.endsWith(rel)) {
		const root = dest.slice(0, dest.length - rel.length).replace(new RegExp(`${sep}$`), "");
		if (root) return root;
	}
	return dirname(dest);
}

function assertNoPrivilege(command: string, args: readonly string[]): void {
	if (command === "sudo" || args.includes("sudo")) throw new Error("sudo_refused");
}

function runChild(
	command: string,
	args: readonly string[],
	signal: AbortSignal,
	env?: NodeJS.ProcessEnv,
): Promise<{ code: number; detail?: string }> {
	assertNoPrivilege(command, args);
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, [...args], {
			shell: false,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			...(env ? { env } : {}),
		});
		let detail = "";
		const keepTail = (chunk: Buffer): void => {
			detail = (detail + chunk.toString("utf8")).slice(-1500);
		};
		child.stdout?.on("data", keepTail);
		child.stderr?.on("data", keepTail);
		let escalate: ReturnType<typeof setTimeout> | undefined;
		const stopGroup = (): void => {
			if (!child.pid) return;
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				child.kill("SIGTERM");
			}
			escalate = setTimeout(() => {
				if (!child.pid) return;
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					/* the process group is already gone */
				}
			}, 5000);
			escalate.unref();
		};
		if (signal.aborted) stopGroup();
		else signal.addEventListener("abort", stopGroup, { once: true });
		child.once("error", (error) => {
			if (escalate) clearTimeout(escalate);
			signal.removeEventListener("abort", stopGroup);
			reject(error);
		});
		child.once("exit", (code) => {
			if (escalate) clearTimeout(escalate);
			signal.removeEventListener("abort", stopGroup);
			if (signal.aborted) {
				reject(new Error("cancelled"));
				return;
			}
			const tail = detail.trim();
			resolveRun(tail ? { code: code ?? 1, detail: tail } : { code: code ?? 1 });
		});
	});
}

export function createNetworkOnboardingIo(): OnboardingIo {
	return {
		async fetch(artifact: VibeVoiceArtifact, destination: string, signal: AbortSignal): Promise<void> {
			await mkdir(dirname(destination), { recursive: true });
			const archive = artifact.origin.endsWith(".tar.gz");
			const root = engineRoot(destination, artifact.relativePath);
			const landing = archive
				? join(root, ".download-cache", `${createHash("sha256").update(artifact.origin).digest("hex")}.tgz`)
				: `${destination}.download`;
			let reuse = false;
			if (archive) {
				try {
					reuse = (await stat(landing)).size > 0;
				} catch {
					reuse = false;
				}
			}
			if (!reuse) {
				await mkdir(dirname(landing), { recursive: true });
				const response = await fetch(artifact.origin, { signal });
				if (!response.ok || !response.body) throw new Error(`download_failed:${artifact.id}`);
				const stream = createWriteStream(landing, { mode: 0o600 });
				try {
					const reader = response.body.getReader();
					for (;;) {
						const step = await reader.read();
						if (step.done) break;
						if (signal.aborted) throw new Error("cancelled");
						await new Promise<void>((resolveWrite, reject) => {
							stream.write(Buffer.from(step.value), (error) => (error ? reject(error) : resolveWrite()));
						});
					}
				} finally {
					await new Promise<void>((resolveClose) => stream.end(resolveClose));
				}
			}
			if (archive && artifact.layout === "repo") {
				await extractRepoArchive(landing, dirname(destination), signal);
				return;
			}
			if (archive) {
				const name = artifact.relativePath.split("/").pop() ?? artifact.relativePath;
				await extractTarMember(
					landing,
					artifact.memberSuffix ? { basename: name, pathSuffix: artifact.memberSuffix } : name,
					destination,
					signal,
				);
				return;
			}
			await rename(landing, destination);
		},
		run(command: string, args: readonly string[], signal: AbortSignal): Promise<{ code: number; detail?: string }> {
			return runChild(command, args, signal);
		},
		probeWorker(python: string, workerScript: string, home: string, signal: AbortSignal) {
			return runChild(python, [workerScript], signal, {
				...process.env,
				GENTLE_VOICE_VIBEVOICE_HOME: home,
				GENTLE_VOICE_VIBEVOICE_PROBE: "synthesize",
				HF_HOME: join(home, "cache", "huggingface"),
				TRANSFORMERS_CACHE: join(home, "cache", "huggingface"),
				TORCH_HOME: join(home, "cache", "torch"),
			});
		},
	};
}
