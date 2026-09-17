#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { importCsv } from "./csv.js";
import { Ledger } from "./ledger.js";
import { renderCategoryReport, renderMonthlyReport } from "./report.js";
import { formatMoney } from "./format.js";

export function run(argv) {
	const [command, file, ...rest] = argv;
	if (!command || !file) return "usage: ledger <total|monthly|categories> <file.csv> [--category NAME]";
	const ledger = new Ledger();
	const { entries, errors } = importCsv(readFileSync(file, "utf8"));
	ledger.addAll(entries);
	const category = rest.includes("--category") ? rest[rest.indexOf("--category") + 1] : undefined;
	switch (command) {
		case "total":
			return `${formatMoney(ledger.total({ category }))}${errors.length ? ` (${errors.length} lines skipped)` : ""}`;
		case "monthly":
			return renderMonthlyReport(ledger);
		case "categories":
			return renderCategoryReport(ledger, { category });
		default:
			return `unknown command: ${command}`;
	}
}

if (process.argv[1] && process.argv[1].endsWith("cli.js")) {
	console.log(run(process.argv.slice(2)));
}
