/**
 * Barge-in gate. This is not acoustic echo cancellation.
 *
 * Mic RMS and the WAV's digital RMS are different domains. Comparing them
 * (mic must beat 2.2× the file) rejects normal speech even on headphones,
 * because the file is loud and the mic is not.
 *
 * The reference is the mic's own floor: it falls quickly on quiet frames and
 * rises slowly. A candidate must stay above max(absolute floor, floor × ratio)
 * for minVoicedMs. Constant speaker bleed sits on the floor and does not confirm.
 */

export interface BargeGateOptions {
	readonly minVoicedMs?: number;
	/** Absolute mic RMS floor (0–1). */
	readonly micFloor?: number;
	/** Mic must exceed the learned floor by this multiple. */
	readonly floorRatio?: number;
	/** Allowed dip without resetting the voiced run. */
	readonly dipMs?: number;
	/** How fast the floor may rise toward louder mic frames (0–1). */
	readonly floorRise?: number;
}

export interface BargeFrame {
	readonly atMs: number;
	readonly micRms: number;
	/** Digital playback window. Logged by the session. Not a mic-scale reference. */
	readonly playbackRms: number;
}

export interface BargeGateDecision {
	readonly confirmed: boolean;
	readonly reason: "below_floor" | "echo_like" | "building" | "confirmed" | "already";
	readonly echoFloor: number;
	/** Start of the current voiced candidate, ms from the first pushed frame clock. */
	readonly runStartMs?: number;
}

const DEFAULTS = {
	minVoicedMs: 480,
	micFloor: 0.018,
	floorRatio: 1.85,
	dipMs: 90,
	floorRise: 0.04,
} as const;

export function rmsS16le(pcm: Uint8Array, channels = 1): number {
	const frameBytes = 2 * Math.max(1, channels);
	const frames = Math.floor(pcm.byteLength / frameBytes);
	if (frames <= 0) return 0;
	let sumSq = 0;
	for (let f = 0; f < frames; f++) {
		let acc = 0;
		for (let c = 0; c < channels; c++) {
			const o = (f * channels + c) * 2;
			const v = pcm[o]! | (pcm[o + 1]! << 8);
			const signed = v > 32767 ? v - 65536 : v;
			acc += signed;
		}
		const mixed = acc / channels;
		sumSq += mixed * mixed;
	}
	return Math.sqrt(sumSq / frames) / 32768;
}

export function createBargeGate(options: BargeGateOptions = {}) {
	const minVoicedMs = options.minVoicedMs ?? DEFAULTS.minVoicedMs;
	const micFloor = options.micFloor ?? DEFAULTS.micFloor;
	const floorRatio = options.floorRatio ?? DEFAULTS.floorRatio;
	const dipMs = options.dipMs ?? DEFAULTS.dipMs;
	const floorRise = options.floorRise ?? DEFAULTS.floorRise;

	let confirmed = false;
	let runStart: number | undefined;
	let lastPassAt: number | undefined;
	let echoFloor = Number.POSITIVE_INFINITY;

	const learnFloor = (micRms: number): void => {
		if (!Number.isFinite(echoFloor)) {
			echoFloor = micRms;
			return;
		}
		if (micRms < echoFloor) {
			echoFloor = micRms;
			return;
		}
		echoFloor += (micRms - echoFloor) * floorRise;
	};

	return {
		get confirmed() {
			return confirmed;
		},
		get echoFloor() {
			return Number.isFinite(echoFloor) ? echoFloor : 0;
		},
		get runStartMs(): number | undefined {
			return runStart;
		},
		push(frame: BargeFrame): BargeGateDecision {
			if (confirmed) {
				return {
					confirmed: true,
					reason: "already",
					echoFloor: this.echoFloor,
					...(runStart !== undefined ? { runStartMs: runStart } : {}),
				};
			}
			learnFloor(frame.micRms);
			const need = Math.max(micFloor, echoFloor * floorRatio);
			const pass = frame.micRms >= need;
			const floorNow = this.echoFloor;
			if (!pass) {
				if (lastPassAt !== undefined && frame.atMs - lastPassAt <= dipMs && runStart !== undefined) {
					return {
						confirmed: false,
						reason: "building",
						echoFloor: floorNow,
						...(runStart !== undefined ? { runStartMs: runStart } : {}),
					};
				}
				runStart = undefined;
				lastPassAt = undefined;
				return {
					confirmed: false,
					reason: frame.micRms < micFloor ? "below_floor" : "echo_like",
					echoFloor: floorNow,
				};
			}
			lastPassAt = frame.atMs;
			if (runStart === undefined) runStart = frame.atMs;
			if (frame.atMs - runStart >= minVoicedMs) {
				confirmed = true;
				return { confirmed: true, reason: "confirmed", echoFloor: floorNow, runStartMs: runStart };
			}
			return { confirmed: false, reason: "building", echoFloor: floorNow, runStartMs: runStart };
		},
	};
}
