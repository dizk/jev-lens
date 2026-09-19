/**
 * Run the fixture tasks through pi headless, with and without the extension, and score them.
 *
 *   node --import tsx eval/generate.ts --cond baseline|jev|jev-batch [--mode rolling|batch] [--tasks a,b] [--repeat N] [--from N] [--parallel 2] [--model openai-codex/gpt-5.6-luna]
 *
 * Each run gets a fresh copy of eval/fixture, its own session dir, and is scored by copying
 * the task's hidden test into tests/ and running `node --test tests/`. Results are appended
 * to eval/runs/results.jsonl and per-run artifacts live in eval/runs/<cond>/<task>-<n>/.
 */
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "eval", "fixture");
const RUNS = join(ROOT, "eval", "runs");
const TASKS = JSON.parse(readFileSync(join(ROOT, "eval", "tasks", "tasks.json"), "utf8")) as { id: string; prompt: string; hidden: string; scoreOnlyHidden?: boolean }[];

interface Args { cond: string; tasks?: string[]; repeat: number; from: number; variant?: string; parallel: number; model: string; timeoutMs: number; mode: "rolling" | "batch" | "budget" }
function parseArgs(argv: string[]): Args {
	const a: Args = { cond: "baseline", repeat: 1, from: 1, parallel: 2, model: "openai-codex/gpt-5.6-luna", timeoutMs: 15 * 60 * 1000, mode: "rolling" };
	for (let i = 0; i < argv.length; i++) {
		const v = argv[i];
		if (v === "--cond") a.cond = argv[++i];
		else if (v === "--tasks") a.tasks = argv[++i].split(",");
		else if (v === "--repeat") a.repeat = Number(argv[++i]);
		else if (v === "--from") a.from = Number(argv[++i]);
		else if (v === "--variant") a.variant = resolve(argv[++i]);
		else if (v === "--parallel") a.parallel = Number(argv[++i]);
		else if (v === "--model") a.model = argv[++i];
		else if (v === "--timeout") a.timeoutMs = Number(argv[++i]) * 1000;
		else if (v === "--mode") { const m = argv[++i]; a.mode = m === "batch" || m === "budget" ? m : "rolling"; }
	}
	return a;
}

function sh(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; stdout?: string }): Promise<{ code: number | null; out: string; err: string; timedOut: boolean }> {
	return new Promise((res) => {
		const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		let timedOut = false;
		child.stdout.on("data", (d) => { out += d; });
		child.stderr.on("data", (d) => { err += d; });
		const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (opts.stdout) writeFileSync(opts.stdout, out);
			res({ code, out, err, timedOut });
		});
	});
}

export interface RunResult {
	cond: string; task: string; n: number; ok: boolean; testExit: number | null; timedOut: boolean; wallMs: number;
	calls: number; input: number; cacheRead: number; output: number; toolCalls: number; cacheHit: number; finalPrompt: number; recalls: number;
	pruned?: number; decisions?: number; presend?: { considered: number; compressed: number; tokensBefore: number }; sessionFile?: string; dir: string;
}

