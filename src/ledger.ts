import type { Decision } from "./types.ts";

export const ENTRY_TYPE = "jev-context";

export interface LedgerEntryData {
	kind: "decision";
	decision: Decision;
}

/** Rebuild the decision map from persisted custom entries (survives resume, reload, fork). */
export function rebuildLedger(entries: Iterable<unknown>): Map<string, Decision> {
	const ledger = new Map<string, Decision>();
	for (const e of entries) {
		const entry = e as { type?: string; customType?: string; data?: LedgerEntryData };
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !entry.data) continue;
		if (entry.data.kind === "decision") {
			const d = entry.data.decision;
			const prev = ledger.get(d.id);
			// Later entries win; an applied entry never regresses to pending.
			if (prev?.status === "applied" && d.status === "pending") continue;
			ledger.set(d.id, { ...d });
		}
	}
	return ledger;
}
