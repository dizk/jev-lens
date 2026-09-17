import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDate, parseAmount, parseDate } from "../src/parse.js";

test("parseDate accepts ISO dates", () => {
	assert.equal(formatDate(parseDate("2024-03-05")), "2024-03-05");
});

test("parseDate accepts European dates", () => {
	assert.equal(formatDate(parseDate("31.12.2023")), "2023-12-31");
});

test("parseDate rejects garbage", () => {
	assert.equal(parseDate("yesterday"), null);
	assert.equal(parseDate("2024-13-01"), null);
});

test("parseAmount handles common formats", () => {
	assert.equal(parseAmount("12.50"), 1250);
	assert.equal(parseAmount("1,234.50"), 123450);
	assert.equal(parseAmount("4,00"), 400);
	assert.equal(parseAmount("-3"), -300);
	assert.ok(Number.isNaN(parseAmount("abc")));
});
