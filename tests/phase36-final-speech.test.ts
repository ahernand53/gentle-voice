/**
 * Final-speech eligibility is structural. Word cues do not grant or deny speech.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentReplyTracker, lastAssistantFromMessages } from "../lib/agent-reply-tracker.ts";
import {
	APPROVAL_NOTICE,
	classifyAssistantForSpeech,
	classifyUiPrompt,
} from "../lib/narration/final-speech-eligibility.ts";

const text = (body: string) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text: body }],
});

test("plain assistant text is a final answer, even if it mentions RDD or done", () => {
	const d = classifyAssistantForSpeech(
		text("El flujo RDD quedó done, pero la compilación sigue en segundo plano."),
		"completed",
	);
	assert.equal(d.kind, "final_answer");
	assert.equal(d.speak, true);
	assert.match(d.text, /segundo plano/);
});

test("thinking and tool calls are not spoken", () => {
	const d = classifyAssistantForSpeech({
		role: "assistant",
		content: [
			{ type: "thinking", text: "voy a leer el archivo" },
			{ type: "toolCall", name: "bash", arguments: { command: "npm test" } },
		],
	}, "completed");
	assert.equal(d.kind, "tool_output");
	assert.equal(d.speak, false);
	assert.equal(d.text, "");
});

test("text beside a tool call keeps only the text", () => {
	const d = classifyAssistantForSpeech({
		role: "assistant",
		content: [
			{ type: "text", text: "Encontré el problema en la consulta." },
			{ type: "toolCall", name: "read", arguments: {} },
		],
	}, "completed");
	assert.equal(d.kind, "final_answer");
	assert.equal(d.text, "Encontré el problema en la consulta.");
	assert.doesNotMatch(d.text, /toolCall|npm/);
});

test("aborted run is not spoken", () => {
	const d = classifyAssistantForSpeech(text("resultado viejo"), "aborted");
	assert.equal(d.kind, "cancelled");
	assert.equal(d.speak, false);
});

test("missing message is unknown, not a guessed success", () => {
	const d = classifyAssistantForSpeech(null, "completed");
	assert.equal(d.kind, "unknown");
	assert.equal(d.speak, false);
});

test("approval notice is fixed and ignores the prompt title", () => {
	const d = classifyUiPrompt({
		type: "ui_prompt_start",
		kind: "confirm",
		title: "rm -rf /tmp/proyecto && cat ~/.ssh/id_rsa",
	});
	assert.equal(d.kind, "approval_required");
	assert.equal(d.text, APPROVAL_NOTICE);
	assert.doesNotMatch(d.text, /rm -rf|id_rsa/);
});

test("a trailing tool-only turn does not hide the earlier answer", () => {
	const tracker = new AgentReplyTracker();
	tracker.markVoiceSubmit("t");
	tracker.onTurnEnd({
		message: text("Corregí la condición. Las pruebas pasaron."),
	});
	tracker.onTurnEnd({
		message: {
			role: "assistant",
			content: [{ type: "toolCall", name: "bash", arguments: {} }],
		},
	});
	const plan = tracker.consumeSettled({ aborted: false });
	assert.match(JSON.stringify(plan.message), /pruebas pasaron/);
});

test("agent_end prefers the last assistant text over a later tool-only message", () => {
	const found = lastAssistantFromMessages([
		text("Respuesta final para el usuario."),
		{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }] },
		{ role: "toolResult", content: [{ type: "text", text: "exit 0" }] },
	]);
	assert.match(JSON.stringify(found), /Respuesta final/);
});

test("repeated settle of the same text is a duplicate", () => {
	const tracker = new AgentReplyTracker();
	const msg = text("Ya está.");
	tracker.markVoiceSubmit("a");
	tracker.onAgentEnd({ messages: [msg] });
	assert.equal(tracker.consumeSettled({ aborted: false }).skipReason, undefined);
	tracker.markVoiceSubmit("b");
	tracker.onAgentEnd({ messages: [msg] });
	assert.equal(tracker.consumeSettled({ aborted: false }).skipReason, "duplicate_fingerprint");
});
