import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createPipewireCaptureAdapter } from "../lib/adapters/pipewire-capture.ts";
import { createSileroVadFromRunner } from "../lib/vad/silero-vad.ts";

test("capture recovers from async Silero failure, ends the turn and releases the model", { timeout: 5000 }, async t => {
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
		kill() {
			this.killed = true;
			queueMicrotask(() => this.emit("close", 0));
			return true;
		},
	});
	t.mock.method(childProcess, "spawn", () => child);
	syncBuiltinESMExports();
	const abort = new AbortController();
	try {
		const vad = createSileroVadFromRunner({ runFrame: async () => { throw new Error("ORT failed"); } });
		let disposed = 0;
		vad.dispose = () => { disposed++; };
		const backends: string[] = [];
		let speechSeen = false;
		let finish!: () => void;
		const ended = new Promise<void>(resolve => { finish = resolve; });
		const capture = createPipewireCaptureAdapter({
			vadEngine: vad,
			vad: { silenceHangMs: 100, postRollMs: 20, maxIntraPauseMs: 40 },
			onVadResolved: info => backends.push(info.backend),
			onVadEnd: finish,
		});
		const session = await capture.start({ signal: abort.signal, onSpeechSeen: () => { speechSeen = true; } });
		const speech = Buffer.alloc(3200);
		for (let i = 0; i < 1600; i++) speech.writeInt16LE(6000, i * 2);
		child.stdout.write(speech);
		await new Promise(resolve => setImmediate(resolve));
		child.stdout.write(Buffer.alloc(6400));
		await ended;
		const audio = await session.stop(abort.signal);
		await Promise.resolve();
		assert.deepEqual(backends, ["silero", "energy"]);
		assert.equal(speechSeen, true);
		assert.equal(audio.captureMeta?.speechSeen, true);
		assert.equal(audio.captureMeta?.endReason, "vad");
		assert.equal(disposed, 1);
		assert.ok(audio.bytes.length > 44);
	} finally {
		abort.abort();
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
});
