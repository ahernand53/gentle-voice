/**
 * Single gate for experimental lab path probes (env-configured trees only).
 * Product builds must keep this OFF so npm packages never touch lab paths.
 */

/** Env keys that explicitly enable lab absolute path probes. */
export const LAB_PATH_ENV_KEYS = ["GENTLE_VOICE_LAB", "GENTLE_VOICE_REAL_AUDIO"] as const;

/**
 * True only when the operator opted into lab behaviour.
 * Empty / unset / any value other than `"1"` is OFF.
 */
export function isGentleVoiceLabPathsAllowed(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return (
		env.GENTLE_VOICE_LAB === "1" || env.GENTLE_VOICE_REAL_AUDIO === "1"
	);
}
