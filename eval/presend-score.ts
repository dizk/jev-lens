/**
 * Shared scoring of pre-send compression against a recorded session: for every large tool
 * result, build views, let the classifier choose, and compare with what the agent did next.
 */
import { matchesGlob, posix } from "node:path";
import { displayedFiles } from "../src/shell-display.ts";
import type { Config } from "../src/config.ts";
import { buildPresendState, decideView, expandRelevantBlocks, type PresendClassifier } from "../src/presend.ts";
import type { AgentMessage } from "../src/pi-types.ts";
import { contentText, estimateTokensOfText } from "../src/text.ts";
import { buildCandidatesAsync, extractTerms, type View, type ViewParams } from "../src/views.ts";

export interface ScoreRow {
	session: string; tool: string; args: string; kind: string; tokens: number; view: string; viewTokens: number; chosen: string;
	needsFull: number; pFull: number; confidence: number; editMiss: boolean; quoteMiss: boolean; refMiss: boolean; refMissId?: string; editsChecked: number; ms: number;
	/** Per-block probabilities from the expansion step, when it ran. */
	expandProbs?: number[];
}

/** Code-like identifiers only: snake_case, camelCase or containing digits, 5+ chars. Plain words (even long ones) are not identifiers. */
function identifiers(text: string): Set<string> {
	const out = new Set<string>();
	for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{4,}/g)) {
		const w = m[0];
		const camel = /[a-z][A-Z]/.test(w);
		const snake = w.includes("_") && !/^_+$/.test(w);
		const digit = /\d/.test(w);
		if (camel || snake || digit) out.add(w);
	}
	return out;
}

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

