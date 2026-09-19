/**
 * Export Claude Code sessions as trajectories the pre-send benchmark can replay (eval/bench/run.ts):
 * one JSON line per transcript, { id, cwd, messages } in pi's message shape, with every compressed tool
 * result put back to its full text from the plugin's outputs store. Uncompressed results are taken
 * from the transcript as they are. Sub-agent transcripts become trajectories of their own.
 *
 *   node packages/claude-code/src/trajectory.ts <transcript.jsonl | project dir>... > sessions.jsonl
 *
 * Mapping: Read → read {path, offset, limit}; Bash → bash {command}; Grep → grep {pattern, path};
 * Edit and MultiEdit → edit {path, edits: [{oldText, newText}]}; Write → write {path, content};
 * the plugin's recall tool → recall {id, lines, pattern}; anything else keeps its name and input.
 * A tool result carries `details.view` (the view Claude saw) when the plugin compressed it, so the
 * recorded decision stays visible next to the replayed one.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadOutputAnywhere, type StoredOutput } from "./store.ts";
import { subagentTranscripts } from "./transcript.ts";

interface Block { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean }
interface Entry { type?: string; isMeta?: boolean; cwd?: string; timestamp?: string; toolUseResult?: unknown; message?: { id?: string; role?: string; content?: unknown } }

export interface Trajectory { id: string; cwd?: string; messages: unknown[] }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Claude Code's tool name and input → the canonical tool call the core and the scorer understand. */
export function mapToolCall(name: string, input: Record<string, unknown>): { name: string; arguments: Record<string, unknown> } {
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	switch (name) {
		case "Read": return { name: "read", arguments: { path: str(input.file_path), ...(input.offset !== undefined ? { offset: input.offset } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}) } };
		case "Bash": return { name: "bash", arguments: { command: str(input.command) } };
		case "Grep": return { name: "grep", arguments: { pattern: str(input.pattern), path: str(input.path) || "." } };
		case "Edit": return { name: "edit", arguments: { path: str(input.file_path), edits: [{ oldText: str(input.old_string), newText: str(input.new_string) }] } };
		case "MultiEdit": return { name: "edit", arguments: { path: str(input.file_path), edits: (Array.isArray(input.edits) ? input.edits : []).map((e) => ({ oldText: str((e as Record<string, unknown>).old_string), newText: str((e as Record<string, unknown>).new_string) })) } };
		case "Write": return { name: "write", arguments: { path: str(input.file_path), content: str(input.content) } };
		default:
			if (/(^|__)recall$/.test(name)) return { name: "recall", arguments: { id: str(input.id), ...(input.lines !== undefined ? { lines: input.lines } : {}), ...(input.pattern !== undefined ? { pattern: input.pattern } : {}) } };
			return { name, arguments: input };
	}
}

function blockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Block[]).filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

/**
 * The raw text of a tool result: the plugin's stored full output when it compressed this result,
 * else the tool's own structured result (Read's file content without Claude Code's line numbers,
 * Bash's stdout, Grep's content), else the text Claude saw.
 */
function resultText(toolName: string, block: Block, tur: unknown, stored: StoredOutput | undefined): string {
	if (stored) return stored.text;
	if (isObj(tur)) {
		if (toolName === "read" && isObj(tur.file) && typeof tur.file.content === "string") return tur.file.content;
		if (toolName === "bash" && typeof tur.stdout === "string") return tur.stderr && typeof tur.stderr === "string" && tur.stderr.trim() ? `${tur.stdout}\n${tur.stderr}` : tur.stdout;
		if (toolName === "grep" && typeof tur.content === "string") return tur.content;
	}
	return blockText(block.content);
}

