/**
 * Adapt Pi ExtensionContext.modelRegistry to NarrationModelHost.
 * No hard dependency on @earendil-works packages at import time.
 */

import { extractAssistantPlainText } from "../final-utterance.ts";
import type { NarrationModelHost } from "./types.ts";

type RegistryLike = {
	find?: (provider: string, modelId: string) => unknown;
	hasConfiguredAuth?: (model: unknown) => boolean;
	complete?: (
		model: unknown,
		context: unknown,
		options?: unknown,
	) => Promise<unknown>;
};

export function createModelRegistryHost(registry: unknown): NarrationModelHost | undefined {
	if (!registry || typeof registry !== "object") return undefined;
	const r = registry as RegistryLike;
	if (typeof r.find !== "function" || typeof r.complete !== "function") {
		return undefined;
	}
	return {
		find: (provider, modelId) => r.find!(provider, modelId),
		hasConfiguredAuth: typeof r.hasConfiguredAuth === "function"
			? (model) => Boolean(r.hasConfiguredAuth!(model))
			: undefined,
		complete: async (model, context, options) => {
			const msg = (await r.complete!(model, context, options)) as {
				content?: unknown;
				usage?: Record<string, number>;
				errorMessage?: string;
				stopReason?: string;
			};
			return msg;
		},
	};
}

/** Pull plain text from a ModelRegistry.complete() AssistantMessage-like result. */
export function extractCompletionText(result: {
	content?: unknown;
	errorMessage?: string;
}): string {
	if (result.errorMessage) return "";
	return extractAssistantPlainText({
		role: "assistant",
		content: result.content as never,
	});
}
