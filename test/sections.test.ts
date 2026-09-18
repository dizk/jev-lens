import { describe, expect, it } from "vitest";
import { buildCandidates, buildCandidatesAsync, sectionsView, splitSections } from "../src/views.ts";
import { buildPresendState, decideView, expandRelevantBlocks, MockPresend } from "../src/presend.ts";

const grep = [
	"src/a.py:10:def parse(x):", "src/a.py-11-    return x", "src/a.py-12-", "--",
	"src/a.py:40:def parse_all(xs):", "src/a.py-41-    return [parse(x) for x in xs]", "src/a.py-42-", "--",
	"src/b.py:5:from a import parse", "src/b.py-6-", "src/b.py-7-def main():", "src/b.py-8-    parse(1)",
].join("\n");
const json = ["{", '  "findings": [', '    {"id": 1},', '    {"id": 2}', "  ],", '  "metrics": {', '    "n": 2,', '    "ok": true', "  },", '  "run": "abc"', "}"].join("\n");
const doc = ["# Title", "intro line", "", "## Section one", "body 1", "body 2", "", "## Section two", "body 3", "body 4", "", "COMMAND: uv run x", "EXIT: 0", "out"].join("\n");

describe("splitSections", () => {
	it("splits grep context output at separators and file changes", () => {
		const b = splitSections(grep, 2);
		expect(b.map((x) => [x.from, x.to])).toEqual([[1, 4], [5, 8], [9, 12]]);
		expect(b[0].name).toBe("src/a.py:10:def parse(x):");
	});
	it("splits a JSON document at its top-level keys", () => {
		const b = splitSections(json, 1, 24, 0);
		expect(b.map((x) => x.name)).toEqual(['{ "findings": [', '"metrics": {', '"run": "abc"']);
	});
	it("splits prose at headings, blank lines and marker lines, merging small sections", () => {
		const b = splitSections(doc, 1);
		expect(b.map((x) => x.name)).toEqual(["# Title", "## Section one", "## Section two", "COMMAND: uv run x", "EXIT: 0"]);
		expect(b.at(-1)!.to).toBe(14);
		expect(splitSections(doc, 3).map((x) => x.name)).toEqual(["# Title", "## Section one", "## Section two"]);
	});
	it("falls back to fixed chunks when there is no structure, and caps the count", () => {
		const flat = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
		expect(splitSections(flat, 3, 24, 50).map((x) => [x.from, x.to])).toEqual([[1, 50], [51, 100], [101, 150], [151, 200]]);
		expect(splitSections(flat, 3, 24, 0)).toEqual([]);
		const many = Array.from({ length: 100 }, (_, i) => `## h${i}\na\nb\n`).join("\n");
		expect(splitSections(many, 3, 8).length).toBeLessThanOrEqual(8);
	});
	it("returns nothing for tiny output", () => {
		expect(splitSections("a\nb\nc")).toEqual([]);
	});
});

describe("sections view", () => {
	it("is a numbered subset of first lines, offered for command output", () => {
		const v = sectionsView(grep, splitSections(grep, 2))!;
		expect(v.kind).toBe("sections");
		expect(v.included).toEqual([1, 5, 9]);
		expect(v.text).toContain("1│ src/a.py:10:def parse(x):");
		expect(v.text).toContain("lines omitted");
		const big = Array.from({ length: 30 }, (_, i) => `src/f${i}.py:1:def f${i}():\nsrc/f${i}.py-2-    pass\nsrc/f${i}.py-3-    pass\n--`).join("\n");
		const c = buildCandidates("bash", { command: "grep -rn -A2 'def' src" }, big, []);
		expect(c.kind).toBe("command");
		expect(c.views.map((x) => x.kind)).toContain("sections");
		const nope = buildCandidates("bash", { command: "grep -rn -A2 'def' src" }, big, [], { sectionsView: false });
		expect(nope.views.map((x) => x.kind)).not.toContain("sections");
		// a mixed file display (code + docs) stays command output but must not get section headers: it may be edited from
		const display = buildCandidates("bash", { command: "cat README.md; cat src/a.py" }, big, []);
		expect(display.views.map((x) => x.kind)).not.toContain("sections");
	});
});

describe("command sections policy and expansion", () => {
	const big = Array.from({ length: 12 }, (_, i) => `src/f${i}.py:1:def handler_${i}():\nsrc/f${i}.py-2-    value = ${i}\nsrc/f${i}.py-3-    if value is None:\nsrc/f${i}.py-4-        raise ValueError("missing")\nsrc/f${i}.py-5-    log.debug("handler %s", value)\nsrc/f${i}.py-6-    return value\n--`).join("\n");
	const cfgBase = { presendNeedsFullAbove: 0.5, presendFullMassAbove: 0.5, presendMinConfidence: 0, presendCodeNeedsFullAbove: 0.5, presendCommandNeedsFullAbove: 0.65 };
	it("sections policy replaces a full choice when needs-full is low; gate keeps full", async () => {
		const cands = await buildCandidatesAsync("bash", { command: "grep -rn -A2 'def handler' src" }, big, []);
		expect(cands.blocks!.length).toBeGreaterThan(2);
		const answer = { choice: "full" as const, probabilities: { full: 0.7, sections: 0.2, signals: 0.1 }, confidence: 0.6, needsFull: 0.3 };
		expect(decideView(answer, cands, { ...cfgBase, presendCommandPolicy: "gate" }).kind).toBe("full");
		expect(decideView(answer, cands, { ...cfgBase, presendCommandPolicy: "sections" }).kind).toBe("sections");
		expect(decideView({ ...answer, needsFull: 0.8 }, cands, { ...cfgBase, presendCommandPolicy: "sections" }).kind).toBe("full");
	});
	it("expands the sections jev says the agent needs into a relevant view", async () => {
		const cands = await buildCandidatesAsync("bash", { command: "grep -rn -A2 'def handler' src" }, big, []);
		const sections = cands.views.find((v) => v.kind === "sections")!;
		const state = buildPresendState({ stateHeadChars: 2500 }, { firstUser: "fix handler_7 so it returns twice the value", latestUser: "", agentText: "", toolName: "bash", args: { command: "grep" }, isError: false, cands, totalLines: big.split("\n").length, totalChars: big.length });
		const ex = await expandRelevantBlocks(new MockPresend(), state, big, cands, sections, 0.5, undefined, cands.blocks);
		expect(ex).toBeDefined();
		expect(ex!.view.kind).toBe("relevant");
		expect(ex!.view.text).toContain("value = 7");
		expect(ex!.view.text).not.toContain("value = 8");
		expect(ex!.view.chars).toBeLessThan(cands.views[0].chars);
		// no section clears the bar: full, not headers alone
		const unrelated = { ...state, task: { ...state.task, first_user_request: "unrelated" }, agent: { ...state.agent, args: "{}" } };
		const none = await expandRelevantBlocks(new MockPresend(), unrelated, big, cands, sections, 0.5, undefined, cands.blocks, 0.3);
		expect(none!.view.kind).toBe("full");
		const headers = await expandRelevantBlocks(new MockPresend(), unrelated, big, cands, sections, 0.5, undefined, cands.blocks, 0);
		expect(headers!.view.kind).toBe("relevant");
		expect(headers!.view.included).toEqual(sections.included);
		// not applicable for other command views
		expect(await expandRelevantBlocks(new MockPresend(), state, big, cands, cands.views[0], 0.5)).toBeUndefined();
	});
});
