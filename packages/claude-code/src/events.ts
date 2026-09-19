/**
 * The conversation as the plugin's own hooks saw it, captured synchronously instead of read from
 * the transcript file, which is written asynchronously and can lag the turn. Two cheap shell hooks
 * append their raw JSON input to `events.jsonl` in the data directory: UserPromptSubmit (the prompt)
 * and MessageDisplay (each batch of assistant text as it streams, before any tool of that message
 * runs). The PostToolUse hook reads that file for its session: the first and latest prompt, and the
 * text of the latest assistant message of the current turn, or of an earlier turn when this turn has
 * shown none yet. Sub-agents are not displayed and do not submit prompts, so their calls keep using
 * their own transcript file (see transcript.ts).
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./store.ts";

export interface EventsContext {
	firstUser: string;
	latestUser: string;
	agentText: string;
	/** The latest displayed message of this turn, one of an earlier turn, or nothing captured. */
	source: "turn" | "earlier" | "none";
}

interface Event {
	hook_event_name?: string;
	session_id?: string;
	agent_id?: string;
	prompt?: string;
	message_id?: string;
	delta?: string;
}

export function eventsFile(): string {
	return join(dataDir(), "events.jsonl");
}

export function contextFromEventLines(lines: Iterable<string>, sessionId: string): EventsContext {
	let firstUser = "", latestUser = "";
	let messageId: string | undefined, message = "";
	let turnText = "", earlierText = "";
	for (const line of lines) {
		if (!line || !line.includes(sessionId)) continue;
		let e: Event;
		try { e = JSON.parse(line) as Event; } catch { continue; }
		if (e.session_id !== sessionId || e.agent_id) continue;
		if (e.hook_event_name === "UserPromptSubmit" && typeof e.prompt === "string") {
			const t = e.prompt.trim();
			if (!t) continue;
			if (!firstUser) firstUser = t;
			latestUser = t;
			if (turnText) earlierText = turnText;
			turnText = "";
			messageId = undefined;
			message = "";
		} else if (e.hook_event_name === "MessageDisplay" && typeof e.delta === "string") {
			if (e.message_id !== messageId) { messageId = e.message_id; message = ""; }
			message += e.delta;
			if (message.trim()) turnText = message.trim();
		}
	}
	if (turnText) return { firstUser, latestUser, agentText: turnText, source: "turn" };
	if (earlierText) return { firstUser, latestUser, agentText: earlierText, source: "earlier" };
	return { firstUser, latestUser, agentText: "", source: "none" };
}

export function contextFromEvents(sessionId: string | undefined, file = eventsFile()): EventsContext {
	if (!sessionId) return { firstUser: "", latestUser: "", agentText: "", source: "none" };
	try {
		if (!existsSync(file)) return { firstUser: "", latestUser: "", agentText: "", source: "none" };
		return contextFromEventLines(readFileSync(file, "utf8").split("\n"), sessionId);
	} catch {
		return { firstUser: "", latestUser: "", agentText: "", source: "none" };
	}
}

/** Keep the events file small: above `maxBytes`, keep the last `keepBytes` from a line boundary. */
export function pruneEvents(file = eventsFile(), maxBytes = 4 * 1024 * 1024, keepBytes = 1024 * 1024): boolean {
	try {
		if (!existsSync(file) || statSync(file).size <= maxBytes) return false;
		const text = readFileSync(file, "utf8");
		const cut = text.indexOf("\n", text.length - keepBytes);
		writeFileSync(file, cut < 0 ? "" : text.slice(cut + 1));
		return true;
	} catch {
		return false;
	}
}
