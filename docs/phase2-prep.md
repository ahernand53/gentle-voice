# Phase 2 preparation (blocked until explicit authorization)

## Goals (ordered)

1. Install Whisper.cpp lab-local via `gs-lab/install-whisper-lab.sh` with `AUTHORIZE=1 CONFIRM=whisper-b5454`.
2. Transcribe a Spanish test WAV using Voxtype `ggml-small.bin` by path (no copy).
3. Synthesize with Piper (execute mode) — still optional before speakers.
4. Measure wall time, RSS RAM, CPU for STT + TTS smoke.
5. Implement Linux capture (PipeWire → Pulse fallback) behind `CaptureAdapter`.
6. Silence detection (VAD / energy hang).
7. Wire STT→Pi submit + TTS from final-utterance policy (brief, results-focused).
8. Keep spoken replies short via existing `final-utterance` limits.

## Platforms

Same adapter contracts: WASAPI / AVFoundation remain stubs until those OSes are tested.

## Non-goals until further auth

- Global package installs
- New model downloads
- Modifying Voxtype / main GS
- Commits/pushes
