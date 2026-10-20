/**
 * Ordered TTS queue with optional prefetch: synthesize unit N+1 while N plays.
 * Cancel drops pending synth+play; never reorders or duplicates.
 * Fragment lifecycle is recorded for lab diagnostics (unitId + dropReason).
 */

import type { AudioChunk } from "../contracts.ts";
import type { AssembledUnit } from "./sentence-assembler.ts";

export type StreamSpeakFragmentEvent =
	| { readonly type: "enqueue"; readonly unitId: string; readonly atMs: number }
	| { readonly type: "synth_start"; readonly unitId: string; readonly atMs: number }
	| { readonly type: "synth_done"; readonly unitId: string; readonly atMs: number }
	| { readonly type: "play_start"; readonly unitId: string; readonly atMs: number }
	| { readonly type: "play_done"; readonly unitId: string; readonly atMs: number }
	| {
		readonly type: "drop";
		readonly unitId: string;
		readonly atMs: number;
		readonly dropReason: string;
	}
	| { readonly type: "cancel"; readonly atMs: number; readonly pending: number };

export interface StreamSpeakMetrics {
	readonly streamStartedAtMs?: number;
	readonly firstDeltaAtMs?: number;
	readonly firstUnitAtMs?: number;
	readonly firstSynthStartedAtMs?: number;
	readonly firstSynthDoneAtMs?: number;
	readonly firstPlaybackAtMs?: number;
	readonly unitsEnqueued: number;
	readonly unitsPlayed: number;
	readonly unitsDropped: number;
	readonly prefetchStarts: number;
	readonly prefetchHits: number;
	/** Gaps between end of play(i) and start of play(i+1), ms. */
	readonly interPlayGapsMs: readonly number[];
	readonly blockedReason?: string;
	readonly mode: "idle" | "streaming" | "blocked" | "fallback" | "done";
	/** Ordered fragment lifecycle (capped). */
	readonly fragmentLog: readonly StreamSpeakFragmentEvent[];
}

/** Legacy: caller performs synth+play inside one function (no prefetch). */
export type StreamSpeakPlayFn = (unit: AssembledUnit, signal: AbortSignal) => Promise<void>;

export interface StreamSpeakPipeline {
	readonly synthesize: (
		unit: AssembledUnit,
		signal: AbortSignal,
	) => Promise<AudioChunk>;
	readonly play: (
		unit: AssembledUnit,
		audio: AudioChunk,
		signal: AbortSignal,
	) => Promise<void>;
	/** Clips to keep synthesized ahead of the playhead (default 1). */
	readonly prefetchDepth?: number;
}

interface ReadyClip {
	readonly unit: AssembledUnit;
	readonly audio: AudioChunk;
}

const FRAGMENT_LOG_CAP = 64;

export class StreamSpeakQueue {
	#queue: AssembledUnit[] = [];
	#ready: ReadyClip[] = [];
	#pump: Promise<void> = Promise.resolve();
	#pumping = false;
	#epoch = 0;
	#aborted = false;
	#metrics: StreamSpeakMetrics = emptyMetrics();
	#now: () => number;
	#lastPlayEndedAtMs: number | undefined;
	#onFragment?: (event: StreamSpeakFragmentEvent) => void;

	constructor(
		now: () => number = () => Date.now(),
		onFragment?: (event: StreamSpeakFragmentEvent) => void,
	) {
		this.#now = now;
		this.#onFragment = onFragment;
	}

