import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../src/ledger.js";
import { parseDate } from "../src/parse.js";

const e = (date, cents, category, note = "") => ({ date: parseDate(date), cents, category, note });

test("add rejects duplicates", () => {
	const l = new Ledger();
	assert.equal(l.add(e("2024-01-01", 100, "food")), true);
	assert.equal(l.add(e("2024-01-01", 100, "food")), false);
	assert.equal(l.size(), 1);
});

test("total and byCategory", () => {
	const l = new Ledger();
	l.addAll([e("2024-01-01", 100, "food"), e("2024-01-02", 250, "food"), e("2024-02-01", 999, "rent")]);
	assert.equal(l.total(), 1349);
	assert.equal(l.total({ category: "food" }), 350);
	assert.equal(l.byCategory().get("rent"), 999);
});

test("filter by date range", () => {
	const l = new Ledger();
	l.addAll([e("2024-01-01", 100, "food"), e("2024-02-01", 200, "food")]);
	assert.equal(l.filter({ from: parseDate("2024-01-15") }).length, 1);
});
