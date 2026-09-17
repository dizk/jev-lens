import { test } from "node:test";
import assert from "node:assert/strict";
import { exportCsv, importCsv } from "../src/csv.js";
import { Ledger } from "../src/ledger.js";
import { parseDate } from "../src/parse.js";
test("hidden: exportCsv round trip and quoting", () => {
	const l = new Ledger();
	l.add({ date: parseDate("2024-01-02"), cents: 1250, category: "food", note: "lunch, with \"friends\"" });
	l.add({ date: parseDate("2024-01-01"), cents: 500, category: "transport", note: "" });
	const csv = exportCsv(l);
	const lines = csv.trim().split("\n");
	assert.equal(lines[0], "date,amount,category,note");
	assert.equal(lines[1], "2024-01-01,5.00,transport,");
	assert.equal(lines[2], '2024-01-02,12.50,food,"lunch, with ""friends"""');
	const back = importCsv(csv);
	assert.equal(back.errors.length, 0);
	assert.equal(back.entries.length, 2);
	assert.equal(back.entries[1].note, 'lunch, with "friends"');
});
