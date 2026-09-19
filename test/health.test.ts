import { describe, expect, it } from "vitest";
import { APIError, APIConnectionError, APITimeoutError } from "@typesafe-ai/sdk";
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

	it.each([[400, "request format"], [401, "API key"], [402, "credits and billing"], [403, "account permissions"], [404, "model and API endpoint"], [408, "timed out"], [422, "request format"], [429, "usage limit"], [500, "server error"], [504, "timed out"], [418, "unexpected HTTP response"]])("gives safe advice for status %s", (status, advice) => {
		const health = new Health();
		health.failure("presend", { status, message: "ts_secret" });
		const text = [...health.warnings(), ...health.lines()].join("\n");
		expect(text).toContain(advice);
		expect(text).toContain(`HTTP ${status}:`);
		expect(text).not.toContain("ts_secret");
	});

	it.each([
		[new APITimeoutError(15000), "Request timed out"],
		[new APIConnectionError("ts_secret"), "Connection failed"],
		[new TypeError("ts_secret"), "TypeError"],
		[new Error("ts_secret"), "Unclassified error"],
	])("distinguishes failures without an HTTP response", (error, advice) => {
		const health = new Health();
		health.failure("presend", error);
		const text = [...health.warnings(), ...health.lines()].join("\n");
		expect(text).toContain(advice);
		expect(text).toContain("no HTTP status");
		expect(text).not.toContain("ts_secret");
	});

	it("handles an SDK payment error without exposing its response or headers", () => {
		const health = new Health();
		health.failure("presend", new APIError(402, { message: "ts_secret", input: "private source" }, new Headers({ "x-typesafe-request-id": "private-id" })));
		const text = [...health.warnings(), ...health.lines()].join("\n");
		expect(text).toContain("HTTP 402: Payment required");
		for (const secret of ["ts_secret", "private source", "private-id"]) expect(text).not.toContain(secret);
	});

	it.each(["ts_secret", "402 ts_secret", NaN, Infinity, 402.5, 999])("does not echo malformed status values: %s", (status) => {
		const health = new Health();
		health.failure("presend", { status, name: "ts_secret", message: "ts_secret", body: "ts_secret" });
		const text = [...health.warnings(), ...health.lines()].join("\n");
		expect(text).toContain("Unclassified error");
		expect(text).not.toContain("ts_secret");
	});
});
