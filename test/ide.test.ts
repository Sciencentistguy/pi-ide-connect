import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { IdeClient } from "../src/client.ts";
import { proposeChange } from "../src/diff.ts";
import { matchingLocks, readLocks } from "../src/lockfiles.ts";
import { lineRange, mentionReference, parseSelection, selectionContext } from "../src/selection.ts";
import { MockIde } from "./mock-ide.ts";

const scratch = mkdtempSync(join(tmpdir(), "pi-ide-"));
const lockDir = join(scratch, "ide");
const project = join(scratch, "project");
mkdirSync(project, { recursive: true });

describe("lock files", () => {
	it("matches IDEs whose workspace contains cwd and ignores dead pids", async () => {
		const ide = await new MockIde().start();
		ide.writeLock(lockDir, [project]);
		writeFileSync(join(lockDir, "1.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, workspaceFolders: [project], transport: "ws" }));
		writeFileSync(join(lockDir, "2.lock"), "not json");
		assert.equal(readLocks(lockDir).length, 1);
		assert.equal(matchingLocks(join(project, "src"), {}, lockDir).length, 1);
		assert.equal(matchingLocks(scratch, {}, lockDir).length, 0);
		await ide.stop();
	});

	it("prefers CLAUDE_CODE_SSE_PORT", async () => {
		const a = await new MockIde().start();
		const b = await new MockIde().start();
		const dir = join(scratch, "two");
		a.writeLock(dir, [project]);
		b.writeLock(dir, [project]);
		const found = matchingLocks(project, { CLAUDE_CODE_SSE_PORT: String(b.port) }, dir);
		assert.equal(found[0].port, b.port);
		await a.stop();
		await b.stop();
	});
});

describe("client", () => {
	const lockFor = (ide: MockIde) => ({
		port: ide.port, pid: process.pid, ideName: "MockIDE", workspaceFolders: [project], authToken: ide.token, transport: "ws", lockPath: "",
	});

	it("handshakes, announces itself and lists tools", async () => {
		const ide = await new MockIde().start();
		const client = new IdeClient(lockFor(ide));
		await client.connect();
		assert.deepEqual(ide.received.map((m) => m.method), ["initialize", "notifications/initialized", "ide_connected", "tools/list"]);
		assert.equal(ide.received[2].params.pid, process.pid);
		assert.ok(client.tools.has("openDiff"));
		client.close();
		await ide.stop();
	});

	it("works with IDEs that do not echo the mcp subprotocol", async () => {
		const ide = await new MockIde({ echoSubprotocol: false }).start();
		const client = new IdeClient(lockFor(ide));
		await client.connect();
		assert.ok(client.connected);
		client.close();
		await ide.stop();
	});

	it("is rejected with a wrong token", async () => {
		const ide = await new MockIde().start();
		const client = new IdeClient({ ...lockFor(ide), authToken: "nope" });
		await assert.rejects(client.connect(), /401|reject/i);
		await ide.stop();
	});

	it("forwards notifications and calls tools", async () => {
		const ide = await new MockIde({
			onToolCall: (name, args) => ({ content: [{ type: "text", text: JSON.stringify({ name, args }) }] }),
		}).start();
		const client = new IdeClient(lockFor(ide));
		await client.connect();
		const seen = new Promise<[string, any]>((resolve) => client.once("notification", (m, p) => resolve([m, p])));
		ide.notify("at_mentioned", { filePath: "/x", lineStart: 1, lineEnd: 2 });
		assert.deepEqual(await seen, ["at_mentioned", { filePath: "/x", lineStart: 1, lineEnd: 2 }]);
		const result = await client.callTool("getDiagnostics", { uri: "file:///x" });
		assert.deepEqual(IdeClient.json(result), { name: "getDiagnostics", args: { uri: "file:///x" } });
		client.close();
		await ide.stop();
	});

	it("emits close when the IDE goes away and fails pending calls", async () => {
		let release!: () => void;
		const ide = await new MockIde({ onToolCall: () => new Promise((resolve) => (release = () => resolve(undefined))) }).start();
		const client = new IdeClient(lockFor(ide));
		await client.connect();
		const closed = new Promise<void>((resolve) => client.once("close", resolve));
		const pending = client.callTool("openDiff", {}, { timeoutMs: 0 });
		await new Promise((resolve) => setTimeout(resolve, 50));
		await ide.stop();
		await assert.rejects(pending, /closed/);
		await closed;
		release?.();
	});
});

describe("proposeChange", () => {
	const file = join(project, "a.txt");
	writeFileSync(file, "one\ntwo\nthree\n");

	it("applies edits against the original", () => {
		const p = proposeChange("edit", { path: "a.txt", edits: [{ oldText: "one", newText: "1" }, { oldText: "three", newText: "3" }] }, project);
		assert.equal(p?.after, "1\ntwo\n3\n");
	});
	it("refuses ambiguous or missing matches", () => {
		assert.equal(proposeChange("edit", { path: "a.txt", edits: [{ oldText: "e", newText: "x" }] }, project), undefined);
		assert.equal(proposeChange("edit", { path: "a.txt", edits: [{ oldText: "zzz", newText: "x" }] }, project), undefined);
	});
	it("handles write, including new files", () => {
		assert.equal(proposeChange("write", { path: "new.txt", content: "hi" }, project)?.before, undefined);
		assert.equal(proposeChange("write", { path: "@a.txt", content: "hi" }, project)?.before, readFileSync(file, "utf8"));
	});
});

describe("selection", () => {
	const sel = parseSelection({
		text: "foo", filePath: "/p/a.ts", selection: { start: { line: 9, character: 0 }, end: { line: 14, character: 0 }, isEmpty: false },
	})!;
	it("computes line ranges like Claude Code", () => {
		assert.deepEqual(lineRange(sel), { first: 10, last: 14 });
		assert.match(selectionContext(sel), /lines 10 to 14 from \/p\/a\.ts/);
	});
	it("formats at-mentions with 1-based lines and relative paths", () => {
		assert.equal(mentionReference("/p", "/p/src/a.ts", 9, 14), "@src/a.ts#L10-15");
		assert.equal(mentionReference("/p", "/p/a.ts", 3, 3), "@a.ts#L4");
		assert.equal(mentionReference("/p", "/other/a.ts"), "@/other/a.ts");
	});
});

