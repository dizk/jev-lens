import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDate, parseDate } from "../src/parse.js";
test("hidden: parseDate month handling", () => {
	assert.equal(formatDate(parseDate("2024-01-31")), "2024-01-31");
	assert.equal(formatDate(parseDate("12/25/2023")), "2023-12-25");
	assert.equal(formatDate(parseDate("1.2.2024")), "2024-02-01");
	assert.equal(parseDate("2024-02-30"), null);
});