export function convertTranscript(lines: Iterable<string>, id: string, lookup: (id: string) => StoredOutput | undefined = loadOutputAnywhere): Trajectory {
	const messages: unknown[] = [];
	const calls = new Map<string, { name: string; arguments: Record<string, unknown> }>();
	let cwd: string | undefined;
	let currentId: string | undefined;
	let current: { role: "assistant"; content: unknown[]; stopReason: string; timestamp: number } | undefined;
	let n = 0;
	for (const line of lines) {
		if (!line || (!line.includes('"type":"user"') && !line.includes('"type":"assistant"'))) continue;
		let e: Entry;
		try { e = JSON.parse(line) as Entry; } catch { continue; }
		if (!e.message) continue;
		cwd ??= e.cwd;
		const ts = e.timestamp ? Date.parse(e.timestamp) : n;
		n++;
		if (e.type === "assistant" && e.message.role === "assistant") {
			// One assistant message arrives as several lines (one per content block) sharing message.id.
			if (!current || e.message.id !== currentId) {
				currentId = e.message.id;
				current = { role: "assistant", content: [], stopReason: "stop", timestamp: ts };
				messages.push(current);
			}
			for (const b of (Array.isArray(e.message.content) ? e.message.content : []) as Block[]) {
				if (b.type === "text" && typeof b.text === "string" && b.text.trim()) current.content.push({ type: "text", text: b.text });
				if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
					const mapped = mapToolCall(b.name, isObj(b.input) ? b.input : {});
					calls.set(b.id, mapped);
					current.content.push({ type: "toolCall", id: b.id, ...mapped });
					current.stopReason = "toolUse";
				}
			}
			continue;
		}
		if (e.type !== "user" || e.message.role !== "user" || e.isMeta) continue;
		const content = e.message.content;
		const results = Array.isArray(content) ? (content as Block[]).filter((b) => b && b.type === "tool_result") : [];
		if (results.length) {
			for (const b of results) {
				const callId = b.tool_use_id ?? "";
				const call = calls.get(callId);
				const toolName = call?.name ?? "tool";
				const stored = lookup(callId);
				const text = resultText(toolName, b, e.toolUseResult, stored);
				messages.push({ role: "toolResult", toolCallId: callId, toolName, content: [{ type: "text", text }], isError: b.is_error === true, ...(stored ? { details: { view: stored.view, kind: stored.kind } } : {}), timestamp: ts });
			}
			continue;
		}
		const text = blockText(content).trim();
		if (text) messages.push({ role: "user", content: [{ type: "text", text }], timestamp: ts });
	}
	return { id, cwd, messages };
}

/** Transcript files under the given paths: a file as is, a directory recursively, sub-agent files next to each session. */
export function listTranscripts(paths: string[]): string[] {
	const out = new Set<string>();
	const add = (f: string) => { out.add(f); for (const s of subagentTranscripts(f)) out.add(s); };
	for (const p of paths) {
		if (!existsSync(p)) continue;
		if (statSync(p).isDirectory()) {
			for (const f of readdirSync(p, { recursive: true }) as string[]) if (f.endsWith(".jsonl")) add(join(p, f));
		} else add(p);
	}
	return [...out].sort();
}

export function trajectoryId(file: string): string {
	const session = basename(file, ".jsonl");
	return file.includes("/subagents/") ? `${basename(join(file, "..", ".."))}/${session}` : session;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const paths = process.argv.slice(2);
	if (!paths.length) { console.error("usage: trajectory.ts <transcript.jsonl | directory>..."); process.exit(2); }
	let sessions = 0, results = 0, restored = 0;
	for (const f of listTranscripts(paths)) {
		let seen = 0;
		const t = convertTranscript(readFileSync(f, "utf8").split("\n"), trajectoryId(f), (id) => { const s = loadOutputAnywhere(id); if (s) seen++; return s; });
		const tr = t.messages.filter((m) => (m as { role: string }).role === "toolResult").length;
		if (!tr) continue;
		process.stdout.write(`${JSON.stringify(t)}\n`);
		sessions++; results += tr; restored += seen;
	}
	console.error(`${sessions} trajectories, ${results} tool results, ${restored} restored from the outputs store`);
}
