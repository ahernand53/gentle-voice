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

> **Status:** `0.1.3` on npm. Linux experimental. **Windows and macOS are not supported** until real hardware smoke tests pass.  
> An npm publish does **not** mean universal OS compatibility.

## Requirements

- Node.js ≥ 22.19 (same class as current Pi)
- Pi Coding Agent ≥ 1.2 **or** Gentle Shell that hosts Pi packages
- Linux + PipeWire recommended for real mic/speaker today
- Disk ≈ **220 MiB** for pinned Whisper + Piper + Daniela (one-time, after consent)
- Optional: `ffmpeg` on PATH for Windows/macOS portable audio fallbacks (**unverified** — do not rely on this)

## Install

```bash
# Pi (independent)
pi install npm:gentle-voice

# Gentle Shell
gentle-shell install npm:gentle-voice
```

Restart Pi / Gentle Shell after install.

From git (development / pre-publish):

```bash
pi install git:github.com/efolchmontiel/gentle-voice@main
```

### First run (automatic, consent-gated)

1. Start Pi / Gentle Shell — on `session_start` (and on first `/gentle:voice` / shortcut), Gentle Voice checks readiness.
2. If STT/TTS artifacts are missing, the host shows a **consent dialog** (licenses + ≈220 MiB size). Accept to download **Whisper**, **Piper**, the STT model, and the Daniela voice into **private host storage only**:
   - **Standalone Pi:** XDG on Linux (`~/.local/share|config|cache/gentle-voice`), or the equivalent LocalAppData / Application Support layout on other OSes.
   - **Gentle Shell** (isolated/bundled): `<prefix>/gentle-voice/` (for example `~/.gentle-shell/gentle-voice/`).
3. Downloads do **not** depend on a lab tree, WD-Black, Voxtype, or global system packages. No sudo, no PATH mutation, no Python/compiler required.
4. `/gentle:voice setup` remains for **diagnostics / repair / manual** re-consent — it is **not** required for first use. `/gentle:voice storage` shows the resolved host kind and private paths.
5. Non-interactive automation only: `GENTLE_VOICE_AUTO_DOWNLOAD=1` (after reviewing licenses). Opt-out: `GENTLE_VOICE_DISABLE_DOWNLOADS=1`.
6. Attribution for the Daniela voice (CC-BY-SA-4.0) is in `THIRD_PARTY_NOTICES.md`.

## Commands & shortcuts

| Action | How |
| --- | --- |
| Toggle conversation | `Ctrl+Alt+Space` or `/gentle:voice converse on\|off` |
| Edit current / last voice line | `Ctrl+Alt+E` or `/gentle:voice edit` |
| Cancel capture / TTS | `Esc` (when voice is busy) |
| Setup / readiness | `/gentle:voice setup` |
| Storage / isolation | `/gentle:voice storage` |
| Status | `/gentle:voice status` |
| Data cleanup plan | `/gentle:voice purge` (see below) |

Modes: **conversation** (hands-free auto-submit while the session is on) and **dictation** (review, explicit `/gentle:voice send`).

Opt out of product shortcuts: `GENTLE_VOICE_DISABLE_SHORTCUTS=1`.

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

## Uninstall package (keeps private data by default)

Removes the npm package from the agent home. It does **not** delete STT/TTS binaries, models, voices, config, or cache.

```bash
# Pi
pi remove npm:gentle-voice

# Gentle Shell
gentle-shell remove npm:gentle-voice
```

### Partial uninstall repair

If `settings.json` still lists `npm:gentle-voice` but the npm dependency is already gone, repair with the standalone CLI (requires an explicit `--settings` path; never defaults to `~/.pi`):

```bash
# Dry-run on a copy first
cp ~/.pi/agent/settings.json /tmp/settings-gv-repair.json
npx --package gentle-voice gentle-voice-repair-settings --settings /tmp/settings-gv-repair.json
npx --package gentle-voice gentle-voice-repair-settings --settings /tmp/settings-gv-repair.json --write
```

`--write` creates a `*.bak-gentle-voice-repair` backup next to the settings file.

More detail: [docs/phase35-uninstall-pnpm.md](docs/phase35-uninstall-pnpm.md).

## Data cleanup (optional)

Private data removal is a **separate** step from package remove. Always review the path list first.

### Dry-run (list paths, no delete)

While the extension is still installed:

```text
/gentle:voice purge
/gentle:voice purge --keep-models
```

Or after the package is gone (standalone CLI):

```bash
npx --package gentle-voice gentle-voice-cleanup
npx --package gentle-voice gentle-voice-cleanup --keep-models
```

### Confirm delete

```bash
# Full private-data delete (plugin already removed or still installed)
npx --package gentle-voice gentle-voice-cleanup --confirm DELETE_GENTLE_VOICE_DATA

# Keep STT models + TTS voices for a later reinstall (removes bin/vendor/config/cache/tmp/logs)
npx --package gentle-voice gentle-voice-cleanup --keep-models --confirm DELETE_GENTLE_VOICE_DATA
```

Same flags work with `/gentle:voice purge --confirm DELETE_GENTLE_VOICE_DATA` and `/gentle:voice purge --keep-models --confirm DELETE_GENTLE_VOICE_DATA`.

### Safety

- Deletes **only** planned private `gentle-voice` paths for the **current host** (Pi XDG roots or GS `<prefix>/gentle-voice/`).
- **Never** deletes Voxtype, WD-Black, Kokoro lab trees, other Pi/GS packages, or GS `versions/` / `runtime/`.
- Does **not** cross hosts: uninstalling from Gentle Shell does not touch standalone Pi data, and vice versa.
- Refuses symlink targets even under a `gentle-voice` directory.

## Development

```bash
git clone https://github.com/efolchmontiel/gentle-voice.git
cd gentle-voice
pnpm install   # or npm install
pnpm test
pnpm typecheck
npm pack --dry-run
```

## License

MIT — see [LICENSE](LICENSE). Engine models and voices keep **their own** upstream licenses; this package does not redistribute those binaries in the npm tarball. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (Daniela voice is **CC-BY-SA-4.0**).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
