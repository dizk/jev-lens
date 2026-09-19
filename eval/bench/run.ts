/**
 * Pre-send benchmark on real OpenHands trajectories (eval/bench/openhands.jsonl).
 *
 *   node --import tsx eval/bench/run.ts [--from 200] [--to 300] [--concurrency 6] [--variant file.json] [--mock] [--json out.json] [--max-per-traj 12]
 *
 * A variant file may override { config: Partial<Config>, prompts: Partial<PromptVariant>, views: Partial<ViewParams> }.
 * Prints the summary table (see eval/presend-score.ts for the metrics and the objective).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { loadConfig, type Config } from "jev-lens";
import { DEFAULT_PROMPTS, JevPresend, MockPresend, type PresendClassifier, type PromptVariant } from "jev-lens";
import type { AgentMessage } from "../../packages/pi/src/pi-types.ts";
import type { ViewParams } from "jev-lens";
import { renderSummary, scoreMessages, summarize, type ScoreRow } from "../presend-score.ts";

export interface Variant { name?: string; config?: Partial<Config>; prompts?: Partial<PromptVariant>; views?: Partial<ViewParams> }

function arg(name: string, def: string): string { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }

export async function runBenchmark(opts: { from: number; to: number; concurrency: number; variant: Variant; mock: boolean; maxPerTraj: number; file?: string; quiet?: boolean }) {
	const cfg: Config = { ...loadConfig(), ...(opts.variant.config ?? {}) };
	const prompts: PromptVariant = { ...DEFAULT_PROMPTS, ...(opts.variant.prompts ?? {}), viewDescriptions: { ...DEFAULT_PROMPTS.viewDescriptions, ...(opts.variant.prompts?.viewDescriptions ?? {}) } };
	const presend: PresendClassifier = opts.mock || !cfg.apiKey ? new MockPresend() : new JevPresend(new TypeSafeClient({ apiKey: cfg.apiKey }), cfg.model, prompts);
	const lines = readFileSync(opts.file ?? new URL("./openhands.jsonl", import.meta.url).pathname, "utf8").split("\n").filter((l) => l.trim()).slice(opts.from, opts.to);
	const rows: ScoreRow[] = [];
	let next = 0;
	const worker = async () => {
		while (next < lines.length) {
			const i = next++;
			const t = JSON.parse(lines[i]) as { id: string; messages: AgentMessage[] };
			// cap large results per trajectory so a few huge sessions do not dominate
			let seen = 0;
			const msgs = t.messages.filter((m) => { if (m.role !== "toolResult") return true; const big = (((m as { content: unknown }).content as { text?: string }[])[0]?.text?.length ?? 0) / 4 >= cfg.presendMinTokens; if (!big) return true; return seen++ < opts.maxPerTraj; });
			const r = await scoreMessages(t.id, msgs, presend, cfg, opts.variant.views ?? {}, (row) => { if (!opts.quiet) console.error(`${t.id} ${row.tool} ${row.args.slice(0, 50)} ${row.tokens}t → ${row.view} (${row.viewTokens}t)${row.editMiss ? " EDIT-MISS" : ""}${row.quoteMiss ? " QUOTE-MISS" : ""}${row.refMiss ? ` REF-MISS(${row.refMissId})` : ""}`); });
			rows.push(...r);
		}
	};
	await Promise.all(Array.from({ length: opts.concurrency }, worker));
	return { rows, summary: summarize(rows) };
}

async function main() {
	const variant: Variant = process.argv.includes("--variant") ? JSON.parse(readFileSync(arg("--variant", ""), "utf8")) : {};
	const { rows, summary } = await runBenchmark({ from: Number(arg("--from", "200")), to: Number(arg("--to", "300")), concurrency: Number(arg("--concurrency", "6")), variant, mock: process.argv.includes("--mock"), maxPerTraj: Number(arg("--max-per-traj", "12")), quiet: process.argv.includes("--quiet") });
	console.log(`# variant: ${variant.name ?? "default"}, trajectories ${arg("--from", "200")}-${arg("--to", "300")}\n`);
	console.log(renderSummary(summary));
	if (process.argv.includes("--json")) writeFileSync(arg("--json", ""), JSON.stringify({ variant, summary, rows }, null, 1));
}
if (process.argv[1]?.endsWith("run.ts")) main().catch((e) => { console.error(e); process.exit(1); });
