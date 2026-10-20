import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { nativeVibeVoiceStreamEnabled } from "../lib/adapters/vibevoice-pcm.ts";
import { extractTarMember } from "../lib/vibevoice/archive.ts";
import type { VibeVoiceArtifact } from "../lib/vibevoice/manifest.ts";
import {
	runVibeVoiceOnboarding,
	uninstallVibeVoiceEngine,
	type OnboardingIo,
} from "../lib/vibevoice/onboarding.ts";
import { planVibeVoiceInstall } from "../lib/vibevoice/install-plan.ts";
import {
	chooseTtsEngine,
	readTtsEnginePreference,
	resolvePreferredTts,
	writeTtsEnginePreference,
} from "../lib/vibevoice/tts-preference.ts";
import { resolveLabVoiceAdapters } from "../lib/adapters/lab-resolve.ts";

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

function fixtures(): { artifacts: VibeVoiceArtifact[]; bodies: Map<string, string> } {
	const specs = [
		artifact("weights", "models/VibeVoice-Realtime-0.5B/model.safetensors", "weights-ok"),
		artifact("spanish-voice", "voices/sp-Spk0_woman.pt", "voice-ok"),
		artifact("code-license", "code/LICENSE", "MIT"),
		artifact("code-project", "code/pyproject.toml", "[project]\nname='vibevoice'\n"),
	];
	return { artifacts: specs, bodies: new Map(specs.map((item) => [item.id, {
		weights: "weights-ok",
		"spanish-voice": "voice-ok",
		"code-license": "MIT",
		"code-project": "[project]\nname='vibevoice'\n",
	}[item.id]!])) };
}

function fakeIo(bodies: Map<string, string>, calls: string[], opts?: { fail?: string; corrupt?: string }): OnboardingIo {
	return {
		async fetch(item, destination) {
			calls.push(`fetch:${item.id}`);
			if (opts?.fail === item.id) throw new Error(`boom:${item.id}`);
			const body = opts?.corrupt === item.id ? "corrupt" : bodies.get(item.id)!;
			writeFileSync(destination, body);
		},
		async run(command, args) {
			calls.push([command, ...args].join(" "));
			if (command === "sudo" || args.includes("sudo")) return { code: 9 };
			if (args[0] === "-m" && args[1] === "venv") {
				const venv = args[2]!;
				mkdirSync(join(venv, "bin"), { recursive: true });
				writeFileSync(join(venv, "bin", "python"), "#!/bin/sh\nexit 0\n");
				writeFileSync(join(venv, "bin", "pip"), "#!/bin/sh\nexit 0\n");
			}
			if (command.endsWith("/.venv/bin/python") && args.includes("sys.prefix.endswith('.venv')")) return { code: 0 };
			if (command.endsWith("/.venv/bin/pip")) return { code: 0 };
			return { code: 0 };
		},
	};
}

function layout(): { root: string; target: string; voiceHome: string; outside: string } {
	const root = mkdtempSync(join(tmpdir(), "gv-vv-onboard-"));
	const target = join(root, "engine");
	const voiceHome = join(root, "voice-home");
	mkdirSync(voiceHome, { recursive: true });
	const outside = join(root, "outside.txt");
	writeFileSync(outside, "keep");
	return { root, target, voiceHome, outside };
}

test("hardware below the measured tree is blocked and 6 GB VRAM stays untested", () => {
	const blocked = planVibeVoiceInstall({
		targetDir: "/tmp/gv-plan",
		hardware: { nvidiaPresent: true, vramTotalMb: 8192, freeDiskMb: 9000 },
		alreadyInstalled: false,
	});
	assert.equal(blocked.status, "blocked");
	assert.equal(blocked.reasons.includes("disk_below_12gb"), true);
	const untested = planVibeVoiceInstall({
		targetDir: "/tmp/gv-plan",
		hardware: { nvidiaPresent: true, vramTotalMb: 6144, freeDiskMb: 20000 },
		alreadyInstalled: false,
	});
	assert.equal(untested.status, "needs_consent");
	assert.equal(untested.reasons.includes("vram_above_minimum_untested"), true);
});

