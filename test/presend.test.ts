import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { buildPresendState, decideView, MockPresend, presendQuestions } from "../src/presend.ts";
import { buildCandidates } from "../src/views.ts";

const cfg = loadConfig();
const categories = readFileSync(new URL("../eval/fixture/src/categories.js", import.meta.url), "utf8");

describe("presend", () => {
	const cands = buildCandidates("read", { path: "src/categories.js" }, categories, ["normalizeCategory"]);
	const kinds = cands.views.map((v) => v.kind);

	it("state carries a preview of every candidate", () => {
		const s = buildPresendState(cfg, { firstUser: "task", latestUser: "task", agentText: "let me look", toolName: "read", args: { path: "src/categories.js" }, isError: false, cands, totalLines: 200, totalChars: categories.length });
		expect(Object.keys(s.views)).toEqual(kinds);
		expect(s.views.full.preview.length).toBeLessThanOrEqual(1501);
		expect(s.result.kind).toBe("code");
	});

	it("questions only offer the candidates that exist", () => {
		const q = presendQuestions(kinds);
		expect(Object.keys(q.view.criteria)).toEqual(kinds);
		expect(q.needs_full.type).toBe("noul");
	});

	it("decideView errs towards full", () => {
		const base = { choice: "outline" as const, probabilities: { full: 0.1, outline: 0.8, focus: 0.1 }, confidence: 0.8, needsFull: 0.1 };
		expect(decideView(base, cands, cfg).kind).toBe("outline");
		expect(decideView({ ...base, needsFull: 0.7 }, cands, cfg).kind).toBe("full");
		expect(decideView({ ...base, needsFull: 0.4 }, cands, { ...cfg, presendCodeNeedsFullAbove: 0.35 }).kind).toBe("full"); // code can be stricter
		expect(decideView({ ...base, needsFull: 0.4 }, cands, cfg).kind).toBe("outline");
		expect(decideView({ ...base, choice: "focus", probabilities: { full: 0.1, outline: 0.1, focus: 0.8 } }, cands, cfg).kind).toBe("outline");
		expect(decideView({ ...base, probabilities: { full: 0.6, outline: 0.3, focus: 0.1 } }, cands, cfg).kind).toBe("full");
		expect(decideView({ ...base, probabilities: { full: 0.4, outline: 0.5, focus: 0.1 } }, cands, cfg).kind).toBe("outline");
		expect(decideView({ ...base, confidence: 0.2 }, { ...cands }, { ...cfg, presendMinConfidence: 0.4 }).kind).toBe("full");
		expect(decideView({ ...base, choice: "sample" as never }, cands, cfg).kind).toBe("full");
	});

	it("mock picks outline for code", async () => {
		const s = buildPresendState(cfg, { firstUser: "", latestUser: "", agentText: "", toolName: "read", args: {}, isError: false, cands, totalLines: 1, totalChars: 1 });
		const a = await new MockPresend().choose(s, kinds);
		expect(a.choice).toBe("outline");
		expect(decideView(a, cands, cfg).kind).toBe("outline");
	});
});

describe("block expansion (second step)", () => {
	it("splits code into top-level blocks and expands the relevant ones", async () => {
		const { splitBlocks } = await import("../src/views.ts");
		const { expandRelevantBlocks, buildPresendState: bps } = await import("../src/presend.ts");
		const cands = buildCandidates("read", { path: "src/categories.js" }, categories, ["normalizeCategory"]);
		const blocks = splitBlocks(categories);
		expect(blocks.length).toBeGreaterThanOrEqual(4);
		expect(blocks.some((b) => b.name.startsWith("export function normalizeCategory"))).toBe(true);
		expect(blocks[0].from).toBe(1);
		for (let i = 1; i < blocks.length; i++) expect(blocks[i].from).toBe(blocks[i - 1].to + 1);
		const state = bps(cfg, { firstUser: "fix normalizeCategory so inputs with inner spaces work", latestUser: "", agentText: "", toolName: "read", args: { path: "src/categories.js" }, isError: false, cands, totalLines: 200, totalChars: categories.length });
		const outline = cands.views.find((v: { kind: string }) => v.kind === "outline")!;
		const ex = await expandRelevantBlocks(new MockPresend(), state, categories, cands, outline, 0.5);
		expect(ex?.view.kind).toBe("relevant");
		expect(ex!.view.text).toContain("return ALIASES[key] ?? key;"); // body of normalizeCategory
		expect(ex!.view.chars).toBeLessThan(categories.length * 0.6);
		expect(ex!.view.text).not.toContain('"groceries": "food"'); // ALIASES table body not expanded
	});
});
