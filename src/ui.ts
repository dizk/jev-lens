/**
 * TUI integration: what the model got versus what the tool really returned.
 *
 * - Built-in tools (read, bash, grep, find, ls) are re-registered with renderers that show, for
 *   a compressed result, a savings header and an inline comparison when expanded.
 */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Everything needed to show one compressed result. Stored per session and in the tool result details. */
export interface CompressedRecord {
	id: string;
	toolName: string;
	args: unknown;
	kind: string;
	view: string;
	tokensBefore: number;
	tokensAfter: number;
	full: string;
	sent: string;
	/** 1-based original line numbers present in the view. */
	included: number[];
	needsFull?: number;
	pFull?: number;
	recalls: number;
	at: number;
}

/** Minimal theme surface used here, so the module is testable without pi's Theme class. */
export interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export function savingsLine(r: CompressedRecord, theme: ThemeLike): string {
	const pct = r.tokensBefore ? Math.round((100 * (r.tokensBefore - r.tokensAfter)) / r.tokensBefore) : 0;
	return (
		theme.fg("accent", "⌁ jev-lens ") +
		theme.fg("toolTitle", theme.bold(r.view)) +
		theme.fg("muted", ` · ${r.tokensAfter} of ${r.tokensBefore} tokens (−${pct} %)`) +
		(r.recalls ? theme.fg("warning", ` · recalled ${r.recalls}×`) : "")
	);
}

export function comparisonHint(r: CompressedRecord, key: string): string {
	const original = r.full.split("\n").length;
	const pruned = original - new Set(r.included).size;
	return `… (${pruned} ${pruned === 1 ? "line" : "lines"} pruned, ${original} original, ${key} for diff)`;
}

function describeArgs(toolName: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	if (typeof a.path === "string") return a.path;
	if (typeof a.command === "string") return a.command.replace(/\s+/g, " ").slice(0, 80);
	if (typeof a.pattern === "string") return a.pattern;
	return JSON.stringify(a).slice(0, 80);
}

/** Inline comparison. Pi owns expansion and transcript scrolling; no extra key handler. */
export class ComparisonResult {
	private cache?: { width: number; lines: string[] };
	constructor(private record: CompressedRecord, private theme: ThemeLike, private hint: string) {}

	render(width: number): string[] {
		if (width < 1) return [];
		if (this.cache?.width === width) return this.cache.lines;
		const r = this.record;
		const full = r.full.split("\n");
		const included = new Set(r.included);
		const digits = String(full.length).length;
		const original = (i: number) => this.theme.fg(included.has(i + 1) ? "text" : "toolDiffRemoved",
			`${String(i + 1).padStart(digits)} ${included.has(i + 1) ? "│" : "−"} ${full[i]}`);
		const wrap = (text: string, columns: number) => wrapTextWithAnsi(text.replace(/\t/g, "    "), columns)
			.map((line) => truncateToWidth(line, columns));
		const out = wrap(savingsLine(r, this.theme), width);
		out.push(...wrap(this.theme.fg("dim", this.hint), width));
		out.push(...wrap(this.theme.fg("dim", "− omitted from model input · compressed view excludes the recall footer"), width));
		if (width < 100) {
			out.push(...wrap(this.theme.bold("Full output"), width));
			for (let i = 0; i < full.length; i++) out.push(...wrap(original(i), width));
			out.push("", ...wrap(this.theme.bold("Compressed output"), width));
			for (const line of r.sent.split("\n")) out.push(...wrap(line, width));
		} else {
			const leftWidth = Math.floor((width - 3) / 2);
			const rightWidth = width - leftWidth - 3;
			const row = (left: string, right: string) => {
				const a = wrap(left, leftWidth), b = wrap(right, rightWidth);
				for (let i = 0; i < Math.max(a.length, b.length); i++) {
					const l = a[i] ?? "";
					out.push(l + " ".repeat(Math.max(0, leftWidth - visibleWidth(l))) + this.theme.fg("dim", " │ ") + (b[i] ?? ""));
				}
			};
			row(this.theme.bold("Full output"), this.theme.bold("Compressed output"));
			let cursor = 0;
			// Align numbered view lines with their originals. Keep markers and any other
			// generated view text verbatim on separate rows, rather than reconstructing it.
			for (const line of r.sent.split("\n")) {
				const match = /^\s*(\d+)│ /.exec(line);
				const n = match ? Number(match[1]) : 0;
				if (n > cursor && n <= full.length && included.has(n)) {
					while (cursor < n - 1) row(original(cursor++), "");
					row(original(cursor++), line);
				} else row("", line);
			}
			while (cursor < full.length) row(original(cursor++), "");
		}
		this.cache = { width, lines: out };
		return out;
	}

	invalidate(): void { this.cache = undefined; }
}

/** One row per compressed result, newest last. */
export function listLines(records: CompressedRecord[], theme: ThemeLike): string[] {
	if (records.length === 0) return [theme.fg("muted", "no compressed tool results in this session yet")];
	return records.map((r, i) => {
		const pct = r.tokensBefore ? Math.round((100 * (r.tokensBefore - r.tokensAfter)) / r.tokensBefore) : 0;
		return `${String(records.length - i).padStart(3)}  ${r.view.padEnd(9)} ${String(r.tokensBefore).padStart(6)}→${String(r.tokensAfter).padEnd(6)} −${String(pct).padStart(3)} %  ${r.recalls ? `recalled ${r.recalls}× ` : ""}${r.toolName} ${describeArgs(r.toolName, r.args)}`;
	});
}
