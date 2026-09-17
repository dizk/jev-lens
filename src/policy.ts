import type { AgentMessage, ToolResultMessage } from "./pi-types.ts";
import type { Config } from "./config.ts";
import type { Bucket, Decision } from "./types.ts";
import { contentText, estimateTokensOfText } from "./text.ts";

export const STUB_PREFIX = "[jev-memory pruned:";

export function stubText(summary: string): string {
	return `${STUB_PREFIX} ${summary}. The output was judged no longer needed; call the tool again if you need it.]`;
}

export function trimText(text: string, headLines: number, tailLines: number): string {
	const lines = text.split("\n");
	if (lines.length <= headLines + tailLines + 2) return text;
	const dropped = lines.length - headLines - tailLines;
	return [
		...lines.slice(0, headLines),
		`[jev-memory trimmed ${dropped} lines here; only the head and tail were judged useful. Call the tool again for the full output.]`,
		...lines.slice(-tailLines),
	].join("\n");
}

/** Deterministic transform of a tool result given a frozen decision. */
export function transformToolResult(message: AgentMessage, decision: Decision, cfg: Config): AgentMessage {
	if (message.role !== "toolResult" || decision.bucket === "keep") return message;
	const original = contentText(message.content);
	const text = decision.bucket === "forget" ? stubText(decision.summary) : trimText(original, cfg.trimHeadLines, cfg.trimTailLines);
	return { ...message, content: [{ type: "text", text }] };
}

export function decideBucket(p: { needed: number; outcomeOnly: number }, cfg: Config): Bucket {
	if (p.needed < cfg.forgetBelow) return "forget";
	if (p.needed < cfg.trimBelow && p.outcomeOnly > cfg.trimAbove) return "trim";
	return "keep";
}

/** Tokens that pending (not yet applied) decisions would remove from this message list. */
export function pendingPrunable(messages: AgentMessage[], ledger: Map<string, Decision>, cfg: Config): number {
	let n = 0;
	for (const m of messages) {
		if (m.role !== "toolResult") continue;
		const d = ledger.get(m.toolCallId);
		if (!d || d.status !== "pending" || d.bucket === "keep") continue;
		const before = estimateTokensOfText(contentText(m.content));
		const after = estimateTokensOfText(contentText((transformToolResult(m, d, cfg) as ToolResultMessage).content));
		n += Math.max(0, before - after);
	}
	return n;
}

/** Decide whether this call should apply pending decisions, given the mode and cache state. */
export function shouldApplyPending(
	mode: Config["mode"],
	cfg: Config,
	coldCache: boolean,
	pendingTokens: number,
	promptTokens: number,
): { apply: boolean; reason: string } {
	if (coldCache) return { apply: true, reason: "cold-cache" };
	if (mode === "rolling") return { apply: true, reason: "rolling" };
	if (mode === "budget" && pendingTokens >= cfg.budgetMinTokens && pendingTokens >= cfg.budgetFraction * promptTokens) {
		return { apply: true, reason: "budget" };
	}
	return { apply: false, reason: mode };
}

export interface ApplyResult {
	messages: AgentMessage[];
	tokensOriginal: number;
	tokensSent: number;
	appliedNow: Decision[];
	frozen: number;
	pendingHeld: number;
}

/**
 * Apply the ledger to the outgoing message list.
 * - Frozen (applied) decisions are always re-applied identically, so the prompt prefix stays stable.
 * - Pending decisions are applied now only if `applyPending` is true; they then freeze.
 * - Messages without a decision pass through untouched. Tool results are never removed,
 *   only rewritten, because every function_call needs a matching output.
 */
export function applyLedger(
	messages: AgentMessage[],
	ledger: Map<string, Decision>,
	cfg: Config,
	applyPending: boolean,
	callIndex: number,
	reason: string,
): ApplyResult {
	const out: AgentMessage[] = [];
	const appliedNow: Decision[] = [];
	let frozen = 0;
	let pendingHeld = 0;
	let tokensOriginal = 0;
	let tokensSent = 0;
	for (const m of messages) {
		if (m.role !== "toolResult") {
			out.push(m);
			continue;
		}
		const before = estimateTokensOfText(contentText(m.content));
		tokensOriginal += before;
		const d = ledger.get(m.toolCallId);
		if (!d || d.bucket === "keep") {
			out.push(m);
			tokensSent += before;
			continue;
		}
		if (d.status === "pending") {
			if (!applyPending) {
				pendingHeld++;
				out.push(m);
				tokensSent += before;
				continue;
			}
			d.status = "applied";
			d.appliedAtCall = callIndex;
			d.appliedReason = reason;
			appliedNow.push(d);
		} else {
			frozen++;
		}
		const t = transformToolResult(m, d, cfg) as ToolResultMessage;
		out.push(t);
		tokensSent += estimateTokensOfText(contentText(t.content));
	}
	return { messages: out, tokensOriginal, tokensSent, appliedNow, frozen, pendingHeld };
}
