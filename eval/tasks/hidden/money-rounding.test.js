import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMoney } from "../src/format.js";
test("hidden: formatMoney two decimals", () => {
	assert.equal(formatMoney(1234), "12.34");
	assert.equal(formatMoney(5), "0.05");
	assert.equal(formatMoney(-250), "-2.50");
	assert.equal(formatMoney(100000), "1000.00");
	assert.equal(formatMoney(0), "0.00");
});
