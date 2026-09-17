import { formatMoney, formatTable } from "./format.js";
import { formatDate } from "./parse.js";

/** Group entries by YYYY-MM and return totals per month in chronological order. */
export function monthlyTotals(ledger) {
	const out = new Map();
	for (const e of ledger.list()) {
		const key = formatDate(e.date).slice(0, 7);
		out.set(key, (out.get(key) || 0) + e.cents);
	}
	return out;
}

export function renderMonthlyReport(ledger) {
	const rows = [...monthlyTotals(ledger)].map(([month, cents]) => [month, formatMoney(cents)]);
	return formatTable(["month", "total"], rows);
}

export function renderCategoryReport(ledger, query) {
	const rows = [...ledger.byCategory(query)].sort((a, b) => b[1] - a[1]).map(([cat, cents]) => [cat, formatMoney(cents)]);
	return formatTable(["category", "total"], rows);
}
