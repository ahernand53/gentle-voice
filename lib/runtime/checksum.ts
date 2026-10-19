/**
 * SHA-256 verification for downloaded artifacts.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	const stream = createReadStream(path);
	for await (const chunk of stream) {
		hash.update(chunk as Buffer);
	}
	return hash.digest("hex");
}

export function sha256Buffer(buf: Buffer | Uint8Array): string {
	return createHash("sha256").update(buf).digest("hex");
}

export function checksumMatches(actual: string, expected: string): boolean {
	const a = actual.trim().toLowerCase();
	const e = expected.trim().toLowerCase();
	if (!a || !e) return false;
	return a === e;
}
