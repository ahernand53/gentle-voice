/**
 * Probe-only ffmpeg/ffplay discovery for Windows/macOS fallback planning.
 * Full device I/O is OS-specific (dshow / avfoundation) and requires hardware smoke tests.
 * This module does not install ffmpeg.
 */

import { accessSync, constants } from "node:fs";
import { delimiter } from "node:path";
import type { AdapterAvailability } from "../contracts.ts";

function which(cmd: string): string | undefined {
	const pathEnv = process.env.PATH ?? process.env.Path ?? "";
	const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
	for (const dir of pathEnv.split(delimiter)) {
		for (const ext of exts) {
			const candidate = `${dir}${dir.endsWith("/") || dir.endsWith("\\") ? "" : "/"}${cmd}${ext}`;
			try {
				accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {
				try {
					accessSync(candidate, constants.F_OK);
					return candidate;
				} catch {
					/* continue */
				}
			}
		}
	}
	return undefined;
}

export function findFfmpeg(): string | undefined {
	return which("ffmpeg");
}

export function findFfplay(): string | undefined {
	return which("ffplay");
}

export function ffmpegCaptureAvailability(): AdapterAvailability {
	const ffmpeg = findFfmpeg();
	if (!ffmpeg) {
		return {
			status: "unavailable",
			reason: "ffmpeg_not_found",
			detail:
				"Native WASAPI/CoreAudio adapters not smoke-tested. Optional: install ffmpeg for a future fallback.",
		};
	}
	return {
		status: "degraded",
		reason: "ffmpeg_present_unwired",
		detail: `Found ${ffmpeg}, but capture wiring awaits hardware validation on this OS.`,
	};
}

export function ffmpegPlaybackAvailability(): AdapterAvailability {
	const ffplay = findFfplay() ?? findFfmpeg();
	if (!ffplay) {
		return {
			status: "unavailable",
			reason: "ffplay_or_ffmpeg_not_found",
			detail: "Native playback adapters not smoke-tested on this OS yet.",
		};
	}
	return {
		status: "degraded",
		reason: "ffmpeg_present_unwired",
		detail: `Found ${ffplay}, but playback wiring awaits hardware validation on this OS.`,
	};
}
