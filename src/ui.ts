/**
 * TUI integration: what the model got versus what the tool really returned.
 *
 * - Built-in tools (read, bash, grep, find, ls) are re-registered with renderers that show, for
 *   a compressed result, a one-line savings header and (expanded) the exact text the model saw.
 * - `/jev-lens diff [n]` opens an overlay with the original output, omitted lines marked, and
 *   `t` toggles to the sent view.
 */
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

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
		(r.recalls ? theme.fg("warning", ` · recalled ${r.recalls}×`) : "") +
		theme.fg("dim", " · /jev-lens diff")
	);
}

function describeArgs(toolName: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	if (typeof a.path === "string") return a.path;
	if (typeof a.command === "string") return a.command.replace(/\s+/g, " ").slice(0, 80);
	if (typeof a.pattern === "string") return a.pattern;
	return JSON.stringify(a).slice(0, 80);
}

/**
 * Overlay showing the original output with omitted lines marked (mode "annotated"), or exactly
 * what was sent (mode "sent"). Keys: ↑/↓ scroll, PgUp/PgDn, Home/End, t toggle, Esc/q close.
 */
export class DiffOverlay {
	private offset = 0;
	private mode: "annotated" | "sent" = "annotated";
	private cache?: { width: number; lines: string[] };
	constructor(
		private record: CompressedRecord,
		private theme: ThemeLike,
		private height: number,
		private onClose: () => void,
		private onChange?: () => void,
	) {}

	private bodyLines(width: number): string[] {
		const r = this.record;
		const out: string[] = [];
		if (this.mode === "sent") {
			for (const l of r.sent.split("\n")) out.push(truncateToWidth(l, width));
			return out;
		}
		const inc = new Set(r.included);
		const lines = r.full.split("\n");
		const w = String(lines.length).length;
		for (let i = 0; i < lines.length; i++) {
			const n = String(i + 1).padStart(w);
			if (inc.has(i + 1)) out.push(truncateToWidth(this.theme.fg("dim", `${n} `) + this.theme.fg("text", "│ ") + lines[i], width));
			else out.push(truncateToWidth(this.theme.fg("toolDiffRemoved", `${n} − ${lines[i]}`), width));
		}
		return out;
	}

	header(width: number): string[] {
		const r = this.record;
		const pct = r.tokensBefore ? Math.round((100 * (r.tokensBefore - r.tokensAfter)) / r.tokensBefore) : 0;
		const omitted = r.full.split("\n").length - r.included.length;
		return [
			truncateToWidth(this.theme.fg("accent", this.theme.bold(`jev-lens · ${r.toolName} ${describeArgs(r.toolName, r.args)}`)), width),
			truncateToWidth(this.theme.fg("muted", `${r.kind} → ${r.view} · ${r.tokensAfter} of ${r.tokensBefore} tokens (−${pct} %) · ${omitted} of ${r.full.split("\n").length} lines omitted` + (r.needsFull !== undefined ? ` · P(needs full)=${r.needsFull.toFixed(2)} P(full)=${(r.pFull ?? 0).toFixed(2)}` : "") + (r.recalls ? ` · recalled ${r.recalls}×` : "")), width),
			truncateToWidth(this.theme.fg("dim", this.mode === "annotated" ? "original output; − marks lines the model did not get · t: show what was sent · ↑↓ PgUp PgDn · Esc" : "exactly what the model got · t: show original with omissions · ↑↓ PgUp PgDn · Esc"), width),
			"",
		];
	}

	render(width: number): string[] {
		if (this.cache && this.cache.width === width) return this.cache.lines;
		const head = this.header(width);
		const body = this.bodyLines(width);
		const room = Math.max(3, this.height - head.length - 1);
		const maxOffset = Math.max(0, body.length - room);
		if (this.offset > maxOffset) this.offset = maxOffset;
		const slice = body.slice(this.offset, this.offset + room);
		const footer = truncateToWidth(this.theme.fg("dim", `lines ${body.length ? this.offset + 1 : 0}-${Math.min(body.length, this.offset + room)} of ${body.length}`), width);
		this.cache = { width, lines: [...head, ...slice, footer] };
		return this.cache.lines;
	}

	handleInput(data: string): void {
		const page = Math.max(1, this.height - 6);
		if (matchesKey(data, "escape") || data === "q") { this.onClose(); return; }
		else if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
		else if (matchesKey(data, "down")) this.offset += 1;
		else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - page);
		else if (matchesKey(data, "pageDown")) this.offset += page;
		else if (matchesKey(data, "home")) this.offset = 0;
		else if (matchesKey(data, "end")) this.offset = Number.MAX_SAFE_INTEGER;
		else if (data === "t") { this.mode = this.mode === "annotated" ? "sent" : "annotated"; this.offset = 0; }
		else return;
		this.invalidate();
		this.onChange?.();
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

/** One row per compressed result, newest last. */
export function listLines(records: CompressedRecord[], theme: ThemeLike): string[] {
	if (records.length === 0) return [theme.fg("muted", "no compressed tool results in this session yet")];
	return records.map((r, i) => {
		const pct = r.tokensBefore ? Math.round((100 * (r.tokensBefore - r.tokensAfter)) / r.tokensBefore) : 0;
		return `${String(records.length - i).padStart(3)}  ${r.view.padEnd(9)} ${String(r.tokensBefore).padStart(6)}→${String(r.tokensAfter).padEnd(6)} −${String(pct).padStart(3)} %  ${r.recalls ? `recalled ${r.recalls}× ` : ""}${r.toolName} ${describeArgs(r.toolName, r.args)}`;
	});
}
