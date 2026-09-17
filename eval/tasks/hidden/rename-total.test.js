import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Ledger } from "../src/ledger.js";
import { parseDate } from "../src/parse.js";
test("hidden: sum exists and total is an alias", () => {
	const l = new Ledger();
	l.add({ date: parseDate("2024-01-01"), cents: 100, category: "a", note: "" });
	l.add({ date: parseDate("2024-01-02"), cents: 200, category: "b", note: "" });
	assert.equal(typeof l.sum, "function");
	assert.equal(l.sum(), 300);
	assert.equal(l.sum({ category: "a" }), 100);
	assert.equal(l.total(), 300);
	const src = readFileSync(new URL("../src/cli.js", import.meta.url), "utf8");
	assert.ok(src.includes(".sum("), "cli should call sum()");
});
