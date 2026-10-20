/**
 * Exact Whisper.cpp install consent payload for lab-local install.
 * Phase 1C: never downloads or extracts — presents requirements only.
 */

import { resolveLabWhisperPaths } from "../runtime/lab-paths.ts";

export type WhisperInstallArch = "x86_64" | "aarch64" | "win-x64" | "darwin-arm64" | "darwin-x64";

export interface WhisperBinaryCandidate {
	readonly releaseTag: string;
	readonly assetName: string;
	readonly url: string;
	readonly sizeBytes: number;
	readonly sha256: string;
	readonly arch: WhisperInstallArch;
	readonly platformNote: string;
}

/**
 * Official prebuilt from ggml-org/whisper.cpp (Ubuntu glibc builds).
 * Chosen over Arch `pacman -S whisper-cpp` because pacman is a **global** install
 * and is forbidden by Gentle Voice isolation rules.
 */
export const WHISPER_UBUNTU_X64_B5454: WhisperBinaryCandidate = Object.freeze({
	releaseTag: "b5454",
	assetName: "whisper-bin-ubuntu-x64.tar.gz",
	url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-ubuntu-x64.tar.gz",
	sizeBytes: 10_364_195,
	sha256: "a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c",
	arch: "x86_64",
	platformNote: "Linux x86_64 (glibc / Ubuntu-compatible; expected OK on CachyOS)",
});

export const WHISPER_UBUNTU_ARM64_B5454: WhisperBinaryCandidate = Object.freeze({
	releaseTag: "b5454",
	assetName: "whisper-bin-ubuntu-arm64.tar.gz",
	url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-ubuntu-arm64.tar.gz",
	sizeBytes: 4_608_377,
	sha256: "6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149",
	arch: "aarch64",
	platformNote: "Linux aarch64 — not the current lab machine",
});

export const WHISPER_WIN_X64_B5454: WhisperBinaryCandidate = Object.freeze({
	releaseTag: "b5454",
	assetName: "whisper-bin-x64.zip",
	url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip",
	sizeBytes: 8_928_640,
	sha256: "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb",
	arch: "win-x64",
	platformNote: "Windows x64 prebuilt — untested in this lab",
});

export interface WhisperInstallConsent {
	readonly method: "official_prebuilt_tarball";
	readonly rejectedGlobalMethods: readonly string[];
	readonly candidate: WhisperBinaryCandidate;
	readonly finalLocation: {
		readonly root: string;
		readonly binDir: string;
		readonly expectedCliNames: readonly string[];
	};
	readonly reuseModel: {
		readonly path: string;
		readonly action: "reference_only_no_copy";
		readonly magicExpected: readonly string[];
	};
	readonly dependencies: readonly string[];
	readonly integrity: {
		readonly algorithm: "sha256";
		readonly expected: string;
		readonly verifyCommand: string;
	};
	readonly postInstallVerify: readonly string[];
	readonly authorized: false;
	readonly summary: string;
}

export function buildWhisperInstallConsent(options?: {
	arch?: WhisperInstallArch;
	reuseModelPath?: string;
}): WhisperInstallConsent {
	const arch = options?.arch ?? "x86_64";
	const candidate =
		arch === "aarch64"
			? WHISPER_UBUNTU_ARM64_B5454
			: arch === "win-x64"
				? WHISPER_WIN_X64_B5454
				: WHISPER_UBUNTU_X64_B5454;

	const lab = resolveLabWhisperPaths();
	const installRoot = lab?.installRoot ?? "$GENTLE_VOICE_LAB_ROOT";
	const binDir = lab?.binDir ?? "$GENTLE_VOICE_LAB_ROOT/bin";
	const reusePath =
		options?.reuseModelPath
		?? lab?.model
		?? "$GENTLE_VOICE_WHISPER_MODEL or $GENTLE_VOICE_VOXTYPE_MODEL";

	return {
		method: "official_prebuilt_tarball",
		rejectedGlobalMethods: [
			"pacman -S whisper-cpp (system-wide /usr)",
			"paru/yay AUR global install",
			"modifying system STT package internals",
			"copying/moving third-party ggml models into the lab root",
		],
		candidate,
		finalLocation: {
			root: installRoot,
			binDir,
			expectedCliNames: ["whisper-cli", "main"],
		},
		reuseModel: {
			path: reusePath,
			action: "reference_only_no_copy",
			magicExpected: ["ggml", "lmgg"],
		},
		dependencies: [
			"glibc (system)",
			"libstdc++ / libgcc (system)",
			"No CUDA required for CPU ubuntu-x64 build",
			"ffmpeg not required for whisper-cli file transcription",
		],
		integrity: {
			algorithm: "sha256",
			expected: candidate.sha256,
			verifyCommand:
				`sha256sum -c <<<'${candidate.sha256}  ${candidate.assetName}'`,
		},
		postInstallVerify: [
			`${binDir}/whisper-cli --help`,
			`file ${binDir}/whisper-cli`,
			`# transcribe smoke (later phase): whisper-cli -m <ggml model> -f sample.wav -nt`,
		],
		authorized: false,
		summary:
			`Download ${candidate.assetName} (${candidate.releaseTag}, ${candidate.sizeBytes} bytes) ` +
			`into ${installRoot}/tmp, verify sha256 ${candidate.sha256}, ` +
			`extract CLI only into ${binDir}. Reuse an existing ggml model by path (env). ` +
			`NOT authorized to execute yet.`,
	};
}

export function formatWhisperInstallConsent(consent: WhisperInstallConsent): string {
	const c = consent.candidate;
	return [
		"=== Whisper.cpp install consent (NOT AUTHORIZED) ===",
		`Method: ${consent.method}`,
		`Origin: ${c.url}`,
		`Release: ${c.releaseTag}`,
		`Asset: ${c.assetName}`,
		`Size: ${c.sizeBytes} bytes (~${(c.sizeBytes / (1024 * 1024)).toFixed(1)} MiB)`,
		`Arch: ${c.arch} — ${c.platformNote}`,
		`SHA256: ${c.sha256}`,
		`Verify: ${consent.integrity.verifyCommand}`,
		`Final bin dir: ${consent.finalLocation.binDir}`,
		`Expected CLI names: ${consent.finalLocation.expectedCliNames.join(", ")}`,
		`Reuse model: ${consent.reuseModel.path} (${consent.reuseModel.action})`,
		`Deps: ${consent.dependencies.join("; ")}`,
		`Rejected: ${consent.rejectedGlobalMethods.join("; ")}`,
		`authorized=${consent.authorized}`,
		consent.summary,
	].join("\n");
}
