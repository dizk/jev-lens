import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contextFromEventLines, contextFromEvents, pruneEvents } from "../src/events.ts";

const line = (o: unknown) => JSON.stringify(o);
const S = "sess-1";
const events = [
	line({ hook_event_name: "UserPromptSubmit", session_id: S, prompt: "Fix the login bug" }),
	line({ hook_event_name: "MessageDisplay", session_id: S, turn_id: "t1", message_id: "m1", index: 0, final: false, delta: "I will read auth.ts first.\n" }),
	line({ hook_event_name: "MessageDisplay", session_id: S, turn_id: "t1", message_id: "m1", index: 1, final: true, delta: "" }),
	line({ hook_event_name: "MessageDisplay", session_id: "other", message_id: "x", delta: "another session\n" }),
	line({ hook_event_name: "MessageDisplay", session_id: S, agent_id: "a1", message_id: "s1", delta: "a sub-agent, if it were displayed\n" }),
	line({ hook_event_name: "UserPromptSubmit", session_id: S, prompt: "  " }),
	line({ hook_event_name: "UserPromptSubmit", session_id: S, prompt: "Also check the tests" }),
	"not json",
];

describe("captured events", () => {
	it("takes the prompts and the latest displayed message of the turn, per session, main thread only", () => {
		const c = contextFromEventLines(events, S);
		expect(c).toEqual({ firstUser: "Fix the login bug", latestUser: "Also check the tests", agentText: "I will read auth.ts first.", source: "earlier" });
		const withText = contextFromEventLines([...events,
			line({ hook_event_name: "MessageDisplay", session_id: S, message_id: "m2", index: 0, delta: "Checking tests.\n" }),
			line({ hook_event_name: "MessageDisplay", session_id: S, message_id: "m2", index: 1, delta: "Reading now." }),
			line({ hook_event_name: "MessageDisplay", session_id: S, message_id: "m3", index: 0, delta: "Then the docs.\n" }),
		], S);
		expect(withText.agentText).toBe("Then the docs.");
		expect(withText.source).toBe("turn");
		expect(contextFromEventLines(events, "other")).toEqual({ firstUser: "", latestUser: "", agentText: "another session", source: "turn" });
		expect(contextFromEventLines(events, "nobody").source).toBe("none");
	});
	it("reads the file, tolerates a missing one, and trims it above the size limit", () => {
		const dir = mkdtempSync(join(tmpdir(), "jevev-"));
		const file = join(dir, "events.jsonl");
		expect(contextFromEvents(S, file).source).toBe("none");
		expect(contextFromEvents(undefined, file).source).toBe("none");
		writeFileSync(file, `${events.join("\n")}\n`);
		expect(contextFromEvents(S, file).latestUser).toBe("Also check the tests");
		expect(pruneEvents(file, 10_000, 100)).toBe(false);
		const big = Array.from({ length: 200 }, (_, i) => line({ hook_event_name: "MessageDisplay", session_id: S, message_id: `m${i}`, delta: `line ${i}\n` })).join("\n") + "\n";
		writeFileSync(file, big);
		expect(pruneEvents(file, 1000, 300)).toBe(true);
		expect(statSync(file).size).toBeLessThanOrEqual(300);
		const kept = readFileSync(file, "utf8");
		expect(kept.startsWith("{")).toBe(true);
		expect(contextFromEvents(S, file).agentText).toBe("line 199");
	});
});