test("declining consent keeps Piper and does not fetch", async () => {
	const { target, voiceHome, outside } = layout();
	const { artifacts, bodies } = fixtures();
	const calls: string[] = [];
	const result = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: false,
		allowNetwork: true,
		io: fakeIo(bodies, calls),
		artifacts,
	});
	assert.equal(result.status, "declined");
	assert.equal(result.engine, "piper");
	assert.equal(calls.some((call) => call.startsWith("fetch:")), false);
	assert.equal(readTtsEnginePreference(voiceHome), "piper");
	assert.equal(readFileSync(outside, "utf8"), "keep");
});

test("consent without network authorization does not download or mark the engine", async () => {
	const { target, voiceHome } = layout();
	const { artifacts, bodies } = fixtures();
	const calls: string[] = [];
	const result = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: false,
		io: fakeIo(bodies, calls),
		artifacts,
	});
	assert.equal(result.status, "network_not_authorized");
	assert.equal(calls.length, 0);
	assert.equal(readTtsEnginePreference(voiceHome), "unset");
});

test("simulated install verifies hashes, uses a private venv, and selects PCM", async () => {
	const { target, voiceHome, outside } = layout();
	writeFileSync(join(voiceHome, "..", "outside.txt"), "keep");
	const { artifacts, bodies } = fixtures();
	const calls: string[] = [];
	const result = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		io: fakeIo(bodies, calls),
		artifacts,
	});
	assert.equal(result.status, "installed");
	assert.equal(result.engine, "vibevoice");
	assert.equal(result.voice, "sp-Spk0_woman");
	assert.equal(result.playback, "pcm");
	assert.equal(nativeVibeVoiceStreamEnabled({ HOME: voiceHome, GENTLE_VOICE_HOME: voiceHome }, true), true);
	assert.equal(readTtsEnginePreference(voiceHome), "vibevoice");
	const marker = JSON.parse(readFileSync(join(target, "INSTALL_PENDING.json"), "utf8")) as { authorized?: boolean };
	assert.equal(marker.authorized, true);
	const receipt = JSON.parse(readFileSync(join(target, "integrity.json"), "utf8")) as { kind?: string };
	assert.equal(receipt.kind, "gentle-voice.vibevoice-integrity");
	assert.equal(calls.some((call) => call.startsWith("python3 -m venv ") && call.includes(target)), true);
	assert.equal(calls.some((call) => call.includes("/.venv/bin/pip install")), true);
	assert.equal(calls.some((call) => call.startsWith("sudo")), false);
	assert.equal(readFileSync(outside, "utf8"), "keep");
});

test("a corrupt download is rejected and a retry skips the verified file", async () => {
	const { target, voiceHome } = layout();
	const { artifacts, bodies } = fixtures();
	const calls: string[] = [];
	const corrupt = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		io: fakeIo(bodies, calls, { corrupt: "spanish-voice" }),
		artifacts,
	});
	assert.equal(corrupt.status, "corrupt");
	assert.equal(readTtsEnginePreference(voiceHome), "unset");
	const again = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		io: fakeIo(bodies, calls),
		artifacts,
	});
	assert.equal(again.status, "installed");
	assert.equal(calls.filter((call) => call === "fetch:weights").length, 1);
	assert.equal(calls.filter((call) => call === "fetch:spanish-voice").length, 2);
});

test("cancellation and a failed step leave the install unmarked", async () => {
	const { target, voiceHome } = layout();
	const { artifacts, bodies } = fixtures();
	const calls: string[] = [];
	const aborted = new AbortController();
	aborted.abort();
	const cancelled = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		signal: aborted.signal,
		io: fakeIo(bodies, calls),
		artifacts,
	});
	assert.equal(cancelled.status, "cancelled");
	assert.equal(calls.length, 0);
	const partial = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		io: fakeIo(bodies, calls, { fail: "spanish-voice" }),
		artifacts,
	});
	assert.equal(partial.status, "partial");
	assert.throws(() => readFileSync(join(target, "INSTALL_PENDING.json")));
});

test("an existing engine is reused and an explicit Piper choice is kept", async () => {
	const { target, voiceHome } = layout();
	const { artifacts, bodies } = fixtures();
	const calls: string[] = [];
	writeTtsEnginePreference(voiceHome, "piper");
	const kept = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: true,
		consent: true,
		allowNetwork: true,
		io: fakeIo(bodies, calls),
		artifacts,
	});
	assert.equal(kept.status, "kept_piper");
	assert.equal(calls.length, 0);
	writeTtsEnginePreference(voiceHome, "vibevoice");
	const reused = await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware: { nvidiaPresent: false, freeDiskMb: 1 },
		alreadyInstalled: true,
		consent: false,
		allowNetwork: false,
		artifacts,
	});
	assert.equal(reused.status, "reused");
	assert.equal(reused.engine, "vibevoice");
});