	get metrics(): StreamSpeakMetrics {
		return {
			...this.#metrics,
			interPlayGapsMs: [...this.#metrics.interPlayGapsMs],
			fragmentLog: [...this.#metrics.fragmentLog],
		};
	}

	get pendingCount(): number {
		return this.#queue.length + this.#ready.length;
	}

	get isBusy(): boolean {
		return this.#pumping || this.#queue.length > 0 || this.#ready.length > 0;
	}

	begin(): void {
		this.#epoch += 1;
		this.#aborted = false;
		this.#queue = [];
		this.#ready = [];
		this.#lastPlayEndedAtMs = undefined;
		this.#metrics = {
			...emptyMetrics(),
			streamStartedAtMs: this.#now(),
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
		this.clearPending("blocked");
	}

	markFallback(): void {
		this.#metrics = { ...this.#metrics, mode: "fallback" };
	}

	markDone(): void {
		this.#metrics = { ...this.#metrics, mode: "done" };
	}

	enqueue(units: readonly AssembledUnit[]): void {
		if (this.#aborted || this.#metrics.mode === "blocked") {
			for (const u of units) this.#drop(u.id, "enqueue_while_blocked_or_aborted");
			return;
		}
		if (units.length === 0) return;
		if (this.#metrics.firstUnitAtMs === undefined) {
			this.#metrics = { ...this.#metrics, firstUnitAtMs: this.#now() };
		}
		for (const u of units) {
			this.#queue.push(u);
			this.#emit({ type: "enqueue", unitId: u.id, atMs: this.#now() });
		}
		this.#metrics = {
			...this.#metrics,
			unitsEnqueued: this.#metrics.unitsEnqueued + units.length,
		};
	}

	clearPending(dropReason = "clear_pending"): void {
		const pending = [...this.#queue, ...this.#ready.map((c) => c.unit)];
		this.#queue = [];
		this.#ready = [];
		for (const u of pending) this.#drop(u.id, dropReason);
	}

	cancel(): void {
		this.#aborted = true;
		this.#epoch += 1;
		const pending = this.#queue.length + this.#ready.length;
		this.#emit({ type: "cancel", atMs: this.#now(), pending });
		this.clearPending("cancel");
	}

	/**
	 * Sequential synth+play in one callback (tests / fallback). No prefetch.
	 */
	kick(play: StreamSpeakPlayFn, signal: AbortSignal): Promise<void> {
		const epoch = this.#epoch;
		this.#pump = this.#pump.then(() => this.#drainSequential(play, signal, epoch));
		return this.#pump;
	}

	/**
	 * Prefetch pipeline: synthesize ahead while the previous clip plays.
	 */
	kickPipeline(pipeline: StreamSpeakPipeline, signal: AbortSignal): Promise<void> {
		const epoch = this.#epoch;
		this.#pump = this.#pump.then(() => this.#drainPrefetch(pipeline, signal, epoch));
		return this.#pump;
	}

	async idle(): Promise<void> {
		await this.#pump;
	}

	#emit(event: StreamSpeakFragmentEvent): void {
		const log = this.#metrics.fragmentLog;
		const next = log.length >= FRAGMENT_LOG_CAP
			? [...log.slice(log.length - FRAGMENT_LOG_CAP + 1), event]
			: [...log, event];
		this.#metrics = { ...this.#metrics, fragmentLog: next };
		try {
			this.#onFragment?.(event);
		} catch {
			/* diag must never break audio */
		}
	}

	#drop(unitId: string, dropReason: string): void {
		this.#metrics = {
			...this.#metrics,
			unitsDropped: this.#metrics.unitsDropped + 1,
		};
		this.#emit({ type: "drop", unitId, atMs: this.#now(), dropReason });
	}

	async #drainSequential(
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
				this.#emit({ type: "synth_start", unitId: unit.id, atMs: this.#now() });
				this.#emit({ type: "play_start", unitId: unit.id, atMs: this.#now() });
				try {
					await play(unit, signal);
					if (epoch !== this.#epoch || this.#aborted || signal.aborted) {
						this.#drop(unit.id, signal.aborted || this.#aborted ? "abort" : "epoch");
						break;
					}
					this.#emit({ type: "play_done", unitId: unit.id, atMs: this.#now() });
					this.#metrics = {
						...this.#metrics,
						unitsPlayed: this.#metrics.unitsPlayed + 1,
						...(this.#metrics.firstPlaybackAtMs === undefined
							? { firstPlaybackAtMs: this.#now() }
							: {}),
					};
				} catch (error) {
					const reason = dropReasonFromError(error, signal, epoch, this.#epoch, this.#aborted);
					this.#drop(unit.id, reason);
					if (reason === "abort" || reason === "epoch") break;
				}
			}
		} finally {
			this.#pumping = false;
		}
	}

	async #drainPrefetch(
		pipeline: StreamSpeakPipeline,
		signal: AbortSignal,
		epoch: number,
	): Promise<void> {
		if (this.#pumping) return;
		this.#pumping = true;
		const depth = Math.max(1, pipeline.prefetchDepth ?? 1);
		try {
			while (!this.#aborted && epoch === this.#epoch && !signal.aborted) {
				await this.#synthUntil(pipeline, signal, epoch, depth);
				if (this.#aborted || epoch !== this.#epoch || signal.aborted) break;

				const clip = this.#ready.shift();
				if (!clip) {
					if (this.#queue.length === 0) break;
					continue;
				}

				// Overlap: start filling the next ready slot while we play.
				const prefetchPromise = this.#synthUntil(pipeline, signal, epoch, depth);

				if (this.#lastPlayEndedAtMs !== undefined) {
					const gap = Math.max(0, this.#now() - this.#lastPlayEndedAtMs);
					this.#metrics = {
						...this.#metrics,
						interPlayGapsMs: [...this.#metrics.interPlayGapsMs, gap],
						prefetchHits: this.#metrics.prefetchHits + (gap < 100 ? 1 : 0),
					};
				}
				if (this.#metrics.firstPlaybackAtMs === undefined) {
					this.#metrics = { ...this.#metrics, firstPlaybackAtMs: this.#now() };
				}

				this.#emit({ type: "play_start", unitId: clip.unit.id, atMs: this.#now() });
				try {
					await pipeline.play(clip.unit, clip.audio, signal);
					if (epoch !== this.#epoch || this.#aborted || signal.aborted) {
						this.#drop(
							clip.unit.id,
							signal.aborted || this.#aborted ? "abort_during_play" : "epoch_during_play",
						);
						await prefetchPromise.catch(() => {});
						break;
					}
					this.#emit({ type: "play_done", unitId: clip.unit.id, atMs: this.#now() });
					this.#lastPlayEndedAtMs = this.#now();
					this.#metrics = {
						...this.#metrics,
						unitsPlayed: this.#metrics.unitsPlayed + 1,
					};
				} catch (error) {
					const reason = dropReasonFromError(error, signal, epoch, this.#epoch, this.#aborted);
					this.#drop(clip.unit.id, `play:${reason}`);
					await prefetchPromise.catch(() => {});
					if (reason === "abort" || reason === "epoch") break;
					// Play failure must NOT skip ahead silently past the first unit:
					// re-throw after drop only when it was the first play (unitsPlayed===0).
					if (this.#metrics.unitsPlayed === 0) {
						this.#aborted = true;
						this.clearPending("first_play_failed");
						break;
					}
				}
				await prefetchPromise.catch(() => {});
			}
		} finally {
			this.#pumping = false;
		}
	}

	/**
	 * Synthesize from #queue into #ready until ready.length >= target or queue empty.
	 * One synth at a time (Piper is CPU-heavy); still overlaps with playback.
	 */
	async #synthUntil(
		pipeline: StreamSpeakPipeline,
		signal: AbortSignal,
		epoch: number,
		targetReady: number,
	): Promise<void> {
		while (
			!this.#aborted
			&& epoch === this.#epoch
			&& !signal.aborted
			&& this.#ready.length < targetReady
			&& this.#queue.length > 0
		) {
			const unit = this.#queue.shift();
			if (!unit) break;
			if (this.#metrics.firstSynthStartedAtMs === undefined) {
				this.#metrics = {
					...this.#metrics,
					firstSynthStartedAtMs: this.#now(),
				};
			}
			this.#metrics = {
				...this.#metrics,
				prefetchStarts: this.#metrics.prefetchStarts + 1,
			};
			this.#emit({ type: "synth_start", unitId: unit.id, atMs: this.#now() });
			try {
				const audio = await pipeline.synthesize(unit, signal);
				if (this.#aborted || epoch !== this.#epoch || signal.aborted) {
					this.#drop(
						unit.id,
						signal.aborted || this.#aborted ? "abort_during_synth" : "epoch_during_synth",
					);
					return;
				}
				if (!audio?.bytes || audio.bytes.byteLength === 0) {
					this.#drop(unit.id, "empty_audio");
					if (this.#metrics.unitsPlayed === 0 && this.#ready.length === 0) {
						// First clip empty → stop; caller must not jump to later units.
						this.#aborted = true;
						this.clearPending("first_synth_empty");
						return;
					}
					continue;
				}
				if (this.#metrics.firstSynthDoneAtMs === undefined) {
					this.#metrics = { ...this.#metrics, firstSynthDoneAtMs: this.#now() };
				}
				this.#emit({ type: "synth_done", unitId: unit.id, atMs: this.#now() });
				this.#ready.push({ unit, audio });
			} catch (error) {
				const reason = dropReasonFromError(error, signal, epoch, this.#epoch, this.#aborted);
				this.#drop(unit.id, `synth:${reason}`);
				if (reason === "abort" || reason === "epoch") return;
				if (this.#metrics.unitsPlayed === 0 && this.#ready.length === 0) {
					this.#aborted = true;
					this.clearPending("first_synth_failed");
					return;
				}
			}
		}
	}
}

function dropReasonFromError(
	error: unknown,
	signal: AbortSignal,
	epoch: number,
	currentEpoch: number,
	aborted: boolean,
): string {
	if (signal.aborted || aborted) return "abort";
	if (epoch !== currentEpoch) return "epoch";
	if (error && typeof error === "object" && "name" in error && (error as { name: string }).name === "AbortError") {
		return "abort";
	}
	if (error instanceof Error && error.message) return error.message.slice(0, 80);
	return "error";
}

function emptyMetrics(): StreamSpeakMetrics {
	return {
		unitsEnqueued: 0,
		unitsPlayed: 0,
		unitsDropped: 0,
		prefetchStarts: 0,
		prefetchHits: 0,
		interPlayGapsMs: [],
		fragmentLog: [],
		mode: "idle",
	};
}