export async function scoreMessages(
	session: string,
	msgs: AgentMessage[],
	presend: PresendClassifier,
	cfg: Config,
	viewParams: Partial<ViewParams> = {},
	onRow?: (r: ScoreRow) => void,
): Promise<ScoreRow[]> {
	const rows: ScoreRow[] = [];
	let firstUser = "", latestUser = "", lastAssistant = "";
	const argsById = new Map<string, unknown>();
	/** Everything the agent has already seen: identifiers from all earlier messages (so ref-miss only counts what it could only have learned from the omitted part). */
	const seenIds = new Set<string>();
	const learn = (t: string) => { for (const id of identifiers(t)) seenIds.add(id); };
	for (let k = 0; k < msgs.length; k++) {
		const m = msgs[k];
		if (m.role === "user") { const t = contentText(m.content); if (!firstUser) firstUser = t; latestUser = t; learn(t); continue; }
		if (m.role === "assistant") { lastAssistant = contentText(m.content); learn(lastAssistant); for (const c of m.content) if (c.type === "toolCall") { argsById.set(c.id, c.arguments); learn(JSON.stringify(c.arguments ?? {})); } continue; }
		if (m.role !== "toolResult") continue;
		const text = contentText(m.content);
		const tokens = estimateTokensOfText(text);
		if (tokens < cfg.presendMinTokens) { learn(text); continue; }
		const args = argsById.get(m.toolCallId);
		const terms = extractTerms(latestUser, lastAssistant, JSON.stringify(args ?? {}));
		const cands = await buildCandidatesAsync(m.toolName, args, text, terms, viewParams);
		if (cands.views.length < 2) continue;
		const t0 = Date.now();
		const state = buildPresendState(cfg, { firstUser, latestUser, agentText: lastAssistant, toolName: m.toolName, args, isError: m.isError, cands, totalLines: text.split("\n").length, totalChars: text.length });
		let answer: Awaited<ReturnType<PresendClassifier["choose"]>>;
		try { answer = await presend.choose(state, cands.views.map((v) => v.kind)); } catch { continue; }
		let view = decideView(answer, cands, cfg);
		let expandProbs: number[] | undefined;
		if (view.kind !== "full") {
			try { const ex = await expandRelevantBlocks(presend, state, text, cands, view, cands.kind === "command" ? cfg.presendSectionExpandAbove : cfg.presendExpandAbove, undefined, cands.blocks, cfg.presendSectionFloor); if (ex) { view = ex.view; expandProbs = ex.probs.map((p) => Math.round(p * 100) / 100); } } catch {}
		}
		const a = args as { path?: string; command?: string } | undefined;
		const paths = a?.path ? [a.path] : m.toolName === "bash" && a?.command ? displayedFiles(a.command) ?? [] : [];
		const normalize = (p: string) => posix.normalize(p.replace(/^@/, ""));
		const matchesPath = (p: unknown) => typeof p === "string" && paths.some((path) =>
			normalize(p) === normalize(path) || (m.toolName === "bash" && matchesGlob(normalize(p), normalize(path))));
		const rereadPaths = new Set<string>();
		let editMiss = false, quoteMiss = false, editsChecked = 0, refMiss = false;
		const omitted = omittedText(text, view);
		// ref-miss: the agent's next two steps use an identifier that exists only in the omitted part
		// (not in the view, the task, its own earlier reasoning or the tool call), i.e. it learned it from what we dropped.
		const known = new Set([...seenIds, ...identifiers(view.text)]);
		const omittedIds = view.kind === "full" ? new Set<string>() : identifiers(omitted);
		let refMissId = "";
		// The view is the agent's only knowledge of this output until it reads the same path again
		// (or for at most 12 assistant messages), so edits of that path in that window are checked.
		let seen = 0;
		let reread = false;
		for (let j = k + 1; j < msgs.length && seen < 12 && !reread; j++) {
			const n = msgs[j];
			if (n.role !== "assistant") continue;
			seen++;
			if (seen === 1) { const nt = contentText(n.content); for (const s of spans(nt)) if (omitted.includes(s) && !view.text.includes(s)) { quoteMiss = true; break; } }
			if (seen <= 2 && omittedIds.size) {
				const used = identifiers(contentText(n.content) + " " + JSON.stringify(n.content.filter((c) => c.type === "toolCall").map((c) => (c as { arguments: unknown }).arguments)));
				for (const id of used) if (omittedIds.has(id) && !known.has(id)) { refMiss = true; refMissId = id; break; }
			}
			for (const c of n.content) {
				if (c.type === "toolCall" && c.name === "read") {
					const readPath = (c.arguments as { path?: string })?.path;
					if (readPath && matchesPath(readPath)) rereadPaths.add(normalize(readPath));
				}
				if (c.type === "toolCall" && c.name === "recall" && (c.arguments as { id?: string })?.id === m.toolCallId) reread = true;
			}
			for (const c of n.content) {
				if (c.type !== "toolCall" || c.name !== "edit" || reread) continue;
				const editArgs = c.arguments as { path?: string; oldText?: string; edits?: { oldText: string }[] };
				if (!matchesPath(editArgs.path) || rereadPaths.has(normalize(editArgs.path!))) continue;
				for (const e of (editArgs.edits ?? (editArgs.oldText ? [{ oldText: editArgs.oldText }] : []))) {
					const first = (e.oldText ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
					if (!first) continue;
					editsChecked++;
					if (text.includes(first) && !view.text.includes(first.slice(0, 80))) editMiss = true;
				}
			}
		}
		// after scoring, the agent has seen the view (not the omitted part)
		learn(view.text);
		const row: ScoreRow = { session, tool: m.toolName, refMissId, args: JSON.stringify(args ?? {}).slice(0, 80), kind: cands.kind, tokens, view: view.kind, viewTokens: estimateTokensOfText(view.text), chosen: answer.choice, needsFull: answer.needsFull, pFull: answer.probabilities.full ?? 0, confidence: answer.confidence, editMiss, quoteMiss, refMiss, editsChecked, ms: Date.now() - t0, expandProbs };
		rows.push(row);
		onRow?.(row);
	}
	return rows;
}

export interface Summary {
	results: number; compressed: number; tokens: number; sent: number; savedPct: number;
	editable: number; editMiss: number; editMissPct: number; quoteMiss: number; quoteMissPct: number; refMiss: number; refMissPct: number;
	views: Record<string, number>; byKind: Record<string, { n: number; savedPct: number; editMissPct: number; refMissPct: number }>;
	/** Objective for autoresearch: saved% minus 5× edit-miss% minus 2× quote-miss% minus 1× ref-miss% (percentage points). */
	objective: number; meanMs: number;
}

export function summarize(rows: ScoreRow[]): Summary {
	const tokens = rows.reduce((a, r) => a + r.tokens, 0), sent = rows.reduce((a, r) => a + r.viewTokens, 0);
	const editable = rows.filter((r) => r.editsChecked > 0);
	const editMiss = rows.filter((r) => r.editMiss).length, quoteMiss = rows.filter((r) => r.quoteMiss).length, refMiss = rows.filter((r) => r.refMiss).length;
	const views: Record<string, number> = {};
	for (const r of rows) views[r.view] = (views[r.view] ?? 0) + 1;
	const byKind: Summary["byKind"] = {};
	for (const kind of new Set(rows.map((r) => r.kind))) {
		const rs = rows.filter((r) => r.kind === kind);
		const t = rs.reduce((a, r) => a + r.tokens, 0), s = rs.reduce((a, r) => a + r.viewTokens, 0);
		const ed = rs.filter((r) => r.editsChecked > 0);
		byKind[kind] = { n: rs.length, savedPct: t ? (100 * (t - s)) / t : 0, editMissPct: ed.length ? (100 * ed.filter((r) => r.editMiss).length) / ed.length : 0, refMissPct: rs.length ? (100 * rs.filter((r) => r.refMiss).length) / rs.length : 0 };
	}
	const savedPct = tokens ? (100 * (tokens - sent)) / tokens : 0;
	const editMissPct = editable.length ? (100 * editMiss) / editable.length : 0;
	const quoteMissPct = rows.length ? (100 * quoteMiss) / rows.length : 0;
	const refMissPct = rows.length ? (100 * refMiss) / rows.length : 0;
	return { results: rows.length, compressed: rows.filter((r) => r.view !== "full").length, tokens, sent, savedPct, editable: editable.length, editMiss, editMissPct, quoteMiss, quoteMissPct, refMiss, refMissPct, views, byKind, objective: savedPct - 5 * editMissPct - 2 * quoteMissPct - refMissPct, meanMs: rows.length ? rows.reduce((a, r) => a + r.ms, 0) / rows.length : 0 };
}

export function renderSummary(s: Summary): string {
	return [
		"| large results | compressed | tokens | sent | saved | edit-miss (of edited) | quote-miss | ref-miss | objective | views | mean ms |",
		"|---|---|---|---|---|---|---|---|---|---|---|",
		`| ${s.results} | ${s.compressed} | ${(s.tokens / 1000).toFixed(1)}k | ${(s.sent / 1000).toFixed(1)}k | ${s.savedPct.toFixed(1)}% | ${s.editMiss}/${s.editable} (${s.editMissPct.toFixed(1)}%) | ${s.quoteMiss} (${s.quoteMissPct.toFixed(1)}%) | ${s.refMiss} (${s.refMissPct.toFixed(1)}%) | ${s.objective.toFixed(1)} | ${Object.entries(s.views).map(([k, v]) => `${k}:${v}`).join(", ")} | ${Math.round(s.meanMs)} |`,
		"",
		"| kind | n | saved | edit-miss | ref-miss |",
		"|---|---|---|---|---|",
		...Object.entries(s.byKind).map(([k, v]) => `| ${k} | ${v.n} | ${v.savedPct.toFixed(1)}% | ${v.editMissPct.toFixed(1)}% | ${v.refMissPct.toFixed(1)}% |`),
	].join("\n");
}
