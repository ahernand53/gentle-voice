# Changelog

All notable changes to Gentle Voice are documented here.

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
