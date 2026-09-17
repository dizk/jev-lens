import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { applyLedger, decideBucket, stubText, transformToolResult, trimText } from "../src/policy.ts";
import { rebuildLedger } from "../src/ledger.ts";
import type { AgentMessage } from "../src/pi-types.ts";
import type { Decision } from "../src/types.ts";

const cfg = loadConfig();

function toolResult(id: string, text: string): AgentMessage {
	return { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 1 } as AgentMessage;
}
function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}
function decision(id: string, bucket: Decision["bucket"], status: Decision["status"] = "pending"): Decision {
	return { id, toolName: "read", bucket, durable: false, p: { needed: 0.1, outcomeOnly: 0.1, durable: 0 }, summary: `read ${id}`, tokensBefore: 100, decidedAt: 1, status };
}

describe("decideBucket", () => {
	it("forgets when needed is low", () => expect(decideBucket({ needed: 0.1, outcomeOnly: 0.1 }, cfg)).toBe("forget"));
	it("trims when needed is middling and outcomeOnly is high", () => expect(decideBucket({ needed: 0.4, outcomeOnly: 0.9 }, cfg)).toBe("trim"));
	it("keeps when needed is middling and outcomeOnly is low", () => expect(decideBucket({ needed: 0.4, outcomeOnly: 0.2 }, cfg)).toBe("keep"));
	it("keeps when needed is high", () => expect(decideBucket({ needed: 0.9, outcomeOnly: 0.9 }, cfg)).toBe("keep"));
});

describe("transforms", () => {
	it("trim keeps head and tail", () => {
		const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
		const t = trimText(text, 3, 2);
		expect(t.startsWith("line 0\nline 1\nline 2\n")).toBe(true);
		expect(t.endsWith("line 98\nline 99")).toBe(true);
		expect(t).toContain("trimmed 95 lines");
	});
	it("trim leaves short output alone", () => expect(trimText("a\nb\nc", 5, 5)).toBe("a\nb\nc"));
	it("forget replaces content with a stub and is deterministic", () => {
		const m = toolResult("t1", "x".repeat(1000));
		const d = decision("t1", "forget");
		const a = transformToolResult(m, d, cfg);
		const b = transformToolResult(m, d, cfg);
		expect(a).toEqual(b);
		expect((a as { content: { text: string }[] }).content[0].text).toBe(stubText("read t1"));
	});
});

describe("applyLedger", () => {
	const messages = [user("do it"), toolResult("a", "A".repeat(2000)), toolResult("b", "B".repeat(2000)), toolResult("c", "C".repeat(2000))];

	it("passes messages without decisions through unchanged", () => {
		const r = applyLedger(messages, new Map(), cfg, true, 1, "rolling");
		expect(r.messages).toEqual(messages);
		expect(r.tokensSent).toBe(r.tokensOriginal);
	});

	it("applies pending decisions when allowed and freezes them", () => {
		const ledger = new Map([["a", decision("a", "forget")]]);
		const r = applyLedger(messages, ledger, cfg, true, 7, "rolling");
		expect(r.appliedNow.map((d) => d.id)).toEqual(["a"]);
		expect(ledger.get("a")?.status).toBe("applied");
		expect(ledger.get("a")?.appliedAtCall).toBe(7);
		expect(r.tokensSent).toBeLessThan(r.tokensOriginal);
		// Second call: same output, now counted as frozen.
		const r2 = applyLedger(messages, ledger, cfg, false, 8, "batch");
		expect(r2.messages).toEqual(r.messages);
		expect(r2.frozen).toBe(1);
		expect(r2.appliedNow).toEqual([]);
	});

	it("holds pending decisions in batch mode until allowed", () => {
		const ledger = new Map([["b", decision("b", "forget")]]);
		const held = applyLedger(messages, ledger, cfg, false, 1, "batch");
		expect(held.pendingHeld).toBe(1);
		expect(held.messages).toEqual(messages);
		const applied = applyLedger(messages, ledger, cfg, true, 2, "cold-cache");
		expect(applied.appliedNow.length).toBe(1);
		expect(ledger.get("b")?.appliedReason).toBe("cold-cache");
	});

	it("never removes tool results", () => {
		const ledger = new Map([["a", decision("a", "forget")], ["b", decision("b", "trim")], ["c", decision("c", "forget")]]);
		const r = applyLedger(messages, ledger, cfg, true, 1, "rolling");
		expect(r.messages.filter((m) => m.role === "toolResult").map((m) => (m as { toolCallId: string }).toolCallId)).toEqual(["a", "b", "c"]);
	});
});

describe("rebuildLedger", () => {
	it("later entries win and applied never regresses to pending", () => {
		const entries = [
			{ type: "custom", customType: "jev-memory", data: { kind: "decision", decision: decision("a", "forget", "pending") } },
			{ type: "custom", customType: "jev-memory", data: { kind: "decision", decision: decision("a", "forget", "applied") } },
			{ type: "custom", customType: "jev-memory", data: { kind: "decision", decision: decision("a", "forget", "pending") } },
			{ type: "custom", customType: "other", data: { kind: "decision", decision: decision("z", "forget") } },
			{ type: "message", message: { role: "user" } },
		];
		const l = rebuildLedger(entries);
		expect(l.size).toBe(1);
		expect(l.get("a")?.status).toBe("applied");
	});
});

describe("shouldApplyPending / pendingPrunable", () => {
	it("rolling always applies, batch never (unless cold), budget when the share is large enough", async () => {
		const { shouldApplyPending, pendingPrunable } = await import("../src/policy.ts");
		expect(shouldApplyPending("rolling", cfg, false, 0, 1000).apply).toBe(true);
		expect(shouldApplyPending("batch", cfg, false, 100000, 1000).apply).toBe(false);
		expect(shouldApplyPending("batch", cfg, true, 0, 1000).reason).toBe("cold-cache");
		const c = { ...cfg, budgetFraction: 0.15, budgetMinTokens: 4000 };
		expect(shouldApplyPending("budget", c, false, 3999, 10000).apply).toBe(false);
		expect(shouldApplyPending("budget", c, false, 4000, 100000).apply).toBe(false);
		expect(shouldApplyPending("budget", c, false, 4000, 20000).reason).toBe("budget");
		const msgs = [toolResult("a", "A".repeat(4000)), toolResult("b", "B".repeat(4000))];
		const ledger = new Map([["a", decision("a", "forget")], ["b", decision("b", "keep")]]);
		const n = pendingPrunable(msgs, ledger, cfg);
		expect(n).toBeGreaterThan(900);
		expect(n).toBeLessThan(1000);
	});
});
