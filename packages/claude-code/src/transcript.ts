/**
 * What jev needs to know about the conversation, read from Claude Code's transcript: the first user
 * request (the task), the latest user message, and what Claude wrote right before the tool call.
 *
 * The text before the call is taken from the assistant message that holds the call itself. When that
 * message has no text (Claude Code often calls tools without saying anything, and its thinking blocks
 * are stored empty), the latest assistant text of the same turn is used, then the latest text of an
 * earlier turn. `source` says which, so the log can show how good the context was.
 *
 * Sub-agents get their own transcript file, in which every record is a sidechain. The hook receives
 * the main transcript's path, so when the call is not in that file the sub-agent files next to it are
 * searched. The transcript is written asynchronously and may lag the current turn; whatever is there
 * is used, and `found` records whether the call had reached the transcript.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface TranscriptContext {
	firstUser: string;
	latestUser: string;
	agentText: string;
	/** Where agentText came from: the message with the call, an earlier message of the same turn, an earlier turn, or nowhere. */
	source: "call" | "turn" | "earlier" | "none";
	/** Whether the transcript already held the tool call (false when it lags, or when no id was given). */
	found: boolean;
}

interface Entry {
	type?: string;
	isMeta?: boolean;
	isSidechain?: boolean;
	message?: { id?: string; role?: string; content?: unknown };
}

const EMPTY: TranscriptContext = { firstUser: "", latestUser: "", agentText: "", source: "none", found: false };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const b of content as { type?: string; text?: string }[]) if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
	return parts.join("\n");
}

function hasCall(content: unknown, toolUseId: string): boolean {
	if (!Array.isArray(content)) return false;
	return (content as { type?: string; id?: string }[]).some((b) => b && b.type === "tool_use" && b.id === toolUseId);
}

function parse(lines: Iterable<string>): Entry[] {
	const out: Entry[] = [];
	for (const line of lines) {
		if (!line || (!line.includes('"type":"user"') && !line.includes('"type":"assistant"'))) continue;
		try { out.push(JSON.parse(line) as Entry); } catch {}
	}
	return out;
}

/** Parse transcript lines. Tool results and meta messages are not user text. */
export function contextFromLines(lines: Iterable<string>, toolUseId?: string): TranscriptContext {
	const entries = parse(lines).filter((e) => e.message);
	// The conversation the call belongs to: the main one, or the sidechain when the call is in a sub-agent file.
	const callEntry = toolUseId ? entries.find((e) => e.type === "assistant" && hasCall(e.message!.content, toolUseId)) : undefined;
	const sidechain = callEntry?.isSidechain === true;
	let firstUser = "", latestUser = "";
	let currentId: string | undefined, current = "";
	let callText: string | undefined, turnText = "", earlierText = "";
	for (const e of entries) {
		if ((e.isSidechain === true) !== sidechain) continue;
		if (callEntry && callText !== undefined) break;
		if (e.type === "user" && e.message!.role === "user") {
			if (e.isMeta) continue;
			const t = textOf(e.message!.content).trim();
			if (!t) continue;
			if (!firstUser) firstUser = t;
			latestUser = t;
			// a new turn: what was said before belongs to an earlier turn now
			if (turnText) earlierText = turnText;
			turnText = "";
			currentId = undefined;
			current = "";
		} else if (e.type === "assistant" && e.message!.role === "assistant") {
			// One assistant message arrives as several lines (one per content block) sharing message.id.
			if (e.message!.id !== currentId) { currentId = e.message!.id; current = ""; }
			const t = textOf(e.message!.content).trim();
			if (t) { current = current ? `${current}\n${t}` : t; turnText = current; }
			if (callEntry && hasCall(e.message!.content, toolUseId!)) callText = current;
		}
	}
	if (callText) return { firstUser, latestUser, agentText: callText, source: "call", found: true };
	if (turnText) return { firstUser, latestUser, agentText: turnText, source: "turn", found: !!callEntry };
	if (earlierText) return { firstUser, latestUser, agentText: earlierText, source: "earlier", found: !!callEntry };
	return { firstUser, latestUser, agentText: "", source: "none", found: !!callEntry };
}

/** The sub-agent transcripts that belong to a session transcript: <dir>/<session>/subagents/agent-*.jsonl. */
export function subagentTranscripts(path: string): string[] {
	try {
		const dir = join(dirname(path), basename(path, ".jsonl"), "subagents");
		if (!existsSync(dir)) return [];
		return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
	} catch {
		return [];
	}
}

export function contextFromTranscript(path: string | undefined, toolUseId?: string): TranscriptContext {
	if (!path) return EMPTY;
	let main: TranscriptContext;
	try {
		main = contextFromLines(readFileSync(path, "utf8").split("\n"), toolUseId);
	} catch {
		return EMPTY;
	}
	if (main.found || !toolUseId) return main;
	// Not in the main transcript: a sub-agent's call, or the transcript lags. Try the sub-agent files.
	for (const sub of subagentTranscripts(path)) {
		try {
			const text = readFileSync(sub, "utf8");
			if (!text.includes(toolUseId)) continue;
			const c = contextFromLines(text.split("\n"), toolUseId);
			if (c.found) return c;
		} catch {}
	}
	return main;
}
