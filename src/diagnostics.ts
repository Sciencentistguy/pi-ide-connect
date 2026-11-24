import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// LSP DiagnosticSeverity is 1-based; some IDEs send the names instead.
const SEVERITY_LABELS = ["error", "warning", "info", "hint"];
const SEVERITY_NAMES: Record<string, number> = { error: 0, warning: 1, information: 2, info: 2, hint: 3 };

interface Entry {
	rank: number;
	fileIndex: number;
	line: number;
	text: string;
}

export interface FormatOptions {
	cwd: string;
	/** When set, files outside these folders are omitted. */
	workspaceRoots?: string[];
}

function severityRank(severity: unknown): number {
	if (typeof severity === "number" && Number.isInteger(severity) && severity >= 1 && severity <= 4) return severity - 1;
	if (typeof severity === "string") return SEVERITY_NAMES[severity.toLowerCase()] ?? SEVERITY_LABELS.length;
	return SEVERITY_LABELS.length;
}

function severityLabel(severity: unknown): string {
	return SEVERITY_LABELS[severityRank(severity)] ?? (severity === undefined ? "diagnostic" : String(severity));
}

function isWithin(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function filePath(uri: string): string | undefined {
	try {
		return fileURLToPath(uri);
	} catch {
		return undefined;
	}
}

function position(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value + 1 : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Renders a getDiagnostics response as one line per diagnostic, most severe first, so that
 * truncation keeps errors. Returns undefined if the text is not the expected JSON.
 */
export function formatDiagnostics(text: string, options: FormatOptions): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	const files = isRecord(parsed) ? [parsed] : parsed;
	if (!Array.isArray(files) || !files.every((file) => isRecord(file) && Array.isArray(file.diagnostics))) {
		return undefined;
	}

	const entries: Entry[] = [];
	const counts = SEVERITY_LABELS.map(() => 0);
	let other = 0;
	let shownFiles = 0;
	let omittedFiles = 0;
	let omittedDiagnostics = 0;

	files.forEach((file, fileIndex) => {
		const diagnostics = (file.diagnostics as unknown[]).filter(isRecord);
		if (diagnostics.length === 0) return;
		const uri = typeof file.uri === "string" ? file.uri : "";
		const path = filePath(uri);
		if (options.workspaceRoots && !(path && options.workspaceRoots.some((root) => isWithin(root, path)))) {
			omittedFiles++;
			omittedDiagnostics += diagnostics.length;
			return;
		}
		shownFiles++;
		const shown = path ? (isWithin(options.cwd, path) ? relative(options.cwd, path) : path) : uri;
		for (const diagnostic of diagnostics) {
			const rank = severityRank(diagnostic.severity);
			if (rank < counts.length) counts[rank]++;
			else other++;
			const line = position(diagnostic.range?.start?.line);
			const column = position(diagnostic.range?.start?.character);
			const where = [shown, line, line === undefined ? undefined : column].filter((part) => part !== undefined).join(":");
			const message = String(diagnostic.message ?? "").replace(/\s*\r?\n\s*/g, " ");
			const source = typeof diagnostic.source === "string" && diagnostic.source ? ` [${diagnostic.source}]` : "";
			entries.push({
				rank,
				fileIndex,
				line: line ?? 0,
				text: `${where}: ${severityLabel(diagnostic.severity)}: ${message}${source}`,
			});
		}
	});

	entries.sort((a, b) => a.rank - b.rank || a.fileIndex - b.fileIndex || a.line - b.line);

	const summary = counts
		.map((count, rank) => (count ? `${count} ${SEVERITY_LABELS[rank]}` : ""))
		.concat(other ? `${other} other` : "")
		.filter(Boolean)
		.join(", ");
	const lines = [entries.length ? `${summary} in ${shownFiles} file(s).` : "No diagnostics."];
	if (omittedFiles) {
		lines.push(
			`Omitted ${omittedDiagnostics} diagnostic(s) in ${omittedFiles} file(s) outside the workspace; pass uri to see a specific file.`,
		);
	}
	return [...lines, ...entries.map((entry) => entry.text)].join("\n");
}
