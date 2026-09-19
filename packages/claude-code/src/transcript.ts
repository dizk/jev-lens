/**
 * What jev needs to know about the conversation, read from Claude Code's transcript: the first user
 * request (the task), the latest user message, and what Claude wrote right before the tool call.
 * The transcript is written asynchronously and may lag the current turn; whatever is there is used.
 */
import { readFileSync } from "node:fs";

export interface TranscriptContext {
	firstUser: string;
	latestUser: string;
	agentText: string;
}

interface Entry {
	type?: string;
	isMeta?: boolean;
	isSidechain?: boolean;
	message?: { id?: string; role?: string; content?: unknown };
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const b of content as { type?: string; text?: string }[]) if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
	return parts.join("\n");
}

/** Parse transcript lines. Tool results, meta messages and sidechains are not user text. */
export function contextFromLines(lines: Iterable<string>): TranscriptContext {
	let firstUser = "", latestUser = "";
	let currentId: string | undefined, current = "", agentText = "";
	for (const line of lines) {
		if (!line || (!line.includes('"type":"user"') && !line.includes('"type":"assistant"'))) continue;
		let e: Entry;
		try { e = JSON.parse(line) as Entry; } catch { continue; }
		if (e.isSidechain || !e.message) continue;
		if (e.type === "user" && e.message.role === "user") {
			if (e.isMeta) continue;
			const t = textOf(e.message.content).trim();
			if (!t) continue;
			if (!firstUser) firstUser = t;
			latestUser = t;
		} else if (e.type === "assistant" && e.message.role === "assistant") {
			// One assistant message arrives as several lines (one per content block) sharing message.id.
			if (e.message.id !== currentId) { currentId = e.message.id; current = ""; }
			const t = textOf(e.message.content).trim();
			if (!t) continue;
			current = current ? `${current}\n${t}` : t;
			agentText = current;
		}
	}
	return { firstUser, latestUser, agentText };
}

export function contextFromTranscript(path: string | undefined): TranscriptContext {
	if (!path) return { firstUser: "", latestUser: "", agentText: "" };
	try {
		return contextFromLines(readFileSync(path, "utf8").split("\n"));
	} catch {
		return { firstUser: "", latestUser: "", agentText: "" };
	}
}
