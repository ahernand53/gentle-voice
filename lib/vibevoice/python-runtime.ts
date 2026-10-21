import { execFileSync } from "node:child_process";

/**
 * CPython minors with manylinux x86_64 PyTorch wheels.
 * Python 3.15 is on PATH as `python3` on some machines and has no torch wheel,
 * so pip reports "from versions: none".
 */
export const VIBEVOICE_PYTHON_CANDIDATES = [
	"python3.14",
	"python3.13",
	"python3.12",
	"python3.11",
	"python3.10",
	"python3",
] as const;

export const VIBEVOICE_PYTHON_PROBE =
	"import sys; print(f'GVPY {sys.version_info[0]}.{sys.version_info[1]}')";

export const VIBEVOICE_VENV_READY =
	"import sys; ok = sys.prefix.endswith('.venv') and (3, 10) <= sys.version_info[:2] <= (3, 14); raise SystemExit(0 if ok else 3)";

export function vibeVoicePythonSupported(report: string): boolean {
	const match = /GVPY\s+(\d+)\.(\d+)/.exec(report);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major === 3 && minor >= 10 && minor <= 14;
}

/** True when some installed interpreter can create a venv PyTorch can install into. */
export function python3CanCreateVenv(): boolean {
	for (const command of VIBEVOICE_PYTHON_CANDIDATES) {
		try {
			const out = execFileSync(command, ["-c", VIBEVOICE_PYTHON_PROBE], {
				timeout: 2000,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			if (vibeVoicePythonSupported(out)) return true;
		} catch {
			continue;
		}
	}
	return false;
}
