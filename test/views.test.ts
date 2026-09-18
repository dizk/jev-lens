import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCandidates, detectKind, extractTerms, focusView, footer, headTailView, looksRepetitive, outlineView, sampleView, signalsView } from "../src/views.ts";

const categories = readFileSync(new URL("../eval/fixture/src/categories.js", import.meta.url), "utf8");
const csv = readFileSync(new URL("../eval/fixture/data/sample.csv", import.meta.url), "utf8");
const design = readFileSync(new URL("../eval/fixture/docs/DESIGN.md", import.meta.url), "utf8");
const testOut = Array.from({ length: 80 }, (_, i) => `✔ test case ${i} (0.${i}ms)`).join("\n") + "\n✖ parseDate accepts ISO dates (1ms)\n  AssertionError: Expected 2024-01-31\n  + actual - expected\nℹ pass 80\nℹ fail 1\n";

describe("detectKind", () => {
	it("uses extension, tool and shape", () => {
		expect(detectKind("read", { path: "src/a.ts" }, "")).toBe("code");
		expect(detectKind("read", { path: "data/x.csv" }, "")).toBe("data");
		expect(detectKind("read", { path: "README.md" }, "")).toBe("prose");
		expect(detectKind("bash", { command: "npm test" }, "")).toBe("command");
		expect(detectKind("read", { path: "noext" }, csv)).toBe("data");
		expect(looksRepetitive(csv)).toBe(true);
		expect(looksRepetitive(design)).toBe(false);
	});
});

