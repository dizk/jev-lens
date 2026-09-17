/** Format an amount in cents as a decimal string with two decimals, e.g. 1234 → "12.34". */
export function formatMoney(cents) {
	const value = cents / 100;
	return String(value);
}

/** Render rows (arrays of strings) as an aligned text table. */
export function formatTable(header, rows) {
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
	const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
	return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}
