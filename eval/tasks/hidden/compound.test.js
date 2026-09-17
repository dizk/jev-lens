import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDate, parseDate } from "../src/parse.js";
import { formatMoney } from "../src/format.js";
import { exportCsv, importCsv } from "../src/csv.js";
import { Ledger } from "../src/ledger.js";

test("hidden 1: parseDate month handling", () => {
	assert.equal(formatDate(parseDate("2024-01-31")), "2024-01-31");
	assert.equal(formatDate(parseDate("12/25/2023")), "2023-12-25");
	assert.equal(formatDate(parseDate("1.2.2024")), "2024-02-01");
	assert.equal(parseDate("2024-02-30"), null);
});

test("hidden 2: formatMoney two decimals", () => {
	assert.equal(formatMoney(1234), "12.34");
	assert.equal(formatMoney(5), "0.05");
	assert.equal(formatMoney(-250), "-2.50");
	assert.equal(formatMoney(100000), "1000.00");
});

test("hidden 3: exportCsv round trip and quoting", () => {
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
});

test("hidden 4: add validates entries", () => {
	const l = new Ledger();
	assert.throws(() => l.add({ date: "2024-01-01", cents: 1, category: "a" }), TypeError);
	assert.throws(() => l.add({ date: new Date("nope"), cents: 1, category: "a" }), TypeError);
	assert.throws(() => l.add({ date: parseDate("2024-01-01"), cents: 1.5, category: "a" }), TypeError);
	assert.throws(() => l.add({ date: parseDate("2024-01-01"), cents: 1, category: "" }), TypeError);
	assert.equal(l.add({ date: parseDate("2024-01-01"), cents: 1, category: "a" }), true);
});

test("hidden 5: config defaults and currency formatting", async () => {
	assert.ok(existsSync(new URL("../src/config.js", import.meta.url)), "src/config.js missing");
	const { loadConfig } = await import("../src/config.js");
	const dir = mkdtempSync(join(tmpdir(), "cfg-"));
	assert.deepEqual(loadConfig(join(dir, "missing.json")), { currency: "USD", locale: "en-US" });
	const p = join(dir, "c.json");
	writeFileSync(p, JSON.stringify({ currency: "EUR" }));
	assert.deepEqual(loadConfig(p), { currency: "EUR", locale: "en-US" });
	const s = formatMoney(1234, { currency: "USD", locale: "en-US" });
	assert.ok(s.includes("12.34") && s.includes("$"), s);
});