describe("views are subsets with line numbers", () => {
	it("outline of code keeps signatures and shrinks a lot", () => {
		const v = outlineView(categories, "code");
		expect(v.kind).toBe("outline");
		expect(v.text).toContain("export function normalizeCategory");
		expect(v.text).toContain("export const ALIASES");
		expect(v.chars).toBeLessThan(categories.length * 0.3);
		expect(v.text).toMatch(/\d+│ /);
		expect(v.text).toContain("lines omitted");
	});
	it("outline of prose keeps headings", () => {
		const v = outlineView(design, "prose");
		expect(v.text).toContain("## 1. Goals");
		expect(v.chars).toBeLessThan(design.length * 0.5);
	});
	it("sample of csv keeps header and count", () => {
		const v = sampleView(csv);
		expect(v.text.startsWith("  1│ date,amount,category,note")).toBe(true);
		expect(v.lines).toBeLessThanOrEqual(14);
		expect(v.included[0]).toBe(1);
	});
	it("signals of test output keeps the failure and the summary", () => {
		const v = signalsView(testOut);
		expect(v.kind).toBe("signals");
		expect(v.text).toContain("✖ parseDate accepts ISO dates");
		expect(v.text).toContain("AssertionError");
		expect(v.text).toContain("ℹ fail 1");
		expect(v.chars).toBeLessThan(testOut.length * 0.5);
	});
	it("focus finds term lines with context and declines when everything matches", () => {
		const v = focusView(categories, ["normalizeCategory"]);
		expect(v?.text).toContain("normalizeCategory");
		expect(v!.lines).toBeLessThan(30);
		expect(focusView(csv, ["food", "transport", "rent", "utilities", "entertainment", "health", "clothing", "travel", "gifts", "subscriptions", "education", "household"])).toBeUndefined();
		expect(focusView(categories, [])).toBeUndefined();
	});
	it("head_tail keeps both ends", () => {
		const v = headTailView(csv, 5, 2);
		expect(v.included.slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
		expect(v.included.at(-1)).toBe(csv.split("\n").length);
	});
});

describe("extractTerms and buildCandidates", () => {
	it("pulls identifiers and quoted names from task text", () => {
		const terms = extractTerms("Rename the Ledger method total() to sum() across the codebase, keep `entryKey` and fix \"parseDate\" handling");
		expect(terms).toContain("entryKey");
		expect(terms).toContain("parseDate");
		expect(terms).not.toContain("across");
	});
	it("always offers full first and drops views that do not shrink", () => {
		const c = buildCandidates("read", { path: "src/categories.js" }, categories, ["normalizeCategory"]);
		expect(c.kind).toBe("code");
		expect(c.views[0].kind).toBe("full");
		const kinds = c.views.map((v) => v.kind);
		expect(kinds).toContain("outline");
		expect(kinds).toContain("focus");
		for (const v of c.views.slice(1)) expect(v.chars).toBeLessThan(categories.length * 0.6);
		const small = buildCandidates("read", { path: "a.js" }, "export const a = 1;\n", []);
		expect(small.views.length).toBe(1);
	});
	it("footer names the view and how to recall", () => {
		const c = buildCandidates("read", { path: "data/sample.csv" }, csv, []);
		const sample = c.views.find((v) => v.kind === "sample")!;
		const f = footer(sample, "call_1", 601);
		expect(f).toContain('recall(id: "call_1")');
		expect(f).toContain('"sample" view');
		expect(footer(c.views[0], "x", 1)).toBe("");
	});
});

describe("testlog view", () => {
	it("keeps failures and summary, drops passing tests and bars", async () => {
		const { testlogView, looksLikeTestLog, tidyLine } = await import("../src/views.ts");
		const pyt = ["=".repeat(300) + " test session starts " + "=".repeat(300), "platform linux -- Python 3.11", "collected 40 items", "", "tests/test_a.py ........F.....                       [ 50%]", "tests/test_b.py ....................                 [100%]", "", "=".repeat(200) + " FAILURES " + "=".repeat(200), "_".repeat(60) + " test_parse_date " + "_".repeat(60), "", "    def test_parse_date():", ">       assert parse('2024-01-31') == '2024-01-31'", "E       AssertionError: assert '2024-03-02' == '2024-01-31'", "", "tests/test_a.py:12: AssertionError", "=".repeat(100) + " short test summary info " + "=".repeat(100), "FAILED tests/test_a.py::test_parse_date - AssertionError", "=".repeat(120) + " 1 failed, 39 passed in 0.42s " + "=".repeat(120)].join("\n");
		expect(looksLikeTestLog(pyt)).toBe(true);
		const v = testlogView(pyt)!;
		expect(v.kind).toBe("testlog");
		expect(v.text).toContain("AssertionError");
		expect(v.text).toContain("FAILED tests/test_a.py::test_parse_date");
		expect(v.text).toContain("1 failed, 39 passed");
		expect(v.text).not.toContain("=".repeat(30));
		expect(v.text).not.toContain("test_b.py ....");
		expect(tidyLine("=".repeat(300)).length).toBeLessThan(30);
		expect(testlogView("hello world\nno tests here")).toBeUndefined();
	});
});

describe("tree view", () => {
	it("detects listings and collapses big directories", async () => {
		const { detectKind, treeView } = await import("../src/views.ts");
		const listing = "Here's the files and directories up to 2 levels deep in /workspace, excluding hidden items:\n/workspace/\n/workspace/repo/\n/workspace/repo/README.md\n/workspace/repo/setup.py\n/workspace/repo/src/\n" + Array.from({ length: 40 }, (_, i) => `/workspace/repo/src/mod${i}.py`).join("\n") + "\n" + Array.from({ length: 30 }, (_, i) => `/workspace/repo/tests/test_${i}.py`).join("\n") + "\n";
		expect(detectKind("read", { path: "/workspace" }, listing)).toBe("listing");
		const v = treeView(listing)!;
		expect(v.kind).toBe("tree");
		expect(v.text).toContain("/workspace/repo/README.md");
		expect(v.text).toContain("mod0.py");
		expect(v.text).not.toContain("mod30.py");
		expect(v.text).toContain("lines omitted");
		expect(v.lines).toBeLessThan(30);
	});
});
