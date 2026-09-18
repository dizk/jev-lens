import { describe, expect, it } from "vitest";
import { Health } from "../src/health.ts";

describe("session health", () => {
	it("counts repeated failures but warns only once per stage", () => {
		const health = new Health();
		expect(health.failing).toBe(false);
		for (let i = 0; i < 3; i++) health.failure("presend", new Error("secret provider response"));
		expect(health.failing).toBe(true);
		expect(health.warnings()).toHaveLength(1);
		expect(health.warnings()).toEqual([]);
		expect(health.lines()[0]).toContain("3 (last attempt failed)");
		health.success("presend");
		expect(health.failing).toBe(false);
		expect(health.lines()[0]).toContain("a later attempt succeeded");
		health.failure("presend", undefined);
		expect(health.warnings()).toEqual([]);
		health.failure("postsend", undefined);
		expect(health.warnings()).toHaveLength(1);
		health.success("presend");
		expect(health.failing).toBe(true); // post-send still failing
	});

	it.each([[401, "API key"], [403, "API key"], [429, "usage limit"], [500, "connection"]])("gives safe advice for status %s", (status, advice) => {
		const health = new Health();
		health.failure("presend", { status, message: "ts_secret" });
		const text = [...health.warnings(), ...health.lines()].join("\n");
		expect(text).toContain(advice);
		expect(text).not.toContain("ts_secret");
	});
});
