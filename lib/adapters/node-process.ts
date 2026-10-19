/**
 * Node child_process helpers — cancellable, no Gentle Shell coupling.
 * Not used by the default extension path in phase 1C (stubs / dry-run).
 */

import { spawn } from "node:child_process";
import type { CancellableProcess, ProcessSupervisor } from "../contracts.ts";
import { onAbort } from "../process-cancel.ts";

export function createNodeProcessSupervisor(): ProcessSupervisor {
	return {
		spawn(command, args, options = {}) {
			const child = spawn(command, [...args], {
				env: options.env ?? process.env,
				cwd: options.cwd,
				stdio: ["ignore", "ignore", "ignore"],
			});

			const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
				child.once("exit", (code, signal) => resolve({ code, signal }));
				child.once("error", () => resolve({ code: 1, signal: null }));
			});

			const detach = onAbort(options.signal, () => {
				if (!child.killed) child.kill("SIGTERM");
			});
			void exit.finally(detach);

			const handle: CancellableProcess = {
				get pid() {
					return child.pid;
				},
				kill(signal: NodeJS.Signals = "SIGTERM") {
					if (child.killed) return false;
					return child.kill(signal);
				},
				exit,
			};
			return handle;
		},
	};
}

export interface SpawnCaptureResult {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: Buffer;
	readonly stderr: Buffer;
}

/** Spawn with stdin/stdout capture; honors AbortSignal and optional timeout. */
export async function runCaptured(
	command: string,
	args: readonly string[],
	options: {
		signal: AbortSignal;
		stdin?: string | Uint8Array;
		env?: NodeJS.ProcessEnv;
		cwd?: string;
		timeoutMs?: number;
	},
): Promise<SpawnCaptureResult> {
	const proc = spawn(command, [...args], {
		env: options.env ?? process.env,
		cwd: options.cwd,
		stdio: ["pipe", "pipe", "pipe"],
	});

	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	proc.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
	proc.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));

	const detach = onAbort(options.signal, () => {
		if (!proc.killed) proc.kill("SIGTERM");
	});

	let timer: ReturnType<typeof setTimeout> | undefined;
	if (options.timeoutMs && options.timeoutMs > 0) {
		timer = setTimeout(() => {
			if (!proc.killed) proc.kill("SIGTERM");
		}, options.timeoutMs);
	}

	try {
		if (options.stdin !== undefined && proc.stdin) {
			proc.stdin.end(typeof options.stdin === "string" ? options.stdin : Buffer.from(options.stdin));
		} else {
			proc.stdin?.end();
		}

		const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			proc.once("exit", (code, signal) => resolve({ code, signal }));
			proc.once("error", () => resolve({ code: 1, signal: null }));
		});

		return {
			code: exit.code,
			signal: exit.signal,
			stdout: Buffer.concat(stdoutChunks),
			stderr: Buffer.concat(stderrChunks),
		};
	} finally {
		detach();
		if (timer) clearTimeout(timer);
	}
}
