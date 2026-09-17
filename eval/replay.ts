/**
 * Offline replay: run the jev classifier over recorded pi sessions and simulate the
 * cache-aware policy, without calling the coding model.
 *
 *   node --import tsx eval/replay.ts [--mock] [--mode rolling|batch] [--json out.json] <session.jsonl | dir>...
 *
 * Reports, per session and in total: tokens sent with and without pruning, a simulated
 * prompt-cache split (prefix identical to the previous call = cached), decisions by
 * bucket, and "re-read after forget" (a later read of a path whose earlier read was
 * pruned), which is the cheapest proxy for a harmful forget.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildItemState, JevClassifier, MockClassifier, type Classifier } from "../src/classifier.ts";
import { loadConfig } from "../src/config.ts";
import { applyLedger, decideBucket } from "../src/policy.ts";
import type { AgentMessage } from "../src/pi-types.ts";
import { contentText, describeToolCall, estimateTokensOfText } from "../src/text.ts";
import type { Decision } from "../src/types.ts";

const CACHED_PRICE = 0.1; // cached input relative to uncached, OpenAI-style

interface Args { mock: boolean; mode: "rolling" | "batch"; json?: string; paths: string[] }
function parseArgs(argv: string[]): Args {
	const a: Args = { mock: false, mode: "rolling", paths: [] };
	for (let i = 0; i < argv.length; i++) {
		const v = argv[i];
		if (v === "--mock") a.mock = true;
		else if (v === "--mode") a.mode = argv[++i] === "batch" ? "batch" : "rolling";
		else if (v === "--json") a.json = argv[++i];
		else a.paths.push(v);
	}
	return a;
}

function listSessions(paths: string[]): string[] {
	const out: string[] = [];
	for (const p of paths) {
		const st = statSync(p);
		if (st.isDirectory()) {
			for (const f of readdirSync(p, { recursive: true }) as string[]) if (f.endsWith(".jsonl") && !f.includes("events")) out.push(join(p, f));
		} else out.push(p);
	}
	return out.sort();
}

export function loadMessages(file: string): AgentMessage[] {
	const msgs: AgentMessage[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let e: { type?: string; message?: AgentMessage };
		try { e = JSON.parse(line); } catch { continue; }
		// Session files use {type:"message"}; --mode json event streams use {type:"message_end"}.
		if ((e.type === "message" || e.type === "message_end") && e.message) msgs.push(e.message);
	}
	return msgs;
}

function tokensOf(m: AgentMessage): number {
	if (m.role === "assistant") {
		let n = 0;
		for (const c of m.content) {
			if (c.type === "text") n += estimateTokensOfText(c.text);
			else if (c.type === "toolCall") n += estimateTokensOfText(JSON.stringify(c.arguments)) + 8;
		}
		return n;
	}
	if (m.role === "toolResult" || m.role === "user" || m.role === "custom") return estimateTokensOfText(contentText(m.content));
	return 0;
}

function canonical(m: AgentMessage): string {
	if (m.role === "toolResult") return `T:${m.toolCallId}:${contentText(m.content)}`;
	if (m.role === "assistant") return `A:${JSON.stringify(m.content.filter((c) => c.type !== "thinking"))}`;
	return `${m.role}:${contentText((m as { content?: unknown }).content)}`;
}

function readPath(m: AgentMessage): string | undefined {
	if (m.role !== "assistant") return undefined;
	for (const c of m.content) if (c.type === "toolCall" && c.name === "read" && typeof c.arguments?.path === "string") return c.arguments.path as string;
	return undefined;
}

export interface SessionReport {
	file: string;
	calls: number;
	toolResults: number;
	classified: number;
	buckets: Record<"keep" | "trim" | "forget", number>;
	durable: number;
	baseline: { input: number; cached: number; uncached: number; costUnits: number; finalContext: number };
	pruned: { input: number; cached: number; uncached: number; costUnits: number; finalContext: number };
	rereadAfterForget: number;
	rereadBaseline: number;
	jevMs: number[];
	decisions: { tool: string; summary: string; bucket: string; p: Decision["p"]; tokens: number }[];
}

export async function replaySession(file: string, classifier: Classifier, mode: "rolling" | "batch"): Promise<SessionReport> {
	const cfg = loadConfig();
	cfg.mode = mode;
	const messages = loadMessages(file);
	const ledger = new Map<string, Decision>();
	const argsById = new Map<string, unknown>();
	const report: SessionReport = {
		file, calls: 0, toolResults: 0, classified: 0, buckets: { keep: 0, trim: 0, forget: 0 }, durable: 0,
		baseline: { input: 0, cached: 0, uncached: 0, costUnits: 0, finalContext: 0 },
		pruned: { input: 0, cached: 0, uncached: 0, costUnits: 0, finalContext: 0 },
		rereadAfterForget: 0, rereadBaseline: 0, jevMs: [], decisions: [],
	};
	let firstUser = "";
	let latestUser = "";
	let buffer: (AgentMessage & { role: "toolResult" })[] = [];
	let prevBaseline: string[] = [];
	let prevPruned: string[] = [];
	const forgottenPaths = new Map<string, number>(); // path → call index when the forget was applied
	const readSeen = new Set<string>();

	for (let k = 0; k < messages.length; k++) {
		const m = messages[k];
		if (m.role === "user") {
			const t = contentText(m.content);
			if (!firstUser) firstUser = t;
			latestUser = t;
			continue;
		}
		if (m.role === "toolResult") {
			report.toolResults++;
			buffer.push(m);
			continue;
		}
		if (m.role !== "assistant") continue;
		if (m.stopReason === "error" || m.stopReason === "aborted") continue;

		// ---- the call that produced this assistant message: context = messages[0..k)
		report.calls++;
		const context = messages.slice(0, k);
		const applyPending = mode === "rolling";
		const result = applyLedger(context, ledger, cfg, applyPending, report.calls, mode);
		for (const d of result.appliedNow) {
			if (d.bucket === "forget") {
				const rp = (d as Decision & { path?: string }).path;
				if (rp) forgottenPaths.set(rp, report.calls);
			}
		}
		const baseCanon = context.map(canonical);
		const prunedCanon = result.messages.map(canonical);
		const baseTok = context.map(tokensOf);
		const prunedTok = result.messages.map(tokensOf);
		const account = (canon: string[], tok: number[], prev: string[], acc: SessionReport["baseline"]) => {
			let i = 0;
			while (i < canon.length && i < prev.length && canon[i] === prev[i]) i++;
			const cached = tok.slice(0, i).reduce((a, b) => a + b, 0);
			const total = tok.reduce((a, b) => a + b, 0);
			acc.input += total;
			acc.cached += cached;
			acc.uncached += total - cached;
			acc.costUnits += total - cached + CACHED_PRICE * cached;
			acc.finalContext = total;
		};
		account(baseCanon, baseTok, prevBaseline, report.baseline);
		account(prunedCanon, prunedTok, prevPruned, report.pruned);
		prevBaseline = baseCanon;
		prevPruned = prunedCanon;

		// ---- re-read accounting
		const rp = readPath(m);
		if (rp) {
			if (readSeen.has(rp)) report.rereadBaseline++;
			if (forgottenPaths.has(rp)) report.rereadAfterForget++;
			readSeen.add(rp);
		}
		for (const c of m.content) if (c.type === "toolCall") argsById.set(c.id, c.arguments);

		// ---- classification of the previous turn's results, given what the agent did next
		const afterText = contentText(m.content);
		const afterCalls = m.content.filter((c) => c.type === "toolCall").map((c) => ({ name: c.name, arguments: c.arguments }));
		const toClassify = buffer;
		buffer = [];
		await Promise.all(toClassify.map(async (r) => {
			const output = contentText(r.content);
			const tokens = estimateTokensOfText(output);
			if (tokens < cfg.minTokens) return;
			const args = argsById.get(r.toolCallId);
			const state = buildItemState(cfg, { firstUser, latestUser, toolName: r.toolName, args, isError: r.isError, output, afterText, afterCalls });
			const t0 = Date.now();
			const p = await classifier.classifyToolResult(state);
			report.jevMs.push(Date.now() - t0);
			const summary = describeToolCall(r.toolName, args, output.length, output.split("\n").length);
			const d: Decision & { path?: string } = {
				id: r.toolCallId, toolName: r.toolName, bucket: decideBucket(p, cfg), durable: p.durable > cfg.durableAbove, p, summary,
				tokensBefore: tokens, decidedAt: Date.now(), status: "pending",
			};
			const a = (args ?? {}) as { path?: unknown };
			if (r.toolName === "read" && typeof a.path === "string") d.path = a.path;
			ledger.set(d.id, d);
			report.classified++;
			report.buckets[d.bucket]++;
			if (d.durable) report.durable++;
			report.decisions.push({ tool: r.toolName, summary, bucket: d.bucket, p, tokens });
		}));
	}
	return report;
}

function pct(a: number, b: number): string { return b === 0 ? "n/a" : `${((100 * a) / b).toFixed(1)}%`; }
function k(n: number): string { return (n / 1000).toFixed(1) + "k"; }

export function renderTable(reports: SessionReport[]): string {
	const rows = reports.map((r) => {
		const name = r.file.split("/").slice(-3).join("/");
		return `| ${name} | ${r.calls} | ${r.toolResults} | ${r.buckets.keep}/${r.buckets.trim}/${r.buckets.forget} | ${k(r.baseline.input)} | ${k(r.pruned.input)} | ${pct(r.baseline.input - r.pruned.input, r.baseline.input)} | ${pct(r.baseline.cached, r.baseline.input)} | ${pct(r.pruned.cached, r.pruned.input)} | ${r.baseline.costUnits.toFixed(0)} | ${r.pruned.costUnits.toFixed(0)} | ${r.rereadAfterForget}/${r.rereadBaseline} |`;
	});
	const sum = (f: (r: SessionReport) => number) => reports.reduce((a, r) => a + f(r), 0);
	const total = `| **total** | ${sum((r) => r.calls)} | ${sum((r) => r.toolResults)} | ${sum((r) => r.buckets.keep)}/${sum((r) => r.buckets.trim)}/${sum((r) => r.buckets.forget)} | ${k(sum((r) => r.baseline.input))} | ${k(sum((r) => r.pruned.input))} | ${pct(sum((r) => r.baseline.input) - sum((r) => r.pruned.input), sum((r) => r.baseline.input))} | ${pct(sum((r) => r.baseline.cached), sum((r) => r.baseline.input))} | ${pct(sum((r) => r.pruned.cached), sum((r) => r.pruned.input))} | ${sum((r) => r.baseline.costUnits).toFixed(0)} | ${sum((r) => r.pruned.costUnits).toFixed(0)} | ${sum((r) => r.rereadAfterForget)}/${sum((r) => r.rereadBaseline)} |`;
	const ms = reports.flatMap((r) => r.jevMs);
	const meanMs = ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0;
	return [
		"| session | calls | tool results | keep/trim/forget | input base | input pruned | saved | cache hit base | cache hit pruned | cost base | cost pruned | re-read after forget / base |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|",
		...rows,
		total,
		"",
		`Cost units = uncached tokens + ${CACHED_PRICE} × cached tokens (simulated prefix cache). jev calls: ${ms.length}, mean ${meanMs} ms.`,
	].join("\n");
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const cfg = loadConfig();
	const classifier: Classifier = args.mock || !cfg.apiKey ? new MockClassifier() : new JevClassifier(cfg);
	if (!args.mock && !cfg.apiKey) console.error("TYPESAFE_API_KEY not set, using mock classifier");
	const files = listSessions(args.paths);
	const reports: SessionReport[] = [];
	for (const f of files) {
		const r = await replaySession(f, classifier, args.mode);
		if (r.calls === 0) continue;
		reports.push(r);
		console.error(`${f}: calls=${r.calls} results=${r.toolResults} keep/trim/forget=${r.buckets.keep}/${r.buckets.trim}/${r.buckets.forget}`);
	}
	console.log(renderTable(reports));
	if (args.json) writeFileSync(args.json, JSON.stringify(reports, null, 1));
}

if (process.argv[1] && process.argv[1].endsWith("replay.ts")) main().catch((e) => { console.error(e); process.exit(1); });
