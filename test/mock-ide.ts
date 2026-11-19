import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { type AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { AUTH_HEADER } from "../src/client.ts";

export interface MockOptions {
	token?: string;
	echoSubprotocol?: boolean;
	tools?: string[];
	onToolCall?: (name: string, args: any) => unknown | Promise<unknown>;
}

/** Minimal stand-in for an IDE extension: a WebSocket MCP server guarded by the lock-file token. */
export class MockIde {
	readonly token: string;
	readonly received: { method: string; params: any }[] = [];
	sockets = new Set<WebSocket>();
	port = 0;
	private server!: WebSocketServer;

	private options: MockOptions;

	constructor(options: MockOptions = {}) {
		this.options = options;
		this.token = options.token ?? "0123456789abcdef0123456789abcdef";
	}

	async start(): Promise<this> {
		this.server = new WebSocketServer({
			host: "127.0.0.1",
			port: 0,
			handleProtocols: (protocols) => (this.options.echoSubprotocol === false ? false : [...protocols][0] ?? false),
			verifyClient: ({ req }: { req: IncomingMessage }) => req.headers[AUTH_HEADER] === this.token,
		});
		await new Promise<void>((resolve) => this.server.once("listening", resolve));
		this.port = (this.server.address() as AddressInfo).port;
		this.server.on("connection", (socket) => {
			this.sockets.add(socket);
			socket.on("close", () => this.sockets.delete(socket));
			socket.on("message", (data) => void this.handle(socket, JSON.parse(data.toString())));
		});
		return this;
	}

	writeLock(dir: string, workspaceFolders: string[], pid = process.pid): string {
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${this.port}.lock`);
		writeFileSync(
			path,
			JSON.stringify({ pid, workspaceFolders, ideName: "MockIDE", transport: "ws", authToken: this.token }),
		);
		return path;
	}

	notify(method: string, params: unknown): void {
		for (const socket of this.sockets) socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
	}

	async stop(): Promise<void> {
		for (const socket of this.sockets) socket.terminate();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	private async handle(socket: WebSocket, message: any): Promise<void> {
		this.received.push({ method: message.method, params: message.params });
		if (message.id === undefined) return;
		const reply = (result: unknown) => socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		switch (message.method) {
			case "initialize":
				return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mock-ide", version: "1" } });
			case "tools/list":
				return reply({ tools: (this.options.tools ?? ["openDiff", "getDiagnostics"]).map((name) => ({ name })) });
			case "tools/call": {
				const result = await this.options.onToolCall?.(message.params.name, message.params.arguments);
				return reply(result ?? { content: [{ type: "text", text: "ok" }] });
			}
			default:
				socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }));
		}
	}
}
