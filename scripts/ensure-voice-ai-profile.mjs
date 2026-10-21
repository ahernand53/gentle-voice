#!/usr/bin/env node
/**
 * Lab seed: ensure profiles.json contains voice-ai (MiMo) under lab config home.
 *   GENTLE_VOICE_LAB=1 GENTLE_SHELL_CONFIG_HOME=.../gs-lab/gentle-ai \
 *     node --experimental-strip-types scripts/ensure-voice-ai-profile.mjs
 */
import { ensureVoiceAiProfile } from "../lib/lab/voice-ai-profile.ts";

const result = ensureVoiceAiProfile(process.env);
console.log(JSON.stringify(result, null, 2));
if (result.refused) process.exit(2);
process.exit(0);
