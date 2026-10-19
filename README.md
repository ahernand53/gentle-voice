# Gentle Voice

Local voice conversation extension for **Pi Coding Agent** (STT + TTS).

Gentle Shell is **not** required. It is only an optional compatibility test host.

> Experimental lab project. Linux + PipeWire is the supported path.
> Windows / macOS are **not** claimed as supported.

## Recommended engines

| Role | Recommended | Fallback |
| --- | --- | --- |
| STT | Whisper.cpp | stubs (tests) |
| TTS | Kokoro (lab) / **Piper** (stable fallback) | stubs |

No automatic model downloads. No global package installs from this repo.

## Modes

| Mode | Behavior |
| --- | --- |
| **Conversation** | Hands-free listen → STT → optional auto-submit → agent reply → TTS → re-listen |
| **Dictation** | Capture → transcript for review; never auto-submits |
| **Silent** | Transcript path without TTS |

## Shortcuts

| Chord | Action |
| --- | --- |
| `Ctrl+Alt+Space` | Toggle / enable voice (registered only when verified free) |
| `Ctrl+Alt+E` | Edit current capture (or last sent voice line if idle) |
| `Esc` | Cancel capture / TTS / stream queue; abort agent if awaiting |

Check conflicts with Hyprland / terminal / Gentle Shell before enabling lab shortcuts.

### Ctrl+Alt+E (capture-aware)

1. If **listening** or **transcribing**: hold auto-submit, finish capture, transcribe, put **current** text in Pi’s editor.
2. If idle with a prior voice submit: load **last sent** line and notify that Enter **re-sends** (does not rewrite history).
3. Empty / silence captures are not treated as valid utterances.
4. Existing editor text is not overwritten without confirmation when the host supports `confirm`.

## Install (Linux)

```bash
git clone <your-fork-or-repo> gentle-voice
cd gentle-voice
# Use the Node version in package.json engines
npm install   # or pnpm install

# Point models/cache at YOUR writable paths (examples — do not hardcode others' homes)
export GENTLE_VOICE_HOME="$HOME/.local/share/gentle-voice"
export GENTLE_VOICE_MODELS="$GENTLE_VOICE_HOME/models"
export GENTLE_VOICE_CACHE="$GENTLE_VOICE_HOME/cache"
export GENTLE_VOICE_TMP="${TMPDIR:-/tmp}/gentle-voice"
```

Wire the extension into Pi per [docs/experimental-integration.md](docs/experimental-integration.md).

Lab-only real audio (developer machine):

```bash
export GENTLE_VOICE_LAB=1
# optional: GENTLE_VOICE_LAB_AUTO_SUBMIT=1  GENTLE_VOICE_LAB_DIAG=1
```

## Tests

```bash
npm test
# equivalent: node --experimental-strip-types --test tests/*.test.ts
```

Automated tests use stubs — **no LLM tokens**, no ElevenLabs, no network TTS.

## Architecture

See [docs/architecture.md](docs/architecture.md).

High level: `extensions/voice.ts` → `VoiceSession` → capture / Whisper / Piper|Kokoro / PipeWire playback.

Streaming TTS uses **Strategy B**: group ~2–3 short sentences (or ~140+ chars) per speak unit for less choppy prosody, while long sentences flush alone for first-audio latency.

## Privacy & cost

- Default path is **local** STT/TTS (no cloud required).
- ElevenLabs is design-only in this repo (budget helpers); do **not** enable remote TTS without reviewing cost and data retention of that provider.
- Do not commit `.env`, WAVs, transcripts, or model binaries (see `.gitignore`).

## Platform limits

| OS | Status |
| --- | --- |
| Linux (PipeWire) | Supported lab target |
| Windows | Not implemented / not tested |
| macOS | Not implemented / not tested |

## License

MIT — see [LICENSE](LICENSE). Engine models (Whisper, Piper, Kokoro) keep **their own** upstream licenses; this repo does not redistribute those binaries.
