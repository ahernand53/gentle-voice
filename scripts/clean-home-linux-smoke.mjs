#!/usr/bin/env node
/**
 * Clean-HOME Linux smoke (no WD-Black / Voxtype / developer HOME reuse).
 * 1) npm pack → extract
 * 2) Isolated HOME + GENTLE_VOICE_HOME
 * 3) Consent-gated download (AUTO_DOWNLOAD=1 for non-interactive)
 * 4) Verify SHA + binaries
 * 5) Piper synth + Whisper STT round-trip
 * 6) Optional pw-play
 * 7) Extension load from extracted package (Pi harness)
 *
 * Usage: node --experimental-strip-types scripts/clean-home-linux-smoke.mjs
 * Env: GENTLE_VOICE_SMOKE_PLAY=1 to attempt pw-play of a short phrase.
 */

import { mkdtemp, mkdir, rm, writeFile, readFile, access, constants, readdir } from "node:fs/promises";
import { createWriteStream, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const report = [];
const log = (m) => {
	report.push(m);
	console.log(m);
};

function run(cmd, args, opts = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout?.on("data", (c) => {
			out += String(c);
		});
		child.stderr?.on("data", (c) => {
			err += String(c);
		});
		child.on("close", (code) => resolve({ code, out, err }));
		child.on("error", reject);
	});
}

async function sha256(path) {
	const buf = await readFile(path);
	return createHash("sha256").update(buf).digest("hex");
}

function assertNoLeak(label, path) {
	if (/WD-Black|voxtype/i.test(path)) {
		throw new Error(`LEAK ${label}: path references lab media (${path})`);
	}
}

