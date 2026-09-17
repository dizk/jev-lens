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
import { buildPresendState, decideView, expandRelevantBlocks, JevPresend, MockPresend, type PresendClassifier } from "../src/presend.ts";
import type { AgentMessage } from "../src/pi-types.ts";
import { contentText, estimateTokensOfText } from "../src/text.ts";
import { buildCandidates, extractTerms, type View } from "../src/views.ts";

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

interface Row { file: string; tool: string; args: string; kind: string; tokens: number; view: string; viewTokens: number; chosen: string; needsFull: number; pFull: number; confidence: number; editMiss: boolean; quoteMiss: boolean; editsChecked: number }

function omittedText(full: string, view: View): string {
	if (view.kind === "full") return "";
	const inc = new Set(view.included);
	return full.split("\n").filter((_, i) => !inc.has(i + 1)).join("\n");
}
function spans(text: string, n = 40): string[] {
	const out: string[] = [];
	for (const line of text.split("\n")) { const t = line.trim(); if (t.length >= n) out.push(t); }
	return out;
}

async function main() {
	const argv = process.argv.slice(2);
	const mock = argv.includes("--mock");
	const jsonOut = argv.includes("--json") ? argv[argv.indexOf("--json") + 1] : undefined;
	const paths = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--json");
	const cfg = loadConfig();
	const presend: PresendClassifier = mock || !cfg.apiKey ? new MockPresend() : new JevPresend(new TypeSafeClient({ apiKey: cfg.apiKey }), cfg.model);
	const rows: Row[] = [];
	for (const file of listSessions(paths)) {
		const msgs = loadMessages(file);
		let firstUser = "", latestUser = "", lastAssistant = "";
		const argsById = new Map<string, unknown>();
		for (let k = 0; k < msgs.length; k++) {
			const m = msgs[k];
			if (m.role === "user") { const t = contentText(m.content); if (!firstUser) firstUser = t; latestUser = t; continue; }
			if (m.role === "assistant") { lastAssistant = contentText(m.content); for (const c of m.content) if (c.type === "toolCall") argsById.set(c.id, c.arguments); continue; }
			if (m.role !== "toolResult") continue;
			const text = contentText(m.content);
			const tokens = estimateTokensOfText(text);
			if (tokens < cfg.presendMinTokens) continue;
			const args = argsById.get(m.toolCallId);
			const terms = extractTerms(latestUser, lastAssistant, JSON.stringify(args ?? {}));
			const cands = buildCandidates(m.toolName, args, text, terms);
			if (cands.views.length < 2) continue;
			const state = buildPresendState(cfg, { firstUser, latestUser, agentText: lastAssistant, toolName: m.toolName, args, isError: m.isError, cands, totalLines: text.split("\n").length, totalChars: text.length });
			const answer = await presend.choose(state, cands.views.map((v) => v.kind));
			let view = decideView(answer, cands, cfg);
			if (view.kind !== "full") { const ex = await expandRelevantBlocks(presend, state, text, cands, view, cfg.presendExpandAbove); if (ex) view = ex.view; }
			// what did the agent do next?
			const path = (args as { path?: string })?.path;
			let editMiss = false, quoteMiss = false, editsChecked = 0;
			const omitted = omittedText(text, view);
			let seen = 0;
			for (let j = k + 1; j < msgs.length && seen < 3; j++) {
				const n = msgs[j];
				if (n.role !== "assistant") continue;
				seen++;
				if (seen === 1) {
					const nt = contentText(n.content);
					for (const s of spans(nt)) if (omitted.includes(s) && !view.text.includes(s)) { quoteMiss = true; break; }
				}
				for (const c of n.content) {
					if (c.type !== "toolCall" || c.name !== "edit" || (c.arguments as { path?: string })?.path !== path) continue;
					for (const e of ((c.arguments as { edits?: { oldText: string }[] }).edits ?? [])) {
						editsChecked++;
						if (text.includes(e.oldText) && !view.text.includes(e.oldText.split("\n")[0].trim().slice(0, 60))) editMiss = true;
					}
				}
			}
			rows.push({ file: file.split("/").slice(-4, -2).join("/"), tool: m.toolName, args: JSON.stringify(args ?? {}).slice(0, 60), kind: cands.kind, tokens, view: view.kind, viewTokens: estimateTokensOfText(view.text), chosen: answer.choice, needsFull: answer.needsFull, pFull: answer.probabilities.full ?? 0, confidence: answer.confidence, editMiss, quoteMiss, editsChecked });
			console.error(`${rows.at(-1)!.file} ${m.toolName} ${rows.at(-1)!.args} ${tokens}t → ${view.kind} (${rows.at(-1)!.viewTokens}t) needsFull=${answer.needsFull.toFixed(2)} pFull=${(answer.probabilities.full ?? 0).toFixed(2)}${editMiss ? " EDIT-MISS" : ""}${quoteMiss ? " QUOTE-MISS" : ""}`);
		}
	}
	const total = rows.reduce((a, r) => a + r.tokens, 0), sent = rows.reduce((a, r) => a + r.viewTokens, 0);
	const compressed = rows.filter((r) => r.view !== "full");
	const byView = new Map<string, number>();
	for (const r of rows) byView.set(r.view, (byView.get(r.view) || 0) + 1);
	const editable = rows.filter((r) => r.editsChecked > 0);
	console.log(`| large results | compressed | tokens (all) | tokens sent | saved | views | edit-miss / results later edited | quote-miss |`);
	console.log(`|---|---|---|---|---|---|---|---|`);
	console.log(`| ${rows.length} | ${compressed.length} | ${(total / 1000).toFixed(1)}k | ${(sent / 1000).toFixed(1)}k | ${total ? ((100 * (total - sent)) / total).toFixed(1) : 0}% | ${[...byView].map(([k, v]) => `${k}:${v}`).join(", ")} | ${rows.filter((r) => r.editMiss).length} / ${editable.length} | ${rows.filter((r) => r.quoteMiss).length} |`);
	if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
