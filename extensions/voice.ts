/**
 * Pi extension entry — Gentle Voice.
 * Phase 2C.1: recover final reply from turn_end/agent_end (agent_settled has no message).
 * Lab-only: test-speak / converse (GENTLE_VOICE_LAB=1).
 */

import { randomUUID } from "node:crypto";
import type { VoiceHostApi, VoiceHostCommandContext } from "../lib/contracts.ts";
import { DEFAULT_VOICE_CONFIG, resolveVoicePaths, validateVoiceConfig, type VoiceConfig } from "../lib/config.ts";
import {
	isGentleVoiceLabMode,
	parseModeFlag,
	parseVoiceArgs,
	VOICE_COMMAND,
	voiceHelpText,
} from "../lib/commands.ts";
import { probeAdapterBundle } from "../lib/adapters/platform.ts";
import { resolveLabVoiceAdapters } from "../lib/adapters/lab-resolve.ts";
import { LAB_TEST_SPEAK_PHRASE } from "../lib/adapters/piper-tts.ts";
import { VoiceSession } from "../lib/voice-session.ts";
import {
	maybeRegisterVoiceShortcut,
	maybeRegisterExtraShortcut,
	type ShortcutProbe,
	labShortcutProbeFromEnv,
} from "../lib/shortcut.ts";
import { beginSetup } from "../lib/engines/setup.ts";
import type { EngineProbe } from "../lib/engines/detect.ts";
import { createFilesystemEngineProbe } from "../lib/engines/probe-fs.ts";
import { formatCorrectionDiff } from "../lib/stt/corrections.ts";
import { AgentReplyTracker } from "../lib/agent-reply-tracker.ts";
import {
	AB_COMPARE_PHRASES,
	createAbCompareSession,
	formatAbCompareStatus,
	listInstalledTtsSlots,
	piperSlotFromAdapter,
	researchOnlyProviders,
	scoreLastTrial,
	type AbCompareSession,
} from "../lib/tts/ab-compare.ts";
import {
	snapshotVoiceChrome,
	VOICE_STATUS_KEY,
	VOICE_WIDGET_KEY,
} from "../lib/widget-chrome.ts";
import { voiceWidgetContent } from "../lib/visual/compact-widget.ts";
import { runFirstRunPreparation } from "../lib/runtime/first-run.ts";
import { formatCompatMarkdown } from "../lib/runtime/compat-matrix.ts";
import {
	formatStorageDiagnostics,
	planGentleVoiceDataCleanup,
	resolveGentleVoiceStorage,
} from "../lib/runtime/storage.ts";

export { VOICE_STATUS_KEY, VOICE_WIDGET_KEY };

/** Lab opt-in for hands-free auto-submit (never outside GENTLE_VOICE_LAB). */
export function labAutoSubmitOptIn(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.GENTLE_VOICE_LAB === "1" && env.GENTLE_VOICE_LAB_AUTO_SUBMIT === "1";
}

export interface VoiceExtensionOptions {
	config?: VoiceConfig;
	session?: VoiceSession;
	/** Injected for tests — fail-closed by default (no auto shortcut). */
	shortcutProbe?: ShortcutProbe;
	engineProbe?: EngineProbe;
	/** Force stubs (unit tests). */
	forceStubAdapters?: boolean;
}

function interactive(ctx: VoiceHostCommandContext): boolean {
	return ctx.mode === "tui" && ctx.hasUI;
}

/** Single chrome path — every command/lifecycle hook must use this. */
export function updateChrome(ctx: VoiceHostCommandContext, session: VoiceSession): void {
	if (!interactive(ctx)) return;
	const cols = typeof process.stdout?.columns === "number" ? process.stdout.columns : 80;
	session.setTerminalColumns(cols);
	const chrome = snapshotVoiceChrome(session.state, session.chromeVisual());
	try {
		ctx.ui.setStatus?.(chrome.statusKey, chrome.statusText);
	} catch {
		/* status is cosmetic */
	}
	try {
		// Factory → compact themed leaf (GS customize colors). Avoid string[]
		// full-width Text padding ("huge waybar").
		const content = voiceWidgetContent(chrome.widgetContent, chrome.activity);
		ctx.ui.setWidget?.(chrome.widgetKey, content, { placement: chrome.placement });
	} catch {
		/* widget is cosmetic — fall back to plain lines */
		try {
			ctx.ui.setWidget?.(chrome.widgetKey, chrome.widgetContent, { placement: chrome.placement });
		} catch {
			/* ignore */
		}
	}
}

function enableLabConverse(session: VoiceSession): void {
	const auto = labAutoSubmitOptIn();
	session.replaceConfig({
		...session.config,
		enabled: true,
		behavior: {
			...session.config.behavior,
			mode: "conversation",
			fluentConversation: true,
			autoSubmitTranscript: auto,
			// 2D.5: slightly tighter end-of-utterance hang (keep anti-ghost gates).
			silenceMs: Math.min(session.config.behavior.silenceMs, 900),
			vadMaxIntraPauseMs: Math.max(session.config.behavior.vadMaxIntraPauseMs, 500),
		},
	});
	session.dispatch({ type: "ENABLE" });
	session.dispatch({ type: "SET_MODE", mode: "conversation" });
}

