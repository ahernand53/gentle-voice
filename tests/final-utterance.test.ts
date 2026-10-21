import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildFinalUtterance,
	extractAssistantPlainText,
	selectSpokenSentences,
} from "../lib/final-utterance.ts";

test("ignores thinking and toolCall parts", () => {
	const text = extractAssistantPlainText({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "I will call tools" },
			{ type: "toolCall", name: "bash" },
			{ type: "text", text: "Build fixed." },
		],
	});
	assert.equal(text, "Build fixed.");
});

test("tool-only turn does not speak", () => {
	const result = buildFinalUtterance({
		message: {
			role: "assistant",
			content: [{ type: "toolCall", name: "read" }],
		},
		outcome: "completed",
	});
	assert.equal(result.speak, false);
	assert.equal(result.reason, "tool_only_turn");
});

test("aborted runs stay silent", () => {
	const result = buildFinalUtterance({
		message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
		outcome: "aborted",
	});
	assert.equal(result.speak, false);
	assert.equal(result.reason, "run_aborted");
});

test("keeps opening sentence and still prefers warnings/conclusions", () => {
	const body = [
		"I inspected several files in the repository and considered a few options along the way.",
		"There was also a long discussion about formatting preferences that is not actionable.",
		"Warning: do not deploy with the debug flag enabled.",
		"In summary, the login bug is fixed and tests are green.",
	].join(" ");

	// maxSentences=3: opening (always) + top-ranked cues — never start mid-reply.
	const spoken = selectSpokenSentences(body, { maxSentences: 3, maxChars: 500 });
	assert.match(spoken, /^I inspected/i);
	assert.match(spoken, /Warning/i);
	assert.match(spoken, /summary|fixed|green/i);
});

test("buildFinalUtterance returns ranked summary", () => {
	const result = buildFinalUtterance({
		message: {
			role: "assistant",
			content: [{
				type: "text",
				text: "Looked at the logs. Checked caches. Conclusion: restart the worker. Warning: backlog may grow.",
			}],
		},
		outcome: "completed",
		maxSentences: 2,
		maxChars: 200,
	});
	assert.equal(result.speak, true);
	assert.match(result.text, /Warning|Conclusion|restart/i);
});
