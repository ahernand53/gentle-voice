<div align="center">
  <img src="assets/gentle-logo-only.png" alt="Gentle AI logo" width="132" />

# Gentle Voice

**Local voice conversation for Pi Coding Agent (STT + TTS).**

[![Built for Pi](https://img.shields.io/badge/built%20for-Pi-6f42c1)](https://github.com/badlogic/pi-mono)
[![Gentle Shell](https://img.shields.io/badge/works%20with-gentle--shell-22c55e)](https://github.com/Gentleman-Programming/gentle-shell)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/gentle-voice.svg)](https://www.npmjs.com/package/gentle-voice)

</div>

Speak with your already-authenticated Pi / Gentle Shell model. Gentle Voice runs **local** speech-to-text and text-to-speech. It does **not** require OpenAI, ElevenLabs, or a second login.

> **Status:** `0.1.0` — installable on Linux (experimental). **Windows and macOS are not supported** until real hardware smoke tests pass.  
> An npm publish does **not** mean universal OS compatibility.

## Requirements

- Node.js ≥ 22.19 (same class as current Pi)
- Pi Coding Agent ≥ 1.2 **or** Gentle Shell that hosts Pi packages
- Linux + PipeWire recommended for real mic/speaker today
- Disk ≈ **220 MiB** for pinned Whisper + Piper + Daniela (one-time, after consent)
- Optional: `ffmpeg` on PATH for Windows/macOS portable audio fallbacks (**unverified** — do not rely on this)

## Install

```bash
# Pi
pi install npm:gentle-voice

# Gentle Shell
gentle-shell install npm:gentle-voice
```

From git (development / pre-publish):

```bash
pi install git:github.com/efolchmontiel/gentle-voice@v0.1.0
# or @main
```

Restart Pi / Gentle Shell after install.

### First run (automatic)

1. Start Pi / Gentle Shell — on `session_start` (and on first `/gentle:voice` / shortcut), Gentle Voice checks readiness.
2. If STT/TTS artifacts are missing, the host shows a consent dialog (licenses + size). Accept to download into the **private** data dir (XDG / LocalAppData / Application Support). No sudo, no PATH mutation, no Python/compiler required.
3. `/gentle:voice setup` remains for **diagnostics / repair / manual** re-consent — it is **not** required for first use.
4. Non-interactive automation only: `GENTLE_VOICE_AUTO_DOWNLOAD=1` (after reviewing licenses). Opt-out: `GENTLE_VOICE_DISABLE_DOWNLOADS=1`.
5. Attribution for the Daniela voice (CC-BY-SA-4.0) is in `THIRD_PARTY_NOTICES.md`.

## Commands & shortcuts

| Action | How |
| --- | --- |
| Toggle conversation | `Ctrl+Alt+Space` (when verified free) or `/gentle:voice` |
| Edit current / last voice line | `Ctrl+Alt+E` or `/gentle:voice edit` |
| Cancel capture / TTS | `Esc` (when voice is busy) |
| Setup / readiness | `/gentle:voice setup` |
| Status | `/gentle:voice status` |

Modes: **conversation** (default hands-free path) and **dictation** (review, no auto-send).

## Compatibility (honest)

| OS | Arch | Capture | Playback | STT/TTS | Notes |
| --- | --- | --- | --- | --- | --- |
| Linux | x64 | experimental | experimental | experimental | Clean-HOME auto-download + PipeWire smoke |
| Linux | arm64 | planned | planned | experimental (bins) | Binaries pinned; capture smoke pending |
| Windows | x64 | blocked | blocked | experimental (bins) | ffmpeg WASAPI adapters present — **no hardware smoke** |
| macOS | arm64/x64 | blocked | blocked | STT blocked / TTS bins | No official whisper-cli in b5454; Piper pinned |

Full matrix: `lib/runtime/compat-matrix.ts` and `/gentle:voice setup`.

## Privacy & cost

- Default path is **local** STT/TTS (no cloud required for voice).
- Uses the model you already configured in Pi / Gentle Shell for agent replies.
- Temp WAV/PCM under the private cache; cleaned after use when adapters allow.
- No ElevenLabs dependency for core mode.

## Development

```bash
git clone https://github.com/efolchmontiel/gentle-voice.git
cd gentle-voice
pnpm install   # or npm install
pnpm test
pnpm typecheck
npm pack --dry-run
```

## Uninstall

```bash
pi remove npm:gentle-voice
# optional: delete the private data dir shown by /gentle:voice config
```

Does not remove Whisper/Piper copies you installed yourself outside Gentle Voice’s data dir.

## License

MIT — see [LICENSE](LICENSE). Engine models and voices keep **their own** upstream licenses; this package does not redistribute those binaries in the npm tarball. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (Daniela voice is **CC-BY-SA-4.0**).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
