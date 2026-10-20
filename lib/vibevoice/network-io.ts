/**
 * Network adapter for a later authorized install.
 * Importing this module does not download or start a GPU process.
 * The voice command constructs it only when GENTLE_VOICE_VIBEVOICE_ALLOW_NETWORK=1.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { extractTarMember } from "./archive.ts";
import type { VibeVoiceArtifact } from "./manifest.ts";
import type { OnboardingIo } from "./onboarding.ts";

function assertNoPrivilege(command: string, args: readonly string[]): void {
	if (command === "sudo" || args.includes("sudo")) throw new Error("sudo_refused");
}

export function createNetworkOnboardingIo(): OnboardingIo {
	return {
		async fetch(artifact: VibeVoiceArtifact, destination: string, signal: AbortSignal): Promise<void> {
			await mkdir(dirname(destination), { recursive: true });
			const archive = artifact.origin.endsWith(".tar.gz");
			const landing = archive
				? join(dirname(destination), ".download-cache", `${createHash("sha256").update(artifact.origin).digest("hex")}.tgz`)
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
			if (archive) {
				await extractTarMember(landing, basename(artifact.relativePath), destination, signal);
				return;
			}
			await rename(landing, destination);
		},
		run(command: string, args: readonly string[], signal: AbortSignal): Promise<{ code: number }> {
			assertNoPrivilege(command, args);
			return new Promise((resolveRun, reject) => {
				const child = spawn(command, [...args], { shell: false, stdio: "ignore" });
				const onAbort = () => child.kill("SIGTERM");
				signal.addEventListener("abort", onAbort, { once: true });
				child.once("error", (error) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				});
				child.once("exit", (code) => {
					signal.removeEventListener("abort", onAbort);
					resolveRun({ code: code ?? 1 });
				});
			});
		},
	};
}
