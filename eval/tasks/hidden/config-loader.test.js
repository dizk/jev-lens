import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { formatMoney } from "../src/format.js";
test("hidden: config defaults and currency formatting", () => {
	const dir = mkdtempSync(join(tmpdir(), "cfg-"));
	assert.deepEqual(loadConfig(join(dir, "missing.json")), { currency: "USD", locale: "en-US" });
	const p = join(dir, "c.json");
	writeFileSync(p, JSON.stringify({ currency: "EUR" }));
	assert.deepEqual(loadConfig(p), { currency: "EUR", locale: "en-US" });
	assert.equal(formatMoney(1234), "12.34");
	const s = formatMoney(1234, { currency: "USD", locale: "en-US" });
	assert.ok(s.includes("12.34") && s.includes("$"), s);
});
