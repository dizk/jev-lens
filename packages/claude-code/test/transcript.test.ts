import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contextFromLines, contextFromTranscript, subagentTranscripts } from "../src/transcript.ts";

const line = (o: unknown) => JSON.stringify(o);
const entries = [
	line({ type: "mode", mode: "normal" }),
	line({ type: "user", message: { role: "user", content: "Fix the login bug" } }),
	line({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: "" }] } }),
	line({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "I will read auth.ts first." }] } }),
	line({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "auth.ts" } }] } }),
	line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents" }] } }),
	line({ type: "user", isMeta: true, message: { role: "user", content: "system-ish meta text" } }),
	line({ type: "user", isSidechain: true, message: { role: "user", content: "subagent prompt" } }),
	line({ type: "user", message: { role: "user", content: [{ type: "text", text: "Also check the tests" }] } }),
	line({ type: "assistant", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "Checking tests." }] } }),
	line({ type: "assistant", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "Reading now." }] } }),
	"not json",
];
const silentCall = line({ type: "assistant", message: { id: "m3", role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: {} }] } });
const newTurn = line({ type: "user", message: { role: "user", content: "And the docs" } });

describe("transcript context", () => {
	it("takes the first and latest real user messages and the latest assistant text, grouped by message id", () => {
		const c = contextFromLines(entries);
		expect(c.firstUser).toBe("Fix the login bug");
		expect(c.latestUser).toBe("Also check the tests");
		expect(c.agentText).toBe("Checking tests.\nReading now.");
		expect(c.source).toBe("turn");
		expect(c.found).toBe(false);
	});
	it("prefers the text of the message that holds the call", () => {
		const c = contextFromLines(entries, "t1");
		expect(c.agentText).toBe("I will read auth.ts first.");
		expect(c.source).toBe("call");
		expect(c.found).toBe(true);
		// the context stops at the call: later turns are not part of it
		expect(c.latestUser).toBe("Fix the login bug");
	});
	it("falls back to the same turn's text, then to an earlier turn, and says so", () => {
		const turn = contextFromLines([...entries, silentCall], "t2");
		expect(turn.agentText).toBe("Checking tests.\nReading now.");
		expect(turn.source).toBe("turn");
		expect(turn.found).toBe(true);
		const earlier = contextFromLines([...entries, newTurn, silentCall], "t2");
		expect(earlier.agentText).toBe("Checking tests.\nReading now.");
		expect(earlier.source).toBe("earlier");
		expect(earlier.latestUser).toBe("And the docs");
		const lagging = contextFromLines(entries, "t-not-written-yet");
		expect(lagging.found).toBe(false);
		expect(lagging.source).toBe("turn");
	});
	it("uses the sidechain when the call is in a sub-agent transcript", () => {
		const sub = [
			line({ type: "user", isSidechain: true, message: { role: "user", content: "Find the statusLine fields" } }),
			line({ type: "assistant", isSidechain: true, message: { id: "s1", role: "assistant", content: [{ type: "text", text: "Fetching the docs." }] } }),
			line({ type: "assistant", isSidechain: true, message: { id: "s1", role: "assistant", content: [{ type: "tool_use", id: "t9", name: "Read", input: {} }] } }),
		];
		const c = contextFromLines(sub, "t9");
		expect(c).toEqual({ firstUser: "Find the statusLine fields", latestUser: "Find the statusLine fields", agentText: "Fetching the docs.", source: "call", found: true });
		expect(contextFromLines([...entries, ...sub], "t1").firstUser).toBe("Fix the login bug");
	});
	it("reads a file, searches the sub-agent files next to it, and tolerates a missing one", () => {
		const dir = mkdtempSync(join(tmpdir(), "jevtr-"));
		const p = join(dir, "sess.jsonl");
		writeFileSync(p, entries.join("\n"));
		expect(contextFromTranscript(p).firstUser).toBe("Fix the login bug");
		expect(contextFromTranscript(join(dir, "missing.jsonl"))).toEqual({ firstUser: "", latestUser: "", agentText: "", source: "none", found: false });
		expect(contextFromTranscript(undefined).latestUser).toBe("");
		mkdirSync(join(dir, "sess", "subagents"), { recursive: true });
		writeFileSync(join(dir, "sess", "subagents", "agent-1.jsonl"), [
			line({ type: "user", isSidechain: true, message: { role: "user", content: "Sub task" } }),
			line({ type: "assistant", isSidechain: true, message: { id: "s1", role: "assistant", content: [{ type: "tool_use", id: "t9", name: "Bash", input: {} }] } }),
		].join("\n"));
		expect(subagentTranscripts(p)).toEqual([join(dir, "sess", "subagents", "agent-1.jsonl")]);
		const c = contextFromTranscript(p, "t9");
		expect(c.firstUser).toBe("Sub task");
		expect(c.found).toBe(true);
		expect(c.source).toBe("none");
		// a call that is nowhere yet gets the main transcript's context
		expect(contextFromTranscript(p, "t-lagging").firstUser).toBe("Fix the login bug");
	});
});
