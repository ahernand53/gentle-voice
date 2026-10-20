# Phase 3.5 — reference voice packages (license-aware)

Inspected via `npm pack` into `/tmp` only — **not** installed into the user's Pi.

| Package | Version | License | Takeaways (ideas only — no code copy) |
| --- | --- | --- | --- |
| `@juicesharp/rpiv-voice` | 2.13.9 | MIT | Rolling **partial** transcripts; Whisper **hallucination filter** for silence artifacts; Silero VAD with energy fallback; native sample-rate fallback when 16 kHz refused; async decode so TUI does not freeze; sherpa-onnx stack (costly — not adopted here without a separate proposal) |
| `@agimon-ai/po-voice` | 0.0.0-alpha.29 | **BUSL-1.1** | Silero VAD worker; client capture activity with endpoint silence; narration + compose commands (`po send` / `po cancel`). **Do not copy** without BUSL review |
| `@agimon-ai/doompi-voice` | 0.0.1-alpha.129 | MIT | Similar capture/VAD/narration patterns to po-voice; barge-in aware VAD; 16 kHz PCM framing |

## Gentle Voice adoption (this phase)

- Keep Piper + whisper.cpp product path (no sherpa-onnx dependency yet).
- Document hallucination/silence filtering and variable sample-rate as **follow-ups** (inspired by rpiv MIT ideas, reimplemented if/when scheduled).
- Product hands-free conversation + honest shortcut status ship in 0.1.2 without copying reference code.

## Not doing now

- Installing these three packages on the real Pi.
- Adding sherpa-onnx / new models without cost & compat analysis.
