/**
 * Phase 1C — TUI lifecycle (harness), shortcut inventory, adapters, whisper consent.
 * Separates: simulated | real integration | pending human.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, access, constants } from "node:fs/promises";
import { createVoiceExtension, VOICE_WIDGET_KEY } from "../extensions/voice.ts";
import { createPiHostHarness } from "../lib/lab/pi-host-harness.ts";
import { collectShortcutConflictEvidence } from "../lib/lab/shortcut-conflicts.ts";
import {
	GS_DEFAULT_SHORTCUTS,
	inventoryPreferredAgainstGs,
} from "../lib/lab/gs-shortcut-inventory.ts";
import {
	buildPhase1cTuiReport,
	TUI_HUMAN_INSTRUCTIONS,
} from "../lib/lab/tui-validation.ts";
import {
	createPiperTtsAdapter,
} from "../lib/adapters/piper-tts.ts";
import {
	createWhisperSttAdapter,
	readGgmlMagic,
} from "../lib/adapters/whisper-stt.ts";
import {
	buildWhisperInstallConsent,
	formatWhisperInstallConsent,
	WHISPER_UBUNTU_X64_B5454,
} from "../lib/engines/whisper-install-consent.ts";
import {
	preferredCaptureBackends,
	preferredPlaybackBackends,
	isAudioBackendImplemented,
	AUDIO_BACKEND_CATALOG,
} from "../lib/adapters/audio-backends.ts";
import { deniedShortcutProbe, labShortcutProbeFromEnv, maybeRegisterVoiceShortcut } from "../lib/shortcut.ts";
import { PREFERRED_SHORTCUT } from "../lib/engines/contracts.ts";
import { DEFAULT_VOICE_CONFIG } from "../lib/config.ts";
import { VOICE_COMMAND } from "../lib/commands.ts";
import { createFakeProcess, CancellationBag, AbortError } from "../lib/process-cancel.ts";
import { ADAPTER_READY_ENGINES } from "../lib/engines/probe-fs.ts";
import { resolveVoiceAdapters } from "../lib/adapters/platform.ts";
import {
	appendLabLog,
	skipWithoutLab,
	applyDeveloperLabEnv,
	LAB_PIPER_DEFAULTS,
	LAB_VOXTYPE_GGML_SMALL,
	LAB_WHISPER_CLI_CANDIDATE,
} from "./lab-env.ts";

async function labLog(line: string): Promise<void> {
	await appendLabLog("phase1c-access.log", line);
}

test("simulated: TUI command+widget lifecycle and cleanup", async () => {
	const harness = createPiHostHarness();
	createVoiceExtension(harness.pi, {
		config: { ...DEFAULT_VOICE_CONFIG, enabled: false },
		shortcutProbe: deniedShortcutProbe(),
	});

	await harness.runCommand(VOICE_COMMAND, "on");
	const afterOn = harness.widgets.filter((w) => w.key === VOICE_WIDGET_KEY).at(-1);
	assert.match(afterOn?.content?.[0] ?? "", /READY/);

	await harness.runCommand(VOICE_COMMAND, "listen");
	const during = harness.widgets.filter((w) => w.key === VOICE_WIDGET_KEY);
	assert.ok(during.some((w) => Array.isArray(w.content) && /LISTENING/.test(w.content[0] ?? "")));
	assert.equal(during.at(-1)?.placement, "aboveEditor");

	await harness.runCommand(VOICE_COMMAND, "stop");
	const afterStop = harness.widgets.filter((w) => w.key === VOICE_WIDGET_KEY).at(-1);
	assert.match(afterStop?.content?.[0] ?? "", /READY/, "stop returns READY widget (voice still on)");

	await harness.runCommand(VOICE_COMMAND, "listen");
	await harness.runCommand(VOICE_COMMAND, "off");
	const afterOff = harness.widgets.filter((w) => w.key === VOICE_WIDGET_KEY);
	assert.ok(afterOff.some((w) => w.content === undefined), "widget cleared after off");

	const report = buildPhase1cTuiReport({
		harnessCommandsOk: true,
		harnessWidgetOk: true,
		harnessCleanupOk: true,
		liveTuiObserved: false,
		shortcutLiveOk: false,
	});
	assert.equal(report.overall, "pending_human");
	assert.equal(report.llmTokensUsed, false);
	assert.ok(TUI_HUMAN_INSTRUCTIONS.includes("gentle-shell --home"));
	await labLog("simulated: tui lifecycle ok; live pending_human");
});

test("simulated: Ctrl+Alt+Space remains fail-closed; GS defaults do not claim it", async () => {
	const inventory = inventoryPreferredAgainstGs(GS_DEFAULT_SHORTCUTS);
	assert.equal(inventory.conflictsWithGsDefaults, false);
	assert.equal(inventory.preferred, "ctrl+alt+space");

	const evidence = await collectShortcutConflictEvidence({ home: "/home/erickfm" });
	assert.equal(evidence.osConflictSuspected, false);
	assert.equal(evidence.piKeyIdValid, true);

	const harness = createPiHostHarness();
	const denied = await maybeRegisterVoiceShortcut(harness.pi, {
		probe: labShortcutProbeFromEnv({}),
		handler: async () => {},
	});
	assert.equal(denied.registered, false);

	const stillDenied = await maybeRegisterVoiceShortcut(harness.pi, {
		probe: labShortcutProbeFromEnv({ GENTLE_VOICE_LAB: "1" }),
		handler: async () => {},
	});
	assert.equal(stillDenied.registered, false, "LAB alone is not enough");

	const allowed = await maybeRegisterVoiceShortcut(harness.pi, {
		probe: labShortcutProbeFromEnv({
			GENTLE_VOICE_LAB: "1",
			GENTLE_VOICE_LAB_SHORTCUT: "1",
		}),
		handler: async () => {},
	});
	assert.equal(allowed.registered, true);
	assert.ok(harness.shortcuts.has(PREFERRED_SHORTCUT));
	await labLog("shortcut: fail-closed default; lab double-gate works in harness only");
});

test("real: Piper CLI + daniela voice reusable; dry-run adapter ready", { skip: skipWithoutLab }, async () => {
	await access(LAB_PIPER_DEFAULTS.piperPath, constants.X_OK);
	await access(LAB_PIPER_DEFAULTS.voiceModelPath, constants.R_OK);
	await access(LAB_PIPER_DEFAULTS.voiceConfigPath, constants.R_OK);

	const tts = createPiperTtsAdapter({
		...LAB_PIPER_DEFAULTS,
		dryRun: true,
	});
	const avail = await tts.availability();
	assert.equal(avail.status, "ready");
	assert.match(avail.detail ?? "", /dry_run/);

	const ac = new AbortController();
	const result = await tts.synthesize("hola laboratorio", { signal: ac.signal });
	assert.equal(result.audio.bytes.byteLength, 0, "dry-run must not produce audio bytes");
	assert.ok(tts.lastPlan);
	assert.equal(tts.lastPlan!.command, LAB_PIPER_DEFAULTS.piperPath);
	assert.ok(tts.lastPlan!.args.includes(LAB_PIPER_DEFAULTS.voiceModelPath));
	assert.ok(ADAPTER_READY_ENGINES.has("piper"));
	await labLog(`piper: ready dry-run path=${LAB_PIPER_DEFAULTS.piperPath}`);
});

test("real: Voxtype ggml-small magic compatible; whisper-cli ready under WD-Black", { skip: skipWithoutLab }, async () => {
	const magic = await readGgmlMagic(LAB_VOXTYPE_GGML_SMALL);
	assert.ok(magic);
	assert.ok(magic.magic === "ggml" || magic.magic === "lmgg");
	assert.ok(magic.bytes > 100_000_000);

	const stt = createWhisperSttAdapter({
		whisperCliPath: LAB_WHISPER_CLI_CANDIDATE,
		modelPath: LAB_VOXTYPE_GGML_SMALL,
		dryRun: true,
	});
	const modelOk = await stt.validateModelMagic();
	assert.equal(modelOk.ok, true);
	const avail = await stt.availability();
	// Phase 2A: lab whisper-cli is installed under WD-Black (path reference only for model).
	assert.equal(avail.status, "ready");
	assert.match(avail.detail ?? "", /whisper_ready/);
	await labLog(`whisper-model: ok magic=${magic.magic} bytes=${magic.bytes}; cli_ready`);
});

test("consent: whisper.cpp install requirements exact (not executed)", { skip: skipWithoutLab }, async () => {
	applyDeveloperLabEnv();
	const consent = buildWhisperInstallConsent({ arch: "x86_64" });
	assert.equal(consent.authorized, false);
	assert.equal(consent.candidate.assetName, WHISPER_UBUNTU_X64_B5454.assetName);
	assert.equal(consent.candidate.sha256, WHISPER_UBUNTU_X64_B5454.sha256);
	assert.equal(consent.candidate.sizeBytes, 10_364_195);
	assert.ok(consent.rejectedGlobalMethods.some((m) => m.includes("pacman")));
	assert.equal(consent.reuseModel.action, "reference_only_no_copy");
	const text = formatWhisperInstallConsent(consent);
	assert.match(text, /NOT AUTHORIZED/);
	assert.match(text, /GENTLE_VOICE_LAB_ROOT|gentle-voice/);

	await appendLabLog("phase1c-whisper-consent.txt", text);
	await labLog("whisper-consent: written; install not executed");
});

test("architecture: multiplatform audio backends declared; PipeWire capture implemented on Linux", () => {
	assert.ok(AUDIO_BACKEND_CATALOG.length >= 8);
	assert.deepEqual(preferredCaptureBackends("linux")[0], "linux-pipewire");
	assert.deepEqual(preferredCaptureBackends("win32")[0], "win-wasapi");
	assert.deepEqual(preferredCaptureBackends("darwin")[0], "darwin-avfoundation");
	assert.equal(isAudioBackendImplemented("linux-pipewire"), true);
	assert.equal(isAudioBackendImplemented("stub"), true);
	assert.equal(isAudioBackendImplemented("win-wasapi"), false);
	assert.equal(isAudioBackendImplemented("darwin-avfoundation"), false);
	const bundle = resolveVoiceAdapters({ platform: "linux" });
	assert.ok(!bundle.plannedCaptureBackends.includes("linux-pipewire"));
	assert.ok(bundle.plannedCaptureBackends.includes("stub"));
	assert.ok(preferredPlaybackBackends("linux").includes("linux-pulse"));
});

test("cancellation: bag aborts and fake process honors signal", async () => {
	const bag = new CancellationBag();
	const signal = bag.derive();
	const proc = createFakeProcess({ signal, delayMs: 5_000 });
	bag.abortAll();
	const exit = await proc.exit;
	assert.equal(exit.signal, "SIGTERM");
	assert.equal(bag.size, 0);

	const ac = new AbortController();
	ac.abort();
	const tts = createPiperTtsAdapter({ ...LAB_PIPER_DEFAULTS, dryRun: true });
	await assert.rejects(
		() => tts.synthesize("x", { signal: ac.signal }),
		(err: unknown) => err instanceof AbortError || (err as Error).name === "AbortError",
	);
});

test("isolation: gs-lab paths used; global GS settings untouched by this suite", { skip: skipWithoutLab }, async () => {
	const globalSettings = "/home/erickfm/.gentle-shell/gentle-ai/settings.json";
	let before: string | undefined;
	try {
		before = await readFile(globalSettings, "utf8");
	} catch {
		before = undefined;
	}
	// suite only appends under gs-lab/logs
	await labLog("isolation: no write to global GS config from phase1c tests");
	let after: string | undefined;
	try {
		after = await readFile(globalSettings, "utf8");
	} catch {
		after = undefined;
	}
	assert.equal(before, after);
});
