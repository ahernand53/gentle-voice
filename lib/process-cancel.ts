/**
 * Safe cancellation helpers for future child-process adapters.
 * Phase 0: pure supervisor stubs — no real spawns in unit tests.
 */

import { EventEmitter } from "node:events";
import type { CancellableProcess, ProcessSupervisor } from "./contracts.ts";

export class AbortError extends Error {
	constructor(message = "Aborted") {
		super(message);
		this.name = "AbortError";
	}
}

export function isAbortError(error: unknown): boolean {
	if (error instanceof AbortError) return true;
	if (!error || typeof error !== "object") return false;
	return (error as { name?: string }).name === "AbortError";
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new AbortError();
}

/**
 * Swallow AbortError rejections so aborting a capture/play promise before any
 * awaiter cannot crash the host (uncaughtException / unhandledRejection).
 * Non-abort errors are re-queued so they still surface if nothing awaits.
 */
export function ignoreUnhandledAbort(promise: Promise<unknown>): void {
	void promise.catch((error) => {
		if (isAbortError(error)) return;
		queueMicrotask(() => {
			Promise.reject(error);
		});
	});
}

export function onAbort(signal: AbortSignal | undefined, fn: () => void): () => void {
	if (!signal) return () => {};
	if (signal.aborted) {
		fn();
		return () => {};
	}
	const handler = () => fn();
	signal.addEventListener("abort", handler, { once: true });
	return () => signal.removeEventListener("abort", handler);
}

/** In-memory fake process for tests and unavailable platforms. */
export function createFakeProcess(options?: {
	pid?: number;
	exitCode?: number;
	delayMs?: number;
	signal?: AbortSignal;
}): CancellableProcess {
	const emitter = new EventEmitter();
	let killed = false;
	let settled = false;
	const pid = options?.pid ?? 42_000;
	const delayMs = options?.delayMs ?? 0;

	const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		const finish = (code: number | null, sig: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			resolve({ code, signal: sig });
			emitter.emit("exit", code, sig);
		};
		const timer = setTimeout(() => finish(options?.exitCode ?? 0, null), delayMs);
		const stop = onAbort(options?.signal, () => {
			clearTimeout(timer);
			killed = true;
			finish(null, "SIGTERM");
		});
		emitter.once("kill", (sig: NodeJS.Signals) => {
			stop();
			clearTimeout(timer);
			killed = true;
			finish(null, sig);
		});
	});

	return {
		pid,
		kill(signal: NodeJS.Signals = "SIGTERM") {
			if (settled) return false;
			emitter.emit("kill", signal);
			return true;
		},
		exit,
		// expose for tests
		get killed() {
			return killed;
		},
	} as CancellableProcess & { readonly killed: boolean };
}

/**
 * Supervisor that refuses real spawns — phase 0 default.
 * Real adapters in later phases inject a Node child_process implementation.
 */
export function createNoopProcessSupervisor(): ProcessSupervisor {
	return {
		spawn(command: string) {
			throw new Error(`Process spawn disabled in phase 0 (refused: ${command})`);
		},
	};
}

/**
 * Track active cancellables and abort them together (session STOP / DISABLE).
 */
export class CancellationBag {
	#controllers = new Set<AbortController>();

	derive(parent?: AbortSignal): AbortSignal {
		const controller = new AbortController();
		this.#controllers.add(controller);
		const detachParent = onAbort(parent, () => controller.abort());
		const originalAbort = controller.abort.bind(controller);
		controller.abort = (reason?: unknown) => {
			detachParent();
			this.#controllers.delete(controller);
			originalAbort(reason);
		};
		onAbort(controller.signal, () => {
			detachParent();
			this.#controllers.delete(controller);
		});
		return controller.signal;
	}

	abortAll(): void {
		for (const controller of [...this.#controllers]) {
			controller.abort();
		}
		this.#controllers.clear();
	}

	get size(): number {
		return this.#controllers.size;
	}
}
