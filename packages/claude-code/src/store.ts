/**
 * Where the plugin keeps state between hook runs: full outputs for the recall tool, a JSON-lines log
 * and the TypeSafe key file. Everything lives in one directory: JEV_LENS_DATA_DIR, else Claude Code's
 * persistent plugin data directory, else ~/.claude/jev-lens.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir(): string {
	return process.env.JEV_LENS_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA || join(homedir(), ".claude", "jev-lens");
}

/** The key file has a fixed, documented place, independent of where Claude Code puts plugin data. */
export function keyFile(): string {
	return join(homedir(), ".claude", "jev-lens", "key.json");
}

export function logFile(): string {
	return join(dataDir(), "log.jsonl");
}

export interface StoredOutput {
	id: string;
	toolName: string;
	args: unknown;
	text: string;
	view: string;
	kind: string;
	sessionId: string;
	cwd: string;
	at: number;
}

/** tool_use_ids are [A-Za-z0-9_-]; anything else is replaced so an id can never leave the outputs directory. */
function safeName(id: string): string {
	return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);
}

function outputsDir(): string {
	return join(dataDir(), "outputs");
}

export function saveOutput(rec: StoredOutput): string {
	const dir = outputsDir();
	mkdirSync(dir, { recursive: true });
	const p = join(dir, `${safeName(rec.id)}.json`);
	writeFileSync(p, JSON.stringify(rec));
	return p;
}

export function loadOutput(id: string): StoredOutput | undefined {
	try {
		const p = join(outputsDir(), `${safeName(id)}.json`);
		if (!existsSync(p)) return undefined;
		return JSON.parse(readFileSync(p, "utf8")) as StoredOutput;
	} catch {
		return undefined;
	}
}

export function appendLog(record: Record<string, unknown>): void {
	try {
		mkdirSync(dataDir(), { recursive: true });
		appendFileSync(logFile(), `${JSON.stringify({ t: Date.now(), ...record })}\n`);
	} catch {}
}

export function readLog(): Record<string, unknown>[] {
	try {
		if (!existsSync(logFile())) return [];
		return readFileSync(logFile(), "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });
	} catch {
		return [];
	}
}

const DAY = 24 * 60 * 60 * 1000;

/** Drop stored outputs older than `maxAgeMs`, at most once an hour (a stamp file records the last sweep). */
export function pruneOutputs(maxAgeMs = 14 * DAY, now = Date.now()): number {
	try {
		const dir = outputsDir();
		if (!existsSync(dir)) return 0;
		const stamp = join(dataDir(), "prune.stamp");
		if (existsSync(stamp) && now - statSync(stamp).mtimeMs < 60 * 60 * 1000) return 0;
		writeFileSync(stamp, String(now));
		let removed = 0;
		for (const f of readdirSync(dir)) {
			const p = join(dir, f);
			if (now - statSync(p).mtimeMs > maxAgeMs) { unlinkSync(p); removed++; }
		}
		return removed;
	} catch {
		return 0;
	}
}
