import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, truncateSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createVibeVoiceTtsAdapter, VibeVoiceWorkerStartupError, VIBEVOICE_MODEL_SAFETENSORS_BYTES } from "../lib/adapters/vibevoice-tts.ts";

for (const structured of [true, false]) {
	test(`worker boot reports ${structured ? "structured load error" : "stderr tail and exit status"}`, async t => {
		const home = mkdtempSync(join(tmpdir(), "gv-worker-startup-"));
		for (const dir of [".venv/bin", "models/VibeVoice-Realtime-0.5B", "voices", "code"]) mkdirSync(join(home, dir), { recursive: true });
		writeFileSync(join(home, ".venv/bin/python"), "stub", { mode: 0o755 });
		writeFileSync(join(home, "voices/sp-Spk0_woman.pt"), "stub");
		writeFileSync(join(home, "INSTALL_PENDING.json"), JSON.stringify({ authorized: true, status: "installed" }));
		const weights = join(home, "models/VibeVoice-Realtime-0.5B/model.safetensors");
		for (const file of ["config.json", "preprocessor_config.json"]) writeFileSync(join(home, "models/VibeVoice-Realtime-0.5B", file), "{}");
		writeFileSync(weights, "");
		truncateSync(weights, VIBEVOICE_MODEL_SAFETENSORS_BYTES);
		const child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
			kill() { this.killed = true; return true; },
		});
		t.mock.method(childProcess, "spawn", () => {
			setImmediate(() => {
				child.stderr.write("FutureWarning: deprecated cache\n" + "x".repeat(700) + "\nRuntimeError: actual failure");
				if (structured) child.stdout.write(JSON.stringify({ op: "error", req_id: null, error: "load_failed:RuntimeError: actual failure" }) + "\n");
				child.stdout.end();
				child.emit("exit", 1, null);
				child.emit("close", 1, null);
			});
			return child;
		});
		syncBuiltinESMExports();
		const adapter = createVibeVoiceTtsAdapter({ env: { HOME: home, GENTLE_VOICE_VIBEVOICE_HOME: home }, tmpDir: join(home, "tmp") });
		try {
			await assert.rejects(adapter.synthesize("Hola", { signal: new AbortController().signal }), error => {
				assert.ok(error instanceof VibeVoiceWorkerStartupError, String(error));
				assert.match(error.message, /actual failure/);
				if (structured) assert.match(error.message, /^load_failed:/);
				else assert.match(error.message, /code=1/);
				return true;
			});
		} finally {
			await adapter.dispose();
			t.mock.restoreAll();
			syncBuiltinESMExports();
			rmSync(home, { recursive: true, force: true });
		}
	});
}