async function runOne(task: (typeof TASKS)[number], n: number, args: Args): Promise<RunResult> {
	const dir = join(RUNS, args.cond, `${task.id}-${n}`);
	const work = join(dir, "work");
	const sessions = join(dir, "sessions");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(sessions, { recursive: true });
	cpSync(FIXTURE, work, { recursive: true });
	const piArgs = ["--mode", "json", "--model", args.model, "--thinking", "low", "--session-dir", sessions, "--no-approve"];
	if (args.cond.startsWith("jev")) piArgs.unshift("-e", join(ROOT, "packages", "pi", "index.ts"));
	piArgs.push(task.prompt);
	const t0 = Date.now();
	const r = await sh("pi", piArgs, { cwd: work, timeoutMs: args.timeoutMs, stdout: join(dir, "events.jsonl"), env: { JEV_LENS_MODE: args.mode, JEV_LENS_PRESEND: args.cond.includes("presend") ? "1" : "0", ...(args.variant ? { JEV_LENS_VARIANT: args.variant } : {}) } });
	const wallMs = Date.now() - t0;
	writeFileSync(join(dir, "pi.stderr"), r.err);

	// Score: hidden test + existing suite.
	cpSync(join(ROOT, "eval", "tasks", "hidden", task.hidden), join(work, "tests", `zz-hidden-${task.hidden}`));
	const t = await sh("node", task.scoreOnlyHidden ? ["--test", `tests/zz-hidden-${task.hidden}`] : ["--test"], { cwd: work, timeoutMs: 120_000 });
	writeFileSync(join(dir, "test.out"), t.out + "\n" + t.err);

	// Usage from the event stream.
	let calls = 0, input = 0, cacheRead = 0, output = 0, toolCalls = 0, finalPrompt = 0, recalls = 0;
	const events = existsSync(join(dir, "events.jsonl")) ? readFileSync(join(dir, "events.jsonl"), "utf8").split("\n") : [];
	for (const line of events) {
		if (!line.trim()) continue;
		let e: { type?: string; message?: { role?: string; usage?: { input?: number; cacheRead?: number; output?: number }; content?: { type: string }[] } };
		try { e = JSON.parse(line); } catch { continue; }
		if (e.type !== "message_end" || e.message?.role !== "assistant") continue;
		calls++;
		input += e.message.usage?.input ?? 0;
		cacheRead += e.message.usage?.cacheRead ?? 0;
		output += e.message.usage?.output ?? 0;
		finalPrompt = (e.message.usage?.input ?? 0) + (e.message.usage?.cacheRead ?? 0);
		toolCalls += (e.message.content ?? []).filter((c) => c.type === "toolCall").length;
		recalls += (e.message.content ?? []).filter((c) => c.type === "toolCall" && (c as { name?: string }).name === "recall").length;
	}
	const result: RunResult = {
		cond: args.cond, task: task.id, n, ok: !r.timedOut && t.code === 0, testExit: t.code, timedOut: r.timedOut, wallMs,
		calls, input, cacheRead, output, toolCalls, cacheHit: input + cacheRead > 0 ? cacheRead / (input + cacheRead) : 0, finalPrompt, recalls, dir,
	};
	const logPath = join(work, ".pi", "jev-lens.log");
	if (existsSync(logPath)) {
		let pruned = 0, decisions = 0;
		for (const line of readFileSync(logPath, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const e = JSON.parse(line);
				if (e.event === "context") pruned = Math.max(pruned, e.tokensPruned ?? 0);
				if (e.event === "decision") decisions++;
			} catch {}
		}
		result.pruned = pruned;
		result.decisions = decisions;
		let presendSaved = 0, presendCompressed = 0, presendConsidered = 0;
		for (const line of readFileSync(logPath, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const e = JSON.parse(line);
				if (e.event === "presend") { presendConsidered++; if (e.view && e.view !== "full") { presendCompressed++; presendSaved += e.tokens ?? 0; } }
			} catch {}
		}
		result.presend = { considered: presendConsidered, compressed: presendCompressed, tokensBefore: presendSaved };
	}
	const sessionFiles = existsSync(sessions) ? (readdirSync(sessions, { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl")).map((f) => join(sessions, f)) : [];
	if (sessionFiles.length) result.sessionFile = sessionFiles[0];
	appendFileSync(join(RUNS, "results.jsonl"), `${JSON.stringify(result)}\n`);
	return result;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const tasks = TASKS.filter((t) => !args.tasks || args.tasks.includes(t.id));
	mkdirSync(RUNS, { recursive: true });
	const queue: { task: (typeof TASKS)[number]; n: number }[] = [];
	for (let n = args.from; n < args.from + args.repeat; n++) for (const task of tasks) queue.push({ task, n });
	const results: RunResult[] = [];
	const worker = async () => {
		while (queue.length) {
			const job = queue.shift()!;
			console.error(`[${args.cond}] start ${job.task.id}-${job.n}`);
			const r = await runOne(job.task, job.n, args);
			results.push(r);
			console.error(`[${args.cond}] done  ${job.task.id}-${job.n} ok=${r.ok} calls=${r.calls} input=${r.input} cacheRead=${r.cacheRead} hit=${(100 * r.cacheHit).toFixed(0)}% wall=${Math.round(r.wallMs / 1000)}s${r.pruned !== undefined ? ` pruned=${r.pruned}` : ""}${r.presend ? ` presend=${r.presend.compressed}/${r.presend.considered}` : ""} recalls=${r.recalls}`);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, args.parallel) }, worker));
	const ok = results.filter((r) => r.ok).length;
	console.log(JSON.stringify({ cond: args.cond, runs: results.length, ok, input: results.reduce((a, r) => a + r.input, 0), cacheRead: results.reduce((a, r) => a + r.cacheRead, 0) }));
}

main().catch((e) => { console.error(e); process.exit(1); });
