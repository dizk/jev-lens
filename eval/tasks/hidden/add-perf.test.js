import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../src/ledger.js";
test("hidden: 50k inserts fast and duplicates rejected", () => {
	const l = new Ledger();
	const base = Date.UTC(2024, 0, 1);
	const t0 = Date.now();
	for (let i = 0; i < 50000; i++) l.add({ date: new Date(base + (i % 365) * 86400000), cents: i, category: "c" + (i % 7), note: "" });
	assert.ok(Date.now() - t0 < 2000, "should finish under 2s");
	assert.equal(l.size(), 50000);
	assert.equal(l.add({ date: new Date(base), cents: 0, category: "c0", note: "" }), false);
	assert.equal(l.size(), 50000);
	assert.equal(l.total({ category: "c0" }) > 0, true);
});
