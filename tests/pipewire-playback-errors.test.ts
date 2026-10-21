import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { openPipewirePcmStream } from "../lib/adapters/pipewire-playback.ts";

for (const afterFinish of [false, true]) {
	test(`PCM process failure ${afterFinish ? "after finish" : "before first audio"} is observable`, async t => {
		const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stderr: new PassThrough(), killed: false, kill() { return true; } });
		t.mock.method(childProcess, "spawn", () => child);
		syncBuiltinESMExports();
		try {
			const player = openPipewirePcmStream({ signal: new AbortController().signal, sampleRateHz: 24000, channels: 1, format: "f32" });
			if (afterFinish) player.finish();
			child.stderr.write("output device unavailable");
			child.emit("exit", 1, null);
			await assert.rejects(player.done, /output device unavailable/);
			assert.throws(() => player.write(new Uint8Array(4)), /output device unavailable/);
		} finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
	});
}
