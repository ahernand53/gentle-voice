# Voice AI — narration role + second LLM (Phase 3.6)

## Profiles vs roles

| Concept | What it is |
| --- | --- |
| **Profile** | Named snapshot in `/gentle:profiles` (e.g. `OpenSource`) with an **orchestrator** + routing map |
| **Role** | Named entry *inside* a profile (Profile routing), e.g. `review-risk`, `voice-ai` |
| **Orchestrator** | Reserved key `orchestrator` — drives primary chat. **Not** a role |

`voice-ai` is a **role** under the active profile — never a sibling top-level profile.

## Pipeline

1. Orchestrator (e.g. DeepSeek) produces the **written** reply (tools, agents, screen).
2. Gentle Voice resolves narrator:
   - **A** — role `voice-ai` with valid model → that model
   - **B** — role absent → profile orchestrator / active Pi model (second inference only)
   - **C** — role present but invalid / missing in registry → **deterministic** Speech Renderer (no silent swap)
   - **D** — disabled / API fail / timeout → deterministic; **Esc** → cancel, no playback
3. Narrated text goes to the selected TTS engine after settle. Piper is the default. VibeVoice uses PCM when that engine is selected and `pw-play` supports float32.

The visible reply is **never** rewritten.

## Commands

```text
/gentle:voice voice-ai on|off|status
/gentle:voice voice-ai-profile   # lab only: seed OpenSource.voice-ai → MiMo (does not change orchestrator)
```

The extra call is a second model request, billed apart from the orchestrator. `voice-ai` is the role name, not a model name. MiMo is one model that can fill it. Input is the assistant text clipped to 8000 characters. The default timeout is 25 seconds. One lab observation with MiMo was 363 input tokens and 9 output tokens. That figure is not a quota and it does not mean the model is free. Off, an invalid role, a provider error, or a timeout skips the extra call and uses the deterministic renderer. The written reply stays as the orchestrator wrote it.

Activation (not GS profiles):

| State | Narration LLM |
| --- | --- |
| Preference unset + `/gentle:voice converse on` | on (automatic) |
| Preference unset + normal chat | off |
| `/gentle:voice voice-ai on` | on (explicit; survives converse off) |
| `/gentle:voice voice-ai off` | off (explicit; converse does not re-enable) |
| `GENTLE_VOICE_AI=0` and preference still unset | process lock off |

Preference file: `$GENTLE_VOICE_HOME/voice-ai-preference.json`. Status resolves the profile even when narration is disabled.

## Config (`voiceAi.*`)

Model/effort live in `/gentle:profiles`, not duplicated in GV config.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Master switch |
| `role` | `voice-ai` | Routing role name |
| `fallback` | `orchestrator` | When role absent |
| `onError` | `deterministic` | Invalid / API error |
| `streaming` | `after_settle` | Wait for final text, narrate, then stream TTS |
| `timeoutMs` | `25000` | Narration budget |
| `maxInputChars` | `8000` | Clip input to narrator |

## Integration (no GS package import)

- Reads `profiles.json` schema (`gentle-pi.agent_model_profiles`)
- Optional session binding via `Symbol.for("gentle-pi:session-profile-bindings")`
- Inference via Pi `ExtensionContext.modelRegistry.complete` (tools-less, no history write)

## Pi standalone

Without GS profiles: narrator = active Pi model (Case B / active_model_fallback). TTS stays local. Voice AI can be disabled.

## converse-style (separate)

`/gentle:voice converse-style` still injects `appendSystemPrompt` on the **same** orchestrator turn (style only). Prefer Voice AI for spoken naturalness without changing the written reply.
