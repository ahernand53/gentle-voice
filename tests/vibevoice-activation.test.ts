import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { formatPiperActivation, formatVibeVoiceActivation, formatWhisperActivation } from "../lib/vibevoice/activation.ts";
import { driveVibeVoiceInstall } from "../lib/vibevoice/install-drive.ts";
import { resetVibeVoiceInstallState, vibeVoiceInstallSnapshot } from "../lib/vibevoice/install-session.ts";
import type { VibeVoiceArtifact } from "../lib/vibevoice/manifest.ts";
import type { OnboardingIo } from "../lib/vibevoice/onboarding.ts";
import { recommendTts } from "../lib/runtime/onboarding-choice.ts";
import { readTtsEnginePreference } from "../lib/vibevoice/tts-preference.ts";

const hardware = { nvidiaPresent: true, vramTotalMb: 8192, freeDiskMb: 20000 };

function artifact(id: VibeVoiceArtifact["id"], relativePath: string, body: string): VibeVoiceArtifact {
	const bytes = Buffer.from(body);
	return {
		id,
		relativePath,
		bytes: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		origin: `fixture://${id}`,
	};
}

function fixtureArtifacts(): { artifacts: VibeVoiceArtifact[]; io: OnboardingIo } {
	const artifacts = [
		artifact("weights", "models/model.safetensors", "weights"),
		artifact("spanish-voice", "voices/sp-Spk0_woman.pt", "voice"),
		artifact("code-license", "code/LICENSE", "MIT"),
		artifact("code-project", "code/pyproject.toml", "project"),
	];
	const bodies = new Map(artifacts.map((item) => [item.id, {
		weights: "weights",
		"spanish-voice": "voice",
		"code-license": "MIT",
		"code-project": "project",
	}[item.id]!]));
	return {
		artifacts,
		io: {
			async fetch(item, destination) {
				writeFileSync(destination, bodies.get(item.id)!);
			},
			async run(_command, args) {
				if (args[0] === "-m" && args[1] === "venv") {
					const venv = args[2]!;
					mkdirSync(join(venv, "bin"), { recursive: true });
					writeFileSync(join(venv, "bin", "python"), "#!/bin/sh\n");
					writeFileSync(join(venv, "bin", "pip"), "#!/bin/sh\n");
				}
				if (args.some((arg) => arg.includes("importlib.metadata"))) return { code: 0 };
				return { code: 0 };
			},
		},
	};
}

test("activation text requires an active engine", () => {
	const ready = formatVibeVoiceActivation({ voice: "sp-Spk0_woman", playback: "PCM", active: true });
	assert.match(ready, /VibeVoice installed successfully!/);
	assert.match(ready, /Engine: VibeVoice/);
	assert.match(ready, /Voice: sp-Spk0_woman/);
	assert.match(ready, /Playback: PCM/);
	assert.match(ready, /Status: Ready to use/);
	const idle = formatVibeVoiceActivation({
		voice: "sp-Spk0_woman",
		playback: "WAV",
		active: false,
		detail: "active engine: piper",
	});
	assert.equal(idle.includes("Ready to use"), false);
	assert.match(idle, /not active/);
	assert.equal(formatPiperActivation({ voice: "es_AR-daniela-high", active: false }).includes("Ready to use"), false);
	assert.match(formatPiperActivation({ voice: "es_AR-daniela-high", active: true }), /Engine: Piper/);
	assert.match(formatWhisperActivation(true), /Engine: Whisper/);
	assert.equal(formatWhisperActivation(false).includes("Ready to use"), false);
});

test("a finished install activates VibeVoice in the current session", async () => {
	resetVibeVoiceInstallState();
	const root = mkdtempSync(join(tmpdir(), "gv-vv-activate-"));
	const target = join(root, "engine");
	const voiceHome = join(root, "voice");
	mkdirSync(voiceHome, { recursive: true });
	const { artifacts: specs, io } = fixtureArtifacts();
	const notices: string[] = [];
	const widgets: string[][] = [];
	let activated = 0;
	try {
		await driveVibeVoiceInstall({
			notify: (message) => notices.push(message),
			setWidget: (_key, content) => {
				if (typeof content === "function") {
					const leaf = content(undefined, { fg: (_role: string, text: string) => text }) as { render: () => string[] };
					widgets.push(leaf.render());
				}
			},
			activateEngine: async () => {
				activated += 1;
				return { ttsId: "vibevoice", sttKind: "whisper", pcmSupported: true };
			},
		}, {
			targetDir: target,
			voiceHome,
			hardware,
			alreadyInstalled: false,
			consent: true,
			allowNetwork: true,
			io,
			artifacts: specs,
		});
		assert.equal(notices[0], "Installing VibeVoice...");
		assert.equal(widgets.length > 1, true);
		assert.match(widgets[0]?.join("\n") ?? "", /Installing VibeVoice/);
		const during = widgets.find((lines) => lines.some((line) => line.includes("Running"))
			&& lines.some((line) => line.includes("Completed") || line.includes("Reused")));
		assert.equal(Boolean(during), true, widgets.map((lines) => lines.join(" | ")).join("\n"));
		assert.match(notices.at(-1) ?? "", /Ready to use/);
		assert.equal(activated, 1);
		assert.equal(readTtsEnginePreference(voiceHome), "vibevoice");
		assert.equal(
			vibeVoiceInstallSnapshot().steps.find((step) => step.id === "activate")?.state,
			"completed",
		);
	} finally {
		resetVibeVoiceInstallState();
	}
});

