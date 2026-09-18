import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { DiffOverlay, listLines, savingsLine, type CompressedRecord } from "../src/ui.ts";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const full = Array.from({ length: 50 }, (_, i) => `line ${i + 1}: ${"x".repeat(20)}`).join("\n");
const rec: CompressedRecord = { id: "c1", toolName: "read", args: { path: "src/a.py" }, kind: "code", view: "outline", tokensBefore: 400, tokensAfter: 60, full, sent: "1│ line 1\n  ⋯ 48 lines omitted\n50│ line 50", included: [1, 50], needsFull: 0.3, pFull: 0.2, recalls: 1, at: 0 };
const PAGE_DOWN = String.fromCharCode(27) + "[6~";

describe("ui", () => {
	it("savings line and list rows carry the numbers", () => {
		expect(savingsLine(rec, theme)).toContain("60 of 400 tokens (−85 %)");
		expect(savingsLine(rec, theme)).toContain("recalled 1×");
		const rows = listLines([rec, { ...rec, id: "c2", recalls: 0, view: "sample" }], theme);
		expect(rows.length).toBe(2);
		expect(rows[0]).toContain("outline");
		expect(rows[1]).toContain("sample");
		expect(listLines([], theme)[0]).toContain("no compressed");
	});

	it("overlay renders within width and height, scrolls, toggles", () => {
		let closed = false;
		const o = new DiffOverlay(rec, theme, 20, () => { closed = true; });
		const narrow = o.render(60);
		expect(narrow.length).toBeLessThanOrEqual(20);
		for (const l of narrow) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
		const lines = o.render(160);
		expect(lines[0]).toContain("read src/a.py");
		expect(lines[1]).toContain("48 of 50 lines omitted");
		expect(lines.some((l) => l.includes("1 │ line 1"))).toBe(true);
		expect(lines.some((l) => l.includes("− line 2"))).toBe(true);
		o.handleInput(PAGE_DOWN);
		const after = o.render(160);
		expect(after[after.length - 1]).toMatch(/lines \d+-\d+ of 50/);
		expect(after[after.length - 1]).not.toContain("lines 1-");
		o.handleInput("t");
		const sent = o.render(160);
		expect(sent.some((l) => l.includes("48 lines omitted"))).toBe(true);
		expect(sent[2]).toContain("exactly what the model got");
		o.handleInput("q");
		expect(closed).toBe(true);
	});
});
