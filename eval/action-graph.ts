/**
 * Procedural graph prototype (after "Procedural Graphs: Self-Evolving Execution Structures for
 * LLM Agents", Lu et al.). Mines recorded pi sessions into a graph of abstract actions, then lets
 * jev act as the guidance model: at each step of a held-out session, jev localizes the agent in the
 * graph and chooses the next procedure from the current node's outgoing edges (with their success
 * statistics). We report how often jev's choice matches what the agent actually did next, and how
 * often it matches when the run ended in success versus failure.
 *
 *   node --import tsx eval/action-graph.ts [--mock] [--holdout <substring>] <results.jsonl>
 *
 * Nodes are (tool, target class) pairs such as read:src, read:test, edit:src, bash:test, write:test.
 */
import { readFileSync } from "node:fs";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { loadConfig } from "../src/config.ts";
import type { AgentMessage } from "../src/pi-types.ts";
import { contentText, truncate } from "../src/text.ts";

type Node = string;
interface Edge { from: Node; to: Node; n: number; ok: number }

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

function classify(name: string, args: Record<string, unknown>): Node {
	const path = typeof args.path === "string" ? args.path : "";
	const cmd = typeof args.command === "string" ? args.command : "";
	const target = (p: string) => (/test/i.test(p) ? "test" : /\.(md|txt)$/i.test(p) ? "doc" : /^src\//.test(p) || /\.(js|ts|py|go|rs)$/.test(p) ? "src" : /\.(csv|json|log)$/.test(p) ? "data" : "other");
	switch (name) {
		case "read": return `read:${target(path)}`;
		case "edit": return `edit:${target(path)}`;
		case "write": return `write:${target(path)}`;
		case "bash": return /\b(npm|node|pytest|cargo|go)\b.*\btest\b|node --test/.test(cmd) ? "bash:test" : /\b(ls|find|tree|cat|head|wc|grep|rg)\b/.test(cmd) ? "bash:explore" : "bash:other";
		case "grep": case "find": case "ls": return `explore:${name}`;
		case "recall": return "recall";
		default: return `${name}`;
	}
}

/** Sequence of abstract actions in a session, one per tool call, plus "final_answer". */
function trajectory(msgs: AgentMessage[]): Node[] {
	const out: Node[] = ["start"];
	for (const m of msgs) {
		if (m.role !== "assistant") continue;
		let calls = 0;
		for (const c of m.content) if (c.type === "toolCall") { out.push(classify(c.name, (c.arguments ?? {}) as Record<string, unknown>)); calls++; }
		if (calls === 0 && m.stopReason === "stop") out.push("final_answer");
	}
	return out;
}

interface Run { task: string; cond: string; ok: boolean; file: string; dir: string }

function buildGraph(runs: { traj: Node[]; ok: boolean }[]): Map<string, Edge> {
	const edges = new Map<string, Edge>();
	for (const r of runs) {
		for (let i = 0; i + 1 < r.traj.length; i++) {
			const key = `${r.traj[i]}→${r.traj[i + 1]}`;
			const e = edges.get(key) ?? { from: r.traj[i], to: r.traj[i + 1], n: 0, ok: 0 };
			e.n++;
			if (r.ok) e.ok++;
			edges.set(key, e);
		}
	}
	return edges;
}

function neighbourhood(edges: Map<string, Edge>, node: Node): Edge[] {
	return [...edges.values()].filter((e) => e.from === node).sort((a, b) => b.n - a.n);
}

async function main() {
	const argv = process.argv.slice(2);
	const mock = argv.includes("--mock");
	const holdout = argv.includes("--holdout") ? argv[argv.indexOf("--holdout") + 1] : "marathon";
	const resultsFile = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--holdout")[0] ?? "eval/runs/results.jsonl";
	const rows: Run[] = readFileSync(resultsFile, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).map((r) => ({ task: r.task, cond: r.cond, ok: r.ok, file: `${r.dir}/events.jsonl`, dir: r.dir }));
	const all = rows.map((r) => ({ ...r, msgs: loadMessages(r.file) })).map((r) => ({ ...r, traj: trajectory(r.msgs) }));
	const train = all.filter((r) => !r.task.includes(holdout));
	const test = all.filter((r) => r.task.includes(holdout));
	const graph = buildGraph(train);

	console.log(`# Procedural graph mined from ${train.length} runs (holdout: tasks containing "${holdout}", ${test.length} runs)\n`);
	const nodes = new Map<Node, number>();
	for (const e of graph.values()) nodes.set(e.from, (nodes.get(e.from) ?? 0) + e.n);
	console.log("| from | → to (count, success rate) |");
	console.log("|---|---|");
	for (const [node] of [...nodes].sort((a, b) => b[1] - a[1])) {
		const outs = neighbourhood(graph, node).slice(0, 6).map((e) => `${e.to} (${e.n}, ${Math.round((100 * e.ok) / e.n)}%)`);
		console.log(`| ${node} | ${outs.join("; ")} |`);
	}

	// ---- jev as the guidance model on the held-out runs
	const cfg = loadConfig();
	const client = mock || !cfg.apiKey ? undefined : new TypeSafeClient({ apiKey: cfg.apiKey });
	let steps = 0, agree = 0, agreeOk = 0, stepsOk = 0, agreeFail = 0, stepsFail = 0;
	const confusion = new Map<string, number>();
	for (const r of test) {
		// walk the assistant messages; at each tool-call step ask what should come next
		let firstUser = "";
		let node: Node = "start";
		let lastText = "";
		const recent: Node[] = [];
		for (const m of r.msgs) {
			if (m.role === "user") { if (!firstUser) firstUser = contentText(m.content); continue; }
			if (m.role !== "assistant") continue;
			const calls = m.content.filter((c) => c.type === "toolCall");
			const actual: Node = calls.length ? classify(calls[0].name, (calls[0].arguments ?? {}) as Record<string, unknown>) : m.stopReason === "stop" ? "final_answer" : "";
			if (!actual) continue;
			const outs = neighbourhood(graph, node);
			if (outs.length >= 2 && steps < 400) {
				const options: Record<string, string> = {};
				for (const e of outs.slice(0, 8)) options[e.to] = `Seen ${e.n} times after ${node} in earlier runs; ${Math.round((100 * e.ok) / e.n)}% of those runs ended in success.`;
				let choice: string;
				if (client) {
					const res = await client.systemOne({
						state: { task: truncate(firstUser, 500), recent_actions: recent.slice(-6), current_node: node, agent_last_message: truncate(lastText, 400), graph_neighbourhood: options },
						questions: { next: { type: "choice", instructions: "The agent is at `current_node` in a procedural graph mined from earlier runs of similar tasks (`graph_neighbourhood` lists the procedures that followed this node and how often those runs succeeded). Given `task`, `recent_actions` and `agent_last_message`, which procedure should the agent do next?", criteria: options } },
						model: cfg.model,
					});
					choice = res.answers.next.choice;
				} else choice = outs[0].to;
				steps++;
				const hit = choice === actual;
				if (hit) agree++;
				if (r.ok) { stepsOk++; if (hit) agreeOk++; } else { stepsFail++; if (hit) agreeFail++; }
				if (!hit) confusion.set(`${choice} vs actual ${actual}`, (confusion.get(`${choice} vs actual ${actual}`) ?? 0) + 1);
			}
			lastText = contentText(m.content);
			recent.push(actual);
			node = actual;
		}
	}
	console.log(`\n## jev as guidance model on held-out runs\n`);
	console.log(`| decision points | jev agrees with what the agent did | in runs that passed | in runs that failed | most-common-edge baseline |`);
	console.log(`|---|---|---|---|---|`);
	// baseline: always follow the most common edge
	let baseAgree = 0, baseSteps = 0;
	for (const r of test) { let node: Node = "start"; for (const a of r.traj.slice(1)) { const outs = neighbourhood(graph, node); if (outs.length >= 2) { baseSteps++; if (outs[0].to === a) baseAgree++; } node = a; } }
	console.log(`| ${steps} | ${steps ? Math.round((100 * agree) / steps) : 0}% | ${stepsOk ? Math.round((100 * agreeOk) / stepsOk) : 0}% (${stepsOk}) | ${stepsFail ? Math.round((100 * agreeFail) / stepsFail) : 0}% (${stepsFail}) | ${baseSteps ? Math.round((100 * baseAgree) / baseSteps) : 0}% |`);
	console.log(`\nMost common disagreements: ${[...confusion].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} (${v})`).join("; ")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
