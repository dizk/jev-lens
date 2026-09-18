import { describe, expect, it } from "vitest";
import { commandCompletions, commandHelp } from "../src/commands.ts";

describe("command completions", () => {
	it("completes subcommands without a diff command", () => {
		expect(commandCompletions("")!.map((i) => i.value)).toEqual(["stats", "list", "decisions", "key", "help"]);
		expect(commandCompletions("  st")![0].value).toBe("stats");
		expect(commandHelp).toContain("ctrl+o");
		expect(commandHelp).not.toContain("/jev-lens diff");
	});
	it("does not complete removed commands or extra arguments", () => {
		for (const prefix of ["diff", "diff ", "diff 1", "key secret", "stats ", "unknown"])
			expect(commandCompletions(prefix)).toBeNull();
	});
});
