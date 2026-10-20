#!/usr/bin/env node
/**
 * Scaffold isolated VibeVoice lab dirs — NO downloads, NO pip, NO torch.
 *
 * Usage:
 *   node scripts/prepare-vibevoice-lab.mjs
 *
 * Override root:
 *   GENTLE_VOICE_VIBEVOICE_HOME=/path/to/root node scripts/prepare-vibevoice-lab.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MODEL_BYTES = 2_035_332_888;
const root = process.env.GENTLE_VOICE_VIBEVOICE_HOME?.trim();
if (!root) {
	console.error("Set GENTLE_VOICE_VIBEVOICE_HOME to a directory you own. This scaffold does not download anything.");
	process.exit(2);
}

const dirs = ["code", ".venv", "models", "voices", "cache", "logs", "tmp"];

for (const d of dirs) {
	mkdirSync(join(root, d), { recursive: true });
}

const readme = `# VibeVoice lab root (Gentle Voice)

Created by prepare-vibevoice-lab.mjs — scaffold only.

## Consent required before:

1. git clone https://github.com/microsoft/VibeVoice → ./code
2. uv venv (Python 3.11/3.12) → ./.venv + PyTorch CUDA
3. HF microsoft/VibeVoice-Realtime-0.5B → ./models
   Expected model.safetensors size: ${MODEL_BYTES} bytes
4. experimental_voices_sp.tar.gz → ./voices (sp-Spk0_woman)

Never use sudo, global pip, or privileged Docker.
Never point public installs at this tree.
Piper remains the default TTS until human A/B approval.
`;

writeFileSync(join(root, "README.md"), readme, { mode: 0o644 });
writeFileSync(
	join(root, "INSTALL_PENDING.json"),
	`${JSON.stringify(
		{
			status: "awaiting_user_authorization",
			modelId: "microsoft/VibeVoice-Realtime-0.5B",
			modelSafetenorsBytes: MODEL_BYTES,
			preferredVoice: "sp-Spk0_woman",
			defaultTtsRemains: "piper",
			authorized: false,
		},
		null,
		2,
	)}\n`,
	{ mode: 0o644 },
);

console.log(`vibevoice-lab: scaffold ready at ${root}`);
console.log("vibevoice-lab: NO downloads performed.");
console.log(`vibevoice-lab: model.safetensors expected bytes=${MODEL_BYTES}`);
console.log("vibevoice-lab: authorize in chat before running install steps (see docs/vibevoice-tts.md).");