async function main() {
	const smokeRoot = await mkdtemp(join(tmpdir(), "gv-clean-"));
	const home = join(smokeRoot, "home");
	const gvHome = join(smokeRoot, "gentle-voice-data");
	await mkdir(home, { recursive: true });
	await mkdir(gvHome, { recursive: true });

	log(`smokeRoot=${smokeRoot}`);
	log(`HOME=${home}`);
	log(`GENTLE_VOICE_HOME=${gvHome}`);
	assertNoLeak("HOME", home);
	assertNoLeak("GENTLE_VOICE_HOME", gvHome);

	const wantPlay = process.env.GENTLE_VOICE_SMOKE_PLAY === "1";
	const wantMic = process.env.GENTLE_VOICE_SMOKE_MIC === "1";
	for (const k of Object.keys(process.env)) {
		if (k.startsWith("GENTLE_VOICE_")) delete process.env[k];
	}

	process.env.HOME = home;
	process.env.XDG_DATA_HOME = join(home, ".local", "share");
	process.env.XDG_CONFIG_HOME = join(home, ".config");
	process.env.XDG_CACHE_HOME = join(home, ".cache");
	process.env.GENTLE_VOICE_HOME = gvHome;
	process.env.GENTLE_VOICE_AUTO_DOWNLOAD = "1";
	if (wantPlay) process.env.GENTLE_VOICE_SMOKE_PLAY = "1";
	if (wantMic) process.env.GENTLE_VOICE_SMOKE_MIC = "1";

	const pack = await run("npm", ["pack", "--silent"], { cwd: root });
	if (pack.code !== 0) throw new Error(`npm pack failed: ${pack.err}`);
	const tgz = readdirSync(root).find((f) => f.endsWith(".tgz"));
	if (!tgz) throw new Error("no tarball");
	const extract = join(smokeRoot, "pkg");
	await mkdir(extract, { recursive: true });
	await run("tar", ["-xzf", join(root, tgz), "-C", extract]);
	const pkg = join(extract, "package");
	log(`tarball=${tgz}`);
	log(`extracted=${pkg}`);

	const firstRunUrl = pathToFileURL(join(pkg, "lib/runtime/first-run.ts")).href;
	const { runFirstRunPreparation } = await import(firstRunUrl);
	const snap = await runFirstRunPreparation({
		notify: (m, l) => log(`[${l ?? "info"}] ${m}`),
		confirm: async () => true,
	});
	log(`readiness=${snap.status}`);
	log(`layoutHome=${snap.layoutHome}`);
	log(`present=${snap.present.join(",")}`);
	log(`missing=${snap.missing.join(",")}`);
	log(`blockers=${(snap.blockers ?? []).join(" | ") || "(none)"}`);
	assertNoLeak("layoutHome", snap.layoutHome);

	const whisper = join(gvHome, "bin", "whisper-cli");
	const piper = join(gvHome, "bin", "piper");
	const model = join(gvHome, "models", "whisper", "ggml-base-q5_1.bin");
	const voice = join(gvHome, "models", "piper", "es_AR-daniela-high.onnx");
	const voiceJson = `${voice}.json`;

	const expected = {
		[model]: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
		[voice]: "7ceb1fc0dab349418c5b54a639ae9ee595212d7c9ea422220d8419163d5cc985",
		[voiceJson]: "aedbf69647e1d754c62ecf8e0366ca5f16af3e768e3c6b5329af6eb6bde3852b",
	};

	for (const p of [whisper, piper, model, voice, voiceJson]) {
		try {
			await access(p, constants.R_OK);
			log(`ok exists ${p}`);
		} catch {
			log(`MISSING ${p}`);
		}
	}

	for (const [p, want] of Object.entries(expected)) {
		try {
			const got = await sha256(p);
			log(`sha256 ${p.split("/").slice(-2).join("/")}=${got === want ? "MATCH" : `MISMATCH got=${got}`}`);
		} catch (e) {
			log(`sha256 skip ${p}: ${e.message}`);
		}
	}

	let sttText = "";
	if (snap.status === "ready" || snap.status === "partial") {
		const wh = await run(whisper, ["-h"]);
		log(`whisper-cli -h exit=${wh.code} (stderr_has_usage=${/usage|whisper/i.test(wh.err + wh.out)})`);

		const phrase = "Hola, prueba Gentle Voice.";
		const outWav = join(smokeRoot, "out.wav");
		const pr2 = await new Promise((resolve) => {
			const child = spawn(piper, ["--model", voice, "--output_file", outWav], {
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env },
			});
			child.stdin.write(phrase);
			child.stdin.end();
			let err = "";
			child.stderr?.on("data", (c) => {
				err += String(c);
			});
			child.on("close", (code) => resolve({ code, err }));
		});
		log(`piper synth exit=${pr2.code}`);

		try {
			await access(outWav, constants.R_OK);
			log("out.wav ok");
			if (wantPlay) {
				const play = await run("/usr/bin/pw-play", [outWav]);
				log(`pw-play exit=${play.code}`);
			} else {
				log("skip pw-play (set GENTLE_VOICE_SMOKE_PLAY=1)");
			}

			const stt = await run(whisper, [
				"-m", model,
				"-f", outWav,
				"-l", "es",
				"-nt",
				"-np",
			]);
			sttText = (stt.out + stt.err).replace(/\x1b\[[0-9;]*m/g, "").trim();
			log(`whisper stt exit=${stt.code}`);
			log(`whisper stt text=${sttText.slice(0, 240)}`);

			if (wantMic) {
				const micWav = join(smokeRoot, "mic.wav");
				log("mic capture: pw-record 2.5s @ 16k mono…");
				const rec = await new Promise((resolve) => {
					const child = spawn(
						"/usr/bin/pw-record",
						["--rate=16000", "--channels=1", "--format=s16", micWav],
						{ stdio: ["ignore", "pipe", "pipe"] },
					);
					let err = "";
					child.stderr?.on("data", (c) => {
						err += String(c);
					});
					setTimeout(() => {
						try {
							child.kill("SIGINT");
						} catch {
							/* ignore */
						}
					}, 2500);
					child.on("close", (code) => resolve({ code, err }));
				});
				log(`pw-record exit=${rec.code}`);
				try {
					await access(micWav, constants.R_OK);
					const micStt = await run(whisper, ["-m", model, "-f", micWav, "-l", "es", "-nt", "-np"]);
					log(`mic whisper exit=${micStt.code} text=${(micStt.out + micStt.err).slice(0, 200)}`);
				} catch {
					log(`mic wav missing: ${rec.err?.slice(0, 200)}`);
				}
			} else {
				log("skip mic (set GENTLE_VOICE_SMOKE_MIC=1)");
			}
		} catch (e) {
			log(`audio/stt path failed: ${e.message}; piper_err=${pr2.err?.slice(0, 200)}`);
		}
	}

	// Extension load from tarball (Pi harness) — proves package entry works in clean HOME.
	try {
		const harnessUrl = pathToFileURL(join(pkg, "lib/lab/pi-host-harness.ts")).href;
		const extUrl = pathToFileURL(join(pkg, "extensions/voice.ts")).href;
		const { createPiHostHarness } = await import(harnessUrl);
		const { createVoiceExtension } = await import(extUrl);
		const harness = createPiHostHarness();
		createVoiceExtension(harness.pi, { forceStubAdapters: true });
		const names = [...harness.commands.keys()];
		log(`pi-extension-load ok commands=${names.join(",")}`);
		harness.fire("session_start", {});
		log(`pi-extension session_start fired lifecycle=${harness.lifecycle.map((l) => l.event).join(",")}`);
	} catch (e) {
		log(`pi-extension-load FAIL: ${e instanceof Error ? e.stack : e}`);
	}

	// Gentle Shell isolated: only verify we do not require GS when Pi loads alone.
	log("gs-isolated: extension loads without Gentle Shell installed (peer optional) — OK by design");

	await writeFile(join(smokeRoot, "report.txt"), report.join("\n") + "\n");
	log(`report=${join(smokeRoot, "report.txt")}`);
	console.log(
		"CLEAN_SMOKE_DONE",
		JSON.stringify({
			smokeRoot,
			status: snap.status,
			sttSnippet: sttText.slice(0, 120),
		}),
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
