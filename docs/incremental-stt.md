# Incremental STT — phase 3.6 increment 2

## Goal

Show **provisional** Spanish transcripts while the user speaks, without sending incomplete text to Pi. Final submit remains **post-Silero VAD + full Whisper**.

## Audit summary

| Piece | Finding |
| --- | --- |
| Pipeline today | `pw-record` → Silero/energy VAD → stop → `whisper-cli` once → gate → Pi |
| whisper-cli streaming | **No** live stdin ASR; file-based batch only |
| whisper-server warm | Model load ~100 ms; **decode** dominates (~3.5–4 s on ggml-small CPU) |
| Concurrent CLI | Forbidden — saturates CPU; spike uses **single-flight** |

**Viable approach (no new models):** periodic full-buffer re-decode with at most one `whisper-cli`, replace provisional text wholesale (`…` in chrome). Classic path remains when `GENTLE_VOICE_INCREMENTAL_STT=0`.

**Honest latency:** first provisional helps **long** utterances; final wall time stays ~same as classic.

## Config

| Knob | Meaning |
| --- | --- |
| `behavior.incrementalStt` | Config flag (default `false`) |
| `GENTLE_VOICE_INCREMENTAL_STT=1` | Lab default in `launch-voice-lab.sh` |
| `=0` | Force classic fallback |

## Safety

- Partials never call `submitTranscript` / never set auto-send draft.
- Cancel / turn change bumps generation → stale results dropped.
- In-flight partial aborted before final STT.
- Ctrl+Alt+E, Esc, history, fluent loop, Silero unchanged.

## Stale / frozen partial UX (lab fix)

Root cause: single-flight Whisper decode lasts ~4–7 s on ggml-small, so the chrome
kept showing the last `…` text with no refresh.

Mitigations:

| Knob | Default | Effect |
| --- | --- | --- |
| `staleMs` | 3200 | Clear provisional if no new accept |
| `decodingHideMs` | 1800 | While busy, switch chrome to `⋯ escuchando` (no old words) |
| re-kick | after each decode | Next attempt without waiting for interval |

Chrome kinds: `… text` (partial) · `⋯ escuchando` (decoding) · `✓ text` (final).

## Tech vocabulary

- Whisper `--prompt` stays **product-only** (prompt-echo risk).
- Conservative post-corrections in `lib/stt/corrections.ts` (C-Charm→C#, Postgres SQL→PostgreSQL, …).
- ggml-small ES still limits rare tech terms — lexicon helps known mishears only.

## Measure

```bash
node --experimental-strip-types scripts/incremental-stt-ab.mjs
# → gs-lab/logs/incremental-stt-ab-report.json
```
