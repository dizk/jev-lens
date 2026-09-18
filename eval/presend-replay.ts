/**
 * Offline evaluation of pre-send compression on recorded sessions.
 *
 *   node --import tsx eval/presend-replay.ts [--mock] [--json out.json] <session.jsonl | events.jsonl | dir>...
 *
 * For every large tool result: build the candidate views, ask jev which to send, and check the
 * choice against what the agent actually did next in the recording:
 *   - "edit-miss": within the next 3 assistant messages the agent edited the same file and an
 *     oldText is not contained in the chosen view → the agent would have needed a recall.
 *   - "quote-miss": the next assistant message contains a 40+ char span that only exists in the
 *     omitted part of the output.
 * Reports tokens saved, views chosen, and the miss rates.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { loadConfig } from "../src/config.ts";
import { JevPresend, MockPresend, type PresendClassifier } from "../src/presend.ts";
import type { AgentMessage } from "../src/pi-types.ts";
import { renderSummary, scoreMessages, summarize, type ScoreRow } from "./presend-score.ts";

function listSessions(paths: string[]): string[] {
	const out: string[] = [];
	for (const p of paths) {
		if (statSync(p).isDirectory()) for (const f of readdirSync(p, { recursive: true }) as string[]) { if (f.endsWith(".jsonl") && !f.includes("results")) out.push(join(p, f)); }
		else out.push(p);
	}
	return out.sort();
}
function loadMessages(file: string): AgentMessage[] {
	const msgs: AgentMessage[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let e: { type?: string; message?: AgentMessage };
		try { e = JSON.parse(line); } catch { continue; }
		if ((e.type === "message" || e.type === "message_end") && e.message) msgs.push(e.message);
	}
	return msgs;
}


async function main() {
	const argv = process.argv.slice(2);
	const mock = argv.includes("--mock");
	const jsonOut = argv.includes("--json") ? argv[argv.indexOf("--json") + 1] : undefined;
	const paths = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--json");
	const cfg = loadConfig();
	const presend: PresendClassifier = mock || !cfg.apiKey ? new MockPresend() : new JevPresend(new TypeSafeClient({ apiKey: cfg.apiKey }), cfg.model);
	const rows: ScoreRow[] = [];
	for (const file of listSessions(paths)) {
		const r = await scoreMessages(file.split("/").slice(-4, -2).join("/"), loadMessages(file), presend, cfg, {}, (row) => console.error(`${row.session} ${row.tool} ${row.args.slice(0, 50)} ${row.tokens}t → ${row.view} (${row.viewTokens}t) needsFull=${row.needsFull.toFixed(2)} pFull=${row.pFull.toFixed(2)}${row.editMiss ? " EDIT-MISS" : ""}${row.quoteMiss ? " QUOTE-MISS" : ""}`));
		rows.push(...r);
	}
	console.log(renderSummary(summarize(rows)));
	if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
