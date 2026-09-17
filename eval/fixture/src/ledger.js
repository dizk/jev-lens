import { formatDate } from "./parse.js";

/**
 * In-memory ledger of entries: { date: Date, cents: number, category: string, note: string }.
 * Entries are identified by the tuple (date, cents, category, note); duplicates are rejected.
 */
export class Ledger {
	constructor() {
		this.entries = [];
	}

	add(entry) {
		const key = entryKey(entry);
		for (const existing of this.entries) {
			if (entryKey(existing) === key) return false;
		}
		this.entries.push({ ...entry });
		return true;
	}

	addAll(entries) {
		let added = 0;
		for (const e of entries) if (this.add(e)) added++;
		return added;
	}

	list() {
		return [...this.entries].sort((a, b) => a.date - b.date);
	}

	filter({ from, to, category } = {}) {
		return this.list().filter((e) => {
			if (from && e.date < from) return false;
			if (to && e.date > to) return false;
			if (category && e.category !== category) return false;
			return true;
		});
	}

	total(query) {
		return this.filter(query).reduce((sum, e) => sum + e.cents, 0);
	}

	byCategory(query) {
		const out = new Map();
		for (const e of this.filter(query)) out.set(e.category, (out.get(e.category) || 0) + e.cents);
		return out;
	}

	size() {
		return this.entries.length;
	}
}

export function entryKey(entry) {
	return `${formatDate(entry.date)}|${entry.cents}|${entry.category}|${entry.note || ""}`;
}
