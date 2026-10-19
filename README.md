<div align="center">
  <img src="assets/gentle-logo-only.png" alt="Gentle AI logo" width="132" />

# Gentle Voice

**Local voice conversation for Pi Coding Agent (STT + TTS).**

[![Built for Pi](https://img.shields.io/badge/built%20for-Pi-6f42c1)](https://github.com/badlogic/pi-mono)
[![Gentle Shell](https://img.shields.io/badge/works%20with-gentle--shell-22c55e)](https://github.com/Gentleman-Programming/gentle-shell)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/badge/npm-not%20published%20yet-lightgrey)](https://www.npmjs.com/package/gentle-voice)

</div>

Speak with your already-authenticated Pi / Gentle Shell model. Gentle Voice runs **local** speech-to-text and text-to-speech. It does **not** require OpenAI, ElevenLabs, or a second login.

> **Status:** `0.1.0-beta.1` — packaging + portable first-run scaffolding.  
> **Do not** treat Windows/macOS as supported until real audio smoke tests exist.  
> **npm / `pi install npm:gentle-voice`:** not published until a human approves the first release.

## Requirements

- Node.js ≥ 22.19 (same class as current Pi)
- Pi Coding Agent ≥ 1.2 **or** Gentle Shell that hosts Pi packages
- Linux + PipeWire recommended for real mic/speaker today
- Disk for local models (order of **hundreds of MiB** once downloads are pinned)

## Install (when published)

```bash
# Pi
pi install npm:gentle-voice

# Gentle Shell
gentle-shell install npm:gentle-voice
```

Until npm publish is approved, install from git:

```bash
pi install git:github.com/efolchmontiel/gentle-voice@main
# or a release tag once cut
```

Restart Pi / Gentle Shell after install.

### First run

1. Run `/gentle:voice setup` (or enable voice once).
2. Gentle Voice uses a **private data directory** (XDG / LocalAppData / Application Support) — not your project folder.
3. If engines are missing, you see a summary of licenses + approximate size.
4. Downloads only proceed with **consent** and `GENTLE_VOICE_ALLOW_DOWNLOADS=1`, and only after release assets have pinned SHA-256.
5. Until pins exist, place Whisper.cpp + Piper under the data dir shown by `/gentle:voice config`.

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
| Linux | x64 | experimental | experimental | experimental | Lab: PipeWire + Whisper + Piper/Kokoro |
| Linux | arm64 | planned | planned | planned | Needs binaries + smoke tests |
| Windows | x64 | planned | planned | planned | WASAPI not implemented |
| macOS | arm64/x64 | planned | planned | planned | CoreAudio / TCC not smoke-tested |

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

MIT — see [LICENSE](LICENSE). Engine models and voices keep **their own** upstream licenses; this package does not redistribute those binaries in the npm tarball.
