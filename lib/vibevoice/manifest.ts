/**
 * Integrity pins for a new VibeVoice engine.
 *
 * Hashes are of the validated files. They are not a promise that every
 * future upstream upload has the same bytes. A download that does not match
 * is rejected. INSTALL_PENDING.json is written only after these checks.
 */

export const VIBEVOICE_CODE_COMMIT = "16fb2cb1217c9934a886e1948ffb06120caa2df5";

export interface VibeVoiceArtifact {
	readonly id: "weights" | "spanish-voice" | "code-license" | "code-project";
	readonly relativePath: string;
	readonly bytes: number;
	readonly sha256: string;
	readonly origin: string;
}

export const VIBEVOICE_ARTIFACTS: readonly VibeVoiceArtifact[] = [
	{
		id: "weights",
		relativePath: "models/VibeVoice-Realtime-0.5B/model.safetensors",
		bytes: 2_035_332_888,
		sha256: "7758b150b8139deb48ac1ff6f181f745c8fedd5511232fd974b3eb217d83b514",
		origin: "https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B/resolve/main/model.safetensors",
	},
	{
		id: "spanish-voice",
		relativePath: "voices/sp-Spk0_woman.pt",
		bytes: 4_243_906,
		sha256: "a8b2c54cfe9b46a711642a96cdcc49545140374ae769cc62cf89c593c38b13c0",
		origin: "https://github.com/user-attachments/files/24035884/experimental_voices_sp.tar.gz",
	},
	{
		id: "code-license",
		relativePath: "code/LICENSE",
		bytes: 1066,
		sha256: "98a96c38494df4963951e32b81ec4effebe4c8a812ab8d9e7d185d59e86fe2fc",
		origin: `https://github.com/microsoft/VibeVoice/archive/${VIBEVOICE_CODE_COMMIT}.tar.gz`,
	},
	{
		id: "code-project",
		relativePath: "code/pyproject.toml",
		bytes: 1195,
		sha256: "6887842e9e9c417541684b73b8db4d0c44fc9a7ce4cf0f49f333da1f376cd6f2",
		origin: `https://github.com/microsoft/VibeVoice/archive/${VIBEVOICE_CODE_COMMIT}.tar.gz`,
	},
];

export const VIBEVOICE_INTEGRITY_KIND = "gentle-voice.vibevoice-integrity" as const;
