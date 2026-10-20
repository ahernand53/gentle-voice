/**
 * Session controller: wires state machine + adapters + cancellation.
 * Phase 0 uses stubs; no real Pi agent loop required for unit tests.
 */

import type {
	AssistantMessageLike,
	AudioChunk,
	CaptureAdapter,
	PlaybackAdapter,
	SttAdapter,
	TtsAdapter,
} from "./contracts.ts";
import type { VoiceConfig } from "./config.ts";
import { DEFAULT_VOICE_CONFIG } from "./config.ts";
import { buildFinalUtterance } from "./final-utterance.ts";
import { AbortError, CancellationBag, isAbortError } from "./process-cancel.ts";
import { renderForSpeech } from "./tts/speech-renderer.ts";
import {
	applySttCorrections,
	DEFAULT_WHISPER_INITIAL_PROMPT,
	formatCorrectionDiff,
	type SttCorrectionResult,
	type SttCorrectionRule,
} from "./stt/corrections.ts";
import { gateUtteranceForAutoSubmit } from "./stt/utterance-gate.ts";
import { randomUUID } from "node:crypto";
import {
	describeVoiceStatus,
	initialVoiceState,
	reduceVoiceState,
	type VoiceEffect,
	type VoiceMachineEvent,
	type VoiceMachineState,
} from "./state-machine.ts";
import {
	extractTextDeltaFromMessageUpdate,
	isNonSpeakableAssistantEvent,
	SentenceAssembler,
} from "./tts/sentence-assembler.ts";
import { StreamSpeakQueue } from "./tts/stream-speak-queue.ts";
import { VisualMeter } from "./visual/visual-meter.ts";
import type { VoiceChromeVisual } from "./widget-chrome.ts";

/** P0 listen-cycle diagnostics (lab / tests). */
export interface ListenCycleDiag {
	readonly listenRequestedAtMs?: number;
	readonly captureStartedAtMs?: number;
	readonly firstPcmAtMs?: number;
	readonly speechSeenAtMs?: number;
	readonly widgetActivityAtListen?: string;
	readonly micReady: boolean;
}

export interface VoiceSessionDeps {
	config?: VoiceConfig;
	capture: CaptureAdapter;
	stt: SttAdapter;
	tts: TtsAdapter;
	playback: PlaybackAdapter;
	/** Submit transcript to the host agent (injected). */
	submitTranscript?: (text: string) => void | Promise<void>;
	/** Phase 2A review path — show text without LLM send. */
	presentTranscript?: (text: string) => void | Promise<void>;
	notify?: (message: string, level: "info" | "warning" | "error") => void;
	now?: () => number;
	/** Optional local STT lexicon (defaults applied when undefined). */
	sttCorrectionRules?: readonly SttCorrectionRule[];
	/** Disable post-corrections (prompt-only). */
	disableSttCorrections?: boolean;
	/** Called when capture VAD ends the utterance (optional). */
	onVadEnd?: () => void;
	/**
	 * Fluent loop hook: after a turn is fully done (TTS finished, muted skip,
	 * or agent settled with nothing to speak). Session schedules echo settle.
	 */
	onSpeakFinished?: () => void;
	/** Throttled chrome repaint (visual meter). */
	onChromeUpdate?: () => void;
	/** Terminal width for narrow wave layout. */
	terminalColumns?: number;
	/** Whisper --prompt used by STT (for prompt-echo gate). */
	whisperInitialPrompt?: string;
	/** Lab diagnostics (no full transcript). */
	onLabDiag?: (line: string) => void;
}

