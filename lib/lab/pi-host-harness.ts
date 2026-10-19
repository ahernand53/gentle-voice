/**
 * Faithful Pi ExtensionAPI harness for integration tests without LLM/tokens.
 * Mirrors registerCommand / registerShortcut / setWidget / agent_settled from Pi 1.2.
 */

import type { VoiceHostApi, VoiceHostCommandContext, VoiceHostContext } from "../contracts.ts";

export interface HarnessNotify {
	message: string;
	type?: string;
}

export interface HarnessWidget {
	key: string;
	content: string[] | undefined;
	placement?: string;
}

export interface PiHostHarness {
	readonly pi: VoiceHostApi;
	readonly commands: Map<string, (args: string, ctx: VoiceHostCommandContext) => Promise<void>>;
	readonly shortcuts: Map<string, (ctx: VoiceHostContext) => Promise<void> | void>;
	readonly notifies: HarnessNotify[];
	readonly widgets: HarnessWidget[];
	readonly statuses: Map<string, string | undefined>;
	readonly lifecycle: Array<{ event: string; payload?: unknown }>;
	runCommand(name: string, args?: string): Promise<void>;
	fire(event: string, payload?: unknown): void;
	ctx: VoiceHostCommandContext;
}

export function createPiHostHarness(): PiHostHarness {
	const commands = new Map<string, (args: string, ctx: VoiceHostCommandContext) => Promise<void>>();
	const shortcuts = new Map<string, (ctx: VoiceHostContext) => Promise<void> | void>();
	const notifies: HarnessNotify[] = [];
	const widgets: HarnessWidget[] = [];
	const statuses = new Map<string, string | undefined>();
	const lifecycle: Array<{ event: string; payload?: unknown }> = [];
	const listeners = new Map<string, Array<(event: unknown, ctx: VoiceHostContext) => unknown>>();

	const ctx: VoiceHostCommandContext = {
		mode: "tui",
		hasUI: true,
		ui: {
			notify(message, type) {
				notifies.push({ message, type });
			},
			setStatus(key, text) {
				statuses.set(key, text);
			},
			setEditorText(text) {
				(ctx as { __editor?: string }).__editor = text;
			},
			getEditorText() {
				return (ctx as { __editor?: string }).__editor ?? "";
			},
			onTerminalInput() {
				return () => {};
			},
			setWidget(key, content, options) {
				let lines: string[] | undefined;
				if (content === undefined) {
					lines = undefined;
				} else if (Array.isArray(content)) {
					lines = content;
				} else if (typeof content === "function") {
					const theme = {
						fg: (_c: string, t: string) => t,
						bg: (_c: string, t: string) => t,
						bold: (t: string) => t,
					};
					const leaf = content({}, theme) as { render?: (w: number) => string[] } | undefined;
					lines = leaf?.render?.(80);
				} else {
					lines = undefined;
				}
				widgets.push({
					key,
					content: lines,
					...(options?.placement ? { placement: options.placement } : {}),
				});
			},
		},
		isIdle() {
			return true;
		},
	};

	const pi: VoiceHostApi = {
		registerCommand(name, options) {
			commands.set(name, options.handler);
		},
		registerShortcut(shortcut, options) {
			shortcuts.set(shortcut, options.handler);
		},
		on(event, handler) {
			const list = listeners.get(event) ?? [];
			list.push(handler);
			listeners.set(event, list);
			return () => {
				listeners.set(event, (listeners.get(event) ?? []).filter((h) => h !== handler));
			};
		},
		sendUserMessage() {
			/* no LLM — record only via lifecycle if needed */
		},
	};

	return {
		pi,
		commands,
		shortcuts,
		notifies,
		widgets,
		statuses,
		lifecycle,
		ctx,
		async runCommand(name, args = "") {
			const handler = commands.get(name);
			if (!handler) throw new Error(`command not registered: ${name}`);
			await handler(args, ctx);
		},
		fire(event, payload) {
			lifecycle.push({ event, payload });
			for (const handler of listeners.get(event) ?? []) {
				handler(payload, ctx);
			}
		},
	};
}
