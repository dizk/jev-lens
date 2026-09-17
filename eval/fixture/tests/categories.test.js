import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCategory, sectionOf } from "../src/categories.js";

test("normalizeCategory maps aliases", () => {
	assert.equal(normalizeCategory(" Groceries "), "food");
	assert.equal(normalizeCategory("rent"), "rent");
	assert.equal(normalizeCategory("weird"), "weird");
});

test("sectionOf groups categories", () => {
	assert.equal(sectionOf("rent"), "essentials");
	assert.equal(sectionOf("travel"), "lifestyle");
	assert.equal(sectionOf("nope"), "other");
});
