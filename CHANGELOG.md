# Changelog

All notable changes to Gentle Voice are documented here.

## [0.1.2] — 2026-10-20

Phase 3.5 — production conversation UX, honest status, safe uninstall/cleanup.

### Added

- Product Ctrl+Alt+Space / Ctrl+Alt+E registration without `GENTLE_VOICE_LAB*` (opt-out: `GENTLE_VOICE_DISABLE_SHORTCUTS=1`).
- `/gentle:voice converse on|off` as a product command (hands-free session).
- `/gentle:voice purge` + `gentle-voice-cleanup` CLI for optional private-data removal with explicit confirm token.
- Docs: `docs/phase35-uninstall-pnpm.md`, `docs/phase35-voice-refs.md`.

### Changed

- Conversation sessions enable fluent + auto-submit by default (opt-out: `GENTLE_VOICE_DISABLE_AUTO_SUBMIT=1`).
- Help/status no longer present “phase 2C”; status distinguishes engine readiness, conversation, registered shortcuts vs OS key delivery.
- Dictation still requires explicit `/gentle:voice send`.

### Fixed (pre-publish)

- Cleanup deletes Pi XDG **config** + **cache** gentle-voice roots, not only `share/` (complete remove).
- `gentle-voice-repair-settings` repairs partial unregister (`settings` vs npm) without defaulting to `~/.pi`.

### Notes

- Does not overwrite published `0.1.1`. Windows / macOS / portable Kokoro still unsupported claims.
- `pi remove` + `ERR_PNPM_IGNORED_BUILDS` is a Pi/`allowBuilds` + `pi-lens`→`@ast-grep/cli` issue — see uninstall doc.

## [0.1.1] — 2026-10-19

Gentle Shell isolation + lab-path hard gate for published product behaviour.

### Added

- `resolveGentleVoiceStorage()` — env-only host detection (Pi standalone, GS bundled, GS isolated, `--link`, custom `--home`, explicit overrides).
- Storage under `<GENTLE_SHELL_PREFIX>/gentle-voice/` (or `~/.gentle-shell/gentle-voice/`) with `bin/`, `models/`, `config/`, `cache/`, `tmp/`, `logs/`.
- `/gentle:voice storage` — diagnostics + optional data-cleanup dry-run (never deletes automatically).
- `isGentleVoiceLabPathsAllowed()` + `lib/runtime/lab-paths.ts` — lab paths only from env (no hard-coded homes in the tarball).
- Isolation + lab-gate regression tests (temporary HOME/prefix sentinels; no real Pi/GS mutation).
- Design doc: `docs/kokoro-portable.md` (ONNX Runtime path; no downloads in this release).

### Changed

- Inside GS isolated/bundled sessions, first-run downloads no longer use ambient `~/.local/share/gentle-voice` / XDG paths (unless `GENTLE_VOICE_*` overrides).
- `--link` keeps the portable Pi layout (does not treat GS prefix alone as isolation).
- `labKokoroPresent()` returns false without probing disk when lab is OFF.
- Filesystem engine probe no longer scans third-party/lab trees unless lab env is set.
- Product TTS default remains **Piper**; Kokoro stays lab-only (env-configured) until a portable ONNX ship.
- `lib/lab/*` and machine-specific docs excluded from the npm tarball.

### Notes

- Does **not** publish over `0.1.0`; patch `0.1.1` only after PR merge + explicit publish authorization.
- Windows / macOS remain unsupported pending real hardware smoke.
- Existing external lab models are **not** deleted or modified.

## [0.1.0] — 2026-10-19

First stable npm release (`latest`). Linux first-run path is experimental but installable; Windows and macOS are **not** claimed as supported.

### Added

- Automatic first-run on host `session_start` / first voice command (consent-gated downloads).
- Pinned Whisper.cpp + Piper + `es_AR-daniela-high` artifacts with SHA-256 verification.
- Private XDG / LocalAppData / Application Support layout (`GENTLE_VOICE_HOME` nests cache).
- Portable ffmpeg WASAPI / AVFoundation adapters (code only — **unverified** on hardware).
- `THIRD_PARTY_NOTICES.md` (including CC-BY-SA-4.0 obligations for Daniela).
- Clean-HOME Linux smoke script for maintainers.

### Fixed

- Ambient lab `GENTLE_VOICE_CACHE` no longer leaks into private `GENTLE_VOICE_HOME` installs (cross-device EXDEV).

### Compatibility (honest)

| Platform | Status |
| --- | --- |
| Linux x64 | Experimental — clean install + PipeWire exercised |
| Linux arm64 | Planned / bins pinned |
| Windows x64 | Blocked for conversation — bins pinned, no hardware smoke |
| macOS | Blocked — no official whisper-cli in pinned whisper.cpp release |

### Notes

- Historical GitHub release `v0.1.0-beta.1` remains for reference; this `0.1.0` supersedes it on npm `latest`.
- Publishing does **not** imply universal OS support.

## [0.1.0-beta.1] — 2026-10-19

Portable runtime scaffolding, pinned engines catalog, Pi package metadata (`pi-package`), GitHub release tag only (npm beta publish was not completed).
