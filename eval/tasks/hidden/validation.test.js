import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../src/ledger.js";
import { parseDate } from "../src/parse.js";
test("hidden: add validates entries", () => {
	const l = new Ledger();
	assert.throws(() => l.add({ date: "2024-01-01", cents: 1, category: "a" }), TypeError);
	assert.throws(() => l.add({ date: new Date("nope"), cents: 1, category: "a" }), TypeError);
	assert.throws(() => l.add({ date: parseDate("2024-01-01"), cents: 1.5, category: "a" }), TypeError);
	assert.throws(() => l.add({ date: parseDate("2024-01-01"), cents: Infinity, category: "a" }), TypeError);
	assert.throws(() => l.add({ date: parseDate("2024-01-01"), cents: 1, category: "" }), TypeError);
	assert.equal(l.add({ date: parseDate("2024-01-01"), cents: 1, category: "a" }), true);
	assert.equal(l.size(), 1);
});
