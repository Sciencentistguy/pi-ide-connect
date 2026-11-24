import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { formatDiagnostics } from "../src/diagnostics.ts";

const root = join(process.platform === "win32" ? "C:\\" : "/", "work", "project");
const outside = join(process.platform === "win32" ? "C:\\" : "/", "sdk", "include", "windows.h");
const uri = (path: string) => pathToFileURL(path).href;
const at = (line: number, character: number) => ({ start: { line, character }, end: { line, character } });

describe("formatDiagnostics", () => {
	it("prints one line per diagnostic, most severe first, relative to cwd", () => {
		const text = JSON.stringify([
			{
				uri: uri(join(root, "src", "a.cpp")),
				diagnostics: [
					{ message: "unused", severity: 2, source: "VS", range: at(9, 4) },
					{ message: "broken\n  badly", severity: 1, range: at(2, 0) },
				],
			},
			{ uri: uri(join(root, "src", "b.cpp")), diagnostics: [] },
		]);
		assert.equal(
			formatDiagnostics(text, { cwd: root }),
			[
				"1 error, 1 warning in 1 file(s).",
				`${join("src", "a.cpp")}:3:1: error: broken badly`,
				`${join("src", "a.cpp")}:10:5: warning: unused [VS]`,
			].join("\n"),
		);
	});

	it("omits files outside the workspace roots and says so", () => {
		const text = JSON.stringify([
			{ uri: uri(outside), diagnostics: [{ message: "sdk", severity: 2, range: at(0, 0) }] },
			{ uri: uri(join(root, "x.h")), diagnostics: [{ message: "info", severity: "Information", range: at(0, 0) }] },
		]);
		const formatted = formatDiagnostics(text, { cwd: root, workspaceRoots: [root] })!;
		assert.match(formatted, /^1 info in 1 file\(s\)\.\nOmitted 1 diagnostic\(s\) in 1 file\(s\) outside the workspace/);
		assert.ok(!formatted.includes("sdk"));
		assert.ok(formatted.endsWith("x.h:1:1: info: info"));
	});

	it("does not treat a sibling folder sharing the root's prefix as inside it", () => {
		const text = JSON.stringify([{ uri: uri(`${root}2${join("/", "a.cpp")}`), diagnostics: [{ message: "m", severity: 1 }] }]);
		assert.match(formatDiagnostics(text, { cwd: root, workspaceRoots: [root] })!, /^No diagnostics\.\nOmitted 1/);
	});

	it("shows absolute paths outside cwd and keeps unknown severities", () => {
		const text = JSON.stringify({ uri: uri(outside), diagnostics: [{ message: "m", severity: 9 }] });
		assert.equal(formatDiagnostics(text, { cwd: root }), `1 other in 1 file(s).\n${outside}: 9: m`);
	});

	it("returns undefined for text that is not a diagnostics response", () => {
		assert.equal(formatDiagnostics("not json", { cwd: root }), undefined);
		assert.equal(formatDiagnostics("[1, 2]", { cwd: root }), undefined);
		assert.equal(formatDiagnostics('{"error": "x"}', { cwd: root }), undefined);
	});

	it("reports an empty response", () => {
		assert.equal(formatDiagnostics("[]", { cwd: root }), "No diagnostics.");
	});
});
