import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("hidden 6: sum exists and total is an alias", () => {
	const l = new Ledger();
	l.add({ date: parseDate("2024-01-01"), cents: 100, category: "a", note: "" });
	l.add({ date: parseDate("2024-01-02"), cents: 200, category: "b", note: "" });
	assert.equal(typeof l.sum, "function");
	assert.equal(l.sum(), 300);
	assert.equal(l.total(), 300);
});

test("hidden 7: 50k inserts fast and duplicates rejected", () => {
	const l = new Ledger();
	const base = Date.UTC(2024, 0, 1);
	const t0 = Date.now();
	for (let i = 0; i < 50000; i++) l.add({ date: new Date(base + (i % 365) * 86400000), cents: i, category: "c" + (i % 7), note: "" });
	assert.ok(Date.now() - t0 < 2000, "should finish under 2s");
	assert.equal(l.size(), 50000);
	assert.equal(l.add({ date: new Date(base), cents: 0, category: "c0", note: "" }), false);
});

test("hidden 8: ARCHITECTURE.md covers the modules", () => {
	const p = new URL("../ARCHITECTURE.md", import.meta.url);
	assert.ok(existsSync(p), "ARCHITECTURE.md missing");
	const text = readFileSync(p, "utf8");
	for (const mod of ["parse.js", "ledger.js", "format.js", "report.js", "csv.js", "cli.js"]) assert.ok(text.includes(mod), `missing ${mod}`);
	assert.ok(/cents/.test(text), "should describe the cents field");
	assert.ok(/npm test|node --test/.test(text), "should say how to run tests");
});
