import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export interface Proposal {
	path: string;
	/** Current contents, or undefined when the file does not exist yet. */
	before: string | undefined;
	after: string;
}

export function resolveToolPath(cwd: string, path: string): string {
	let value = path.startsWith("@") ? path.slice(1) : path;
	if (value === "~" || value.startsWith("~/")) value = homedir() + value.slice(1);
	return isAbsolute(value) ? value : resolve(cwd, value);
}

function readIfExists(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function occurrences(haystack: string, needle: string): number {
	let count = 0;
	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
	return count;
}

/**
 * Computes what pi's `edit` / `write` tools are about to produce.
 * Returns undefined when it cannot be determined exactly (pi's own tool will then report the problem).
 */
export function proposeChange(toolName: string, input: Record<string, any>, cwd: string): Proposal | undefined {
	if (typeof input.path !== "string") return undefined;
	const path = resolveToolPath(cwd, input.path);
	try {
		const before = readIfExists(path);
		if (toolName === "write") {
			return typeof input.content === "string" ? { path, before, after: input.content } : undefined;
		}
		if (toolName !== "edit" || before === undefined || !Array.isArray(input.edits) || input.edits.length === 0) {
			return undefined;
		}
		const spans: { start: number; end: number; text: string }[] = [];
		for (const edit of input.edits) {
			if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string" || edit.oldText === "") return undefined;
			if (occurrences(before, edit.oldText) !== 1) return undefined;
			const start = before.indexOf(edit.oldText);
			spans.push({ start, end: start + edit.oldText.length, text: edit.newText });
		}
		spans.sort((a, b) => a.start - b.start);
		let after = "";
		let cursor = 0;
		for (const span of spans) {
			if (span.start < cursor) return undefined;
			after += before.slice(cursor, span.start) + span.text;
			cursor = span.end;
		}
		return { path, before, after: after + before.slice(cursor) };
	} catch {
		return undefined;
	}
}
