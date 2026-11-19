import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

export interface IdeLock {
	port: number;
	pid: number;
	ideName: string;
	workspaceFolders: string[];
	authToken?: string;
	transport: string;
	lockPath: string;
}

export function lockDirectory(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "ide");
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

export function parseLock(lockPath: string, raw: string): IdeLock | undefined {
	const port = Number.parseInt(lockPath.split(sep).pop()?.replace(/\.lock$/, "") ?? "", 10);
	if (!Number.isInteger(port) || port <= 0) return undefined;
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	if (typeof data !== "object" || data === null) return undefined;
	return {
		port,
		pid: typeof data.pid === "number" ? data.pid : 0,
		ideName: typeof data.ideName === "string" ? data.ideName : "IDE",
		workspaceFolders: Array.isArray(data.workspaceFolders)
			? data.workspaceFolders.filter((folder): folder is string => typeof folder === "string")
			: [],
		authToken: typeof data.authToken === "string" ? data.authToken : undefined,
		transport: typeof data.transport === "string" ? data.transport : "ws",
		lockPath,
	};
}

export function readLocks(dir = lockDirectory()): IdeLock[] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".lock"));
	} catch {
		return [];
	}
	const locks: IdeLock[] = [];
	for (const name of names) {
		const lockPath = join(dir, name);
		try {
			const lock = parseLock(lockPath, readFileSync(lockPath, "utf8"));
			if (lock && lock.transport === "ws" && isProcessAlive(lock.pid)) locks.push(lock);
		} catch {
			// unreadable or vanished lock files are ignored
		}
	}
	return locks;
}

/** Length of the matching workspace folder, or -1 when cwd is outside every workspace folder. */
export function workspaceMatch(lock: IdeLock, cwd: string): number {
	const target = canonical(cwd);
	let best = -1;
	for (const folder of lock.workspaceFolders) {
		const root = canonical(folder).replace(/[\\/]+$/, "");
		if (target === root || target.startsWith(root + sep)) best = Math.max(best, root.length);
	}
	return best;
}

/** IDEs whose workspace contains cwd, best match first; the CLAUDE_CODE_SSE_PORT one wins ties. */
export function matchingLocks(cwd: string, env: NodeJS.ProcessEnv = process.env, dir = lockDirectory(env)): IdeLock[] {
	const preferred = Number.parseInt(env.CLAUDE_CODE_SSE_PORT ?? "", 10);
	return readLocks(dir)
		.map((lock) => ({ lock, score: workspaceMatch(lock, cwd) }))
		.filter(({ score }) => score >= 0)
		.sort((a, b) => Number(b.lock.port === preferred) - Number(a.lock.port === preferred) || b.score - a.score)
		.map(({ lock }) => lock);
}
