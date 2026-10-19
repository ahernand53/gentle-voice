/** Minimal WAV helpers for STT (PCM s16le). */

export function isWavBuffer(bytes: Uint8Array): boolean {
	if (bytes.byteLength < 12) return false;
	const riff = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
	const wave = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
	return riff === "RIFF" && wave === "WAVE";
}

export function pcmS16leToWav(
	pcm: Uint8Array,
	sampleRateHz: number,
	channels: 1 | 2,
): Uint8Array {
	const dataSize = pcm.byteLength;
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);
	const out = new Uint8Array(buffer);
	const writeStr = (offset: number, s: string) => {
		for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
	};
	writeStr(0, "RIFF");
	view.setUint32(4, 36 + dataSize, true);
	writeStr(8, "WAVE");
	writeStr(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRateHz, true);
	view.setUint32(28, sampleRateHz * channels * 2, true);
	view.setUint16(32, channels * 2, true);
	view.setUint16(34, 16, true);
	writeStr(36, "data");
	view.setUint32(40, dataSize, true);
	out.set(pcm, 44);
	return out;
}