test("activation does not claim ready when the session stays on another engine", async () => {
	resetVibeVoiceInstallState();
	const root = mkdtempSync(join(tmpdir(), "gv-vv-activate-idle-"));
	const voiceHome = join(root, "voice");
	mkdirSync(voiceHome, { recursive: true });
	const { artifacts: specs, io } = fixtureArtifacts();
	const notices: string[] = [];
	try {
		await driveVibeVoiceInstall({
			notify: (message) => notices.push(message),
			activateEngine: async () => ({ ttsId: "piper", sttKind: "whisper", pcmSupported: true }),
		}, {
			targetDir: join(root, "engine"),
			voiceHome,
			hardware,
			alreadyInstalled: false,
			consent: true,
			allowNetwork: true,
			io,
			artifacts: specs,
		});
		assert.equal((notices.at(-1) ?? "").includes("Ready to use"), false);
		assert.match(notices.at(-1) ?? "", /not active/);
		assert.equal(readTtsEnginePreference(voiceHome), "vibevoice");
		assert.equal(
			vibeVoiceInstallSnapshot().steps.find((step) => step.id === "activate")?.state,
			"failed",
		);
	} finally {
		resetVibeVoiceInstallState();
	}
});

test("an installed VibeVoice preference does not open the selector again", () => {
	const again = recommendTts({
		preference: "vibevoice",
		recommendationDeclined: false,
		compatibility: "supported",
		compatibilityReasons: [],
		piperRunnable: true,
		installState: "installed",
		installBlocked: false,
		blockReasons: [],
		location: "/var/lib/gentle-voice/vibevoice",
		consentBody: "terms",
	});
	assert.equal(again.action, "keep");
	assert.equal(again.options.length, 0);
});

test("the worker rejects a parent model directory before importing torch", () => {
	const root = mkdtempSync(join(tmpdir(), "gv-vv-parent-"));
	const modelDir = join(root, "models", "VibeVoice-Realtime-0.5B");
	mkdirSync(modelDir, { recursive: true });
	writeFileSync(join(modelDir, "model.safetensors"), "not-a-model");
	writeFileSync(join(modelDir, "config.json"), "{}");
	const worker = fileURLToPath(new URL("../scripts/vibevoice-lab-worker.py", import.meta.url));
	const started = Date.now();
	const result = spawnSync("python3", [worker], {
		env: {
			...process.env,
			GENTLE_VOICE_VIBEVOICE_HOME: root,
			GENTLE_VOICE_VIBEVOICE_MODEL: join(root, "models"),
		},
		encoding: "utf8",
		timeout: 3000,
	});
	assert.equal(result.status, 1);
	assert.match(result.stdout, /model_files_missing/);
	assert.equal(result.stdout.includes("pytorch_model.bin"), false);
	assert.ok(Date.now() - started < 2500);
});

test("the worker probe starts the process without loading the model", () => {
	const root = mkdtempSync(join(tmpdir(), "gv-vv-probe-"));
	const modelDir = join(root, "models", "VibeVoice-Realtime-0.5B");
	mkdirSync(modelDir, { recursive: true });
	writeFileSync(join(modelDir, "model.safetensors"), "not-a-model");
	const voiceDir = join(root, "code", "demo", "voices", "streaming_model");
	mkdirSync(voiceDir, { recursive: true });
	writeFileSync(join(voiceDir, "sp-Spk0_woman.pt"), "not-a-voice");
	const worker = fileURLToPath(new URL("../scripts/vibevoice-lab-worker.py", import.meta.url));
	const result = spawnSync("python3", [worker], {
		env: {
			...process.env,
			GENTLE_VOICE_VIBEVOICE_HOME: root,
			GENTLE_VOICE_VIBEVOICE_PROBE: "1",
		},
		encoding: "utf8",
		timeout: 5000,
	});
	assert.equal(result.status, 4);
	assert.match(result.stdout, /probe_deps_missing/);
	assert.match(result.stdout, /"loaded": false/);
	assert.equal(result.stdout.includes("load_failed"), false);
});

test("activation sources do not embed a personal or lab path", () => {
	for (const name of ["install-progress.ts", "activation.ts", "install-drive.ts"]) {
		const source = readFileSync(new URL(`../lib/vibevoice/${name}`, import.meta.url), "utf8");
		assert.equal(source.includes("/home/erickfm"), false);
		assert.equal(source.includes("WD-Black"), false);
		assert.equal(source.includes("gs-lab"), false);
	}
});