function endLabConverse(session: VoiceSession): void {
	session.endEditHold();
	session.cancelVoiceAudio("converse_off");
	session.replaceConfig({
		...session.config,
		behavior: {
			...session.config.behavior,
			fluentConversation: false,
			autoSubmitTranscript: false,
		},
	});
	// Stop capture/playback; do not DISABLE if we only end converse — keep widget until off.
	if (session.state.phase === "listening" || session.state.phase === "speaking" || session.state.phase === "transcribing") {
		session.dispatch({ type: "STOP" });
	}
}

function labDiagEnabled(): boolean {
	return isGentleVoiceLabMode() && process.env.GENTLE_VOICE_LAB_DIAG === "1";
}

/** Capture-aware edit → native Pi editor (no parallel UI). */
async function runVoiceEdit(
	ctx: VoiceHostCommandContext,
	session: VoiceSession,
): Promise<void> {
	if (typeof ctx.ui.setEditorText !== "function") {
		ctx.ui.notify(
			"Pi editor API (setEditorText) unavailable in this host — cannot native-edit.",
			"warning",
		);
		return;
	}

	const prep = await session.prepareVoiceEdit();
	await session.flush();

	if (prep.kind === "busy") {
		ctx.ui.notify(
			"Agent/TTS still active. Press Esc to cancel, then Ctrl+Alt+E again.",
			"warning",
		);
		return;
	}
	if (prep.kind === "empty" || prep.kind === "empty_capture") {
		session.endEditHold();
		ctx.ui.notify(
			prep.kind === "empty_capture"
				? "No speech in the current capture — nothing to edit. Keep speaking, then Ctrl+Alt+E."
				: "No voice transcript to edit yet. Speak a turn first.",
			"warning",
		);
		updateChrome(ctx, session);
		return;
	}

	const existing = (ctx.ui.getEditorText?.() ?? "").trim();
	if (existing && existing !== prep.text.trim()) {
		let overwrite = true;
		const editConfirm = (ctx.ui as unknown as { confirm?: (t: string, m: string) => Promise<boolean> }).confirm;
		if (typeof editConfirm === "function") {
			overwrite = await editConfirm(
				"Gentle Voice Edit",
				"El editor ya tiene texto. ¿Reemplazarlo por la transcripción de voz?",
			);
		}
		if (!overwrite) {
			session.endEditHold();
			ctx.ui.notify("Edit cancelled — editor unchanged.", "info");
			updateChrome(ctx, session);
			return;
		}
	}

	ctx.ui.setEditorText(prep.text);
	const note = prep.kind === "current"
		? "Gentle Voice Edit: current utterance is in the Pi editor (auto-send paused). Fix it and press Enter to send as a new message."
		: "Gentle Voice Edit: loaded LAST sent voice line (no newer capture). Enter re-sends as a new message — history is not rewritten.";
	ctx.ui.notify(note, "info");
	updateChrome(ctx, session);
}

/**
 * Esc: cancel voice audio; if agent running, call native ctx.abort().
 * Does not consume Esc when voice is idle (menus/editor keep native behavior).
 * Returns true when the key was handled for voice.
 */
function handleVoiceEscape(
	ctx: VoiceHostCommandContext,
	session: VoiceSession,
): boolean {
	const phase = session.state.phase;
	const busy =
		phase === "listening"
		|| phase === "speaking"
		|| phase === "transcribing"
		|| phase === "awaiting_agent"
		|| session.streamActive
		|| session.editHold;
	if (!session.state.enabled || !busy) return false;

	session.cancelVoiceAudio("escape");
	if (session.editHold) session.endEditHold();

	if (phase === "awaiting_agent" && typeof ctx.abort === "function") {
		try {
			ctx.abort();
		} catch {
			/* host may refuse — audio already cancelled */
		}
	}
	updateChrome(ctx, session);
	return true;
}

