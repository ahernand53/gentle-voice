<div align="center">
  <img src="assets/gentle-logo-only.png" alt="Gentle Voice" width="132" />

# Gentle Voice

**Speak with Pi. Hear the reply. Stay local for the audio.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

Gentle Voice is a [Pi package](https://pi.dev/docs/latest/packages) for conversation: microphone, speech-to-text, and text-to-speech. It runs inside Pi Coding Agent on its own, and inside Gentle Shell when that host is present. Gentle Shell is not required.

The published npm release is `0.1.4`. This tree prepares `0.1.5` and is not published yet.

## Install

You need Node.js ≥ 22.19 and Pi Coding Agent. Linux with PipeWire is the tested audio path. Windows and macOS are not supported.

```bash
pi install npm:gentle-voice
```

From a local checkout, before anything is published:

```bash
pi install ./gentle-voice
```

Gentle Shell, when the installed launcher supports it:

```bash
gentle-shell install npm:gentle-voice
```

A git install is also a Pi source (`pi install git:github.com/efolchmontiel/gentle-voice`). Prefer the npm package once a release exists. Restart the host after installing.

The first launch does not download models by itself. If speech models are missing, the host asks before downloading Whisper, Piper, and the Daniela voice (about 220 MiB) into the private data directory for that host. Decline and nothing is fetched. `/gentle:voice setup` repeats that check. It does not install GPU drivers, CUDA, or a system Python.

## First session

| Step | What you do |
| --- | --- |
| Turn voice on | `Ctrl+Alt+Space` or `/gentle:voice converse on` |
| Speak | The microphone stays off until a session starts |
| Hear the reply | Piper speaks it until you finish a VibeVoice install and keep that engine |
| Stop the audio | `Esc` once, while voice is busy |
| Edit what you said | `Ctrl+Alt+E` or `/gentle:voice edit` |

Opt out of the chords with `GENTLE_VOICE_DISABLE_SHORTCUTS=1`.

## What you can do

- **One utterance.** `/gentle:voice listen`, then `/gentle:voice send` if you are in dictation.
- **Hands-free.** `/gentle:voice converse on`. Speech end submits, the reply is spoken, then it listens again.
- **Edit.** `/gentle:voice edit` loads the pending or last voice line into the Pi editor.
- **Narration.** The written answer stays as the model wrote it. Speech is a separate step.

## Speech detection

`GENTLE_VOICE_VAD=auto` (the default) uses Silero when `silero_vad.onnx` is available, and the energy detector otherwise. `energy` forces the energy detector. `silero` still falls back to energy if the model cannot load, and status reports why. The ONNX file is not in the npm package.

## Speech to text

Whisper runs locally after you accept its download. The transcript that can be sent is the final one. Incremental speech-to-text is off unless `GENTLE_VOICE_INCREMENTAL_STT=1` (or the config flag). While it is on, provisional text is only for the screen. It is not submitted. A short local lexicon rewrites a few known mishearings, such as the product name and `C#`, after Whisper returns. It does not edit the Whisper model.

## Commands

| Command | Effect |
| --- | --- |
| `/gentle:voice` | Toggle on, or show status if already on |
| `/gentle:voice on` / `off` | Enable, or stop and cancel audio work |
| `/gentle:voice converse on` / `off` | Hands-free session. `off` keeps installed engines |
| `/gentle:voice listen` | One listen window |
| `/gentle:voice stop` | Stop listen or speech and return to idle |
| `/gentle:voice mute` | Mute TTS. The microphone can stay on |
| `/gentle:voice send` | Send the pending transcript |
| `/gentle:voice draft <text>` | Replace the pending transcript |
| `/gentle:voice edit` | Open the voice line in the editor |
| `/gentle:voice status` | Engines, conversation, shortcuts, storage |
| `/gentle:voice config` | Effective paths |
| `/gentle:voice setup` | Readiness. Downloads only after you accept |
| `/gentle:voice storage` | Where this host keeps private data |
| `/gentle:voice purge` | Show the delete plan. Nothing is removed until you confirm |
| `/gentle:voice stream auto\|pcm\|wav` | VibeVoice playback. See below |
| `/gentle:voice tts piper\|vibevoice` | Engine for this session |
| `/gentle:voice vibevoice-setup` | Install wizard. A download also needs `GENTLE_VOICE_VIBEVOICE_ALLOW_NETWORK=1`. `plan` only prints |
| `/gentle:voice voice-ai on\|off\|status` | Optional second model that writes the spoken text |
| `/gentle:voice barge-in on\|off\|status` | Interrupt playback by speaking |

`/gentle:voice tts kokoro` exists only when a lab Kokoro install is present. It is not the product default.

## Esc

The first `Esc` while voice is listening, loading, synthesizing, or speaking cancels that voice channel. It does not abort the agent. A later `Esc`, once voice is idle, is left for Pi. Gentle Voice does not swallow `Esc` when it has nothing to cancel.

## Voice AI

Voice AI writes a short spoken version after the agent settles. It does not change the text on screen and it does not add an agent turn.

`voice-ai` is the name of a role inside the active Gentle Shell profile. It is not a model. In `/gentle:profiles`, add that role to the active profile and point it at any model Pi can already call. The stored fields are `model` and `thinking` (an `effort` field is read the same way). A lab profile used `nan/mimo-v2.6-flash` with effort `low`. That pair is an example, not a default and not a free model. Pi without profiles, or a profile without the role, uses the active model. The lab command `/gentle:voice voice-ai-profile` is not part of the published command list.

| Situation | What happens |
| --- | --- |
| Role `voice-ai` has a valid model | That model writes the spoken text |
| The role is missing | The orchestrator model, or the active Pi model, writes it |
| The role exists but the model id is empty or invalid | Deterministic speech renderer. No model call |
| The provider errors or the call exceeds `voiceAi.timeoutMs` (25 seconds) | Deterministic speech renderer |
| `/gentle:voice voice-ai off` | No extra model call |

The narrator is a second model call. It is billed on top of the orchestrator, at that narrator's own provider rates. The call sends the assistant text, clipped to `voiceAi.maxInputChars` (8000 characters), and receives only the spoken line. It does not send tool history, it does not write the conversation history, and it does not change the text on screen. Cost follows the provider, the price, the context, and the length of the answer. One lab turn with MiMo used 363 input tokens and 9 output tokens. That turn is not the cost of every conversation, and it does not mean MiMo is free. A smaller narrator is usually cheaper. `/gentle:voice voice-ai off` skips the extra call.

The narrator uses whatever provider that model already uses. That can be a remote API. Speech recognition and speech synthesis stay on the machine. Do not treat the whole turn as offline.

`/gentle:voice voice-ai off` persists. Unset follows the conversation session. `GENTLE_VOICE_AI=0` locks it off while the preference file is unset.

## VibeVoice

VibeVoice is optional. Piper does not need it, and a missing VibeVoice install does not block Piper.

When VibeVoice is selected and `pw-play` can play raw float32, playback is native PCM. You do not set an environment variable for that. `/gentle:voice stream wav` saves WAV for this install. `/gentle:voice stream auto` returns to the default. For one process, `GENTLE_VOICE_VIBEVOICE_NATIVE_STREAM=0` forces WAV and wins over the file.

If PCM is not supported, VibeVoice uses WAV and says so. It does not switch to Piper. If PCM already started and synthesis fails, the same sentence is not played again as WAV.

On a compatible machine, `/gentle:voice vibevoice-setup` is the install wizard. It checks NVIDIA, VRAM, and free disk, shows the Microsoft terms, and asks before it fetches. The simulated tests cover consent, a private `.venv`, hash checks, a bad download, cancel, and retry. They do not fetch from Hugging Face. A real fetch needs `GENTLE_VOICE_VIBEVOICE_ALLOW_NETWORK=1` and has not been run. Until that run, do not treat the wizard as a finished download. `vibevoice-setup plan` only prints the plan. Declining, or hardware that fails the floor, leaves Piper in place and does not delete an engine you already have.

The floor is an NVIDIA GPU, 4 GB of VRAM, and 12 GiB free. The one measured tree was about 8.6 GiB, so 8 GiB free is not enough. 8 GB of VRAM is the recommended and tested class: one Linux x64 machine with an RTX 2070. A card above 4 GB is not automatically supported. Windows, macOS, CPU, and other GPUs are not supported by a run we can cite.

The code commit is `16fb2cb1217c9934a886e1948ffb06120caa2df5` from `https://github.com/microsoft/VibeVoice` (MIT). The weights are `model.safetensors`, 2035332888 bytes, sha256 `7758b150b8139deb48ac1ff6f181f745c8fedd5511232fd974b3eb217d83b514`, from `https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B`. The voice file is `sp-Spk0_woman.pt` from the upstream experimental Spanish archive. Those hashes are checked before `INSTALL_PENDING.json` is written. The npm package does not contain the weights. The Python environment is `<engine>/.venv`. The wizard does not use sudo and does not change system Python, CUDA, or drivers.

`/gentle:voice tts vibevoice` selects it when the probe is ready and stores that choice. `/gentle:voice tts piper` stores Piper and stops the worker. Asking `/gentle:voice status` does not download. A partial tree is retried by running the wizard again; files whose hash already matches are not fetched twice. Uninstall removes the pinned files, the receipt, the marker, and `.venv` only when `integrity.json` is present and the confirm token is passed to the library. It does not delete unrelated files, and it will not remove an older engine that has no receipt. Details: [docs/vibevoice-tts.md](docs/vibevoice-tts.md). When the probe is ready, `/gentle:voice tts vibevoice` works without lab mode. The worker starts on the first VibeVoice utterance and stays loaded until the session closes. Expect a multi-second cold load and a few gigabytes of VRAM on the one NVIDIA GPU where this was tested. CPU and other GPUs are not a tested VibeVoice path.

The checkpoint is English-trained. Spanish is experimental. The audible disclaimer and watermark stay. This is not a voice-cloning tool. Details: [docs/vibevoice-tts.md](docs/vibevoice-tts.md).

## Piper

Piper is the engine that installs with the consented voice download. It does not need a GPU. Use `/gentle:voice tts piper` to return to it. That stops the VibeVoice worker.

## Barge-in

During conversation, speaking over playback can interrupt it. The gate is microphone energy, not echo cancellation. It is not reliable on every speaker and microphone. `/gentle:voice barge-in off` stays off until you turn it on. The monitor runs only while audio is playing.

## What gets spoken

The spoken reply is the assistant text you would read. Thinking and tool calls stay silent. An approval prompt is one fixed sentence: the agent needs your authorization. It is not a second agent turn.

A later message that did not come from the voice turn is not spoken automatically. Background jobs, subagents, and host work that never surfaces as that assistant text are not narrated.

## If something fails

`/gentle:voice status` and `/gentle:voice setup` are the starting point.

| Symptom | Check |
| --- | --- |
| No microphone | PipeWire session, device permission, capture not started |
| No speech model | Setup consent was declined, or the download failed |
| No VibeVoice | `GENTLE_VOICE_VIBEVOICE_HOME` missing or incomplete. Piper still works |
| CUDA error | Use Piper, or fix the engine outside this package. Do not expect Gentle Voice to repair drivers |
| PCM refused | `pw-play` has no float32. `/gentle:voice stream wav` |

## Where data lives

Standalone Pi uses the XDG data, config, and cache directories for `gentle-voice` on Linux. Gentle Shell uses `<prefix>/gentle-voice/`. Models are not inside the npm package. `/gentle:voice storage` prints the resolved paths.

Removing the package keeps that data:

```bash
pi remove npm:gentle-voice
gentle-shell remove npm:gentle-voice
```

`/gentle:voice purge` lists what a data delete would remove. Add `--confirm DELETE_GENTLE_VOICE_DATA` only when you mean it. `--keep-models` leaves models and voices. The standalone CLIs `gentle-voice-cleanup` and `gentle-voice-repair-settings` are documented in [docs/phase35-uninstall-pnpm.md](docs/phase35-uninstall-pnpm.md). Cleanup refuses paths that are not this host's Gentle Voice data.

## Privacy

Speech-to-text and Piper or VibeVoice synthesis run locally. Voice AI can call a remote model. Transcripts are not written to the default log. There is no telemetry in this package.

## Support

| Path | State |
| --- | --- |
| Linux x64, PipeWire, Piper, Whisper | Tested in development |
| Linux x64, VibeVoice PCM on NVIDIA CUDA | Tested on one lab GPU. Experimental, especially in Spanish |
| Linux arm64 | Not tested here |
| Windows, macOS | Not supported |

A GPU is not required to install or to use Piper.

## Licenses

Gentle Voice is MIT. See [LICENSE](LICENSE). Whisper, Piper, Daniela, Silero, and VibeVoice keep their own terms. Weights are not in the npm tarball. Read [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before you accept a download. Daniela's voice is CC-BY-SA-4.0. VibeVoice weights are research-scoped and English-trained; keep the watermark.

## Development

```bash
git clone https://github.com/efolchmontiel/gentle-voice.git
cd gentle-voice
pnpm install
pnpm test
pnpm typecheck
npm pack --dry-run
```

Issues: https://github.com/efolchmontiel/gentle-voice/issues
