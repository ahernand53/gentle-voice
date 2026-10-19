# Phase 2D.5 — voice UX stabilization

## Capture-aware edit (`Ctrl+Alt+E`)

- `VoiceSession.prepareVoiceEdit()` sets `editHold` **before** ending capture.
- Active listen → finish → STT → `kind: "current"` into Pi editor; auto-submit blocked.
- Idle + prior voice submit → `kind: "last"` with explicit resend notice.
- Empty / silence → no fake utterance.
- Late STT callbacks cannot submit while `editHold` is true.

## Streaming TTS naturalness (Strategy B)

- `SentenceAssembler` groups ~2–3 short sentences or ≥ ~140 chars per unit.
- Long sentences (≥ ~200 chars) flush alone to keep time-to-first-audio low.
- Continuous PCM merge across Kokoro invocations remains **deferred** (adapter still opens per unit); Piper stays fallback.
- Kokoro has limited prosody controls — grouping reduces choppiness; it does not invent intonation.

## STT latency

- Fluent lab converse caps `silenceMs` at **900** (was 1200 default).
- `sttTiming` snapshot: capture end, whisper start/end, corrections, gate, submit flags, configured silence.
- Dominant stage in human use is usually silence hang + Whisper cold start; do not gut silence indiscriminately.

## Human test checklist

1. Converse on → speak a new phrase → `Ctrl+Alt+E` **before** auto-send → editor shows **current** phrase.
2. Fix text → Enter → single submit.
3. Ask for a long answer → judge TTS continuity.
4. Measure pause after you stop speaking until agent receives / UI reacts.
5. Esc cancels audio cleanly; no ghost transcripts.

Phase 2D.5 is **not closed** until steps 1–3 pass human judgment.
