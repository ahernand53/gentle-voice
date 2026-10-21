export type {
	NarrateInput,
	NarrateResult,
	NarrationDiagnostics,
	NarrationModelHost,
	NarrationPath,
	NarrationThinkingLevel,
	NarrationUsage,
	NarratorModelRef,
	NarratorResolution,
	NarratorSource,
	VoiceNarrationAdapter,
} from "./types.ts";

export {
	DEFAULT_VOICE_AI_ROLE,
	PROFILE_ORCHESTRATOR_KEY,
	parseModelRef,
	profilesJsonPath,
	readFrozenProfileSnapshot,
	readProfilesFile,
	readSessionBindingSnapshot,
	resolveGentleConfigHome,
	resolveNarratorFromProfiles,
} from "./profile-role-resolver.ts";

export {
	DEFAULT_VOICE_AI_RUNTIME,
	createVoiceNarrationAdapter,
	type CreateVoiceNarrationAdapterOptions,
	type VoiceAiRuntimeConfig,
} from "./voice-narration-adapter.ts";

export { createModelRegistryHost, extractCompletionText } from "./model-registry-host.ts";
export { checkNarrationFidelity, extractCriticalTokens } from "./fidelity-gate.ts";
export {
	NARRATION_SYSTEM_PROMPT,
	buildNarrationUserMessage,
	shouldPreferLiteralNarration,
} from "./narration-prompt.ts";
export {
	formatVoiceAiStatus,
	hostStatusLabel,
	narrationModeLabel,
	narratorSourceLabel,
	type VoiceAiStatusSnapshot,
} from "./status.ts";

export {
	readVoiceAiPreference,
	resolveVoiceAiActivation,
	resolveVoiceHomeForPreference,
	writeVoiceAiPreference,
	type VoiceAiActivation,
	type VoiceAiActivationSource,
	type VoiceAiPreference,
} from "./voice-ai-preference.ts";
