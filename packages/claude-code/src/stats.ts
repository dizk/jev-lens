/** A plain-text summary of the log for the `stats` MCP tool and the /jev-lens:stats command. */
import { readLog } from "./store.ts";

export function statsText(records = readLog(), now = Date.now(), sessionLimit = 10): string {
	const presend = records.filter((r) => r.event === "presend");
	const recalls = records.filter((r) => r.event === "recall");
	const errors = records.filter((r) => r.event === "presend_error");
	if (!presend.length && !errors.length) return "jev-lens has not seen a large tool result yet. It compresses Read, Bash and Grep results of about 1200 tokens or more.";
	const num = (v: unknown) => (typeof v === "number" ? v : 0);
	const compressed = presend.filter((r) => r.view !== "full");
	const saved = compressed.reduce((s, r) => s + num(r.tokens) - num(r.sentTokens), 0);
	const total = presend.reduce((s, r) => s + num(r.tokens), 0);
	const byKind = new Map<string, { n: number; c: number; saved: number }>();
	for (const r of presend) {
		const k = String(r.kind ?? "?");
		const e = byKind.get(k) ?? { n: 0, c: 0, saved: 0 };
		e.n++;
		if (r.view !== "full") { e.c++; e.saved += num(r.tokens) - num(r.sentTokens); }
		byKind.set(k, e);
	}
	const sessions = [...new Set(presend.map((r) => String(r.session ?? "")))].length;
	const mock = presend.some((r) => r.mock === true);
	const lines = [
		`jev-lens: ${compressed.length} of ${presend.length} large results compressed across ${sessions} session${sessions === 1 ? "" : "s"}, ≈${saved} of ${total} tokens kept out of the prompt (${total ? Math.round((100 * saved) / total) : 0} %), ${recalls.length} recall${recalls.length === 1 ? "" : "s"}, ${errors.length} error${errors.length === 1 ? "" : "s"}.`,
	];
	if (mock) lines.push("Some decisions came from the mock classifier (no TypeSafe API key), which follows fixed rules instead of judging each result.");
	lines.push("", "by kind:");
	for (const [k, e] of byKind) lines.push(`  ${k.padEnd(8)} ${String(e.c).padStart(4)}/${String(e.n).padEnd(4)} compressed, ≈${e.saved} tokens saved`);
	const recent = presend.slice(-sessionLimit).reverse();
	lines.push("", `last ${recent.length}:`);
	for (const r of recent) {
		const ago = Math.round((now - num(r.t)) / 60000);
		lines.push(`  ${String(r.tool ?? "?").padEnd(5)} ${String(r.kind ?? "?").padEnd(8)} ${String(r.view ?? "full").padEnd(9)} ${String(num(r.tokens)).padStart(6)} → ${String(num(r.sentTokens)).padStart(6)} tokens  ${ago} min ago  id ${String(r.id ?? "")}`);
	}
	return lines.join("\n");
}