export function createVoiceExtension(pi: VoiceHostApi, options: VoiceExtensionOptions = {}): VoiceSession {
	const config = options.config ?? {
		...DEFAULT_VOICE_CONFIG,
		engines: { ...DEFAULT_VOICE_CONFIG.engines, language: "es" },
		behavior: { ...DEFAULT_VOICE_CONFIG.behavior, autoSubmitTranscript: false },
	};
	// Product default: real adapters. node:test sets NODE_TEST_CONTEXT → stubs unless forced.
	const underNodeTest = Boolean(process.env.NODE_TEST_CONTEXT);
	const useRealAudio = options.forceStubAdapters === true
		? false
		: options.forceStubAdapters === false
			? true
			: options.session
				? false
				: underNodeTest
					? false
					: true;

	const replyTracker = new AgentReplyTracker();
	let vadFinish: (() => void) | undefined;
	let abSession: AbCompareSession | undefined;
	let firstRunDone = false;
	let firstRunPromise: Promise<void> | undefined;

	const attachVad = () => {
		vadFinish = () => {
			void session.finishListen().then(() => {
				if (lastCtx) updateChrome(lastCtx, session);
			});
		};
	};

	let resolved = resolveLabVoiceAdapters({
		config,
		forceStub: !useRealAudio,
		onVadEnd: () => {
			vadFinish?.();
		},
	});
	let adapters = resolved.bundle;
	let session: VoiceSession;
	let lastCtx: VoiceHostCommandContext | undefined;

	const rebindAdaptersFromRuntime = () => {
		if (!useRealAudio) return;
		resolved = resolveLabVoiceAdapters({
			config: session.config,
			forceStub: false,
			onVadEnd: () => {
				vadFinish?.();
			},
		});
		adapters = resolved.bundle;
		session.deps.capture = adapters.capture;
		session.deps.stt = adapters.stt;
		session.deps.tts = adapters.tts;
		session.deps.playback = adapters.playback;
	};

	const ensureAutomaticFirstRun = (ctx: VoiceHostCommandContext): Promise<void> => {
		if (!useRealAudio || options.session) return Promise.resolve();
		if (firstRunDone) return Promise.resolve();
		if (firstRunPromise) return firstRunPromise;
		firstRunPromise = (async () => {
			const uiConfirm = (ctx.ui as unknown as {
				confirm?: (t: string, m: string) => Promise<boolean>;
			}).confirm;
			const snap = await runFirstRunPreparation({
				notify: (message, level) => {
					try {
						ctx.ui.notify(message, level ?? "info");
					} catch {
						/* ignore */
					}
				},
				...(typeof uiConfirm === "function"
					? { confirm: (title: string, message: string) => uiConfirm(title, message) }
					: {}),
			});
			firstRunDone = true;
			if (snap.status === "ready" || snap.status === "partial") {
				rebindAdaptersFromRuntime();
			}
		})().catch((error) => {
			firstRunDone = true;
			try {
				ctx.ui.notify(
					`Gentle Voice setup failed: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			} catch {
				/* ignore */
			}
		});
		return firstRunPromise;
	};

	session = options.session ?? new VoiceSession({
		config,
		capture: adapters.capture,
		stt: adapters.stt,
		tts: adapters.tts,
		playback: adapters.playback,
		submitTranscript: (text) => {
			replyTracker.markVoiceSubmit(randomUUID());
			pi.sendUserMessage?.(text);
		},
		presentTranscript: (text) => {
			void text;
		},
		notify: () => {},
		onSpeakFinished: () => {
			// Muted: still re-listen. Echo settle lives inside scheduleFluentRelisten.
			session.scheduleFluentRelisten();
		},
		onChromeUpdate: () => {
			if (lastCtx) updateChrome(lastCtx, session);
		},
		whisperInitialPrompt: process.env.GENTLE_VOICE_WHISPER_PROMPT?.trim()
			|| undefined,
		onLabDiag: (line) => {
			if (process.env.GENTLE_VOICE_LAB_DIAG === "1" && lastCtx) {
				try {
					lastCtx.ui.notify(`voice-diag: ${line}`, "info");
				} catch {
					/* ignore */
				}
			}
		},
	});
	attachVad();
	// Injected sessions (tests) still need live chrome refresh during PCM/TTS.
	session.deps.onChromeUpdate = () => {
		if (lastCtx) updateChrome(lastCtx, session);
	};
	session.deps.notify = (message, level) => {
		try {
			lastCtx?.ui.notify(message, level);
		} catch {
			/* ignore */
		}
	};
	session.deps.presentTranscript = async (text) => {
		if (!lastCtx) return;
		const corr = session.lastCorrection;
		const head = corr?.changed
			? formatCorrectionDiff(corr)
			: `🎙 Transcript (review — not sent):\n${text}`;
		lastCtx.ui.notify(
			[head, "", "Edit: /gentle:voice draft <texto>\nSend: /gentle:voice send"].join("\n"),
			"info",
		);
	};
	session.deps.submitTranscript = async (text) => {
		session.endEditHold();
		// Correlate this voice turn with turn_end/agent_end — agent_settled has no message.
		replyTracker.markVoiceSubmit(randomUUID());
		pi.sendUserMessage?.(text);
		// Fluent: one short line (no review spam). Dictation/manual still quiet.
		if (lastCtx && !session.config.behavior.fluentConversation) {
			lastCtx.ui.notify(`Voice transcript queued (${text.length} chars).`, "info");
		}
	};

	const shortcutProbe = options.shortcutProbe
		?? (process.env.GENTLE_VOICE_SHORTCUT_VERIFIED === "1"
			? labShortcutProbeFromEnv()
			: undefined);

	void maybeRegisterVoiceShortcut(pi, {
		...(session.config.behavior.shortcut
			? { configuredShortcut: session.config.behavior.shortcut }
			: {}),
		probe: shortcutProbe,
		handler: async (ctx) => {
			lastCtx = ctx as VoiceHostCommandContext;
			await ensureAutomaticFirstRun(lastCtx);
			const fluent = session.config.behavior.fluentConversation;
			const lab = isGentleVoiceLabMode();

			// ——— Conversation session toggle (lab hands-free) ———
			if (lab && (!session.state.enabled || !fluent)) {
				enableLabConverse(session);
				session.dispatch({ type: "LISTEN" });
				await session.flush();
				lastCtx.ui.notify(
					`Hands-free conversation ON (autoSubmit=${session.config.behavior.autoSubmitTranscript}). Speak freely; VAD ends turns. Press Ctrl+Alt+Space again to end.`,
					"info",
				);
				updateChrome(lastCtx, session);
				return;
			}

			if (lab && fluent) {
				if (session.state.phase === "awaiting_agent") {
					endLabConverse(session);
					await session.flush();
					lastCtx.ui.notify("Conversation ended — agent continues; mic/TTS stopped.", "info");
					updateChrome(lastCtx, session);
					return;
				}
				endLabConverse(session);
				await session.flush();
				lastCtx.ui.notify("Hands-free conversation OFF.", "info");
				updateChrome(lastCtx, session);
				return;
			}

			if (session.state.phase === "speaking") {
				session.cancelVoiceAudio("shortcut_stop");
				await session.flush();
				updateChrome(lastCtx, session);
				return;
			}
			if (session.state.phase === "awaiting_agent") {
				lastCtx.ui.notify("Agent still working — wait before a new listen.", "warning");
				return;
			}
			if (!session.state.enabled) {
				session.dispatch({ type: "ENABLE" });
				session.dispatch({ type: "LISTEN" });
				await session.flush();
				updateChrome(lastCtx, session);
				return;
			}
			if (session.state.phase === "listening") {
				await session.finishListen();
			} else {
				session.dispatch({ type: "LISTEN" });
			}
			await session.flush();
			updateChrome(lastCtx, session);
		},
	});

	// Ctrl+Alt+E — Gentle Voice Edit (same verification gate as Space).
	void maybeRegisterExtraShortcut(pi, {
		chord: "ctrl+alt+e",
		description: "Gentle Voice Edit — last voice transcript in Pi editor",
		probe: shortcutProbe,
		handler: async (ctx) => {
			lastCtx = ctx as VoiceHostCommandContext;
			await runVoiceEdit(lastCtx, session);
		},
	});

	// Esc coordination via raw terminal input — only when voice is busy.
	// Does not register a global Esc shortcut (preserves menus/editor when idle).
	const attachEscape = (ctx: VoiceHostCommandContext) => {
		if (typeof ctx.ui.onTerminalInput !== "function") return;
		if ((attachEscape as { done?: boolean }).done) return;
		(attachEscape as { done?: boolean }).done = true;
		ctx.ui.onTerminalInput((data) => {
			// ESC / CSI sequences start with 0x1b
			if (!data || data.charCodeAt(0) !== 0x1b) return;
			// Lone Esc (not CSI arrow/fn): length 1 or Esc Esc
			if (data.length > 1 && data[1] !== "\x1b") return;
			if (!lastCtx) lastCtx = ctx;
			return handleVoiceEscape(lastCtx, session);
		});
	};

	pi.registerCommand(VOICE_COMMAND, {
		description: "Local voice session (Gentle Voice)",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			attachEscape(ctx);
			await ensureAutomaticFirstRun(ctx);
			const parsed = parseVoiceArgs(args);
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "warning");
				return;
			}

			if (parsed.command === "edit") {
				await runVoiceEdit(ctx, session);
				return;
			}

			if (parsed.labCommand === "converse") {
				if (!isGentleVoiceLabMode()) {
					ctx.ui.notify("Unknown subcommand \"converse\".", "warning");
					return;
				}
				const arg = parsed.rest.trim().toLowerCase();
				const on = arg === "on" || arg === "1" || arg === "true";
				const off = arg === "off" || arg === "0" || arg === "false";
				if (!on && !off) {
					ctx.ui.notify("Usage: /gentle:voice converse on|off", "warning");
					return;
				}
				if (on) {
					enableLabConverse(session);
					session.dispatch({ type: "LISTEN" });
				} else {
					endLabConverse(session);
				}
				ctx.ui.notify(
					on
						? `Fluent conversation ON (autoSubmit=${session.config.behavior.autoSubmitTranscript}). VAD ends utterances. Ctrl+Alt+Space ends session.`
						: "Fluent conversation OFF — manual listen/stop/send.",
					"info",
				);
				await session.flush();
				updateChrome(ctx, session);
				return;
			}

			if (parsed.labCommand === "test-speak") {
				if (!isGentleVoiceLabMode()) {
					ctx.ui.notify("Unknown subcommand \"test-speak\".", "warning");
					return;
				}
				if (!session.state.enabled) {
					session.dispatch({ type: "ENABLE" });
					await session.flush();
				}
				const phrase = parsed.rest.trim() || LAB_TEST_SPEAK_PHRASE;
				if (session.state.muted) {
					ctx.ui.notify("Muted — TTS skipped (mic/STT still work).", "warning");
					updateChrome(ctx, session);
					return;
				}
				const outcome = await session.speakDirect(phrase);
				if (outcome === "muted") {
					ctx.ui.notify("Muted — TTS skipped (mic/STT still work).", "warning");
				} else if (outcome === "disabled") {
					ctx.ui.notify("Voice is off. Use /gentle:voice on first.", "warning");
				} else if (outcome === "played") {
					ctx.ui.notify("test-speak: done.", "info");
				} else if (outcome === "empty") {
					ctx.ui.notify("test-speak: empty phrase.", "warning");
				}
				await session.flush();
				updateChrome(ctx, session);
				return;
			}

			if (parsed.labCommand === "tts") {
				if (!isGentleVoiceLabMode()) {
					ctx.ui.notify("Unknown subcommand \"tts\".", "warning");
					return;
				}
				const eng = parsed.rest.trim().toLowerCase();
				if (eng !== "piper" && eng !== "kokoro") {
					ctx.ui.notify(
						`Usage: /gentle:voice tts piper|kokoro\nactive=${resolved.ttsKind} kokoroReady=${resolved.kokoroReady}`,
						"warning",
					);
					return;
				}
				if (eng === "kokoro") {
					if (!resolved.kokoroAdapter) {
						ctx.ui.notify("Kokoro not installed in WD-Black lab.", "warning");
						return;
					}
					session.deps.tts = resolved.kokoroAdapter;
					ctx.ui.notify(
						"TTS engine → kokoro (session). Applies to agent spoken replies and test-speak. Default install remains Piper until you switch.",
						"info",
					);
				} else {
					if (!resolved.piperAdapter) {
						ctx.ui.notify("Piper not available.", "warning");
						return;
					}
					session.deps.tts = resolved.piperAdapter;
					ctx.ui.notify("TTS engine → piper (session). Applies to agent spoken replies and test-speak.", "info");
				}
				updateChrome(ctx, session);
				return;
			}

			if (parsed.labCommand === "ab-compare") {
				if (!isGentleVoiceLabMode()) {
					ctx.ui.notify("Unknown subcommand \"ab-compare\".", "warning");
					return;
				}
				const tokens = parsed.rest.trim().split(/\s+/).filter(Boolean);
				let phraseIndex = 0;
				let engineHint = "";
				for (const tok of tokens) {
					if (/^\d+$/.test(tok)) phraseIndex = Number.parseInt(tok, 10);
					else engineHint = tok.toLowerCase();
				}
				if (!Number.isInteger(phraseIndex) || phraseIndex < 0 || phraseIndex >= AB_COMPARE_PHRASES.length) {
					ctx.ui.notify(
						`Usage: /gentle:voice ab-compare [0-${AB_COMPARE_PHRASES.length - 1}] [piper|kokoro]\nPhrases:\n${
							AB_COMPARE_PHRASES.map((p, i) => `  ${i}: ${p}`).join("\n")
						}`,
						"warning",
					);
					return;
				}
				if (engineHint === "kokoro" || engineHint === "piper") {
					if (engineHint === "kokoro" && resolved.kokoroAdapter) session.deps.tts = resolved.kokoroAdapter;
					else if (engineHint === "piper" && resolved.piperAdapter) session.deps.tts = resolved.piperAdapter;
					else {
						ctx.ui.notify(`Engine "${engineHint}" not installed.`, "warning");
						return;
					}
				}
				const candidateSlots = [];
				if (resolved.piperAdapter) {
					candidateSlots.push(piperSlotFromAdapter(resolved.piperAdapter, {
						id: "piper-es-AR-daniela-high",
						notes: resolved.piperVoice ?? "lab piper",
					}));
				}
				if (resolved.kokoroAdapter) {
					candidateSlots.push({
						info: {
							id: "kokoro-ef-dora",
							displayName: "Kokoro-82M ef_dora (ES)",
							engine: "kokoro" as const,
							platforms: ["linux", "win32", "darwin"] as const,
							verifiedLocally: true,
							licenseHint: "Apache-2.0",
							notes: "Lab WD-Black ONNX quantized + ef_dora only",
						},
						adapter: resolved.kokoroAdapter,
					});
				}
				const installed = await listInstalledTtsSlots(candidateSlots);
				if (installed.length === 0) {
					ctx.ui.notify("No installed TTS ready for A/B.", "warning");
					return;
				}
				const activeId = session.deps.tts.id.includes("kokoro")
					? "kokoro-ef-dora"
					: "piper-es-AR-daniela-high";
				const slot = installed.find((s) => s.info.id === activeId) ?? installed[0]!;
				if (!abSession) {
					abSession = createAbCompareSession(installed, slot.info.id);
				}
				const research = researchOnlyProviders(new Set(installed.map((s) => s.info.id)));
				const phrase = AB_COMPARE_PHRASES[phraseIndex]!;
				if (session.state.muted) {
					ctx.ui.notify("Muted — A/B playback skipped.", "warning");
					return;
				}
				if (!session.state.enabled) {
					session.dispatch({ type: "ENABLE" });
					await session.flush();
				}
				const prevTts = session.deps.tts;
				session.deps.tts = slot.adapter;
				const t0 = performance.now();
				const outcome = await session.speakDirect(phrase);
				const synthesizeMs = Math.round(performance.now() - t0);
				session.deps.tts = prevTts;
				const trial = {
					phraseIndex,
					phrase,
					providerId: slot.info.id,
					displayName: slot.info.displayName,
					synthesizeMs,
					audioBytes: 0,
					sampleRateHz: slot.info.engine === "kokoro" ? 24_000 : 22_050,
					...(outcome !== "played" ? { error: outcome } : {}),
				};
				abSession = {
					...abSession,
					activeProviderId: slot.info.id,
					trials: [...abSession.trials, trial],
				};
				ctx.ui.notify(
					[
						formatAbCompareStatus(abSession),
						"",
						`Played #${phraseIndex} via ${trial.providerId} (${trial.synthesizeMs}ms wall).`,
						`Rate: /gentle:voice ab-score ${phraseIndex} <1-5>`,
						`Installed: ${installed.map((s) => s.info.id).join(", ")}`,
						research.length
							? `Not selectable: ${research.map((r) => r.id).join(", ")}`
							: "",
					].filter(Boolean).join("\n"),
					"info",
				);
				await session.flush();
				updateChrome(ctx, session);
				return;
			}

			if (parsed.labCommand === "ab-score") {
				if (!isGentleVoiceLabMode()) {
					ctx.ui.notify("Unknown subcommand \"ab-score\".", "warning");
					return;
				}
				if (!abSession || abSession.trials.length === 0) {
					ctx.ui.notify("No A/B trials yet. Run /gentle:voice ab-compare first.", "warning");
					return;
				}
				const parts = parsed.rest.trim().split(/\s+/);
				let phraseIndex: number;
				let score: number;
				if (parts.length === 1) {
					phraseIndex = abSession.trials[abSession.trials.length - 1]!.phraseIndex;
					score = Number.parseInt(parts[0]!, 10);
				} else {
					phraseIndex = Number.parseInt(parts[0]!, 10);
					score = Number.parseInt(parts[1]!, 10);
				}
				const last = [...abSession.trials]
					.reverse()
					.find((t) => t.phraseIndex === phraseIndex);
				if (!last) {
					ctx.ui.notify(`No trial for phrase #${phraseIndex}.`, "warning");
					return;
				}
				try {
					abSession = scoreLastTrial(abSession, last.providerId, phraseIndex, score);
					ctx.ui.notify(formatAbCompareStatus(abSession), "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
				}
				return;
			}

			switch (parsed.command) {
				case "": {
					if (!session.state.enabled) {
						session.dispatch({ type: "ENABLE" });
					} else if (session.state.phase === "idle") {
						ctx.ui.notify(session.statusLine(), "info");
					} else {
						session.dispatch({ type: "STOP" });
					}
					break;
				}
				case "on": {
					const mode = parseModeFlag(parsed.rest);
					if (mode) session.dispatch({ type: "SET_MODE", mode });
					session.dispatch({ type: "ENABLE" });
					break;
				}
				case "off":
					session.dispatch({ type: "DISABLE" });
					break;
				case "listen":
					session.dispatch({ type: "LISTEN" });
					break;
				case "stop":
					if (session.state.phase === "listening") await session.finishListen();
					else session.dispatch({ type: "STOP" });
					break;
				case "mute":
					if (parsed.rest.trim().toLowerCase() === "off") session.dispatch({ type: "UNMUTE" });
					else session.dispatch({ type: "MUTE" });
					break;
				case "draft": {
					const draft = parsed.rest.trim();
					if (!draft) {
						ctx.ui.notify(
							session.pendingReviewText
								? `Current draft:\n${session.pendingReviewText}`
								: "No pending draft. Listen first or: /gentle:voice draft <text>",
							"info",
						);
						break;
					}
					session.setReviewDraft(draft);
					ctx.ui.notify(`Draft updated (not sent):\n${draft}`, "info");
					break;
				}
				case "send": {
					const outcome = await session.submitPending(parsed.rest.trim() || undefined);
					if (outcome === "sent") {
						ctx.ui.notify("Transcript sent to agent.", "info");
					} else if (outcome === "empty") {
						ctx.ui.notify("Nothing to send (empty transcript).", "warning");
					} else if (outcome === "duplicate") {
						ctx.ui.notify("Already sent — waiting for the agent.", "warning");
					} else if (outcome === "busy") {
						ctx.ui.notify("Busy — wait for the agent/TTS to finish.", "warning");
					} else if (outcome === "disabled") {
						ctx.ui.notify("Voice is off. Use /gentle:voice on first.", "warning");
					}
					break;
				}
				case "status": {
					const probe = await probeAdapterBundle(adapters);
					const setup = await beginSetup({
						probe: options.engineProbe ?? createFilesystemEngineProbe(),
					});
					const whisperHint = resolved.sttKind === "whisper"
						? `Whisper operational (lab:${resolved.whisperCli ?? "path"})`
						: setup.report.message;
					const selected = session.config.engines.tts || "(auto)";
					const activeId = session.deps.tts.id;
					const lastSynth = session.lastTtsEngineId;
					const lines = [
						session.statusLine(),
						`platform=${probe.platform}`,
						`capture=${probe.capture}`,
						`stt=${probe.stt}`,
						`tts=${probe.tts}`,
						`playback=${probe.playback}`,
						`lab.capture=${resolved.captureKind}`,
						`lab.stt=${resolved.sttKind}`,
						`lab.tts=${resolved.ttsKind}`,
						`lab.playback=${resolved.playbackKind}`,
						`kokoroReady=${resolved.kokoroReady}`,
						`tts.selected=${selected}`,
						`tts.activeAdapter=${activeId}`,
						`tts.lastSynthesize=${lastSynth}`,
						`tts.fallbackReason=${session.lastTtsFallbackReason || "(none)"}`,
						`tts.voiceHint=${activeId.includes("kokoro") ? "kokoro/ef_dora" : activeId.includes("piper") ? "piper/daniela-high" : activeId}`,
						`engines.scenario=${setup.report.scenario}`,
						`engines.hint=${whisperHint}`,
						`fluent=${session.config.behavior.fluentConversation}`,
						`autoSubmit=${session.config.behavior.autoSubmitTranscript}`,
						`lastSubmitTurn=${session.lastSubmitTurnId || "(none)"}`,
						`lastUtteranceGate=${session.lastLabDiag || "(none)"}`,
						`shortcutVerified=${process.env.GENTLE_VOICE_SHORTCUT_VERIFIED === "1"}`,
						`shortcutLab=${process.env.GENTLE_VOICE_LAB_SHORTCUT === "1"}`,
						"",
						voiceHelpText({ includeLab: isGentleVoiceLabMode() }),
					];
					ctx.ui.notify(lines.join("\n"), "info");
					break;
				}
				case "config": {
					const paths = resolveVoicePaths(session.config);
					const storage = resolveGentleVoiceStorage();
					const validation = validateVoiceConfig(session.config);
					ctx.ui.notify([
						`schema=${session.config.schema}`,
						`enabled=${session.config.enabled}`,
						`mode=${session.config.behavior.mode}`,
						`muted=${session.config.behavior.muted}`,
						`shortcut=${session.config.behavior.shortcut ?? "(none — preferred Ctrl+Alt+Space only if verified)"}`,
						`engines.stt=${session.config.engines.stt || "(auto)"}`,
						`engines.tts=${session.config.engines.tts || "(auto)"}`,
						`hostKind=${storage.hostKind}`,
						`paths.home=${paths.home}`,
						`paths.models=${paths.models}`,
						`paths.cache=${paths.cache}`,
						`paths.tmp=${paths.tmp}`,
						`paths.configFile=${paths.configFile}`,
						`overrides=${storage.activeOverrides.length ? storage.activeOverrides.join(",") : "(none)"}`,
						`validation=${validation.ok ? "ok" : validation.errors.join("; ")}`,
						"",
						`behavior.autoSubmitTranscript=${session.config.behavior.autoSubmitTranscript}`,
						`pendingDraft=${session.pendingReviewText ? "yes" : "no"}`,
						"Overrides: GENTLE_VOICE_HOME|MODELS|CACHE|TMP|CONFIG",
					].join("\n"), "info");
					break;
				}
				case "storage": {
					const storage = resolveGentleVoiceStorage();
					const plan = planGentleVoiceDataCleanup(storage);
					ctx.ui.notify(
						[
							formatStorageDiagnostics(storage),
							"",
							"Cleanup dry-run (no delete):",
							`allowed=${plan.allowed}`,
							...plan.directories.map((d) => `  - ${d}`),
							plan.reasonsDenied.length
								? `denied: ${plan.reasonsDenied.join("; ")}`
								: plan.note,
							"",
							"Package uninstall: `pi remove npm:gentle-voice` or `gentle-shell remove npm:gentle-voice`.",
							"Data cleanup is manual/optional — never automatic.",
						].join("\n"),
						"info",
					);
					break;
				}
				case "setup": {
					const uiConfirm = (ctx.ui as unknown as { confirm?: (t: string, m: string) => Promise<boolean> }).confirm;
					const snap = await runFirstRunPreparation({
						notify: (message, level) => {
							try {
								ctx.ui.notify(message, level ?? "info");
							} catch {
								/* ignore */
							}
						},
						...(typeof uiConfirm === "function"
							? {
								confirm: (title: string, message: string) => uiConfirm(title, message),
							}
							: {}),
					});
					ctx.ui.notify(
						[
							`setup.status=${snap.status}`,
							`setup.platform=${snap.platform}/${snap.arch}`,
							`setup.home=${snap.layoutHome}`,
							`setup.present=${snap.present.join(",") || "(none)"}`,
							`setup.missing=${snap.missing.join(",") || "(none)"}`,
							`setup.estBytes=${snap.estimatedDownloadBytes}`,
							snap.message,
							"",
							"Compat (honest):",
							formatCompatMarkdown(),
						].join("\n"),
						"info",
					);
					break;
				}
				default:
					ctx.ui.notify(voiceHelpText({ includeLab: isGentleVoiceLabMode() }), "info");
			}

			await session.flush();
			updateChrome(ctx, session);
		},
	});

	// Pi 1.2 lifecycle: message lives on turn_end / agent_end; agent_settled is {aborted} only.
	// Streaming: message_update.assistantMessageEvent.text_delta (confirmed in Pi/GS protocol).
	if (typeof pi.on === "function") {
		// First-run on host session start — no mandatory /gentle:voice setup.
		pi.on("session_start", (_event, ctx) => {
			lastCtx = ctx as VoiceHostCommandContext;
			attachEscape(lastCtx);
			void ensureAutomaticFirstRun(lastCtx);
			updateChrome(lastCtx, session);
		});
		pi.on("agent_start", (_event, ctx) => {
			lastCtx = ctx as VoiceHostCommandContext;
			attachEscape(lastCtx);
			void ensureAutomaticFirstRun(lastCtx);
			if (!session.state.enabled) return;
			// Edit → Enter uses native Pi send; correlate so spoken reply still works.
			if (session.editHold) {
				session.endEditHold();
				replyTracker.markVoiceSubmit(randomUUID());
			}
			session.dispatch({ type: "AGENT_STARTED" });
			session.beginStreamSpeak();
			updateChrome(lastCtx, session);
		});
		pi.on("message_update", (event, ctx) => {
			lastCtx = ctx as VoiceHostCommandContext;
			if (!session.state.enabled) return;
			session.onMessageUpdate(event);
			updateChrome(lastCtx, session);
		});
		pi.on("turn_end", (event, ctx) => {
			lastCtx = ctx as VoiceHostCommandContext;
			replyTracker.onTurnEnd(event);
		});
		pi.on("agent_end", (event, ctx) => {
			lastCtx = ctx as VoiceHostCommandContext;
			replyTracker.onAgentEnd(event);
		});
		pi.on("agent_before_settle", (event, ctx) => {
			lastCtx = ctx as VoiceHostCommandContext;
			replyTracker.onBeforeSettle(event);
		});
		pi.on("agent_settled", (event, ctx) => {
			lastCtx = ctx as VoiceHostCommandContext;
			if (!session.state.enabled) return;
			const aborted = Boolean((event as { aborted?: boolean })?.aborted);
			const entries = lastCtx.sessionManager?.getEntries?.();
			const plan = replyTracker.consumeSettled({
				aborted,
				...(entries ? { sessionEntries: entries } : {}),
			});
			if (labDiagEnabled() && plan.skipReason && lastCtx) {
				lastCtx.ui.notify(
					`voice-diag: settle skip=${plan.skipReason} source=${plan.source}`,
					"warning",
				);
			}
			if (plan.skipReason === "duplicate_fingerprint" || plan.skipReason === "aborted") {
				session.cancelVoiceAudio("settle_skip");
				session.onAgentSettled({ message: null, outcome: plan.outcome });
				void session.flush().then(() => updateChrome(lastCtx!, session));
				return;
			}
			if (plan.skipReason === "no_assistant_message" || plan.skipReason === "not_awaiting_voice_turn") {
				session.cancelVoiceAudio("settle_skip");
				session.onAgentSettled({ message: null, outcome: plan.outcome });
				void session.flush().then(() => updateChrome(lastCtx!, session));
				return;
			}
			const decision = session.onAgentSettled({
				message: plan.message,
				outcome: plan.outcome,
			});
			// P4: never duplicate the spoken reply as a notify — widget SPEAKING only.
			if (decision.reason === "unfaithful_skip_show_full") {
				/* notify already emitted inside onAgentSettled */
			} else if (labDiagEnabled() && lastCtx) {
				lastCtx.ui.notify(
					`voice-diag: speak=${decision.speak} streamed=${Boolean(decision.streamed)} reason=${decision.reason}`,
					"info",
				);
			}
			void session.flush().then(() => updateChrome(lastCtx!, session));
		});
		pi.on("session_shutdown", () => {
			session.dispose();
		});
	}

	return session;
}

/** Pi package default export. */
export default function gentleVoice(pi: VoiceHostApi): void {
	createVoiceExtension(pi);
}
