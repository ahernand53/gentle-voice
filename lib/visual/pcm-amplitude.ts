/**
 * Real PCM amplitude helpers — no synthetic/random levels.
 * Operates on s16le mono/stereo interleaved samples.
 */

export interface AmplitudeSample {
	/** RMS normalized to ~0..1 (1.0 ≈ full-scale sine). */
	readonly rms: number;
	/** Peak absolute sample / 32768. */
	readonly peak: number;
	/** True when rms exceeds speech threshold. */
	readonly speech: boolean;
}

/** Extract PCM payload from WAV (returns raw view) or pass-through raw s16le. */
export function pcmBytesFromAudio(bytes: Uint8Array, format: "wav" | "raw" | string): Uint8Array {
	if (format === "wav" || (bytes.byteLength >= 44 && bytes[0] === 0x52 /* R */)) {
		// Find "data" chunk
		let i = 12;
		while (i + 8 <= bytes.byteLength) {
			const id = String.fromCharCode(bytes[i]!, bytes[i + 1]!, bytes[i + 2]!, bytes[i + 3]!);
			const size = bytes[i + 4]! | (bytes[i + 5]! << 8) | (bytes[i + 6]! << 16) | (bytes[i + 7]! << 24);
			if (id === "data") {
				const start = i + 8;
				const end = Math.min(start + size, bytes.byteLength);
				return bytes.subarray(start, end);
			}
			i += 8 + size + (size % 2);
		}
		// Fallback: skip 44-byte header
		return bytes.subarray(Math.min(44, bytes.byteLength));
	}
	return bytes;
}

/**
 * RMS + peak over an s16le buffer. Empty → silence.
 */
export function measurePcmS16le(
	pcm: Uint8Array,
	options?: { speechThreshold?: number; channels?: number },
): AmplitudeSample {
	const speechThreshold = options?.speechThreshold ?? 0.012;
	const channels = Math.max(1, options?.channels ?? 1);
	const sampleBytes = 2 * channels;
	const nFrames = Math.floor(pcm.byteLength / sampleBytes);
	if (nFrames <= 0) {
		return { rms: 0, peak: 0, speech: false };
	}
	const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
	let sumSq = 0;
	let peak = 0;
	for (let f = 0; f < nFrames; f++) {
		// Mix-down: average channels for this frame
		let acc = 0;
		for (let c = 0; c < channels; c++) {
			const s = view.getInt16((f * channels + c) * 2, true);
			acc += s;
			const a = Math.abs(s);
			if (a > peak) peak = a;
		}
		const mixed = acc / channels;
		sumSq += mixed * mixed;
	}
	const rms = Math.sqrt(sumSq / nFrames) / 32768;
	const peakN = peak / 32768;
	return {
		rms: clamp01(rms),
		peak: clamp01(peakN),
		speech: rms >= speechThreshold,
	};
}

/** Slice PCM for an estimated playback window (honest samples, wall-clock position). */
export function pcmWindowAtTime(
	pcm: Uint8Array,
	sampleRateHz: number,
	channels: number,
	timeSec: number,
	windowMs: number,
): Uint8Array {
	const frameBytes = 2 * Math.max(1, channels);
	const totalFrames = Math.floor(pcm.byteLength / frameBytes);
	if (totalFrames <= 0) return new Uint8Array(0);
	const startFrame = Math.max(0, Math.floor(timeSec * sampleRateHz));
	const winFrames = Math.max(1, Math.floor((windowMs / 1000) * sampleRateHz));
	const s = Math.min(startFrame, Math.max(0, totalFrames - 1));
	const e = Math.min(totalFrames, s + winFrames);
	return pcm.subarray(s * frameBytes, e * frameBytes);
}

export function clamp01(n: number): number {
	if (!Number.isFinite(n) || n <= 0) return 0;
	if (n >= 1) return 1;
	return n;
}

/** Soft knee so quiet speech still moves bars without blowing clipping. */
export function displayLevelFromRms(rms: number): number {
	const x = clamp01(rms);
	// sqrt curve: more resolution at low levels
	return Math.sqrt(x);
}
