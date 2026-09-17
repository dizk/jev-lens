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
		expect(decideView({ ...base, probabilities: { full: 0.4, outline: 0.5, focus: 0.1 } }, cands, cfg).kind).toBe("full");
		expect(decideView({ ...base, confidence: 0.2 }, cands, cfg).kind).toBe("full");
		expect(decideView({ ...base, choice: "sample" as never }, cands, cfg).kind).toBe("full");
	});

	it("mock picks outline for code", async () => {
		const s = buildPresendState(cfg, { firstUser: "", latestUser: "", agentText: "", toolName: "read", args: {}, isError: false, cands, totalLines: 1, totalChars: 1 });
		const a = await new MockPresend().choose(s, kinds);
		expect(a.choice).toBe("outline");
		expect(decideView(a, cands, cfg).kind).toBe("outline");
	});
});
