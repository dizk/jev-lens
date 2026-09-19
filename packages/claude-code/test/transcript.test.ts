import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contextFromLines, contextFromTranscript } from "../src/transcript.ts";

const line = (o: unknown) => JSON.stringify(o);
const entries = [
	line({ type: "mode", mode: "normal" }),
	line({ type: "user", message: { role: "user", content: "Fix the login bug" } }),
	line({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } }),
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

describe("transcript context", () => {
	it("takes the first and latest real user messages and the latest assistant text, grouped by message id", () => {
		const c = contextFromLines(entries);
		expect(c.firstUser).toBe("Fix the login bug");
		expect(c.latestUser).toBe("Also check the tests");
		expect(c.agentText).toBe("Checking tests.\nReading now.");
	});
	it("keeps the previous message's text when the latest assistant message has only tool calls", () => {
		const c = contextFromLines([...entries, line({ type: "assistant", message: { id: "m3", role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: {} }] } })]);
		expect(c.agentText).toBe("Checking tests.\nReading now.");
	});
	it("reads a file and tolerates a missing one", () => {
		const dir = mkdtempSync(join(tmpdir(), "jevtr-"));
		const p = join(dir, "t.jsonl");
		writeFileSync(p, entries.join("\n"));
		expect(contextFromTranscript(p).firstUser).toBe("Fix the login bug");
		expect(contextFromTranscript(join(dir, "missing.jsonl"))).toEqual({ firstUser: "", latestUser: "", agentText: "" });
		expect(contextFromTranscript(undefined).latestUser).toBe("");
	});
});
