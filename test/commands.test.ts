import { describe, expect, it } from "vitest";
import { commandCompletions } from "../src/commands.ts";
import type { CompressedRecord } from "../src/ui.ts";

describe("diff completions", () => {
	const records = Array.from({ length: 12 }, (_, i) => ({ toolName: `tool-${i}`, view: "outline", tokensBefore: 100, tokensAfter: 20 } as CompressedRecord));
	it("uses newest-first list numbers and replaces the entire argument", () => {
		const items = commandCompletions("diff ", records)!;
		expect(items).toHaveLength(12);
		expect(items[0].value).toBe("diff 1");
		expect(items[0].description).toContain("tool-11");
		expect(commandCompletions("diff 1", records)!.map((i) => i.value)).toEqual(["diff 1", "diff 10", "diff 11", "diff 12"]);
		expect(commandCompletions("  diff\t2", records)![0].value).toBe("diff 2");
	});
	it("does not complete invalid or extra arguments", () => {
		for (const prefix of ["diff 0", "diff -1", "diff 1.5", "diff 1 ", "diff 99", "key secret"])
			expect(commandCompletions(prefix, records)).toBeNull();
	});
});
