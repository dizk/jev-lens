import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../src/ledger.js";
import { parseDate } from "../src/parse.js";
import { monthlyTotals } from "../src/report.js";

test("monthlyTotals groups by month", () => {
	const l = new Ledger();
	l.addAll([
		{ date: parseDate("2024-01-03"), cents: 100, category: "a", note: "" },
		{ date: parseDate("2024-01-20"), cents: 200, category: "a", note: "" },
		{ date: parseDate("2024-02-01"), cents: 300, category: "a", note: "" },
	]);
	assert.deepEqual([...monthlyTotals(l)], [["2024-01", 300], ["2024-02", 300]]);
});
