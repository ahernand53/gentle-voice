/**
 * Speech Renderer — written agent text → speakable string for TTS only.
 * Never mutates the visible reply, history, or LLM context.
 *
 * Modes:
 * - natural (default): paths/URLs/code softened for narration
 * - detailed: keep more technical tokens, still avoid slash-spelling
 * - verbatim: minimal change (markdown strip + digit expand only via callers)
 */

import { markdownToSpeakable } from "./markdown-for-tts.ts";
import { normalizeForTts } from "./normalize-for-tts.ts";

export type SpeechRenderMode = "natural" | "detailed" | "verbatim";

export interface SpeechRenderContext {
	/** Process cwd — when a spoken path equals this, say "tu directorio de trabajo". */
	readonly cwd?: string;
	readonly language?: string;
	readonly mode?: SpeechRenderMode;
}

export interface SpeechRenderResult {
	readonly mode: SpeechRenderMode;
	/** Text passed to TTS. */
	readonly spoken: string;
	/** Original input (unchanged reference). */
	readonly written: string;
	readonly transforms: readonly string[];
}

// Last segment: word chars / hyphens only (no trailing punctuation dots).
const UNIX_PATH =
	/(?:^|[\s(])(\/(?:[\w.-]+\/)*[\w-]+)(?=$|[\s).,;:!?])/g;
const WIN_PATH =
	/(?:^|[\s(])([A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*)(?=$|[\s).,;:!?])/g;
const URL_RE =
	/(?:^|[\s(])(https?:\/\/[^\s)<]+)(?=$|[\s).,;:!?])/g;
const FILE_EXT_CMD =
	/(?:^|[\s])((?:npm|pnpm|yarn|git|dotnet|cargo|go|python3?|node|pi|gentle-shell)\s+[^\n.]+?)(?=$|[.!\n])/gi;

function normalizePathComparable(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function describeUrl(url: string): string {
	try {
		const u = new URL(url);
		const host = u.hostname.replace(/^www\./, "");
		if (host === "github.com") {
			const parts = u.pathname.split("/").filter(Boolean);
			if (parts.length >= 2) {
				return `el repositorio ${parts[1]} en GitHub`;
			}
			return "el sitio de GitHub";
		}
		return `el enlace de ${host}`;
	} catch {
		return "el enlace indicado en pantalla";
	}
}

function describePath(path: string, ctx: SpeechRenderContext, mode: SpeechRenderMode): string {
	const cwd = ctx.cwd?.trim();
	const pathNorm = normalizePathComparable(path.replace(/[.,;:!?]+$/, ""));
	const cwdNorm = cwd ? normalizePathComparable(cwd) : "";
	if (cwdNorm && (pathNorm === cwdNorm || pathNorm.startsWith(`${cwdNorm}/`) || cwdNorm.startsWith(`${pathNorm}/`))) {
		return "tu directorio de trabajo";
	}
	if (mode === "detailed") {
		// Keep basename for orientation without spelling every slash.
		const base = path.split(/[/\\]/).filter(Boolean).pop() ?? "ruta";
		return `la ruta que termina en ${base}`;
	}
	return "la ruta indicada en pantalla";
}

function softenCommands(text: string, mode: SpeechRenderMode): string {
	if (mode === "verbatim") return text;
	return text.replace(FILE_EXT_CMD, (full, cmd: string) => {
		const trimmed = String(cmd).trim();
		if (/^ejecuta/i.test(full) || /comando/i.test(full)) return full;
		return ` el comando ${trimmed}`;
	});
}

/**
 * Replace filesystem paths and URLs so Piper does not spell "barra".
 */
export function softenPathsAndUrls(
	text: string,
	ctx: SpeechRenderContext = {},
	mode: SpeechRenderMode = "natural",
): { text: string; transforms: string[] } {
	const transforms: string[] = [];
	let s = text;

	s = s.replace(URL_RE, (full, url: string) => {
		const prefix = full.slice(0, full.indexOf(url));
		transforms.push(`url:${url}`);
		if (mode === "verbatim") return full;
		return `${prefix}${describeUrl(url)}`;
	});

	s = s.replace(UNIX_PATH, (full, path: string) => {
		const prefix = full.slice(0, full.indexOf(path));
		transforms.push(`path:${path}`);
		if (mode === "verbatim") {
			// Still avoid slash-spelling: join with spaces
			return `${prefix}${path.split("/").filter(Boolean).join(" ")}`;
		}
		return `${prefix}${describePath(path, ctx, mode)}`;
	});

	s = s.replace(WIN_PATH, (full, path: string) => {
		const prefix = full.slice(0, full.indexOf(path));
		transforms.push(`winpath:${path}`);
		if (mode === "verbatim") {
			return `${prefix}${path.split(/\\/).filter(Boolean).join(" ")}`;
		}
		return `${prefix}${describePath(path, ctx, mode)}`;
	});

	return { text: s, transforms };
}

/**
 * Full speech render pipeline for TTS only.
 */
export function renderForSpeech(
	written: string,
	ctx: SpeechRenderContext = {},
): SpeechRenderResult {
	const mode: SpeechRenderMode = ctx.mode ?? "natural";
	const language = ctx.language ?? "es";
	const transforms: string[] = [];

	let spoken = written ?? "";
	if (!spoken.trim()) {
		return { mode, spoken: "", written, transforms };
	}

	if (mode !== "verbatim") {
		spoken = markdownToSpeakable(spoken);
		transforms.push("markdown");
	} else {
		// Verbatim still strips fences that Piper cannot usefully speak.
		spoken = markdownToSpeakable(spoken);
		transforms.push("markdown-light");
	}

	const softened = softenPathsAndUrls(spoken, ctx, mode);
	spoken = softened.text;
	transforms.push(...softened.transforms);

	spoken = softenCommands(spoken, mode);
	if (mode !== "verbatim") transforms.push("commands");

	spoken = normalizeForTts(spoken, language);
	transforms.push("normalize");

	return {
		mode,
		spoken: spoken.replace(/\s{2,}/g, " ").trim(),
		written,
		transforms,
	};
}
