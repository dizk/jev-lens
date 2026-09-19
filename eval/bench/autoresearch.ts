/**
 * Autoresearch loop for pre-send compression.
 *
 *   node --import tsx eval/bench/autoresearch.ts [--iterations 8] [--from 0] [--to 60] [--concurrency 6] [--researcher openai-codex/gpt-5.6-luna] [--round-dir research/round3]
 *
 * Each iteration: ask the researcher model (via pi -p) for a new variant JSON given PROGRAM.md, the current best,
 * and the history; evaluate it on the train slice; keep it if the objective improves. Everything is logged to
 * research/log.jsonl and the best variant is written to research/best.json. Evaluate the final best on the
 * holdout slice with eval/bench/run.ts --variant research/best.json --from 200 --to 300.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBenchmark, type Variant } from "./run.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
function arg(name: string, def: string): string { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }
const RESEARCH = resolve(ROOT, arg("--round-dir", "research"));
const PROGRAM_FILE = join(ROOT, "research", "PROGRAM.md");

function askResearcher(model: string, prompt: string): Variant | undefined {
	const r = spawnSync("pi", ["-p", "--no-session", "--no-tools", "--model", model, "--thinking", "medium", prompt], { cwd: ROOT, encoding: "utf8", timeout: 240_000, stdio: ["ignore", "pipe", "pipe"] });
	const out = r.stdout ?? "";
	const m = out.match(/\{[\s\S]*\}/);
	if (!m) { console.error("researcher gave no JSON:", out.slice(0, 300), r.stderr?.slice(0, 300)); return undefined; }
	try { return JSON.parse(m[0]); } catch (e) { console.error("bad JSON from researcher", String(e)); return undefined; }
}

async function main() {
	const iterations = Number(arg("--iterations", "8"));
	const from = Number(arg("--from", "0")), to = Number(arg("--to", "60"));
	const concurrency = Number(arg("--concurrency", "6"));
	const researcher = arg("--researcher", "openai-codex/gpt-5.6-luna");
	mkdirSync(RESEARCH, { recursive: true });
	const program = readFileSync(PROGRAM_FILE, "utf8");
	const logFile = join(RESEARCH, "log.jsonl");
	const history: { variant: Variant; summary: ReturnType<typeof JSON.parse>; kept: boolean }[] = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
	let best: { variant: Variant; objective: number; summary: unknown } | undefined = existsSync(join(RESEARCH, "best.json")) ? JSON.parse(readFileSync(join(RESEARCH, "best.json"), "utf8")) : undefined;
	if (!best) {
		console.error("[autoresearch] baseline evaluation");
		const { summary } = await runBenchmark({ from, to, concurrency, variant: { name: "baseline" }, mock: false, maxPerTraj: 12, quiet: true });
		best = { variant: { name: "baseline" }, objective: summary.objective, summary };
		appendFileSync(logFile, `${JSON.stringify({ variant: best.variant, summary, kept: true, t: Date.now() })}\n`);
		writeFileSync(join(RESEARCH, "best.json"), JSON.stringify(best, null, 1));
		history.push({ variant: best.variant, summary, kept: true });
		console.error(`[autoresearch] baseline objective ${summary.objective.toFixed(2)} saved ${summary.savedPct.toFixed(1)}% editMiss ${summary.editMissPct.toFixed(1)}%`);
	}
	for (let it = 0; it < iterations; it++) {
		const recent = history.slice(-8).map((h) => ({ name: h.variant.name, hypothesis: (h.variant as { hypothesis?: string }).hypothesis, changed: { config: h.variant.config, prompts: h.variant.prompts ? Object.keys(h.variant.prompts) : undefined, views: h.variant.views }, objective: h.summary.objective, savedPct: h.summary.savedPct, editMissPct: h.summary.editMissPct, quoteMissPct: h.summary.quoteMissPct, refMissPct: h.summary.refMissPct, recallMissPct: h.summary.recallMissPct, byKind: h.summary.byKind, views: h.summary.views, kept: h.kept }));
		const prompt = `${program}\n\n## Current best variant\n\n${JSON.stringify(best.variant, null, 1)}\n\nBest objective: ${best.objective.toFixed(2)}\n\n## Current default prompt texts (for reference, edit by putting new text in the variant)\n\n${readFileSync(join(ROOT, "src", "presend.ts"), "utf8").match(/export const DEFAULT_PROMPTS[\s\S]*?\n};/)?.[0] ?? ""}\n\n## View descriptions in use\n\n${readFileSync(join(ROOT, "src", "presend.ts"), "utf8").match(/const VIEW_DESCRIPTIONS[\s\S]*?\n};/)?.[0] ?? ""}\n\n## History (most recent last)\n\n${JSON.stringify(recent, null, 1)}\n\nPropose the next variant as JSON.`;
		console.error(`[autoresearch] iteration ${it + 1}/${iterations}: asking ${researcher}`);
		const variant = askResearcher(researcher, prompt);
		if (!variant) continue;
		variant.name = variant.name ?? `it${it + 1}`;
		console.error(`[autoresearch] evaluating "${variant.name}": ${(variant as { hypothesis?: string }).hypothesis ?? ""}`);
		const t0 = Date.now();
		const { summary } = await runBenchmark({ from, to, concurrency, variant, mock: false, maxPerTraj: 12, quiet: true });
		const kept = summary.objective > best.objective + 0.3;
		console.error(`[autoresearch] "${variant.name}" objective ${summary.objective.toFixed(2)} (best ${best.objective.toFixed(2)}) saved ${summary.savedPct.toFixed(1)}% editMiss ${summary.editMissPct.toFixed(1)}% quoteMiss ${summary.quoteMissPct.toFixed(1)}% refMiss ${summary.refMissPct.toFixed(1)}% in ${Math.round((Date.now() - t0) / 1000)}s → ${kept ? "KEEP" : "discard"}`);
		appendFileSync(logFile, `${JSON.stringify({ variant, summary, kept, t: Date.now() })}\n`);
		history.push({ variant, summary, kept });
		if (kept) { best = { variant, objective: summary.objective, summary }; writeFileSync(join(RESEARCH, "best.json"), JSON.stringify(best, null, 1)); }
	}
	console.log(JSON.stringify(best, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
