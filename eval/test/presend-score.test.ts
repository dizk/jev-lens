import { describe, expect, it } from "vitest";
import { loadConfig, MockPresend } from "jev-lens";
import type { View } from "jev-lens";
import { recallMisses, scoreMessages, summarize } from "../presend-score.ts";

const view = (kind: string, included: number[]): View => ({ kind, included, text: "" } as unknown as View);
const full = Array.from({ length: 100 }, (_, i) => `line ${i + 1}${i === 49 ? " needle" : ""}`).join("\n");

describe("recall-miss", () => {
	it("judges a recorded recall against the replayed view", () => {
		expect(recallMisses(view("full", []), full, {})).toBe(false);
		expect(recallMisses(view("focus", [1, 2, 3]), full, {})).toBe(true);
		expect(recallMisses(view("focus", [1, 2, 3, 10, 11, 12]), full, { lines: "10-12" })).toBe(false);
		expect(recallMisses(view("focus", [1, 2, 3, 10, 11]), full, { lines: "10-12" })).toBe(true);
		expect(recallMisses(view("focus", [1, 2, 3]), full, { lines: "x" })).toBe(true);
		expect(recallMisses(view("focus", [50]), full, { pattern: "NEEDLE" })).toBe(false);
		expect(recallMisses(view("focus", [1]), full, { pattern: "needle" })).toBe(true);
		expect(recallMisses(view("focus", [1]), full, { pattern: "/nee.le/" })).toBe(true);
		expect(recallMisses(view("focus", [1]), full, { pattern: "/(/" })).toBe(true);
	});
	it("counts a recall of a compressed result in the summary and the objective", async () => {
		const code = Array.from({ length: 300 }, (_, i) => `export function fn${i}(a${i}: number) {\n\treturn a${i} * ${i};\n}`).join("\n\n");
		const msgs = [
			{ role: "user", content: [{ type: "text", text: "Change fn250" }], timestamp: 0 },
			{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/x/a.ts" } }], stopReason: "toolUse", timestamp: 1 },
			{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: code }], isError: false, timestamp: 2 },
			{ role: "assistant", content: [{ type: "toolCall", id: "c2", name: "recall", arguments: { id: "c1" } }], stopReason: "toolUse", timestamp: 3 },
		] as any;
		const cfg = { ...loadConfig(), apiKey: "" };
		// a mock that always compresses, whichever views the file gets
		const mock = new MockPresend((_s, kinds) => kinds.find((k) => k !== "full") ?? "full");
		const rows = await scoreMessages("s", msgs, mock, cfg);
		expect(rows).toHaveLength(1);
		expect(rows[0].view).not.toBe("full");
		expect(rows[0].recallMiss).toBe(true);
		const s = summarize(rows);
		expect(s.recallMiss).toBe(1);
		expect(s.recallMissPct).toBe(100);
		expect(s.objective).toBeCloseTo(s.savedPct - 200, 5);
		const none = summarize(await scoreMessages("s", msgs.slice(0, 3), mock, cfg));
		expect(none.recallMiss).toBe(0);
	});
});
