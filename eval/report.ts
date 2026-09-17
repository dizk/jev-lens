/**
 * Aggregate eval/runs/results.jsonl into a markdown comparison of conditions.
 *   node --import tsx eval/report.ts [results.jsonl]
 */
import { readFileSync } from "node:fs";
import type { RunResult } from "./generate.ts";

const file = process.argv[2] ?? new URL("./runs/results.jsonl", import.meta.url).pathname;
const rows: RunResult[] = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

// Keep the latest run per (cond, task, n).
const latest = new Map<string, RunResult>();
for (const r of rows) latest.set(`${r.cond}|${r.task}|${r.n}`, r);
const results = [...latest.values()];
const conds = [...new Set(results.map((r) => r.cond))].sort();
const tasks = [...new Set(results.map((r) => r.task))];

const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
const pct = (x: number) => `${(100 * x).toFixed(0)}%`;

console.log("## Per condition\n");
console.log("| condition | runs | passed | calls | uncached input | cached input | cache hit | output | wall (s) | pruned tokens | final prompt (mean) |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const c of conds) {
	const rs = results.filter((r) => r.cond === c);
	const sum = (f: (r: RunResult) => number) => rs.reduce((a, r) => a + f(r), 0);
	const input = sum((r) => r.input), cached = sum((r) => r.cacheRead);
	console.log(`| ${c} | ${rs.length} | ${rs.filter((r) => r.ok).length} | ${sum((r) => r.calls)} | ${k(input)} | ${k(cached)} | ${pct(cached / Math.max(1, input + cached))} | ${k(sum((r) => r.output))} | ${Math.round(sum((r) => r.wallMs) / 1000)} | ${k(sum((r) => r.pruned ?? 0))} | ${k(sum((r) => r.finalPrompt ?? 0) / Math.max(1, rs.length))} |`);
}

console.log("\n## Per task\n");
console.log(`| task | ${conds.map((c) => `${c} ok`).join(" | ")} | ${conds.map((c) => `${c} calls`).join(" | ")} | ${conds.map((c) => `${c} uncached`).join(" | ")} | ${conds.map((c) => `${c} hit`).join(" | ")} |`);
console.log(`|---|${conds.map(() => "---|---|---|---").join("|")}|`);
for (const t of tasks) {
	const cell = (c: string, f: (rs: RunResult[]) => string) => f(results.filter((r) => r.cond === c && r.task === t));
	const okc = (rs: RunResult[]) => `${rs.filter((r) => r.ok).length}/${rs.length}`;
	const calls = (rs: RunResult[]) => String(rs.reduce((a, r) => a + r.calls, 0));
	const unc = (rs: RunResult[]) => k(rs.reduce((a, r) => a + r.input, 0));
	const hit = (rs: RunResult[]) => { const i = rs.reduce((a, r) => a + r.input, 0), c = rs.reduce((a, r) => a + r.cacheRead, 0); return pct(c / Math.max(1, i + c)); };
	console.log(`| ${t} | ${conds.map((c) => cell(c, okc)).join(" | ")} | ${conds.map((c) => cell(c, calls)).join(" | ")} | ${conds.map((c) => cell(c, unc)).join(" | ")} | ${conds.map((c) => cell(c, hit)).join(" | ")} |`);
}