export class VoiceSession {
	#state: VoiceMachineState;
	#config: VoiceConfig;
	#bag = new CancellationBag();
	#captureStop: (() => Promise<void>) | undefined;
	#pendingSpeakText = "";
	#lastTranscript = "";
	/** Draft awaiting explicit `/gentle:voice send` (review mode). */
	#pendingReviewText = "";
	#lastSubmittedText = "";
	/** True after explicit/auto submit until agent_settled (blocks duplicate send). */
	#submitOpen = false;
	#lastCorrection: SttCorrectionResult | undefined;
	/** Bumped to invalidate in-flight TTS when a newer speak/cancel wins. */
	#speakEpoch = 0;
	#effectChain: Promise<void> = Promise.resolve();
	#meter: VisualMeter;
	#terminalColumns: number;
	/**
	 * When true, chrome shows ●●● instead of scrubbed waves.
	 * Used only if audio cannot yield PCM windows (not for wall-clock estimate).
	 */
	#simpleSpeakingActivity = false;
	#relistenTimer: ReturnType<typeof setTimeout> | undefined;
	#lastLabDiag = "";
	#lastSubmitTurnId = "";
	#lastTtsEngineId = "";
	#lastTtsFallbackReason = "";
	/** Mic producing PCM (false while ARMING). */
	#micReady = false;
	#listenDiag: ListenCycleDiag = { micReady: false };
	#streamAssembler: SentenceAssembler | undefined;
	#streamQueue = new StreamSpeakQueue(() => this.#now());
	#streamSignal: AbortSignal | undefined;
	#streamActive = false;
	#streamHadAudio = false;
	/** Bumped each agent/stream turn — stale reconcile callbacks must no-op. */
	#streamTurnId = 0;
	/** True while Ctrl+Alt+E / edit holds auto-submit + fluent re-listen. */
	#editHold = false;
	#editWaiter: {
		resolve: (text: string) => void;
		reject: (err: Error) => void;
	} | undefined;
	/** STT latency stages (ms since epoch via deps.now / Date). */
	#sttTiming: SttTimingSnapshot = {};
	#latency = {
		agentStartedAtMs: 0,
		firstTokenAtMs: 0,
		firstSentenceAtMs: 0,
		firstSynthAtMs: 0,
		firstPlaybackAtMs: 0,
		speakFinishedAtMs: 0,
		relistenAtMs: 0,
	};
	readonly deps: VoiceSessionDeps;

	#now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	constructor(deps: VoiceSessionDeps) {
		this.deps = deps;
		this.#config = deps.config ?? DEFAULT_VOICE_CONFIG;
		this.#terminalColumns = deps.terminalColumns ?? 80;
		this.#state = initialVoiceState({
			enabled: this.#config.enabled,
			mode: this.#config.behavior.mode,
			muted: this.#config.behavior.muted || this.#config.behavior.mode === "silent",
		});
		this.#meter = new VisualMeter({
			enabled: this.#config.behavior.visualWaves,
			maxFps: this.#config.behavior.visualFps,
			speechThreshold: this.#config.behavior.vadSpeechThreshold,
			terminalColumns: this.#terminalColumns,
			...(deps.now ? { now: deps.now } : {}),
			onPaint: () => {
				this.deps.onChromeUpdate?.();
			},
		});
		this.#meter.setSimpleSpeakingActivity(false);
	}

	get state(): VoiceMachineState {
		return this.#state;
	}

	get config(): VoiceConfig {
		return this.#config;
	}

	statusLine(): string {
		const base = describeVoiceStatus(this.#state);
		return this.#lastTranscript
			? `${base} · last="${this.#lastTranscript.slice(0, 80)}"`
			: base;
	}

	get lastTranscript(): string {
		return this.#lastTranscript;
	}

	get lastCorrection(): SttCorrectionResult | undefined {
		return this.#lastCorrection;
	}

	get pendingReviewText(): string {
		return this.#pendingReviewText;
	}

	get lastLabDiag(): string {
		return this.#lastLabDiag;
	}

	get lastSubmitTurnId(): string {
		return this.#lastSubmitTurnId;
	}

	get lastTtsEngineId(): string {
		return this.#lastTtsEngineId || this.deps.tts.id;
	}

	get lastTtsFallbackReason(): string {
		return this.#lastTtsFallbackReason;
	}

	get micReady(): boolean {
		return this.#micReady;
	}

	get listenDiag(): ListenCycleDiag {
		return { ...this.#listenDiag };
	}

	get streamMetrics() {
		return this.#streamQueue.metrics;
	}

	get latencySnapshot() {
		return { ...this.#latency };
	}

	get streamActive(): boolean {
		return this.#streamActive;
	}

	get editHold(): boolean {
		return this.#editHold;
	}

	get streamTurnId(): number {
		return this.#streamTurnId;
	}

	/** Exact last transcript voice submitted (for /gentle:voice edit). */
	get lastSubmittedText(): string {
		return this.#lastSubmittedText;
	}

	get sttTiming(): SttTimingSnapshot {
		return { ...this.#sttTiming };
	}

	/**
	 * Pause auto-submit + fluent re-listen. Does NOT kill an active capture —
	 * call {@link finishListenForEdit} to end capture and keep the PCM.
	 */
	beginEditHold(): void {
		this.#editHold = true;
		this.cancelScheduledListen();
	}

	endEditHold(): void {
		this.#editHold = false;
		if (this.#editWaiter) {
			this.#editWaiter.reject(new Error("edit_hold_ended"));
			this.#editWaiter = undefined;
		}
	}

	#resolveEditWaiter(text: string): void {
		const w = this.#editWaiter;
		this.#editWaiter = undefined;
		w?.resolve(text);
	}

	/**
	 * Capture-aware edit:
	 * - listening/transcribing → hold, finish capture, return CURRENT transcript
	 * - idle with last submit → return that (caller labels as resend)
	 * - silence / empty → empty text
	 */
	async prepareVoiceEdit(): Promise<VoiceEditPrep> {
		if (this.#state.phase === "awaiting_agent" || this.#state.phase === "speaking") {
			return { kind: "busy", text: "" };
		}
		this.beginEditHold();

		if (this.#state.phase === "listening") {
			const wait = this.#armEditWaiter();
			await this.finishListen();
			await this.flush();
			try {
				const text = (await wait).trim();
				if (!text) return { kind: "empty_capture", text: "" };
				this.#pendingReviewText = text;
				return { kind: "current", text };
			} catch {
				return { kind: "empty_capture", text: "" };
			}
		}

		if (this.#state.phase === "transcribing") {
			try {
				const text = (await this.#armEditWaiter()).trim();
				if (!text) return { kind: "empty_capture", text: "" };
				this.#pendingReviewText = text;
				return { kind: "current", text };
			} catch {
				return { kind: "empty_capture", text: "" };
			}
		}

		const last = this.#lastSubmittedText.trim();
		if (last) return { kind: "last", text: last };
		const draft = this.#pendingReviewText.trim();
		if (draft) return { kind: "current", text: draft };
		this.endEditHold();
		return { kind: "empty", text: "" };
	}

	#armEditWaiter(timeoutMs = 90_000): Promise<string> {
		if (this.#pendingReviewText.trim() && this.#state.phase === "idle") {
			return Promise.resolve(this.#pendingReviewText);
		}
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.#editWaiter) {
					this.#editWaiter = undefined;
					reject(new Error("edit_transcript_timeout"));
				}
			}, timeoutMs);
			timer.unref?.();
			this.#editWaiter = {
				resolve: (t) => {
					clearTimeout(timer);
					resolve(t);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			};
		});
	}

	/**
	 * Cancel capture/TTS/stream queue. Does not disable the session.
	 * Used by Esc / edit / new user turn. Does not call host agent abort.
	 */
	cancelVoiceAudio(reason = "cancel"): void {
		this.cancelScheduledListen();
		this.#speakEpoch += 1;
		this.#streamTurnId += 1;
		// Drain active capture before/with abort so AbortError is handled and
		// a later Ctrl+Alt+Space cannot trip an orphaned rejection.
		const stopCapture = this.#captureStop;
		this.#captureStop = undefined;
		this.#bag.abortAll();
		if (stopCapture) {
			void Promise.resolve(stopCapture()).catch((error) => {
				if (isAbortError(error)) return;
				const message = error instanceof Error ? error.message : String(error);
				this.dispatch({ type: "FAIL", error: message });
			});
		}
		this.#streamQueue.cancel();
		this.#streamActive = false;
		this.#streamHadAudio = false;
		this.#streamAssembler = undefined;
		this.#streamSignal = undefined;
		this.#pendingSpeakText = "";
		this.#meter.stopPlaybackVisual();
		this.#labDiagLine(`voice_cancel=${reason}`);
		// Stop listen/speak phases. Do NOT stop mid-transcribe — caller may
		// be about to dispatch TRANSCRIBE_DONE (auto-submit).
		if (this.#state.phase === "listening" || this.#state.phase === "speaking") {
			this.dispatch({ type: "STOP" });
		}
		this.deps.onChromeUpdate?.();
	}

	/** Replace pending transcript before explicit send (empty clears). */
	setReviewDraft(text: string): void {
		this.#pendingReviewText = text.trim();
		if (this.#pendingReviewText) this.#lastTranscript = this.#pendingReviewText;
	}

	/**
	 * Explicit send to the agent. Rejects empty / duplicate while awaiting.
	 * Does not auto-fire from STT when autoSubmitTranscript is false.
	 */
	async submitPending(overrideText?: string): Promise<
		"sent" | "empty" | "duplicate" | "busy" | "disabled"
	> {
		if (!this.#state.enabled) return "disabled";
		if (this.#submitOpen || this.#state.phase === "awaiting_agent" || this.#state.phase === "speaking") {
			const text = (overrideText ?? this.#pendingReviewText).trim();
			if (this.#submitOpen && text && text === this.#lastSubmittedText) return "duplicate";
			return "busy";
		}
		const text = (overrideText ?? this.#pendingReviewText).trim();
		if (!text) return "empty";
		// Cancel any obsolete TTS from a prior turn before submitting.
		this.cancelVoiceAudio("new_submit");
		this.#editHold = false;
		this.#pendingReviewText = "";
		this.#lastSubmittedText = text;
		this.#lastTranscript = text;
		this.#submitOpen = true;
		this.dispatch({ type: "SUBMIT_REVIEW", text });
		await this.flush();
		return "sent";
	}

	/**
	 * Lab / direct speak path (test-speak). Honors mute before any TTS work.
	 * When muted/disabled: returns immediately — no Piper, no WAV, no notify effects.
	 * Caller owns the single user-facing status message.
	 */
	async speakDirect(text: string): Promise<"played" | "muted" | "disabled" | "empty"> {
		const trimmed = text.trim();
		if (!trimmed) return "empty";
		// Fail closed before synthesis: never spawn Piper / write temp WAV while muted.
		if (!this.#state.enabled) return "disabled";
		if (this.#state.muted) {
			this.#pendingSpeakText = "";
			return "muted";
		}
		this.#speakEpoch += 1;
		this.#bag.abortAll();
		this.#pendingSpeakText = renderForSpeech(trimmed, {
			language: this.#config.engines.language === "auto" ? "es" : this.#config.engines.language,
			mode: this.#config.behavior.speechMode,
			cwd: process.cwd(),
		}).spoken;
		this.dispatch({ type: "SPEAK_NOW" });
		await this.flush();
		if (this.#state.muted) return "muted";
		return "played";
	}

	replaceConfig(config: VoiceConfig): void {
		this.#config = config;
		this.#meter.setEnabled(config.behavior.visualWaves);
		this.dispatch({ type: "SET_MODE", mode: config.behavior.mode });
		const silent = (config.behavior.mode as string) === "silent";
		if (config.behavior.muted || silent) {
			this.dispatch({ type: "MUTE" });
		} else if (!config.behavior.muted && this.#state.muted && !silent) {
			this.dispatch({ type: "UNMUTE" });
		}
		if (config.enabled && !this.#state.enabled) this.dispatch({ type: "ENABLE" });
		if (!config.enabled && this.#state.enabled) this.dispatch({ type: "DISABLE" });
	}

	/** Live chrome overlay for updateChrome (real meter only). */
	chromeVisual(): VoiceChromeVisual {
		const wavesOn = this.#config.behavior.visualWaves && !this.#state.muted;
		const stage = this.#meter.speakStage;
		const showWave =
			wavesOn
			&& this.#micReady
			&& (this.#state.phase === "listening"
				|| stage === "speaking"
				|| this.#state.phase === "speaking");
		return {
			speakStage: stage,
			speechDetected: this.#meter.wave.speechDetected,
			...(showWave ? { waveLine: this.#meter.wave.render() } : {}),
			simpleSpeakingActivity: this.#simpleSpeakingActivity,
			terminalColumns: this.#terminalColumns,
			micReady: this.#state.phase === "listening" ? this.#micReady : true,
		};
	}

	/** Perf counters for lab measurement (FPS, paint latency). */
	visualMetrics() {
		return this.#meter.metrics;
	}

	setTerminalColumns(cols: number): void {
		// Full terminal width for chrome narrow/wide decision.
		this.#terminalColumns = Math.max(20, cols);
		// Cap wave bars to ~header text length (avoid full-terminal "waybar").
		this.#meter.setTerminalColumns(Math.min(this.#terminalColumns, 44));
	}

	/** Cancel pending fluent re-listen (session end / dispose). */
	cancelScheduledListen(): void {
		if (this.#relistenTimer) {
			clearTimeout(this.#relistenTimer);
			this.#relistenTimer = undefined;
		}
	}

	/**
	 * After a conversation turn settles: open capture immediately.
	 * Echo settle is applied as VAD arm delay inside capture (PCM buffered,
	 * chrome shows ARMING until first sample — not fake LISTENING).
	 */
	scheduleFluentRelisten(): void {
		if (!this.#config.behavior.fluentConversation) return;
		if (!this.#state.enabled) return;
		if (this.#state.mode === "dictation") return;
		if (this.#editHold) return;
		if (this.#streamActive || this.#streamQueue.isBusy) return;
		this.cancelScheduledListen();
		// Tiny teardown only — real echo hold is vadArmDelayMs on capture start.
		const delay = 0;
		this.#latency = { ...this.#latency, relistenAtMs: this.#now() };
		this.#relistenTimer = setTimeout(() => {
			this.#relistenTimer = undefined;
			if (!this.#config.behavior.fluentConversation) return;
			if (!this.#state.enabled) return;
			if (this.#editHold) return;
			if (this.#streamActive || this.#streamQueue.isBusy) return;
			if (this.#state.phase === "listening" || this.#state.phase === "speaking") return;
			if (this.#state.phase === "awaiting_agent" || this.#state.phase === "transcribing") return;
			this.#listenDiag = {
				listenRequestedAtMs: this.#now(),
				micReady: false,
				widgetActivityAtListen: "ARMING",
			};
			this.#micReady = false;
			this.dispatch({ type: "LISTEN" });
			void this.flush().then(() => this.deps.onChromeUpdate?.());
		}, delay);
		this.#relistenTimer.unref?.();
	}

	/**
	 * Start incremental speak pipeline for the current agent turn.
	 * Persona/style come from Pi text deltas — no rewrite here.
	 * Invalidates any prior turn's queue/playback (no cross-turn audio).
	 */
	beginStreamSpeak(): void {
		if (!this.#state.enabled || this.#state.muted) return;
		if (this.#state.mode !== "conversation") return;
		// Kill obsolete playback from turn A before turn B can stream.
		this.#speakEpoch += 1;
		this.#streamTurnId += 1;
		const turnId = this.#streamTurnId;
		this.#bag.abortAll();
		this.#streamQueue.cancel();
		this.#meter.stopPlaybackVisual();
		this.#streamAssembler = new SentenceAssembler({
			language: this.#config.engines.language === "auto" ? "es" : this.#config.engines.language,
			// 2D.5 Strategy B: group short sentences for less choppy prosody.
			minSentencesPerUnit: 2,
			minCharsPerUnit: 140,
			softFlushChars: 280,
			longSentenceChars: 200,
			speechMode: this.#config.behavior.speechMode,
			cwd: process.cwd(),
		});
		this.#streamQueue.begin();
		this.#streamActive = true;
		this.#streamHadAudio = false;
		this.#streamSignal = this.#bag.derive();
		this.#pendingSpeakText = "";
		this.#latency = {
			...this.#latency,
			agentStartedAtMs: this.#now(),
			firstTokenAtMs: 0,
			firstSentenceAtMs: 0,
			firstSynthAtMs: 0,
			firstPlaybackAtMs: 0,
			speakFinishedAtMs: 0,
			relistenAtMs: 0,
		};
		this.#labDiagLine(`stream_begin turn=${turnId}`);
	}

	/**
	 * Feed a Pi `message_update` event. Only `text_delta` is spoken.
	 * Thinking / toolcall events block further speculative streaming.
	 */
	onMessageUpdate(event: unknown): void {
		if (!this.#streamActive || !this.#streamAssembler) return;
		if (this.#state.muted) {
			this.cancelStreamSpeak();
			return;
		}
		if (isNonSpeakableAssistantEvent(event)) {
			this.#streamQueue.markBlocked("tool_or_thinking");
			this.#labDiagLine("stream_blocked=tool_or_thinking");
			return;
		}
		const delta = extractTextDeltaFromMessageUpdate(event);
		if (!delta) return;
		this.#streamQueue.markFirstDelta();
		if (!this.#latency.firstTokenAtMs) {
			this.#latency = { ...this.#latency, firstTokenAtMs: this.#now() };
		}
		const units = this.#streamAssembler.pushDelta(delta);
		if (units.length === 0) return;
		if (!this.#latency.firstSentenceAtMs) {
			this.#latency = { ...this.#latency, firstSentenceAtMs: this.#now() };
		}
		this.#streamQueue.enqueue(units);
		const signal = this.#streamSignal ?? this.#bag.derive();
		void this.#streamQueue.kick((unit, sig) => this.#playStreamUnit(unit.speakable, sig), signal);
	}

	cancelStreamSpeak(): void {
		this.#streamActive = false;
		this.#streamAssembler = undefined;
		this.#streamQueue.cancel();
		this.#streamSignal = undefined;
		this.#meter.stopPlaybackVisual();
	}

	#labDiagLine(extra: string): void {
		this.#lastLabDiag = extra;
		this.deps.onLabDiag?.(extra);
	}

	async #playStreamUnit(speakable: string, signal: AbortSignal): Promise<void> {
		const turnAtStart = this.#streamTurnId;
		if (!speakable || this.#state.muted || signal.aborted) return;
		if (!this.#latency.firstSynthAtMs) {
			this.#latency = { ...this.#latency, firstSynthAtMs: this.#now() };
		}
		this.#meter.beginSynthesizing();
		this.deps.onChromeUpdate?.();
		this.#lastTtsEngineId = this.deps.tts.id;
		const { audio } = await this.deps.tts.synthesize(speakable, { signal });
		if (signal.aborted || this.#state.muted || turnAtStart !== this.#streamTurnId) return;
		const canScrub =
			audio.format === "wav"
			|| audio.format === "pcm_s16le"
			|| audio.format === "raw";
		this.#simpleSpeakingActivity = !canScrub;
		this.#meter.setSimpleSpeakingActivity(!canScrub);
		this.#meter.beginSpeakingFromAudio(audio);
		this.deps.onChromeUpdate?.();
		if (!this.#latency.firstPlaybackAtMs) {
			this.#latency = { ...this.#latency, firstPlaybackAtMs: this.#now() };
		}
		const handle = await this.deps.playback.play(audio, { signal });
		await handle.done;
		// Cancelled / superseded turn: do not mark as spoken.
		if (signal.aborted || turnAtStart !== this.#streamTurnId || this.#state.muted) return;
		this.#streamHadAudio = true;
		this.#streamAssembler?.markSpoken(speakable);
		this.#meter.stopPlaybackVisual();
		this.deps.onChromeUpdate?.();
	}

	dispatch(event: VoiceMachineEvent): VoiceMachineState {
		const transition = reduceVoiceState(this.#state, event);
		if (!transition.changed && transition.effects.length === 0) return this.#state;
		this.#state = transition.state;
		// Abort in-flight synth/playback immediately — do not wait for the effect
		// queue (otherwise STOP would only cancel after Piper finished).
		const needsEagerCancel = transition.effects.some(
			(e) =>
				e.type === "cancel_tts"
				|| e.type === "cancel_playback"
				|| e.type === "cancel_stt",
		);
		if (needsEagerCancel) {
			this.#bag.abortAll();
		}
		this.#effectChain = this.#effectChain.then(() => this.#runEffects(transition.effects));
		return this.#state;
	}

	/** Wait for queued side effects (tests / command handlers). */
	async flush(): Promise<void> {
		await this.#effectChain;
	}

	/**
	 * Host hook: agent run settled — reconcile stream or fallback to full TTS.
	 * Does not rewrite persona; speaks agent text as-is (TTS normalize only).
	 */
	onAgentSettled(input: {
		message?: AssistantMessageLike | null;
		outcome?: "completed" | "aborted" | "error";
	}): FinalSpeakDecision {
		this.#submitOpen = false;

		const utterance = buildFinalUtterance({
			message: input.message,
			outcome: input.outcome,
			maxSentences: this.#config.behavior.maxSpokenSentences,
			maxChars: this.#config.behavior.maxSpokenChars,
		});

		if (utterance.reason === "unfaithful_skip_show_full" && utterance.text) {
			this.deps.notify?.(
				`Reply (written only — not spoken; could not summarize faithfully):\n${utterance.text}`,
				"info",
			);
		}

		const maySpeak = utterance.speak
			&& this.#state.mode === "conversation"
			&& !this.#state.muted
			&& this.#state.enabled
			&& input.outcome !== "aborted"
			&& (input.outcome !== "error" || this.#config.behavior.speakWarnings);

		const streamMetrics = this.#streamQueue.metrics;
		const streamWasActive = this.#streamActive || this.#streamHadAudio;
		const streamBlocked = streamMetrics.mode === "blocked";
		const settleTurnId = this.#streamTurnId;

		// ——— Incremental path: flush remainder, no duplicate full TTS ———
		if (streamWasActive && maySpeak && !streamBlocked && this.#streamAssembler) {
			const flushed = this.#streamAssembler.flush();
			this.#streamQueue.enqueue(flushed);
			const remainder = this.#streamAssembler.remainderForFinal(utterance.text);
			if (remainder) {
				this.#streamAssembler.markEmitted(remainder);
				this.#streamQueue.enqueue([{
					id: "reconcile",
					raw: remainder,
					speakable: remainder,
				}]);
			}
			this.#streamActive = false;
			const signal = this.#streamSignal ?? this.#bag.derive();
			void this.#streamQueue
				.kick((unit, sig) => this.#playStreamUnit(unit.speakable, sig), signal)
				.then(async () => {
					await this.#streamQueue.idle();
					// Stale settle from turn A after turn B began — do nothing.
					if (settleTurnId !== this.#streamTurnId) {
						this.#labDiagLine(`stream_reconcile_stale turn=${settleTurnId}`);
						return;
					}
					this.#streamQueue.markDone();
					this.#latency = { ...this.#latency, speakFinishedAtMs: this.#now() };
					this.#streamAssembler = undefined;
					this.#streamSignal = undefined;
					this.#streamHadAudio = false;
					this.#meter.stopPlaybackVisual();
					// Leave awaiting_agent → idle without classic start_tts.
					if (this.#state.phase === "awaiting_agent") {
						this.dispatch({ type: "AGENT_SETTLED", speak: false });
					} else if (this.#state.phase === "speaking") {
						this.dispatch({ type: "SPEAK_DONE" });
					}
					this.deps.onSpeakFinished?.();
					this.deps.onChromeUpdate?.();
				});
			return {
				speak: true,
				text: utterance.text,
				reason: `${utterance.reason}+stream_reconcile`,
				streamed: true,
			};
		}

		// Stream blocked by tools/thinking → prefer reliable final TTS.
		if (streamWasActive && streamBlocked) {
			this.#streamQueue.cancel();
			this.#streamAssembler = undefined;
			this.#streamActive = false;
			this.#streamQueue.markFallback();
			this.#labDiagLine(
				`stream_fallback=${streamMetrics.blockedReason ?? "blocked"}`,
			);
		} else {
			this.cancelStreamSpeak();
		}

		// Invalidate any prior playback before starting a new spoken conclusion.
		this.#speakEpoch += 1;
		this.#bag.abortAll();
		this.#pendingSpeakText = maySpeak
			? renderForSpeech(utterance.text, {
				language: this.#config.engines.language === "auto" ? "es" : this.#config.engines.language,
				mode: this.#config.behavior.speechMode,
				cwd: process.cwd(),
			}).spoken
			: "";
		const willSpeak = Boolean(maySpeak && this.#pendingSpeakText);
		this.dispatch({ type: "AGENT_SETTLED", speak: willSpeak });
		if (!willSpeak) {
			this.scheduleFluentRelisten();
		}
		return {
			speak: willSpeak,
			text: maySpeak ? utterance.text : "",
			reason: streamBlocked
				? `${utterance.reason}+stream_fallback`
				: utterance.reason,
			streamed: false,
		};
	}

	async #runEffects(effects: readonly VoiceEffect[]): Promise<void> {
		for (const effect of effects) {
			try {
				await this.#runEffect(effect);
			} catch (error) {
				if (isAbortError(error)) continue;
				const message = error instanceof Error ? error.message : String(error);
				this.dispatch({ type: "FAIL", error: message });
			}
		}
	}

	async #runEffect(effect: VoiceEffect): Promise<void> {
		switch (effect.type) {
			case "notify":
				this.deps.notify?.(effect.message, effect.level);
				return;
			case "start_capture": {
				const signal = this.#bag.derive();
				// Echo control: never capture while TTS is active.
				if (this.#state.phase === "speaking" || this.#streamQueue.isBusy) {
					this.deps.notify?.("Capture skipped — TTS playing (echo guard).", "warning");
					return;
				}
				this.#meter.stopPlaybackVisual();
				this.#meter.wave.clear();
				this.#micReady = false;
				const captureStartedAtMs = this.#now();
				this.#listenDiag = {
					...this.#listenDiag,
					listenRequestedAtMs: this.#listenDiag.listenRequestedAtMs ?? captureStartedAtMs,
					captureStartedAtMs,
					micReady: false,
					widgetActivityAtListen: "ARMING",
				};
				const vadArmDelayMs = this.#config.behavior.fluentConversation
					? Math.max(0, this.#config.behavior.echoSettleMs)
					: 0;
				const session = await this.deps.capture.start({
					signal,
					vadArmDelayMs,
					onFirstPcm: (info) => {
						this.#micReady = true;
						this.#listenDiag = {
							...this.#listenDiag,
							firstPcmAtMs: info.atMs,
							micReady: true,
							widgetActivityAtListen: "LISTENING",
						};
						this.#labDiagLine(
							`mic_ready cap=${info.captureId.slice(0, 8)} firstPcmMs=${
								info.atMs - (this.#listenDiag.captureStartedAtMs ?? info.atMs)
							}`,
						);
						this.deps.onChromeUpdate?.();
					},
					onPcmChunk: (pcm, meta) => {
						if (!this.#config.behavior.visualWaves || this.#state.muted) return;
						this.#meter.pushCapturePcm(pcm, meta.channels);
					},
				});
				this.#captureStop = async () => {
					const audio = await session.stop(signal);
					if (audio.captureMeta?.speechSeenLatencyMs !== undefined) {
						this.#listenDiag = {
							...this.#listenDiag,
							speechSeenAtMs:
								(this.#listenDiag.captureStartedAtMs ?? 0)
								+ audio.captureMeta.speechSeenLatencyMs,
						};
					}
					this.#micReady = false;
					this.#meter.wave.clear();
					this.dispatch({ type: "CAPTURE_DONE" });
					await this.#transcribe(audio, signal);
				};
				// ARMING until onFirstPcm — do not claim LISTENING yet.
				this.deps.onChromeUpdate?.();
				return;
			}
			case "stop_capture": {
				const stop = this.#captureStop;
				this.#captureStop = undefined;
				if (stop) await stop();
				this.#meter.wave.clear();
				this.deps.onChromeUpdate?.();
				return;
			}
			case "cancel_stt":
			case "cancel_tts":
			case "cancel_playback":
				this.#bag.abortAll();
				this.#streamQueue.cancel();
				this.#streamActive = false;
				this.#streamAssembler = undefined;
				this.#streamSignal = undefined;
				this.#meter.stopPlaybackVisual();
				this.deps.onChromeUpdate?.();
				return;
			case "submit_transcript":
				await this.deps.submitTranscript?.(effect.text);
				return;
			case "present_transcript":
				this.#lastTranscript = effect.text;
				this.#pendingReviewText = effect.text;
				await this.deps.presentTranscript?.(effect.text);
				return;
			case "start_tts": {
				const text = this.#pendingSpeakText;
				this.#pendingSpeakText = "";
				const epoch = this.#speakEpoch;
				if (!text || this.#state.muted) {
					this.#meter.stopPlaybackVisual();
					this.dispatch({ type: "SPEAK_DONE" });
					this.deps.onSpeakFinished?.();
					return;
				}
				const signal = this.#bag.derive();
				try {
					// SYNTHESIZING: no voice waves until real playback starts.
					this.#meter.beginSynthesizing();
					this.deps.onChromeUpdate?.();
					this.#lastTtsEngineId = this.deps.tts.id;
					this.#lastTtsFallbackReason = "";
					const { audio } = await this.deps.tts.synthesize(text, { signal });
					if (epoch !== this.#speakEpoch || this.#state.muted || signal.aborted) {
						this.#meter.stopPlaybackVisual();
						this.dispatch({ type: "SPEAK_DONE" });
						this.deps.onSpeakFinished?.();
						return;
					}
					// SPEAKING: amplitude from real WAV/PCM window at wall-clock t.
					// pw-play has no byte cursor — position is estimated; samples are real.
					const canScrub =
						audio.format === "wav"
						|| audio.format === "pcm_s16le"
						|| audio.format === "raw";
					this.#simpleSpeakingActivity = !canScrub;
					this.#meter.setSimpleSpeakingActivity(!canScrub);
					this.#meter.beginSpeakingFromAudio(audio);
					this.deps.onChromeUpdate?.();
					const handle = await this.deps.playback.play(audio, { signal });
					await handle.done;
					this.#meter.stopPlaybackVisual();
					this.deps.onChromeUpdate?.();
					if (epoch !== this.#speakEpoch) {
						this.dispatch({ type: "SPEAK_DONE" });
						this.deps.onSpeakFinished?.();
						return;
					}
					this.dispatch({ type: "SPEAK_DONE" });
					this.deps.onSpeakFinished?.();
				} catch (error) {
					this.#meter.stopPlaybackVisual();
					this.deps.onChromeUpdate?.();
					// Cancel during synth/playback must leave phase idle (no orphan "speaking").
					if (error instanceof AbortError || signal.aborted || epoch !== this.#speakEpoch) {
						this.dispatch({ type: "SPEAK_DONE" });
						this.deps.onSpeakFinished?.();
						return;
					}
					// TTS failure: recover fluent loop instead of staying blocked.
					this.dispatch({ type: "SPEAK_DONE" });
					this.deps.onSpeakFinished?.();
					this.deps.notify?.(
						error instanceof Error ? error.message : String(error),
						"error",
					);
					return;
				}
				return;
			}
			default: {
				const _never: never = effect;
				return _never;
			}
		}
	}

	async #transcribe(audio: AudioChunk, signal: AbortSignal): Promise<void> {
		const language =
			this.#config.engines.language === "auto" ? "es" : this.#config.engines.language;
		const transcriptionId = randomUUID();
		const meta = audio.captureMeta;
		const prompt =
			this.deps.whisperInitialPrompt?.trim() || DEFAULT_WHISPER_INITIAL_PROMPT;
		const t0 = this.#now();
		this.#sttTiming = {
			captureEndAtMs: t0,
			silenceHangMsConfigured: this.#config.behavior.silenceMs,
			...(meta?.durationMs !== undefined
				? { captureDurationMs: meta.durationMs }
				: {}),
			...(meta?.speechSeenLatencyMs !== undefined
				? { speechSeenLatencyMs: meta.speechSeenLatencyMs }
				: {}),
		};

		// P0: no speech validated → do not call Whisper (avoids prompt hallucination on silence).
		if (meta && !meta.speechSeen) {
			this.#lastLabDiag =
				`tx=${transcriptionId.slice(0, 8)} skip_stt=no_speech_seen ${meta.captureId.slice(0, 8)} end=${meta.endReason} durMs=${meta.durationMs}`;
			this.deps.onLabDiag?.(this.#lastLabDiag);
			this.#lastCorrection = undefined;
			this.#pendingReviewText = "";
			this.dispatch({ type: "TRANSCRIBE_EMPTY" });
			if (this.#editHold) {
				this.#resolveEditWaiter("");
				return;
			}
			this.scheduleFluentRelisten();
			return;
		}

		const whisperStart = this.#now();
		this.#sttTiming = { ...this.#sttTiming, whisperStartAtMs: whisperStart };
		const result = await this.deps.stt.transcribe(audio, {
			signal,
			language,
		});
		const whisperEnd = this.#now();
		this.#sttTiming = {
			...this.#sttTiming,
			whisperEndAtMs: whisperEnd,
			whisperMs: whisperEnd - whisperStart,
		};
		const raw = result.text.trim();
		if (!raw) {
			this.#lastLabDiag =
				`tx=${transcriptionId.slice(0, 8)} whisper_empty silence_ok=1 ${meta ? `cap=${meta.captureId.slice(0, 8)}` : ""} whisperMs=${this.#sttTiming.whisperMs ?? "?"}`;
			this.deps.onLabDiag?.(this.#lastLabDiag);
			this.#lastCorrection = undefined;
			this.#pendingReviewText = "";
			this.dispatch({ type: "TRANSCRIBE_EMPTY" });
			if (this.#editHold) {
				this.#resolveEditWaiter("");
				return;
			}
			this.scheduleFluentRelisten();
			return;
		}
		const corrStart = this.#now();
		const correction = this.deps.disableSttCorrections
			? {
				original: raw,
				corrected: raw,
				applied: [] as const,
				changed: false,
			}
			: applySttCorrections(raw, this.deps.sttCorrectionRules);
		this.#lastCorrection = correction;
		const text = correction.corrected;
		this.#sttTiming = {
			...this.#sttTiming,
			correctionsMs: this.#now() - corrStart,
		};

		const gateStart = this.#now();
		const gate = gateUtteranceForAutoSubmit({
			text,
			...(meta ? { captureMeta: meta } : {}),
			whisperPrompt: prompt,
		});
		const nowAfterGate = this.#now();
		this.#sttTiming = {
			...this.#sttTiming,
			gateMs: nowAfterGate - gateStart,
			totalPostCaptureMs: nowAfterGate - t0,
		};
		this.#lastLabDiag =
			`tx=${transcriptionId.slice(0, 8)} ${gate.diag} whisperMs=${this.#sttTiming.whisperMs ?? "?"} totalSttMs=${nowAfterGate - t0} silenceCfg=${this.#config.behavior.silenceMs}`;
		this.deps.onLabDiag?.(this.#lastLabDiag);

		// Edit hold: never auto-submit; hand transcript to editor waiter.
		if (this.#editHold) {
			this.#pendingReviewText = text;
			this.#lastTranscript = text;
			this.dispatch({ type: "TRANSCRIBE_REVIEW", text });
			this.#sttTiming = {
				...this.#sttTiming,
				submitAtMs: this.#now(),
				submitted: false,
				totalPostCaptureMs: this.#now() - t0,
			};
			this.#resolveEditWaiter(text);
			return;
		}

		// Dictation never auto-submits — editable review only.
		const wantAuto =
			this.#config.behavior.autoSubmitTranscript
			&& this.#state.mode === "conversation";

		if (!wantAuto) {
			this.#pendingReviewText = text;
			this.dispatch({ type: "TRANSCRIBE_REVIEW", text });
			if (correction.changed) {
				this.deps.notify?.(formatCorrectionDiff(correction), "info");
			}
			return;
		}

		if (!gate.accept) {
			// Unreliable → manual review (or silence), never auto-send.
			this.#pendingReviewText = "";
			if (gate.reason === "prompt_echo" || gate.reason === "no_speech_seen" || gate.reason === "rms_too_low") {
				this.deps.notify?.(
					`Voice skipped auto-send (${gate.reason}). Silence/noise ignored.`,
					"info",
				);
				this.dispatch({ type: "TRANSCRIBE_EMPTY" });
				this.scheduleFluentRelisten();
				return;
			}
			this.#pendingReviewText = text;
			this.dispatch({ type: "TRANSCRIBE_REVIEW", text });
			this.deps.notify?.(
				`Auto-send blocked (${gate.reason}) — review draft, then /gentle:voice send.`,
				"warning",
			);
			return;
		}

		if (this.#submitOpen && text === this.#lastSubmittedText) {
			this.#lastLabDiag += " anti_dup=hit";
			this.deps.onLabDiag?.(this.#lastLabDiag);
			this.deps.notify?.("Duplicate transcript ignored.", "warning");
			this.#pendingReviewText = "";
			this.dispatch({ type: "TRANSCRIBE_EMPTY" });
			if (this.#config.behavior.fluentConversation) this.scheduleFluentRelisten();
			return;
		}

		const turnId = randomUUID();
		this.#lastSubmitTurnId = turnId;
		this.#lastSubmittedText = text;
		this.#lastTranscript = text;
		this.#pendingReviewText = ""; // do not reuse draft on next silence
		this.#submitOpen = true;
		this.cancelVoiceAudio("auto_submit");
		const submitAt = this.#now();
		this.#sttTiming = {
			...this.#sttTiming,
			submitAtMs: submitAt,
			submitted: true,
			totalPostCaptureMs: submitAt - t0,
		};
		this.#lastLabDiag += ` submitTurn=${turnId.slice(0, 8)}`;
		this.deps.onLabDiag?.(this.#lastLabDiag);
		this.dispatch({ type: "TRANSCRIBE_DONE", text });
	}

	/** End listen window (VAD / user stop) — phase 0 tests call this explicitly. */
	async finishListen(): Promise<void> {
		if (this.#state.phase !== "listening") return;
		const stop = this.#captureStop;
		this.#captureStop = undefined;
		if (stop) await stop();
		else this.dispatch({ type: "STOP" });
	}

	dispose(): void {
		this.cancelScheduledListen();
		this.cancelStreamSpeak();
		this.#bag.abortAll();
		this.#captureStop = undefined;
		this.#submitOpen = false;
		this.#speakEpoch += 1;
		this.#micReady = false;
		this.#meter.dispose();
		this.dispatch({ type: "DISABLE" });
	}
}

export interface FinalSpeakDecision {
	speak: boolean;
	text: string;
	reason: string;
	/** True when incremental stream covered (or will cover) playback. */
	streamed?: boolean;
}

export interface SttTimingSnapshot {
	/** Monotonic-ish wall clock from session #now() (Date.now by default). */
	readonly captureEndAtMs?: number;
	readonly captureDurationMs?: number;
	readonly speechSeenLatencyMs?: number;
	readonly silenceHangMsConfigured?: number;
	readonly whisperStartAtMs?: number;
	readonly whisperEndAtMs?: number;
	readonly whisperMs?: number;
	readonly correctionsMs?: number;
	readonly gateMs?: number;
	readonly submitAtMs?: number;
	readonly submitted?: boolean;
	/** End-to-end from capture end → submit (or edit handoff). */
	readonly totalPostCaptureMs?: number;
}

export type VoiceEditPrep =
	| { kind: "current"; text: string }
	| { kind: "last"; text: string }
	| { kind: "empty"; text: string }
	| { kind: "empty_capture"; text: string }
	| { kind: "busy"; text: string };
