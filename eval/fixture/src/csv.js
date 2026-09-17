import { parseAmount, parseDate } from "./parse.js";

/** Split one CSV line, honouring double quotes. */
export function splitCsvLine(line) {
	const out = [];
	let cur = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quoted) {
			if (ch === '"' && line[i + 1] === '"') {
				cur += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else cur += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ",") {
			out.push(cur);
			cur = "";
		} else cur += ch;
	}
	out.push(cur);
	return out;
}

/**
 * Parse CSV text with header date,amount,category,note into ledger entries.
 * Lines that fail to parse are skipped and reported in `errors`.
 */
export function importCsv(text) {
	const lines = text.split(/\r?\n/).filter((l) => l.trim());
	const entries = [];
	const errors = [];
	for (let i = 1; i < lines.length; i++) {
		const [date, amount, category, note] = splitCsvLine(lines[i]);
		const d = parseDate(date);
		const cents = parseAmount(amount);
		if (!d || Number.isNaN(cents) || !category) {
			errors.push({ line: i + 1, text: lines[i] });
			continue;
		}
		entries.push({ date: d, cents, category, note: note || "" });
	}
	return { entries, errors };
}
