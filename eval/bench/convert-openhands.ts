/**
 * Convert OpenHands trajectories (nebius/SWE-rebench-openhands-trajectories rows JSON) into pi-style
 * message lists so the pre-send replay can score them.
 *
 *   node --import tsx eval/bench/convert-openhands.ts eval/bench/rows-*.json > eval/bench/openhands.jsonl
 *
 * Output: one JSON line per trajectory: { id, repo, resolved, messages: AgentMessage[] }.
 * Mapping: str_replace_editor view (file) → read {path}; str_replace → edit {path, edits:[{oldText,newText}]};
 * create → write; execute_bash → bash {command}. View output has its `cat -n` prefixes stripped so the
 * tool result is the raw file text, as pi's read tool returns it.
 */
import { readFileSync } from "node:fs";

interface Step { role: string; content: string; tool_call_id?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }

const VIEW_HEADER = /^Here's the result of running `cat -n` on [^\n]*:\n/;

function stripCatN(text: string): { text: string; partial: boolean; offset: number } {
	const body = text.replace(VIEW_HEADER, "");
	const lines = body.split("\n");
	const out: string[] = [];
	let first = -1;
	for (const l of lines) {
		const m = l.match(/^\s*(\d+)\t(.*)$/);
		if (m) { if (first < 0) first = Number(m[1]); out.push(m[2]); }
		else if (out.length && /^\s*$/.test(l)) continue;
	}
	if (out.length < lines.length * 0.5) return { text, partial: false, offset: 0 };
	return { text: out.join("\n"), partial: first > 1, offset: first };
}

function convert(row: { instance_id: string; repo: string; resolved?: boolean; trajectory: Step[] }) {
	const messages: unknown[] = [];
	const t = row.trajectory;
	for (let i = 0; i < t.length; i++) {
		const s = t[i];
		if (s.role === "system") continue;
		if (s.role === "user") { messages.push({ role: "user", content: [{ type: "text", text: s.content }], timestamp: i }); continue; }
		if (s.role === "assistant") {
			const content: unknown[] = [];
			if (s.content) content.push({ type: "text", text: s.content });
			for (const tc of s.tool_calls ?? []) {
				let args: Record<string, unknown> = {};
				try { args = JSON.parse(tc.function.arguments); } catch { args = { raw: tc.function.arguments }; }
				const name = tc.function.name;
				let mapped: { name: string; arguments: Record<string, unknown> } | undefined;
				if (name === "str_replace_editor") {
					const cmd = args.command as string;
					if (cmd === "view") mapped = { name: "read", arguments: { path: args.path, ...(args.view_range ? { view_range: args.view_range } : {}) } };
					else if (cmd === "str_replace") mapped = { name: "edit", arguments: { path: args.path, edits: [{ oldText: args.old_str ?? "", newText: args.new_str ?? "" }] } };
					else if (cmd === "create") mapped = { name: "write", arguments: { path: args.path, content: args.file_text } };
					else if (cmd === "insert") mapped = { name: "edit", arguments: { path: args.path, edits: [{ oldText: "", newText: args.new_str ?? "" }], insert_line: args.insert_line } };
					else mapped = { name: `editor_${cmd}`, arguments: args };
				} else if (name === "execute_bash") mapped = { name: "bash", arguments: { command: args.command } };
				else mapped = { name, arguments: args };
				content.push({ type: "toolCall", id: tc.id, ...mapped });
			}
			messages.push({ role: "assistant", content, stopReason: s.tool_calls?.length ? "toolUse" : "stop", timestamp: i });
			continue;
		}
		if (s.role === "tool") {
			// find the call to know the tool name
			let toolName = "tool";
			let isViewOfFile = false;
			for (let j = i - 1; j >= 0 && j >= i - 6; j--) {
				const prev = t[j];
				const tc = prev.tool_calls?.find((c) => c.id === s.tool_call_id);
				if (tc) {
					let a: Record<string, unknown> = {};
					try { a = JSON.parse(tc.function.arguments); } catch {}
					if (tc.function.name === "str_replace_editor") { const cmd = a.command; toolName = cmd === "view" ? "read" : cmd === "str_replace" || cmd === "insert" ? "edit" : cmd === "create" ? "write" : `editor_${cmd}`; isViewOfFile = cmd === "view" && VIEW_HEADER.test(s.content); }
					else if (tc.function.name === "execute_bash") toolName = "bash";
					else toolName = tc.function.name;
					break;
				}
			}
			let text = s.content ?? "";
			let details: Record<string, unknown> | undefined;
			if (isViewOfFile) { const st = stripCatN(text); text = st.text; details = { partial: st.partial, offset: st.offset }; }
			messages.push({ role: "toolResult", toolCallId: s.tool_call_id, toolName, content: [{ type: "text", text }], isError: /^ERROR:|Traceback|No such file/.test(text), details, timestamp: i });
		}
	}
	return { id: row.instance_id, repo: row.repo, resolved: row.resolved, messages };
}

for (const file of process.argv.slice(2)) {
	const d = JSON.parse(readFileSync(file, "utf8")) as { rows: { row: Parameters<typeof convert>[0] }[] };
	for (const r of d.rows) process.stdout.write(`${JSON.stringify(convert(r.row))}\n`);
}
