/**
 * Parse a date given as YYYY-MM-DD, DD.MM.YYYY or MM/DD/YYYY into a UTC Date.
 * Returns null for unparseable input.
 */
export function parseDate(input) {
	if (typeof input !== "string") return null;
	const s = input.trim();
	let y, m, d;
	let match;
	if ((match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
		[y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
	} else if ((match = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/))) {
		[d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
	} else if ((match = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
		[m, d, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
	} else {
		return null;
	}
	if (m < 1 || m > 12 || d < 1 || d > 31) return null;
	// Month is zero-based in the Date constructor.
	const date = new Date(Date.UTC(y, m, d));
	if (date.getUTCDate() !== d) return null;
	return date;
}

/**
 * Parse an amount such as "12.50", "1,234.50", "-3" or "€ 4,00" (European decimal comma
 * when there is exactly one comma and no dot) into a number of cents (integer).
 */
export function parseAmount(input) {
	if (typeof input === "number") return Math.round(input * 100);
	if (typeof input !== "string") return NaN;
	let s = input.replace(/[^\d.,-]/g, "");
	if (!s) return NaN;
	const commas = (s.match(/,/g) || []).length;
	const dots = (s.match(/\./g) || []).length;
	if (commas === 1 && dots === 0) s = s.replace(",", ".");
	else s = s.replace(/,/g, "");
	const n = Number(s);
	if (!Number.isFinite(n)) return NaN;
	return Math.round(n * 100);
}

export function formatDate(date) {
	const y = date.getUTCFullYear();
	const m = String(date.getUTCMonth() + 1).padStart(2, "0");
	const d = String(date.getUTCDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}