test("uninstall removes only the receipt-backed files", async () => {
	const { target, voiceHome } = layout();
	const { artifacts, bodies } = fixtures();
	await runVibeVoiceOnboarding({
		targetDir: target,
		voiceHome,
		hardware,
		alreadyInstalled: false,
		consent: true,
		allowNetwork: true,
		io: fakeIo(bodies, []),
		artifacts,
	});
	const foreign = join(target, "notes.txt");
	writeFileSync(foreign, "mine");
	const refused = await uninstallVibeVoiceEngine({ targetDir: target, artifacts });
	assert.equal(refused.deleted, false);
	const removed = await uninstallVibeVoiceEngine({
		targetDir: target,
		confirmToken: "UNINSTALL_VIBEVOICE",
		artifacts,
	});
	assert.equal(removed.deleted, true);
	assert.equal(readFileSync(foreign, "utf8"), "mine");
	assert.throws(() => readFileSync(join(target, "models/VibeVoice-Realtime-0.5B/model.safetensors")));
});

test("explicit Piper wins over a ready VibeVoice directory", () => {
	const voiceHome = mkdtempSync(join(tmpdir(), "gv-tts-pref-"));
	const prevHome = process.env.GENTLE_VOICE_VIBEVOICE_HOME;
	const prevVoice = process.env.GENTLE_VOICE_HOME;
	const prevTts = process.env.GENTLE_VOICE_TTS;
	try {
		process.env.GENTLE_VOICE_HOME = voiceHome;
		process.env.GENTLE_VOICE_TTS = "piper";
		const resolved = resolveLabVoiceAdapters({ forceStub: false });
		assert.notEqual(resolved.ttsKind, "vibevoice");
		assert.equal(chooseTtsEngine({ preference: "vibevoice", vibevoiceReady: false, kokoroReady: false }), "piper");
		assert.equal(chooseTtsEngine({ preference: "vibevoice", vibevoiceReady: true, kokoroReady: false }), "vibevoice");
		assert.equal(resolvePreferredTts({ GENTLE_VOICE_TTS: "piper", GENTLE_VOICE_HOME: voiceHome }), "piper");
	} finally {
		if (prevHome === undefined) delete process.env.GENTLE_VOICE_VIBEVOICE_HOME;
		else process.env.GENTLE_VOICE_VIBEVOICE_HOME = prevHome;
		if (prevVoice === undefined) delete process.env.GENTLE_VOICE_HOME;
		else process.env.GENTLE_VOICE_HOME = prevVoice;
		if (prevTts === undefined) delete process.env.GENTLE_VOICE_TTS;
		else process.env.GENTLE_VOICE_TTS = prevTts;
	}
});

test("tar extraction ignores members that climb out of the archive", async () => {
	const root = mkdtempSync(join(tmpdir(), "gv-tar-"));
	const src = join(root, "src");
	mkdirSync(src, { recursive: true });
	writeFileSync(join(src, "sp-Spk0_woman.pt"), "voice-bytes");
	const archive = join(root, "voices.tgz");
	const packed = spawnSync("tar", ["-czf", archive, "-C", root, "src/sp-Spk0_woman.pt"], { encoding: "utf8" });
	assert.equal(packed.status, 0, packed.stderr);
	const dest = join(root, "out", "sp-Spk0_woman.pt");
	await extractTarMember(archive, "sp-Spk0_woman.pt", dest);
	assert.equal(readFileSync(dest, "utf8"), "voice-bytes");
	const evil = join(root, "evil.tgz");
	const made = spawnSync("python3", ["-c", `
import tarfile
from pathlib import Path
root = Path(${JSON.stringify(root)})
payload = root / "payload"
payload.write_text("nope")
with tarfile.open(root / "evil.tgz", "w:gz") as tar:
    tar.add(payload, arcname="../passwd")
`], { encoding: "utf8" });
	assert.equal(made.status, 0, made.stderr);
	await assert.rejects(() => extractTarMember(evil, "passwd", join(root, "passwd")));
});
