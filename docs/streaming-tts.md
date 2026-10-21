# Streaming TTS (Phase 3.6 increment 3)

## Pipeline

```
Pi text_delta → SentenceAssembler (early-first + Strategy B)
              → StreamSpeakQueue (prefetch depth=1)
              → Piper synthesize (unit N+1 while N plays)
              → PipeWire playback
```

Speech Renderer runs **only** on spoken units; written Pi text is untouched.

## Changes vs 2D.5 serial queue

| Before | After |
| --- | --- |
| `kick(synth+play)` serial | `kickPipeline({ synthesize, play })` |
| Wait full Piper of N+1 after play N ends | Prefetch clip N+1 during play N |
| `minSentencesPerUnit=2` delays first audio | `earlyFirstUnit`: first sentence alone (TTFA) |

## Cancel / Esc

`STOP` → `cancel_tts` / `cancel_playback` → `AbortSignal` + `StreamSpeakQueue.cancel()` drops `#queue` and `#ready`. No residual ready clips play into the next listen (echo arm / `vadArmDelayMs` unchanged).

## Voice

Piper `es_AR-daniela-high` unchanged.

## Lab A/B

```bash
node --experimental-strip-types scripts/streaming-tts-ab.mjs
```

Report: `gs-lab/logs/streaming-tts-ab-report.json`
