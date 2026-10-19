/**
 * Ordered TTS queue for incremental speak units.
 * Backpressure: at most one synth+play in flight; cancel drops pending.
 */

import type { AssembledUnit } from "./sentence-assembler.ts";

export interface StreamSpeakMetrics {
	readonly streamStartedAtMs?: number;
	readonly firstDeltaAtMs?: number;
	readonly firstUnitAtMs?: number;
	readonly firstSynthStartedAtMs?: number;
	readonly firstPlaybackAtMs?: number;
	readonly unitsEnqueued: number;
	readonly unitsPlayed: number;
	readonly unitsDropped: number;
	readonly blockedReason?: string;
	readonly mode: "idle" | "streaming" | "blocked" | "fallback" | "done";
}

export type StreamSpeakPlayFn = (unit: AssembledUnit, signal: AbortSignal) => Promise<void>;

export class StreamSpeakQueue {
	#queue: AssembledUnit[] = [];
	#pump: Promise<void> = Promise.resolve();
	#pumping = false;
	#epoch = 0;
	#aborted = false;
	#metrics: StreamSpeakMetrics = {
		unitsEnqueued: 0,
		unitsPlayed: 0,
		unitsDropped: 0,
		mode: "idle",
	};
	#now: () => number;

	constructor(now: () => number = () => Date.now()) {
		this.#now = now;
	}

	get metrics(): StreamSpeakMetrics {
		return { ...this.#metrics };
	}

	get pendingCount(): number {
		return this.#queue.length;
	}

	get isBusy(): boolean {
		return this.#pumping || this.#queue.length > 0;
	}

	begin(): void {
		this.#epoch += 1;
		this.#aborted = false;
		this.#queue = [];
		this.#metrics = {
			streamStartedAtMs: this.#now(),
			unitsEnqueued: 0,
			unitsPlayed: 0,
			unitsDropped: 0,
			mode: "streaming",
		};
	}

	markFirstDelta(): void {
		if (this.#metrics.firstDeltaAtMs === undefined) {
			this.#metrics = { ...this.#metrics, firstDeltaAtMs: this.#now() };
		}
	}

	markBlocked(reason: string): void {
		this.#metrics = {
			...this.#metrics,
			mode: "blocked",
			blockedReason: reason,
		};
		this.clearPending();
	}

	markFallback(): void {
		this.#metrics = { ...this.#metrics, mode: "fallback" };
	}

	markDone(): void {
		this.#metrics = { ...this.#metrics, mode: "done" };
	}

	enqueue(units: readonly AssembledUnit[]): void {
		if (this.#aborted || this.#metrics.mode === "blocked") {
			this.#metrics = {
				...this.#metrics,
				unitsDropped: this.#metrics.unitsDropped + units.length,
			};
			return;
		}
		if (units.length === 0) return;
		if (this.#metrics.firstUnitAtMs === undefined) {
			this.#metrics = { ...this.#metrics, firstUnitAtMs: this.#now() };
		}
		this.#queue.push(...units);
		this.#metrics = {
			...this.#metrics,
			unitsEnqueued: this.#metrics.unitsEnqueued + units.length,
		};
	}

	clearPending(): void {
		const n = this.#queue.length;
		this.#queue = [];
		if (n > 0) {
			this.#metrics = {
				...this.#metrics,
				unitsDropped: this.#metrics.unitsDropped + n,
			};
		}
	}

	cancel(): void {
		this.#aborted = true;
		this.#epoch += 1;
		this.clearPending();
	}

	/**
	 * Drain queue with a single in-flight play. Safe to call repeatedly.
	 * Resolves when the queue is empty for this epoch (or cancelled).
	 */
	kick(play: StreamSpeakPlayFn, signal: AbortSignal): Promise<void> {
		const epoch = this.#epoch;
		this.#pump = this.#pump.then(() => this.#drain(play, signal, epoch));
		return this.#pump;
	}

	/** Wait until current pump settles. */
	async idle(): Promise<void> {
		await this.#pump;
	}

	async #drain(
		play: StreamSpeakPlayFn,
		signal: AbortSignal,
		epoch: number,
	): Promise<void> {
		if (this.#pumping) return;
		this.#pumping = true;
		try {
			while (!this.#aborted && epoch === this.#epoch && !signal.aborted) {
				const unit = this.#queue.shift();
				if (!unit) break;
				if (this.#metrics.firstSynthStartedAtMs === undefined) {
					this.#metrics = {
						...this.#metrics,
						firstSynthStartedAtMs: this.#now(),
					};
				}
				try {
					await play(unit, signal);
					if (epoch !== this.#epoch || this.#aborted || signal.aborted) break;
					this.#metrics = {
						...this.#metrics,
						unitsPlayed: this.#metrics.unitsPlayed + 1,
						...(this.#metrics.firstPlaybackAtMs === undefined
							? { firstPlaybackAtMs: this.#now() }
							: {}),
					};
				} catch {
					if (epoch !== this.#epoch || signal.aborted) break;
					this.#metrics = {
						...this.#metrics,
						unitsDropped: this.#metrics.unitsDropped + 1,
					};
				}
			}
		} finally {
			this.#pumping = false;
		}
	}
}
