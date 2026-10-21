/**
 * Integrity pins for a new VibeVoice engine.
 *
 * Hashes are of the validated files. They are not a promise that every
 * future upstream upload has the same bytes. A download that does not match
 * is rejected. INSTALL_PENDING.json is written only after these checks.
 */

export const VIBEVOICE_CODE_COMMIT = "16fb2cb1217c9934a886e1948ffb06120caa2df5";

export interface VibeVoiceArtifact {
	readonly id: "weights" | "model-config" | "model-preprocessor" | "spanish-voice" | "code-license" | "code-project";
	readonly relativePath: string;
	readonly bytes: number;
	readonly sha256: string;
	readonly origin: string;
	/** `repo` extracts the whole code archive. A member suffix picks one file inside it. */
	readonly layout?: "file" | "repo";
	readonly memberSuffix?: string;
}

const VIBEVOICE_CODE_ARCHIVE =
	`https://github.com/microsoft/VibeVoice/archive/${VIBEVOICE_CODE_COMMIT}.tar.gz`;

export const VIBEVOICE_ARTIFACTS: readonly VibeVoiceArtifact[] = [
	{
		id: "code-license",
		relativePath: "code/LICENSE",
		bytes: 1066,
		sha256: "98a96c38494df4963951e32b81ec4effebe4c8a812ab8d9e7d185d59e86fe2fc",
		origin: VIBEVOICE_CODE_ARCHIVE,
		layout: "repo",
	},
	{
		id: "code-project",
		relativePath: "code/pyproject.toml",
		bytes: 1195,
		sha256: "6887842e9e9c417541684b73b8db4d0c44fc9a7ce4cf0f49f333da1f376cd6f2",
		origin: VIBEVOICE_CODE_ARCHIVE,
		memberSuffix: "pyproject.toml",
	},
	{
		id: "spanish-voice",
		relativePath: "code/demo/voices/streaming_model/sp-Spk0_woman.pt",
		bytes: 4_243_906,
		sha256: "a8b2c54cfe9b46a711642a96cdcc49545140374ae769cc62cf89c593c38b13c0",
		origin: VIBEVOICE_CODE_ARCHIVE,
		memberSuffix: "demo/voices/streaming_model/sp-Spk0_woman.pt",
	},
	{
		id: "weights",
		relativePath: "models/VibeVoice-Realtime-0.5B/model.safetensors",
		bytes: 2_035_332_888,
		sha256: "7758b150b8139deb48ac1ff6f181f745c8fedd5511232fd974b3eb217d83b514",
		origin: "https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B/resolve/main/model.safetensors",
	},
	{
		id: "model-config",
		relativePath: "models/VibeVoice-Realtime-0.5B/config.json",
		bytes: 2117,
		sha256: "caee2691e790b04054bbe14a753b40149fa7c0c16fadb58d9adf5412343dcf57",
		origin: "https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B/resolve/main/config.json",
	},
	{
		id: "model-preprocessor",
		relativePath: "models/VibeVoice-Realtime-0.5B/preprocessor_config.json",
		bytes: 360,
		sha256: "ebf514b5d30a012e5ae00d9a19d01e735e35b27768c3926d980815db8fa742e5",
		origin: "https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B/resolve/main/preprocessor_config.json",
	},
];

export const VIBEVOICE_INTEGRITY_KIND = "gentle-voice.vibevoice-integrity" as const;
