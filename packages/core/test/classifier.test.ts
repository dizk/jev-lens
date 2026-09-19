import { describe, expect, it } from "vitest";
import { buildItemState, defaultMockRule, MockClassifier, TOOL_RESULT_QUESTIONS } from "../src/classifier.ts";

describe("buildItemState", () => {
	it("truncates and splits output into head and tail", () => {
		const output = "x".repeat(5000);
		const s = buildItemState({ stateHeadChars: 100, stateTailChars: 50 }, {
			firstUser: "a".repeat(1000), latestUser: "b", toolName: "read", args: { path: "p" }, isError: false, output, afterText: "c".repeat(2000), afterCalls: Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, arguments: {} })),
		});
		expect(s.item.output_head.length).toBe(100);
		expect(s.item.output_tail.length).toBe(50);
		expect(s.item.total_chars).toBe(5000);
		expect(s.task.first_user_request.length).toBe(601);
		expect(s.after.assistant_text.length).toBe(801);
		expect(s.after.next_tool_calls.length).toBe(8);
	});
	it("omits the tail when the output fits in the head", () => {
		const s = buildItemState({ stateHeadChars: 100, stateTailChars: 50 }, {
			firstUser: "", latestUser: "", toolName: "bash", args: {}, isError: true, output: "short", afterText: "", afterCalls: [],
		});
		expect(s.item.output_tail).toBe("");
		expect(s.item.is_error).toBe(true);
	});
});

describe("questions", () => {
	it("are all nouls with both criteria", () => {
		for (const q of Object.values(TOOL_RESULT_QUESTIONS)) {
			expect(q.type).toBe("noul");
			expect(q.criteria.true.length).toBeGreaterThan(20);
			expect(q.criteria.false.length).toBeGreaterThan(20);
		}
	});
});

describe("MockClassifier", () => {
	it("is deterministic", async () => {
		const c = new MockClassifier();
		const s = buildItemState({ stateHeadChars: 10, stateTailChars: 10 }, { firstUser: "", latestUser: "", toolName: "bash", args: {}, isError: false, output: "y".repeat(3000), afterText: "", afterCalls: [] });
		expect(await c.classifyToolResult(s)).toEqual(defaultMockRule(s));
		expect(defaultMockRule(s)).toEqual({ needed: 0.1, outcomeOnly: 0.9 });
	});
});
