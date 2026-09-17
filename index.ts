/**
 * pi-jev-memory: cache-aware memory routing for pi.
 *
 * Every tool result is classified once by jev (TypeSafe System One) after the agent has
 * seen it and acted on it. The decision (keep / trim / forget, plus durable yes/no) is
 * persisted and, once applied to an outgoing prompt, never changes again, so the prompt
 * prefix stays byte-identical across calls and the provider cache keeps hitting.
 *
 * Buckets:
 *   context (keep)  – sent verbatim
 *   trim            – head + tail only
 *   forget          – replaced by a one-line stub (tool results are never removed:
 *                     every function_call needs a matching output)
 *   file (durable)  – appended to <project>/.pi/jev-memory.md, loaded at session start
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "./src/pi-types.ts";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { buildItemState, JevClassifier, MockClassifier, type Classifier } from "./src/classifier.ts";
import { buildPresendState, decideView, expandRelevantBlocks, JevPresend, MockPresend, type PresendClassifier } from "./src/presend.ts";
import { buildCandidates, extractTerms, footer } from "./src/views.ts";
import { loadConfig, type Config } from "./src/config.ts";
import { ENTRY_TYPE, rebuildLedger } from "./src/ledger.ts";
import { appendNotes, memoryPromptSection, readMemoryFile } from "./src/memory-file.ts";
import { applyLedger, decideBucket, pendingPrunable, shouldApplyPending } from "./src/policy.ts";
import { contentText, describeToolCall, estimateTokensOfText, toolCallsOf, truncate } from "./src/text.ts";
import type { CallStats, Decision, DurableNote } from "./src/types.ts";

interface PendingResult {
	message: AgentMessage & { role: "toolResult" };
	args: unknown;
}

export default function (pi: ExtensionAPI) {
	const cfg: Config = loadConfig();
	const usingMock = cfg.forceMock || !cfg.apiKey;
	const classifier: Classifier = usingMock ? new MockClassifier() : new JevClassifier(cfg);
	const presend: PresendClassifier = usingMock ? new MockPresend() : new JevPresend(new TypeSafeClient({ apiKey: cfg.apiKey }), cfg.model);
	/** Full text of compressed tool results, by toolCallId, for the recall tool (also persisted in result details). */
	const fullOutputs = new Map<string, { text: string; toolName: string; args: unknown; view: string }>();
	let lastAssistantText = "";
	let presendTotals = { considered: 0, compressed: 0, tokensSaved: 0, recalls: 0 };

	let ledger = new Map<string, Decision>();
	/** Classifications launched but not yet resolved, keyed by toolCallId. */
	const inflight = new Map<string, Promise<void>>();
	/** Tool results from the previous assistant turn, waiting for "what happened next". */
	let buffer: PendingResult[] = [];
	/** Tool call arguments by id, so results can be described. */
	const argsById = new Map<string, unknown>();
	let callIndex = 0;
	let lastCallAt = 0;
	let memorySnapshot = "";
	let memoryPath = "";
	let logPath = "";
	let totals = { pruned: 0, applied: 0, notes: 0, calls: 0, cacheRead: 0, input: 0 };
	let durableQueue: DurableNote[] = [];
	let firstUser = "";
	let latestUser = "";

	const log = (record: Record<string, unknown>) => {
		if (!cfg.logFile || !logPath) return;
		try {
			appendFileSync(logPath, `${JSON.stringify({ t: Date.now(), ...record })}\n`);
		} catch {}
	};

	const status = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const tag = usingMock ? "jev-memory(mock)" : "jev-memory";
		ctx.ui.setStatus("jev-memory", `${tag} presend −${(presendTotals.tokensSaved / 1000).toFixed(1)}k (${presendTotals.compressed}/${presendTotals.considered}, ${presendTotals.recalls} recalls), pruned −${(totals.pruned / 1000).toFixed(1)}k (${totals.applied}), ${totals.notes} notes`);
	};

	const persist = (d: Decision) => pi.appendEntry(ENTRY_TYPE, { kind: "decision", decision: { ...d } });

	// ---- session lifecycle -------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		ledger = rebuildLedger(ctx.sessionManager.getEntries());
		buffer = [];
		inflight.clear();
		argsById.clear();
		callIndex = 0;
		lastCallAt = 0;
		totals = { pruned: 0, applied: 0, notes: 0, calls: 0, cacheRead: 0, input: 0 };
		firstUser = "";
		latestUser = "";
		fullOutputs.clear();
		presendTotals = { considered: 0, compressed: 0, tokensSaved: 0, recalls: 0 };
		memoryPath = join(ctx.cwd, CONFIG_DIR_NAME, "jev-memory.md");
		memorySnapshot = readMemoryFile(memoryPath);
		try {
			mkdirSync(join(ctx.cwd, CONFIG_DIR_NAME), { recursive: true });
			logPath = join(ctx.cwd, CONFIG_DIR_NAME, "jev-memory.log");
		} catch {
			logPath = "";
		}
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			if (entry.message.role === "user") {
				const t = contentText(entry.message.content);
				if (!firstUser) firstUser = t;
				latestUser = t;
			} else if (entry.message.role === "toolResult") {
				const d = (entry.message as { details?: { jevMemory?: { full?: string; view?: string; args?: unknown } } }).details?.jevMemory;
				if (d?.full) fullOutputs.set(entry.message.toolCallId, { text: d.full, toolName: entry.message.toolName, args: d.args, view: d.view ?? "?" });
			}
		}
		log({ event: "session_start", mode: cfg.mode, enabled: cfg.enabled, mock: usingMock, ledger: ledger.size });
		if (ctx.hasUI && usingMock) ctx.ui.notify("jev-memory: TYPESAFE_API_KEY not set, using mock classifier", "warning");
		status(ctx);
	});

	pi.on("session_shutdown", async () => {
		flushDurable();
	});

	// ---- memory file → system prompt (snapshot taken at session start, stable within the session)

	pi.on("before_agent_start", async (event) => {
		if (!firstUser) firstUser = event.prompt;
		latestUser = event.prompt;
		const section = memoryPromptSection(memorySnapshot);
		if (!section) return;
		return { systemPrompt: event.systemPrompt + section };
	});

	// ---- classification ------------------------------------------------------------------

	pi.on("message_end", async (event, ctx) => {
		const m = event.message;
		if (m.role === "user") {
			const text = contentText(m.content);
			if (!firstUser) firstUser = text;
			latestUser = text;
			queueText("user", text, ctx);
			return;
		}
		if (m.role === "toolResult") {
			return;
		}
		if (m.role !== "assistant" || m.stopReason === "error" || m.stopReason === "aborted") return;
		// The assistant has now reacted to the previous turn's tool results: classify them.
		const afterText = contentText(m.content);
		lastAssistantText = afterText;
		const afterCalls = toolCallsOf(m);
		for (const c of m.content) if (c.type === "toolCall") argsById.set(c.id, c.arguments);
		const toClassify = buffer;
		buffer = [];
		for (const item of toClassify) launchClassification(item, afterText, afterCalls, ctx);
		if (afterText.trim()) queueText("agent", afterText, ctx);
	});

	pi.on("tool_execution_end", async (event) => {
		// Collect the result message from the session once it lands; turn_end has the full list.
		void event;
	});

	pi.on("turn_end", async (event) => {
		for (const r of event.toolResults) {
			buffer.push({ message: r as PendingResult["message"], args: argsById.get(r.toolCallId) });
		}
	});

	pi.on("agent_end", async () => {
		// No further assistant reaction is coming for the last results; classify with what we have.
		const toClassify = buffer;
		buffer = [];
		for (const item of toClassify) launchClassification(item, "", [], undefined);
		flushDurable();
	});

	function launchClassification(item: PendingResult, afterText: string, afterCalls: { name: string; arguments: unknown }[], ctx?: ExtensionContext) {
		const m = item.message;
		if (ledger.has(m.toolCallId) || inflight.has(m.toolCallId)) return;
		const output = contentText(m.content);
		const tokens = estimateTokensOfText(output);
		if (tokens < cfg.minTokens) return;
		const state = buildItemState(cfg, {
			firstUser,
			latestUser,
			toolName: m.toolName,
			args: item.args,
			isError: m.isError,
			output,
			afterText,
			afterCalls,
		});
		const lines = output.split("\n").length;
		const summary = describeToolCall(m.toolName, item.args, output.length, lines);
		const started = Date.now();
		const p = classifier
			.classifyToolResult(state, ctx?.signal)
			.then((probs) => {
				const decision: Decision = {
					id: m.toolCallId,
					toolName: m.toolName,
					bucket: cfg.enabled ? decideBucket(probs, cfg) : "keep",
					durable: probs.durable > cfg.durableAbove,
					p: probs,
					summary,
					tokensBefore: tokens,
					decidedAt: Date.now(),
					status: "pending",
				};
				ledger.set(decision.id, decision);
				persist(decision);
				log({ event: "decision", id: decision.id, tool: m.toolName, bucket: decision.bucket, p: probs, tokens, ms: Date.now() - started, summary });
				// Tool output is rarely a durable fact by itself; only keep a pointer, and only when jev is very sure.
				if (probs.durable > Math.max(cfg.durableAbove, 0.85)) durableQueue.push({ source: "tool", text: `${summary}${m.isError ? " failed" : " succeeded"}`, p: probs.durable, at: Date.now() });
			})
			.catch((err) => {
				log({ event: "classify_error", id: m.toolCallId, error: String(err?.message ?? err) });
			})
			.finally(() => inflight.delete(m.toolCallId));
		inflight.set(m.toolCallId, p);
	}

	function queueText(role: "user" | "agent", text: string, ctx?: ExtensionContext) {
		if (usingMock || text.length < 40 || text.length > 6000) return;
		classifier
			.classifyText({ task: { first_user_request: truncate(firstUser, 600) }, message: truncate(text, 3000), role }, ctx?.signal)
			.then((p) => {
				log({ event: "text", role, p, chars: text.length });
				if (p > cfg.durableAbove) durableQueue.push({ source: role, text: truncate(text, 400), p, at: Date.now() });
			})
			.catch((err) => log({ event: "classify_error", role, error: String(err?.message ?? err) }));
	}

	function flushDurable() {
		if (durableQueue.length === 0 || !memoryPath) return;
		const notes = durableQueue;
		durableQueue = [];
		try {
			const added = appendNotes(memoryPath, notes);
			totals.notes += added;
			log({ event: "memory_file", added, path: memoryPath });
		} catch (err) {
			log({ event: "memory_file_error", error: String((err as Error)?.message ?? err) });
		}
	}

	// ---- the cache-aware cut: right before each LLM call --------------------------------

	pi.on("context", async (event, ctx) => {
		callIndex++;
		const now = Date.now();
		const coldCache = lastCallAt > 0 && now - lastCallAt > cfg.cacheTtlMs;
		lastCallAt = now;

		// Give in-flight classifications a bounded chance to land, so decisions apply at the
		// earliest call and freeze there instead of shifting the prefix one call later.
		if (inflight.size > 0) {
			await Promise.race([Promise.allSettled([...inflight.values()]), new Promise((r) => setTimeout(r, cfg.classifyWaitMs))]);
		}

		const pending = pendingPrunable(event.messages, ledger, cfg);
		const { apply: applyPending, reason } = shouldApplyPending(cfg.mode, cfg, coldCache, pending);
		const result = applyLedger(event.messages, ledger, cfg, applyPending, callIndex, reason);
		for (const d of result.appliedNow) persist(d);
		totals.applied += result.appliedNow.length;
		totals.pruned = 0;
		for (const d of ledger.values()) if (d.status === "applied") totals.pruned += d.tokensBefore;
		totals.calls++;

		const stats: CallStats = {
			call: callIndex,
			at: now,
			messages: event.messages.length,
			tokensOriginal: result.tokensOriginal,
			tokensSent: result.tokensSent,
			tokensPruned: result.tokensOriginal - result.tokensSent,
			appliedNow: result.appliedNow.length,
			frozen: result.frozen,
			pendingHeld: result.pendingHeld,
			coldCache,
		};
		log({ event: "context", ...stats, reason, pendingTokens: pending.tokens, tailTokens: pending.tailTokens, inflight: inflight.size });
		status(ctx);
		return { messages: result.messages };
	});

	// Cache accounting from the provider's own usage numbers.
	pi.on("message_end", async (event) => {
		const m = event.message;
		if (m.role !== "assistant") return;
		totals.cacheRead += m.usage?.cacheRead ?? 0;
		totals.input += m.usage?.input ?? 0;
		log({ event: "usage", call: callIndex, input: m.usage?.input, cacheRead: m.usage?.cacheRead, output: m.usage?.output, model: m.model });
	});

	// Compaction is a full prefix rewrite anyway: apply everything pending first.
	pi.on("session_before_compact", async () => {
		for (const d of ledger.values()) {
			if (d.status === "pending") {
				d.status = "applied";
				d.appliedAtCall = callIndex;
				d.appliedReason = "compaction";
				persist(d);
			}
		}
		flushDurable();
	});

	// ---- pre-send compression: pick a view of a large tool result before it is ever sent ----

	pi.on("tool_result", async (event, ctx) => {
		if (!cfg.presend || !cfg.enabled) return;
		if (event.toolName === "recall") return;
		const text = contentText(event.content);
		const tokens = estimateTokensOfText(text);
		if (tokens < cfg.presendMinTokens) return;
		if (event.content.some((c) => c.type === "image")) return;
		presendTotals.considered++;
		const started = Date.now();
		const terms = extractTerms(latestUser, lastAssistantText, JSON.stringify(event.input ?? {}));
		const cands = buildCandidates(event.toolName, event.input, text, terms);
		if (cands.views.length < 2) {
			log({ event: "presend", id: event.toolCallId, tool: event.toolName, tokens, view: "full", reason: "no-candidates" });
			return;
		}
		const totalLines = text.split("\n").length;
		const state = buildPresendState(cfg, { firstUser, latestUser, agentText: lastAssistantText, toolName: event.toolName, args: event.input, isError: event.isError, cands, totalLines, totalChars: text.length });
		try {
			const answer = await presend.choose(state, cands.views.map((v) => v.kind), ctx.signal);
			let view = decideView(answer, cands, cfg);
			let expanded: number[] | undefined;
			if (view.kind !== "full") {
				const ex = await expandRelevantBlocks(presend, state, text, cands, view, cfg.presendExpandAbove, ctx.signal);
				if (ex) { view = ex.view; expanded = ex.probs.map((p, i) => (p > cfg.presendExpandAbove ? i : -1)).filter((i) => i >= 0); }
			}
			log({ event: "presend", id: event.toolCallId, tool: event.toolName, kind: cands.kind, tokens, view: view.kind, viewTokens: estimateTokensOfText(view.text), chosen: answer.choice, needsFull: answer.needsFull, p: answer.probabilities, confidence: answer.confidence, expanded, candidates: cands.views.map((v) => `${v.kind}:${v.chars}`), ms: Date.now() - started });
			if (view.kind === "full") return;
			presendTotals.compressed++;
			presendTotals.tokensSaved += tokens - estimateTokensOfText(view.text);
			fullOutputs.set(event.toolCallId, { text, toolName: event.toolName, args: event.input, view: view.kind });
			const details = { ...((event.details as object) ?? {}), jevMemory: { full: text, view: view.kind, args: event.input, p: answer.probabilities, needsFull: answer.needsFull } };
			status(ctx);
			return { content: [{ type: "text", text: view.text + footer(view, event.toolCallId, totalLines) }], details };
		} catch (err) {
			log({ event: "presend_error", id: event.toolCallId, error: String((err as Error)?.message ?? err) });
			return;
		}
	});

	pi.registerTool({
		name: "recall",
		label: "Recall",
		description: "Return the full output of an earlier tool call that jev-memory showed in a reduced view (or that was pruned). Pass the id from the [jev-memory: ...] note. Optionally restrict to a line range \"a-b\" or to lines matching a pattern (case-insensitive substring or /regex/).",
		parameters: Type.Object({
			id: Type.String({ description: "toolCallId from the jev-memory note" }),
			lines: Type.Optional(Type.String({ description: "Line range like 120-180 (1-based, inclusive)" })),
			pattern: Type.Optional(Type.String({ description: "Only lines matching this substring or /regex/, with 2 lines of context" })),
		}),
		async execute(_toolCallId, params) {
			presendTotals.recalls++;
			const hit = fullOutputs.get(params.id);
			log({ event: "recall", id: params.id, found: !!hit, lines: params.lines, pattern: params.pattern });
			if (!hit) return { content: [{ type: "text", text: `No stored output for id ${params.id}. Re-run the original tool instead.` }], details: { id: params.id, lines: 0 } };
			const all = hit.text.split("\n");
			let idx = all.map((_, i) => i);
			if (params.lines) {
				const m = params.lines.match(/^(\d+)\s*-\s*(\d+)$/);
				if (!m) return { content: [{ type: "text", text: "lines must look like 120-180" }], details: { id: params.id, lines: 0 } };
				const a = Math.max(1, Number(m[1])), b = Math.min(all.length, Number(m[2]));
				idx = idx.filter((i) => i + 1 >= a && i + 1 <= b);
			}
			if (params.pattern) {
				let test: (l: string) => boolean;
				const rx = params.pattern.match(/^\/(.*)\/([a-z]*)$/);
				if (rx) { const re = new RegExp(rx[1], rx[2].includes("i") ? rx[2] : rx[2] + "i"); test = (l) => re.test(l); }
				else { const needle = params.pattern.toLowerCase(); test = (l) => l.toLowerCase().includes(needle); }
				const keep = new Set<number>();
				for (const i of idx) if (test(all[i])) for (let j = Math.max(0, i - 2); j <= Math.min(all.length - 1, i + 2); j++) keep.add(j);
				idx = idx.filter((i) => keep.has(i));
			}
			const width = String(all.length).length;
			const body = idx.length === all.length ? hit.text : idx.map((i) => `${String(i + 1).padStart(width)}│ ${all[i]}`).join("\n");
			const header = idx.length === all.length ? "" : `[${idx.length} of ${all.length} lines from ${hit.toolName} ${truncate(JSON.stringify(hit.args ?? {}), 80)}]\n`;
			return { content: [{ type: "text", text: header + body }], details: { id: params.id, lines: idx.length } };
		},
	});

	// ---- commands ----------------------------------------------------------------------

	pi.registerCommand("jev-memory", {
		description: "Show jev-memory stats, decisions, or the memory file (/jev-memory [decisions|file])",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim();
			if (sub === "file") {
				const text = readMemoryFile(memoryPath) || "(memory file is empty)";
				ctx.ui.notify(text, "info");
				return;
			}
			if (sub === "decisions") {
				const rows = [...ledger.values()].map((d) => `${d.status === "applied" ? "●" : "○"} ${d.bucket.padEnd(6)} n=${d.p.needed.toFixed(2)} o=${d.p.outcomeOnly.toFixed(2)} d=${d.p.durable.toFixed(2)} ${d.tokensBefore}t ${d.summary}`);
				ctx.ui.notify(rows.join("\n") || "(no decisions yet)", "info");
				return;
			}
			const hit = totals.input + totals.cacheRead > 0 ? Math.round((100 * totals.cacheRead) / (totals.input + totals.cacheRead)) : 0;
			ctx.ui.notify(
				[
					`mode=${cfg.mode} enabled=${cfg.enabled} classifier=${usingMock ? "mock" : cfg.model}`,
					`presend: ${presendTotals.compressed}/${presendTotals.considered} large results compressed, ≈${presendTotals.tokensSaved} tokens saved, ${presendTotals.recalls} recalls`,
					`post-send: calls=${totals.calls} decisions=${ledger.size} applied=${totals.applied} pruned≈${totals.pruned} tokens`,
					`cache: read=${totals.cacheRead} uncached=${totals.input} hit=${hit}%`,
					`memory file: ${memoryPath} (+${totals.notes} notes this session)`,
				].join("\n"),
				"info",
			);
		},
	});
}
