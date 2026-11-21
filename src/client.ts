import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { IdeLock } from "./lockfiles.ts";

export const AUTH_HEADER = "x-claude-code-ide-authorization";
const PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ToolContent {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface ToolResult {
	content: ToolContent[];
	isError?: boolean;
}

export class RpcError extends Error {
	code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer?: NodeJS.Timeout;
}

export interface RequestOptions {
	signal?: AbortSignal;
	/** 0 disables the timeout (blocking calls such as openDiff). */
	timeoutMs?: number;
}

export interface IdeClientEvents {
	notification: [method: string, params: any];
	close: [];
}

/** MCP (JSON-RPC 2.0) client over the WebSocket a Claude Code-compatible IDE exposes. */
export class IdeClient extends EventEmitter<IdeClientEvents> {
	readonly lock: IdeLock;
	tools = new Set<string>();
	serverName = "";
	private socket?: WebSocket;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private closed = false;
	private closeEmitted = false;

	constructor(lock: IdeLock) {
		super();
		this.lock = lock;
	}

	get connected(): boolean {
		return this.socket?.readyState === WebSocket.OPEN && !this.closed;
	}

	async connect(): Promise<void> {
		try {
			await this.open(["mcp"]);
		} catch (error) {
			// Not every IDE echoes the "mcp" subprotocol; retry without negotiating one.
			if (!/subprotocol/i.test((error as Error).message)) throw error;
			await this.open([]);
		}
		this.socket!.on("message", (data) => this.onMessage(data.toString()));
		this.socket!.on("close", () => this.teardown());
		this.socket!.on("error", () => this.teardown());

		const init = (await this.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "claude-code", title: "Pi", version: "0.1.0" },
		})) as { serverInfo?: { name?: string } } | undefined;
		this.serverName = init?.serverInfo?.name ?? this.lock.ideName;
		this.notify("notifications/initialized");
		this.notify("ide_connected", { pid: process.pid });
		try {
			const listed = (await this.request("tools/list", {}, { timeoutMs: 5_000 })) as { tools?: { name: string }[] };
			this.tools = new Set((listed?.tools ?? []).map((tool) => tool.name));
		} catch {
			// tools/list is optional; callers fall back to attempting the call
		}
	}

	private open(protocols: string[]): Promise<void> {
		return new Promise((resolve, reject) => {
			const headers: Record<string, string> = {};
			if (this.lock.authToken) headers[AUTH_HEADER] = this.lock.authToken;
			const socket = new WebSocket(`ws://127.0.0.1:${this.lock.port}`, protocols, { headers });
			socket.once("open", () => {
				this.socket = socket;
				resolve();
			});
			socket.once("error", (error) => reject(error));
			socket.once("unexpected-response", (_request, response) =>
				reject(new Error(`IDE rejected the connection (HTTP ${response.statusCode})`)),
			);
		});
	}

	request(method: string, params?: unknown, options: RequestOptions = {}): Promise<unknown> {
		const { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
		return new Promise((resolve, reject) => {
			if (!this.connected && method !== "initialize") return reject(new Error("Not connected to IDE"));
			if (signal?.aborted) return reject(new Error("Aborted"));
			const id = this.nextId++;
			const entry: Pending = { resolve, reject };
			const onAbort = () => {
				this.pending.delete(id);
				entry.reject(new Error("Aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			const settle = <T extends unknown[]>(fn: (...args: T) => void) => (...args: T) => {
				signal?.removeEventListener("abort", onAbort);
				if (entry.timer) clearTimeout(entry.timer);
				fn(...args);
			};
			entry.resolve = settle(resolve);
			entry.reject = settle(reject);
			if (timeoutMs > 0) {
				entry.timer = setTimeout(() => {
					this.pending.delete(id);
					entry.reject(new Error(`IDE request ${method} timed out`));
				}, timeoutMs);
			}
			this.pending.set(id, entry);
			try {
				this.send({ jsonrpc: "2.0", id, method, params });
			} catch (error) {
				this.pending.delete(id);
				entry.reject(error as Error);
			}
		});
	}

	notify(method: string, params?: unknown): void {
		this.send({ jsonrpc: "2.0", method, params });
	}

	async callTool(name: string, args: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<ToolResult> {
		const result = (await this.request("tools/call", { name, arguments: args }, options)) as ToolResult;
		return { content: result?.content ?? [], isError: result?.isError };
	}

	/** Tool results carry JSON in a text block; returns undefined when the text is not JSON. */
	static json<T = any>(result: ToolResult): T | undefined {
		const text = result.content.find((block) => block.type === "text")?.text;
		if (text === undefined) return undefined;
		try {
			return JSON.parse(text) as T;
		} catch {
			return undefined;
		}
	}

	close(): void {
		this.closed = true;
		this.socket?.close();
		this.teardown();
	}

	private send(message: unknown): void {
		this.socket?.send(JSON.stringify(message));
	}

	private onMessage(raw: string): void {
		let message: any;
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}
		if (message.method !== undefined) {
			if (message.id === undefined) {
				this.emit("notification", message.method, message.params);
			} else if (message.method === "ping") {
				this.send({ jsonrpc: "2.0", id: message.id, result: {} });
			} else {
				this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
			}
			return;
		}
		const entry = this.pending.get(message.id);
		if (!entry) return;
		this.pending.delete(message.id);
		if (message.error) entry.reject(new RpcError(message.error.code, message.error.message));
		else entry.resolve(message.result);
	}

	private teardown(): void {
		this.closed = true;
		const socket = this.socket;
		this.socket = undefined;
		if (socket) {
			socket.removeAllListeners();
			socket.on("error", () => {});
			socket.terminate();
		}
		for (const entry of this.pending.values()) entry.reject(new Error("IDE connection closed"));
		this.pending.clear();
		if (!this.closeEmitted) {
			this.closeEmitted = true;
			this.emit("close");
		}
	}
}
