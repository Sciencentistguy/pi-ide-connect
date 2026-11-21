import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { type ExtensionAPI, type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { IdeClient, type ToolResult } from "./client.ts";
import { proposeChange } from "./diff.ts";
import { type IdeLock, matchingLocks, readLocks } from "./lockfiles.ts";
import {
	displayPath,
	lineRange,
	mentionReference,
	parseSelection,
	type Selection,
	selectionContext,
	selectionKey,
} from "./selection.ts";

const STATUS_KEY = "ide";
const CONTEXT_TYPE = "ide-context";
const IDE_TOOLS = ["ide_get_diagnostics", "ide_execute_code"];
const MAX_RECONNECT_DELAY_MS = 30_000;

function textOf(result: ToolResult): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let client: IdeClient | undefined;
	let lock: IdeLock | undefined;
	let intentionallyDisconnected = false;
	let reconnectTimer: NodeJS.Timeout | undefined;
	let reconnectDelay = 1_000;
	let diffReview = process.env.PI_IDE_DIFF === "on";
	let selection: Selection | undefined;
	let injectedKey: string | undefined;
	let toolsRegistered = false;
	const openDiffs = new Map<string, string>();
	const approved = new Map<string, string>();

	function describe(candidate: IdeLock): string {
		return `${candidate.ideName} (${candidate.workspaceFolders.map((folder) => basename(folder)).join(", ") || candidate.port})`;
	}

	function refreshStatus(): void {
		if (!ctx?.hasUI) return;
		if (!client?.connected) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		let text = `⧉ ${lock?.ideName ?? "IDE"}`;
		if (selection) {
			const where = displayPath(ctx.cwd, selection.filePath);
			if (selection.isEmpty) text += ` · ${where}`;
			else {
				const { first, last } = lineRange(selection);
				text += ` · ${where}:${first === last ? first : `${first}-${last}`}`;
			}
		}
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", text));
	}

	function setIdeToolsActive(active: boolean): void {
		if (!toolsRegistered) return;
		const current = new Set(pi.getActiveTools());
		for (const name of IDE_TOOLS) {
			if (active) current.add(name);
			else current.delete(name);
		}
		pi.setActiveTools([...current]);
	}

	function registerIdeTools(): void {
		if (toolsRegistered) return;
		toolsRegistered = true;
		pi.registerTool({
			name: "ide_get_diagnostics",
			label: "IDE Diagnostics",
			description:
				"Get language diagnostics (errors, warnings) from the connected IDE. Omit uri to get diagnostics for all files.",
			promptSnippet: "Get language diagnostics from the connected IDE",
			promptGuidelines: [
				"Use ide_get_diagnostics after editing code to check the IDE's compiler and linter diagnostics.",
			],
			parameters: Type.Object({
				uri: Type.Optional(Type.String({ description: "File URI (file:///...) to get diagnostics for" })),
			}),
			async execute(_id, params, signal) {
				if (!client?.connected) throw new Error("Not connected to an IDE. Run /ide to connect.");
				const result = await client.callTool("getDiagnostics", params.uri ? { uri: params.uri } : {}, { signal });
				return { content: [{ type: "text", text: textOf(result) || "[]" }], details: {}, isError: result.isError };
			},
		});
		pi.registerTool({
			name: "ide_execute_code",
			label: "IDE Execute Code",
			description:
				"Execute Python code in the Jupyter kernel of the notebook open in the connected IDE. Kernel state persists between calls. Only use when the user asks for it.",
			promptSnippet: "Execute Python in the IDE's Jupyter kernel",
			parameters: Type.Object({ code: Type.String({ description: "Python code to execute" }) }),
			async execute(_id, params, signal) {
				if (!client?.connected) throw new Error("Not connected to an IDE. Run /ide to connect.");
				const result = await client.callTool("executeCode", { code: params.code }, { signal, timeoutMs: 0 });
				return {
					content: result.content.map((block) =>
						block.type === "image"
							? { type: "image" as const, data: block.data ?? "", mimeType: block.mimeType ?? "image/png" }
							: { type: "text" as const, text: block.text ?? "" },
					),
					details: {},
					isError: result.isError,
				};
			},
		});
	}

	function onNotification(method: string, params: any): void {
		if (method === "selection_changed") {
			selection = parseSelection(params) ?? selection;
			refreshStatus();
		} else if (method === "at_mentioned" && ctx?.hasUI && typeof params?.filePath === "string") {
			const reference = mentionReference(ctx.cwd, params.filePath, params.lineStart, params.lineEnd);
			const current = ctx.ui.getEditorText();
			ctx.ui.setEditorText(`${current}${current && !/\s$/.test(current) ? " " : ""}${reference} `);
		}
	}

	async function connect(target: IdeLock, announce: boolean): Promise<boolean> {
		await disconnect(false);
		intentionallyDisconnected = false;
		const next = new IdeClient(target);
		try {
			await next.connect();
		} catch (error) {
			next.close();
			if (announce) ctx?.ui.notify(`Could not connect to ${describe(target)}: ${(error as Error).message}`, "error");
			return false;
		}
		client = next;
		lock = target;
		reconnectDelay = 1_000;
		next.on("notification", onNotification);
		next.on("close", () => {
			if (client !== next) return;
			client = undefined;
			selection = undefined;
			refreshStatus();
			setIdeToolsActive(false);
			scheduleReconnect(target);
		});
		registerIdeTools();
		setIdeToolsActive(true);
		if (!next.tools.has("executeCode") && next.tools.size > 0) {
			pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "ide_execute_code"));
		}
		refreshStatus();
		if (announce) ctx?.ui.notify(`Connected to ${describe(target)}`, "info");
		return true;
	}

	function scheduleReconnect(target: IdeLock): void {
		if (intentionallyDisconnected || reconnectTimer) return;
		reconnectTimer = setTimeout(async () => {
			reconnectTimer = undefined;
			if (intentionallyDisconnected || client) return;
			if (!existsSync(target.lockPath)) return;
			if (!(await connect(target, false))) {
				reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
				scheduleReconnect(target);
			}
		}, reconnectDelay);
	}

	async function closeOpenDiffs(): Promise<void> {
		const active = client;
		const tabs = [...openDiffs.values()];
		openDiffs.clear();
		if (!active?.connected) return;
		await Promise.allSettled(tabs.map((tab_name) => active.callTool("close_tab", { tab_name }, { timeoutMs: 2_000 })));
	}

	async function disconnect(manual: boolean): Promise<void> {
		if (manual) intentionallyDisconnected = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		reconnectTimer = undefined;
		await closeOpenDiffs();
		const active = client;
		client = undefined;
		selection = undefined;
		active?.removeAllListeners("close");
		active?.close();
		refreshStatus();
		setIdeToolsActive(false);
	}

	pi.on("session_start", async (_event, context) => {
		ctx = context;
		if (process.env.PI_IDE_AUTOCONNECT === "0" || client) return;
		const candidates = matchingLocks(context.cwd);
		const target = candidates[0];
		if (target) await connect(target, context.hasUI);
	});

	pi.on("session_shutdown", async () => {
		await disconnect(true);
		ctx = undefined;
	});

	pi.on("before_agent_start", async () => {
		if (!client?.connected || !selection) return;
		const key = selectionKey(selection);
		if (key === injectedKey) return;
		injectedKey = key;
		return { message: { customType: CONTEXT_TYPE, content: selectionContext(selection), display: false } };
	});

	pi.on("tool_call", async (event, context) => {
		if (!diffReview || !client?.connected) return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		if (client.tools.size > 0 && !client.tools.has("openDiff")) return;
		const proposal = proposeChange(event.toolName, event.input as Record<string, unknown>, context.cwd);
		if (!proposal || proposal.before === proposal.after) return;

		const tabName = `✻ [Claude Code] ${basename(proposal.path)} (${randomBytes(3).toString("hex")}) ⧉`;
		openDiffs.set(event.toolCallId, tabName);
		let result: ToolResult;
		try {
			result = await client.callTool(
				"openDiff",
				{
					old_file_path: proposal.path,
					new_file_path: proposal.path,
					new_file_contents: proposal.after,
					tab_name: tabName,
				},
				{ signal: context.signal, timeoutMs: 0 },
			);
		} catch (error) {
			openDiffs.delete(event.toolCallId);
			if (context.signal?.aborted) {
				await client.callTool("close_tab", { tab_name: tabName }, { timeoutMs: 2_000 }).catch(() => {});
				return { block: true, reason: "Cancelled while waiting for the IDE diff review." };
			}
			context.ui.notify(`IDE diff review failed (${(error as Error).message}); applying the change directly.`, "warning");
			return;
		}
		openDiffs.delete(event.toolCallId);

		const [verdict, finalContents] = result.content.filter((block) => block.type === "text").map((block) => block.text ?? "");
		if (verdict !== "FILE_SAVED") {
			return {
				block: true,
				reason: "The user rejected this change in their IDE. Do not retry it unchanged; ask what they would like instead.",
				terminate: true,
			};
		}
		const contents = finalContents ?? proposal.after;
		await withFileMutationQueue(proposal.path, async () => {
			await mkdir(dirname(proposal.path), { recursive: true });
			await writeFile(proposal.path, contents, "utf8");
		});
		const edited = contents !== proposal.after;
		approved.set(
			event.toolCallId,
			edited
				? `The user approved the change in their IDE after modifying it; ${proposal.path} now holds their final version. Re-read it before editing further.`
				: `Applied the change to ${proposal.path} (approved in the IDE).`,
		);
		return { block: true, reason: approved.get(event.toolCallId) };
	});

	pi.on("tool_result", async (event) => {
		const message = approved.get(event.toolCallId);
		if (message === undefined) return;
		approved.delete(event.toolCallId);
		return { content: [{ type: "text", text: message }], isError: false };
	});

	pi.registerCommand("ide", {
		description: "Connect to an IDE running a Claude Code-compatible extension",
		handler: async (args, context) => {
			ctx = context;
			const [sub, value] = args.trim().split(/\s+/);

			if (sub === "off" || sub === "disconnect") {
				await disconnect(true);
				context.ui.notify("Disconnected from IDE", "info");
				return;
			}
			if (sub === "diff") {
				if (value === "on" || value === "off") diffReview = value === "on";
				else diffReview = !diffReview;
				context.ui.notify(`IDE diff review ${diffReview ? "on" : "off"}`, "info");
				return;
			}
			if (sub === "status") {
				context.ui.notify(
					client?.connected
						? `Connected to ${describe(lock!)} · diff review ${diffReview ? "on" : "off"}`
						: "Not connected to an IDE",
					"info",
				);
				return;
			}

			const locks = readLocks();
			const matching = new Set(matchingLocks(context.cwd).map((candidate) => candidate.port));
			const byPort = sub && /^\d+$/.test(sub) ? locks.find((candidate) => candidate.port === Number(sub)) : undefined;
			if (byPort) {
				await connect(byPort, true);
				return;
			}
			if (locks.length === 0) {
				context.ui.notify("No running IDEs found. Install a Claude Code IDE extension and open this project.", "warning");
				return;
			}
			const label = (candidate: IdeLock) =>
				`${matching.has(candidate.port) ? "" : "(other workspace) "}${describe(candidate)} :${candidate.port}`;
			const options = locks.sort((a, b) => Number(matching.has(b.port)) - Number(matching.has(a.port))).map(label);
			if (client?.connected) options.push("Disconnect");
			const choice = await context.ui.select("Connect to IDE", options);
			if (choice === "Disconnect") await disconnect(true);
			else if (choice) await connect(locks[options.indexOf(choice)], true);
		},
	});
}
