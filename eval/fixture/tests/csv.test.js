import { test } from "node:test";
import assert from "node:assert/strict";
import { importCsv, splitCsvLine } from "../src/csv.js";

test("splitCsvLine handles quotes", () => {
	assert.deepEqual(splitCsvLine('a,"b, c","d ""e"""'), ["a", "b, c", 'd "e"']);
});

test("importCsv parses and reports errors", () => {
	const { entries, errors } = importCsv("date,amount,category,note\n2024-01-01,12.50,food,lunch\nbad,1,x,\n");
	assert.equal(entries.length, 1);
	assert.equal(entries[0].cents, 1250);
	assert.equal(errors.length, 1);
});
