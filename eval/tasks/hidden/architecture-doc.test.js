import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
test("hidden: ARCHITECTURE.md covers the modules", () => {
	const p = new URL("../ARCHITECTURE.md", import.meta.url);
	assert.ok(existsSync(p), "ARCHITECTURE.md missing");
	const text = readFileSync(p, "utf8");
	for (const mod of ["parse.js", "ledger.js", "format.js", "report.js", "csv.js", "cli.js"]) assert.ok(text.includes(mod), `missing ${mod}`);
	assert.ok(/cents/.test(text), "should describe the cents field");
	assert.ok(/npm test|node --test/.test(text), "should say how to run tests");
});
