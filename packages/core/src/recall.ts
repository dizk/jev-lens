/**
 * The recall tool's slicing, shared by every host: a stored full output, optionally restricted to a
 * line range or to the lines matching a pattern (with two lines of context), rendered with line numbers.
 */
import { truncate } from "./text.ts";

export interface RecallParams {
	/** Line range like "120-180" (1-based, inclusive). */
	lines?: string;
	/** Case-insensitive substring, or /regex/ with optional flags. */
	pattern?: string;
}

export interface StoredOutput {
	text: string;
	toolName: string;
	args: unknown;
}

export interface RecallSlice {
	text: string;
	/** Lines returned. */
	count: number;
	/** Lines in the stored output. */
	total: number;
	/** Set when the parameters were malformed; `text` then explains what was expected. */
	error?: string;
}

/** Select the requested lines of a stored output. Returns the whole text unchanged when nothing restricts it. */
export function sliceRecall(hit: StoredOutput, params: RecallParams = {}): RecallSlice {
	const all = hit.text.split("\n");
	let idx = all.map((_, i) => i);
	if (params.lines) {
		const m = params.lines.match(/^(\d+)\s*-\s*(\d+)$/);
		if (!m) return { text: "lines must look like 120-180", count: 0, total: all.length, error: "bad-lines" };
		const a = Math.max(1, Number(m[1])), b = Math.min(all.length, Number(m[2]));
		idx = idx.filter((i) => i + 1 >= a && i + 1 <= b);
	}
	if (params.pattern) {
		let test: (l: string) => boolean;
		const rx = params.pattern.match(/^\/(.*)\/([a-z]*)$/);
		if (rx) {
			let re: RegExp;
			try { re = new RegExp(rx[1], rx[2].includes("i") ? rx[2] : rx[2] + "i"); }
			catch { return { text: `pattern is not a valid regular expression: ${params.pattern}`, count: 0, total: all.length, error: "bad-pattern" }; }
			test = (l) => re.test(l);
		} else {
			const needle = params.pattern.toLowerCase();
			test = (l) => l.toLowerCase().includes(needle);
		}
		const keep = new Set<number>();
		for (const i of idx) if (test(all[i])) for (let j = Math.max(0, i - 2); j <= Math.min(all.length - 1, i + 2); j++) keep.add(j);
		idx = idx.filter((i) => keep.has(i));
	}
	if (idx.length === all.length) return { text: hit.text, count: all.length, total: all.length };
	const width = String(all.length).length;
	const body = idx.map((i) => `${String(i + 1).padStart(width)}│ ${all[i]}`).join("\n");
	const header = `[${idx.length} of ${all.length} lines from ${hit.toolName} ${truncate(JSON.stringify(hit.args ?? {}), 80)}]\n`;
	return { text: header + body, count: idx.length, total: all.length };
}

/** What the model gets when it recalls an id nothing was stored for. */
export function recallMissText(id: string): string {
	return `No stored output for id ${id}. Re-run the original tool instead.`;
}

/** The recall tool's description, identical in every host so the model's habits carry over. */
export const RECALL_DESCRIPTION = "Return the full output of an earlier tool call that jev-lens showed in a reduced view. Pass the id from the [jev-lens: ...] note. Optionally restrict to a line range \"a-b\" or to lines matching a pattern (case-insensitive substring or /regex/).";
export const RECALL_PARAM_DESCRIPTIONS = {
	id: "id from the jev-lens note",
	lines: "Line range like 120-180 (1-based, inclusive)",
	pattern: "Only lines matching this substring or /regex/, with 2 lines of context",
};
