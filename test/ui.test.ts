import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { ComparisonResult, comparisonHint, listLines, savingsLine, type CompressedRecord } from "../src/ui.ts";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const rec: CompressedRecord = {
	id: "c1", toolName: "read", args: { path: "src/a.py" }, kind: "code", view: "outline",
	tokensBefore: 400, tokensAfter: 60, full: "first\nomitted\nlast",
	sent: "1│ first\n   ⋯ 1 lines omitted\n3│ last", included: [1, 3], recalls: 1, at: 0,
};
const component = (r = rec) => new ComparisonResult(r, theme, "ctrl+o to collapse");

describe("ui", () => {
	it("savings line and list rows carry the numbers and expansion hint", () => {
		expect(savingsLine(rec, theme)).toContain("60 of 400 tokens (−85 %)");
		expect(savingsLine(rec, theme)).toContain("recalled 1×");
		expect(comparisonHint(rec, "ctrl+o")).toBe("… (1 line pruned, 3 original, ctrl+o for diff)");
		expect(comparisonHint(rec, "alt+x")).toContain("alt+x for diff");
		expect(savingsLine(rec, theme)).not.toContain("/jev-lens diff");
		const rows = listLines([rec, { ...rec, id: "c2", recalls: 0, view: "sample" }], theme);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain("outline");
		expect(rows[1]).toContain("sample");
		expect(listLines([], theme)[0]).toContain("no compressed");
	});

	it("aligns retained lines and preserves omission markers in wide terminals", () => {
		const lines = component().render(120);
		expect(lines.some((l) => /Full output.*│ Compressed output/.test(l))).toBe(true);
		expect(lines.some((l) => /1 │ first.*│ 1│ first/.test(l))).toBe(true);
		expect(lines.some((l) => /3 │ last.*│ 3│ last/.test(l))).toBe(true);
		expect(lines.some((l) => l.includes("2 − omitted"))).toBe(true);
		expect(lines.some((l) => l.includes("⋯ 1 lines omitted"))).toBe(true);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(120);
	});

	it("stacks full and compressed output on narrow terminals", () => {
		const lines = component().render(60);
		expect(lines.indexOf("Full output")).toBeLessThan(lines.indexOf("Compressed output"));
		expect(lines).toContain("2 − omitted");
		expect(lines.join("\n")).toContain(rec.sent);
	});

	it("shows actual shortened command lines, not reconstructed original text", () => {
		const lines = component({ ...rec, full: "long original command output", sent: "1│ shortened…", included: [1] }).render(120);
		expect(lines.some((l) => /long original command output.*│ 1│ shortened…/.test(l))).toBe(true);
	});

	it("wraps long lines, handles ANSI, tabs and wide characters, and reflows after resize", () => {
		const r = { ...rec, full: "\u001b[31m" + "界".repeat(100) + " END\u001b[0m\n\tlast", sent: "1│ " + "界".repeat(100) + " END", included: [1] };
		const c = component(r);
		for (const width of [120, 60, 20, 1, 0, 160]) {
			const lines = c.render(width);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			if (width >= 20) expect(lines.join("\n")).toContain("END");
		}
		const before = c.render(120);
		expect(c.render(120)).toBe(before);
		c.invalidate();
		expect(c.render(120)).toEqual(before);
	});

	it("keeps leading and trailing omissions, blank lines, and unnumbered sent text", () => {
		const r = { ...rec, full: "before\n\nafter", sent: "2│ \n  ⋯ 1 lines omitted\nextra view note", included: [2] };
		const lines = component(r).render(120);
		expect(lines.some((l) => l.includes("1 − before"))).toBe(true);
		expect(lines.some((l) => /2 │ .*│ 2│ /.test(l))).toBe(true);
		expect(lines.some((l) => l.includes("3 − after"))).toBe(true);
		expect(lines.some((l) => l.includes("extra view note"))).toBe(true);
	});
});
