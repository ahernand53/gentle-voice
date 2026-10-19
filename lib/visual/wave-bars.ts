/**
 * Unicode wave bars from real amplitude levels (0..1).
 * No random animation — bars only move when levels are pushed.
 */

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

export interface WaveBarsOptions {
	readonly barCount?: number;
	/** EMA factor 0..1 — higher = snappier. */
	readonly smooth?: number;
	/** Terminal columns available for the wave line. */
	readonly maxWidth?: number;
}

export class WaveBarMeter {
	#bars: number[];
	#smooth: number;
	#maxWidth: number;
	#lastPushAt = 0;
	#speech = false;

	constructor(options: WaveBarsOptions = {}) {
		const count = Math.max(4, Math.min(48, options.barCount ?? 15));
		this.#bars = Array.from({ length: count }, () => 0);
		this.#smooth = clamp(options.smooth ?? 0.35, 0.05, 0.9);
		this.#maxWidth = Math.max(8, options.maxWidth ?? 48);
	}

	get barCount(): number {
		return this.#bars.length;
	}

	get speechDetected(): boolean {
		return this.#speech;
	}

	get lastPushAt(): number {
		return this.#lastPushAt;
	}

	resize(barCount: number): void {
		const n = Math.max(4, Math.min(48, barCount));
		if (n === this.#bars.length) return;
		const next = Array.from({ length: n }, (_, i) => this.#bars[i % this.#bars.length] ?? 0);
		this.#bars = next;
	}

	setMaxWidth(cols: number): void {
		this.#maxWidth = Math.max(8, cols);
		const fit = Math.max(4, Math.min(48, Math.floor(this.#maxWidth / 2)));
		this.resize(fit);
	}

	/** Push one display level 0..1 (already shaped). Spreads across bars with decay. */
	pushLevel(level: number, speech: boolean, nowMs = Date.now()): void {
		this.#lastPushAt = nowMs;
		this.#speech = speech;
		const target = clamp(level, 0, 1);
		const n = this.#bars.length;
		// Center-weighted pulse from real level — deterministic, not random.
		const center = (n - 1) / 2;
		for (let i = 0; i < n; i++) {
			const dist = Math.abs(i - center) / Math.max(center, 1);
			const local = target * (1 - dist * 0.55);
			const prev = this.#bars[i]!;
			this.#bars[i] = prev + (local - prev) * this.#smooth;
		}
	}

	/** Decay toward silence (call on quiet frames). */
	decay(factor = 0.82): void {
		for (let i = 0; i < this.#bars.length; i++) {
			this.#bars[i] = this.#bars[i]! * factor;
		}
		if (this.#bars.every((b) => b < 0.02)) this.#speech = false;
	}

	clear(): void {
		this.#bars.fill(0);
		this.#speech = false;
	}

	/** Render spaced Unicode blocks. */
	render(): string {
		return this.#bars
			.map((v) => {
				const idx = Math.min(BLOCKS.length - 1, Math.max(0, Math.floor(v * BLOCKS.length)));
				return BLOCKS[idx]!;
			})
			.join(" ");
	}

	/** Snapshot for tests. */
	levels(): readonly number[] {
		return [...this.#bars];
	}
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

export function barCountForTerminalColumns(cols: number): number {
	if (cols < 40) return 8;
	if (cols < 60) return 12;
	if (cols < 80) return 15;
	return 20;
}
