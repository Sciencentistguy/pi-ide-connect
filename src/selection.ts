import { isAbsolute, relative } from "node:path";

export interface Position {
	line: number;
	character: number;
}

export interface Selection {
	text: string;
	filePath: string;
	start: Position;
	end: Position;
	isEmpty: boolean;
}

export function parseSelection(params: any): Selection | undefined {
	if (typeof params?.filePath !== "string") return undefined;
	const start = params.selection?.start;
	const end = params.selection?.end;
	if (typeof start?.line !== "number" || typeof end?.line !== "number") return undefined;
	const text = typeof params.text === "string" ? params.text : "";
	return {
		text,
		filePath: params.filePath,
		start: { line: start.line, character: start.character ?? 0 },
		end: { line: end.line, character: end.character ?? 0 },
		isEmpty: params.selection?.isEmpty ?? text === "",
	};
}

/** 1-based inclusive line range; an end at column 0 does not include its own line. */
export function lineRange(selection: Selection): { first: number; last: number } {
	const first = selection.start.line + 1;
	let last = selection.end.line + 1;
	if (selection.end.character === 0 && last > first) last--;
	return { first, last };
}

export function displayPath(cwd: string, filePath: string): string {
	if (!isAbsolute(filePath)) return filePath;
	const rel = relative(cwd, filePath);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : filePath;
}

export function mentionReference(cwd: string, filePath: string, lineStart?: number, lineEnd?: number): string {
	const path = displayPath(cwd, filePath);
	if (typeof lineStart !== "number") return `@${path}`;
	const first = lineStart + 1;
	const last = (typeof lineEnd === "number" ? lineEnd : lineStart) + 1;
	return first === last ? `@${path}#L${first}` : `@${path}#L${first}-${last}`;
}

const MAX_SELECTION_CHARS = 4_000;

/** Context for the model, worded like Claude Code's own IDE context. */
export function selectionContext(selection: Selection): string {
	if (selection.isEmpty) {
		return `The user opened the file ${selection.filePath} in the IDE. This may or may not be related to the current task.`;
	}
	const { first, last } = lineRange(selection);
	const lines = first === last ? `line ${first}` : `the lines ${first} to ${last}`;
	const text =
		selection.text.length > MAX_SELECTION_CHARS
			? `${selection.text.slice(0, MAX_SELECTION_CHARS)}\n... (truncated)`
			: selection.text;
	return `The user selected ${lines} from ${selection.filePath}:\n${text}\n\nThis may or may not be related to the current task.`;
}

export function selectionKey(selection: Selection): string {
	return `${selection.filePath}:${selection.start.line}:${selection.start.character}-${selection.end.line}:${selection.end.character}:${selection.text.length}`;
}
