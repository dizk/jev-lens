/**
 * A status line segment for Claude Code, in the shape of the pi extension's status text:
 *
 *   jev-lens −12.3k · 5/8 · 1 recalls
 *
 * Reads the statusLine JSON from stdin (for the session id), sums this session's records from the log
 * and prints one line. Claude Code has no plugin-provided status line, so the user appends this to
 * their own statusLine command; see the README. Anything unexpected prints nothing and exits 0.
 */
import { pathToFileURL } from "node:url";
import { readAllLogs } from "./store.ts";

export interface SessionTotals {
	considered: number;
	compressed: number;
	tokensSaved: number;
	recalls: number;
	errors: number;
	mock: boolean;
}

export function sessionTotals(records: Record<string, unknown>[], sessionId: string | undefined): SessionTotals {
	const num = (v: unknown) => (typeof v === "number" ? v : 0);
	const t: SessionTotals = { considered: 0, compressed: 0, tokensSaved: 0, recalls: 0, errors: 0, mock: false };
	const ids = new Set<string>();
	for (const r of records) {
		if (r.event === "presend" && r.session === sessionId) {
			t.considered++;
			if (typeof r.id === "string") ids.add(r.id);
			if (r.mock === true) t.mock = true;
			if (r.view !== "full") { t.compressed++; t.tokensSaved += Math.max(0, num(r.tokens) - num(r.sentTokens)); }
		} else if (r.event === "presend_error" && r.session === sessionId) {
			t.errors++;
		}
	}
	// Newer recall records carry the session; older ones are matched on the output id.
	for (const r of records) if (r.event === "recall" && (r.session === sessionId || (r.session === undefined && typeof r.id === "string" && ids.has(r.id)))) t.recalls++;
	return t;
}

/** Same layout as the pi extension's status line, without the parts Claude Code has no data for. */
export function statusText(t: SessionTotals): string {
	const disabled = process.env.JEV_LENS_DISABLED === "1";
	const tag = disabled ? "jev-lens(disabled)" : t.mock ? "jev-lens(mock)" : "jev-lens";
	const label = t.errors ? `${tag}(degraded)` : tag;
	const recalls = `${t.recalls} recall${t.recalls === 1 ? "" : "s"}`;
	return `${label} −${(t.tokensSaved / 1000).toFixed(1)}k · ${t.compressed}/${t.considered} · ${recalls}`;
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const c of process.stdin) chunks.push(c as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
	let sessionId: string | undefined;
	try {
		const input = JSON.parse(await readStdin()) as { session_id?: string };
		sessionId = input.session_id;
	} catch {
		return;
	}
	if (!sessionId) return;
	process.stdout.write(statusText(sessionTotals(readAllLogs(), sessionId)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(() => {}).finally(() => process.exit(0));
}
