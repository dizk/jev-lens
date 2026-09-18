/**
 * pi-jev-lens: jev picks what the model gets to see of large tool results.
 *
 * Pre-send: before a large tool result is stored or sent, code builds candidate views (strict
 * subsets of the output with line numbers), jev (TypeSafe System One) chooses one and, for code
 * and sectioned command output, which blocks to put back. The full text stays in the result's
 * details and the `recall` tool serves it on request.
 *
 * Post-send (off by default, JEV_LENS_MODE=rolling|batch|budget): tool results the agent has
 * already acted on are classified once and trimmed or stubbed behind a frozen, cache-aware ledger.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "./src/pi-types.ts";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createBashToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { DiffOverlay, listLines, savingsLine, type CompressedRecord } from "./src/ui.ts";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { buildItemState, JevClassifier, MockClassifier, type Classifier } from "./src/classifier.ts";
import { buildPresendState, decideView, DEFAULT_PROMPTS, expandRelevantBlocks, JevPresend, MockPresend, type PresendClassifier, type PromptVariant } from "./src/presend.ts";
import { buildCandidatesAsync, extractTerms, footer } from "./src/views.ts";
import { keyFilePath, loadConfigWithVariant, storeKey, type Config } from "./src/config.ts";
import { Health } from "./src/health.ts";
import { SecretInput } from "./src/secret-input.ts";
import { commandCompletions, commandHelp } from "./src/commands.ts";
import { ENTRY_TYPE, rebuildLedger } from "./src/ledger.ts";
import { applyLedger, decideBucket, pendingPrunable, shouldApplyPending } from "./src/policy.ts";
import { contentText, describeToolCall, estimateTokensOfText, toolCallsOf, truncate } from "./src/text.ts";
import type { CallStats, Decision } from "./src/types.ts";

interface PendingResult {
	message: AgentMessage & { role: "toolResult" };
	args: unknown;
}

export default function (pi: ExtensionAPI) {
	const { cfg, variant } = loadConfigWithVariant();
	const prompts: PromptVariant = { ...DEFAULT_PROMPTS, ...((variant.prompts ?? {}) as Partial<PromptVariant>), viewDescriptions: { ...DEFAULT_PROMPTS.viewDescriptions, ...(((variant.prompts ?? {}) as Partial<PromptVariant>).viewDescriptions ?? {}) } };
	const viewParams = variant.views ?? {};
	let keySource = process.env.TYPESAFE_API_KEY === cfg.apiKey && cfg.apiKey ? "env" : cfg.apiKey ? keyFilePath() : "none";
	let usingMock = cfg.forceMock || !cfg.apiKey;
	let classifier: Classifier = usingMock ? new MockClassifier() : new JevClassifier(cfg);
	let presend: PresendClassifier = usingMock ? new MockPresend() : new JevPresend(new TypeSafeClient({ apiKey: cfg.apiKey }), cfg.model, prompts);
	/** Switch from the mock to jev once a key is available (from `/jev-lens key`), without a restart. */
	const useKey = (apiKey: string) => {
		cfg.apiKey = apiKey;
		usingMock = cfg.forceMock;
		classifier = usingMock ? new MockClassifier() : new JevClassifier(cfg);
		presend = usingMock ? new MockPresend() : new JevPresend(new TypeSafeClient({ apiKey }), cfg.model, prompts);
	};
	/** Full text of compressed tool results, by toolCallId, for the recall tool (also persisted in result details). */
	const fullOutputs = new Map<string, { text: string; toolName: string; args: unknown; view: string }>();
	/** Everything the UI needs per compressed result, newest last. */
	const records: CompressedRecord[] = [];
	const recordById = new Map<string, CompressedRecord>();
	const remember = (r: CompressedRecord) => { records.push(r); recordById.set(r.id, r); if (records.length > 200) { const old = records.shift(); if (old) recordById.delete(old.id); } };
	let lastAssistantText = "";
	let health = new Health();
	let presendTotals = { considered: 0, compressed: 0, tokensSaved: 0, recalls: 0 };
	let restored = { compressed: 0, tokensSaved: 0 };

	let ledger = new Map<string, Decision>();
	/** Classifications launched but not yet resolved, keyed by toolCallId. */
	const inflight = new Map<string, Promise<void>>();
	let generation = 0;
	let sessionAbort = new AbortController();
	const workSignal = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, sessionAbort.signal]) : sessionAbort.signal;
	async function waitForWork(work: Promise<void>[]) {
		if (!work.length) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([Promise.allSettled(work), new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, cfg.classifyWaitMs)); })]);
		} finally { clearTimeout(timer); }
	}
	/** Tool results from the previous assistant turn, waiting for "what happened next". */
	let buffer: PendingResult[] = [];
	/** Tool call arguments by id, so results can be described. */
	const argsById = new Map<string, unknown>();
	let callIndex = 0;
	let lastCallAt = 0;
	let logPath = "";
	let totals = { pruned: 0, applied: 0, calls: 0, cacheRead: 0, input: 0 };
	/** Tokens kept out of the prompt, summed over every LLM call of the session (a compressed result saves on each later call too). */
	let cut = { presend: 0, pruned: 0 };
	let firstUser = "";
	let latestUser = "";

	const log = (record: Record<string, unknown>) => {
		if (!cfg.logFile || !logPath) return;
		try {
			appendFileSync(logPath, `${JSON.stringify({ t: Date.now(), ...record })}\n`);
		} catch {}
	};

	/** Share of all input tokens this session that jev kept out of the prompt: cut / (sent + cut), from the provider's own usage counts. */
	const cutShare = () => {
		const sent = totals.input + totals.cacheRead;
		const kept = cut.presend + cut.pruned;
		return sent > 0 ? Math.round((100 * kept) / (sent + kept)) : undefined;
	};
	const statusText = () => {
		const tag = !cfg.enabled ? "jev-lens(disabled)" : usingMock ? "jev-lens(mock)" : "jev-lens";
		const pct = cutShare();
		const label = health.failing ? `${tag}(degraded)` : tag;
		const lead = pct === undefined ? label : `${label} −${pct}% of input`;
		const pruned = cfg.mode === "off" ? "" : `, pruned −${(totals.pruned / 1000).toFixed(1)}k · ${totals.applied}`;
		const saved = presendTotals.tokensSaved + restored.tokensSaved;
		const counts = `${presendTotals.compressed}/${presendTotals.considered}${restored.compressed ? ` new · ${restored.compressed} restored` : ""}`;
		return `${lead} (presend −${(saved / 1000).toFixed(1)}k · ${counts} · ${presendTotals.recalls} recalls${pruned})`;
	};
	const status = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		for (const warning of health.warnings()) ctx.ui.notify(warning, "warning");
		ctx.ui.setStatus("jev-lens", statusText());
	};

	const persist = (d: Decision) => pi.appendEntry(ENTRY_TYPE, { kind: "decision", decision: { ...d } });

	// ---- session lifecycle -------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		generation++;
		sessionAbort.abort();
		sessionAbort = new AbortController();
		lastAssistantText = "";
		health = new Health();
		ledger = rebuildLedger(ctx.sessionManager.getEntries());
		buffer = [];
		inflight.clear();
		argsById.clear();
		callIndex = 0;
		lastCallAt = 0;
		totals = { pruned: 0, applied: 0, calls: 0, cacheRead: 0, input: 0 };
		cut = { presend: 0, pruned: 0 };
		firstUser = "";
		latestUser = "";
		fullOutputs.clear();
		records.length = 0;
		recordById.clear();
		presendTotals = { considered: 0, compressed: 0, tokensSaved: 0, recalls: 0 };
		restored = { compressed: 0, tokensSaved: 0 };
		try {
			mkdirSync(join(ctx.cwd, CONFIG_DIR_NAME), { recursive: true });
			logPath = join(ctx.cwd, CONFIG_DIR_NAME, "jev-lens.log");
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
				const d = (entry.message as { details?: { jevLens?: { full?: string; view?: string; args?: unknown; included?: number[]; kind?: string; needsFull?: number; p?: Record<string, number> } } }).details?.jevLens;
				if (d?.full) {
					fullOutputs.set(entry.message.toolCallId, { text: d.full, toolName: entry.message.toolName, args: d.args, view: d.view ?? "?" });
					const sent = contentText(entry.message.content).replace(/\n\n\[jev-lens:[\s\S]*$/, "");
					restored.compressed++;
					restored.tokensSaved += Math.max(0, estimateTokensOfText(d.full) - estimateTokensOfText(sent));
					remember({ id: entry.message.toolCallId, toolName: entry.message.toolName, args: d.args, kind: d.kind ?? "?", view: d.view ?? "?", tokensBefore: estimateTokensOfText(d.full), tokensAfter: estimateTokensOfText(sent), full: d.full, sent, included: d.included ?? [], needsFull: d.needsFull, pFull: d.p?.full, recalls: 0, at: entry.message.timestamp });
				}
			}
		}
		log({ event: "session_start", mode: cfg.mode, enabled: cfg.enabled, mock: usingMock, ledger: ledger.size, variant: variant.name ?? null });
		if (ctx.hasUI && usingMock && !cfg.forceMock) ctx.ui.notify("jev-lens: no TypeSafe API key. Run /jev-lens key (or set TYPESAFE_API_KEY). Using the mock classifier until then.", "warning");
		status(ctx);
	});

	pi.on("session_shutdown", async () => {
		const epoch = generation;
		await waitForWork([...inflight.values()]);
		if (epoch !== generation) return;
		if (inflight.size) log({ event: "shutdown_timeout", pending: inflight.size });
		generation++;
		sessionAbort.abort();
		inflight.clear();
	});

	pi.on("before_agent_start", async (event) => {
		if (!firstUser) firstUser = event.prompt;
		latestUser = event.prompt;
	});

	// ---- classification ------------------------------------------------------------------

	pi.on("message_end", async (event, ctx) => {
		const m = event.message;
		if (m.role === "user") {
			const text = contentText(m.content);
			if (!firstUser) firstUser = text;
			latestUser = text;
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

	pi.on("agent_end", async (_event, ctx) => {
		// No further assistant reaction is coming for the last results; classify with what we have.
		const toClassify = buffer;
		buffer = [];
		for (const item of toClassify) launchClassification(item, "", [], ctx);
		await waitForWork([...inflight.values()]);
	});

	function launchClassification(item: PendingResult, afterText: string, afterCalls: { name: string; arguments: unknown }[], ctx?: ExtensionContext) {
		const m = item.message;
		if (cfg.mode === "off" || sessionAbort.signal.aborted || m.content.some((c) => c.type !== "text")) return;
		const epoch = generation;
		const signal = workSignal(ctx?.signal);
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
			.classifyToolResult(state, signal)
			.then((probs) => {
				if (epoch !== generation || signal.aborted) return;
				health.success("postsend");
				if (ctx) status(ctx);
				const decision: Decision = {
					id: m.toolCallId,
					toolName: m.toolName,
					bucket: cfg.enabled ? decideBucket(probs, cfg) : "keep",
					p: probs,
					summary,
					tokensBefore: tokens,
					decidedAt: Date.now(),
					status: "pending",
				};
				ledger.set(decision.id, decision);
				persist(decision);
				log({ event: "decision", id: decision.id, tool: m.toolName, bucket: decision.bucket, p: probs, tokens, ms: Date.now() - started, summary });
			})
			.catch((err) => {
				if (epoch !== generation || signal.aborted) return;
				health.failure("postsend", err);
				log({ event: "classify_error", id: m.toolCallId, error: health.lines()[1] });
				if (ctx) status(ctx);
			})
			.finally(() => { if (epoch === generation) inflight.delete(m.toolCallId); });
		inflight.set(m.toolCallId, p);
	}

	// ---- the cache-aware cut: right before each LLM call --------------------------------

	pi.on("context", async (event, ctx) => {
		const epoch = generation;
		callIndex++;
		const now = Date.now();
		const coldCache = lastCallAt > 0 && now - lastCallAt > cfg.cacheTtlMs;
		lastCallAt = now;

		// Give in-flight classifications a bounded chance to land, so decisions apply at the
		// earliest call and freeze there instead of shifting the prefix one call later.
		if (inflight.size > 0) {
			await waitForWork([...inflight.values()]);
		}
		if (epoch !== generation || sessionAbort.signal.aborted) return;

		const pending = pendingPrunable(event.messages, ledger, cfg);
		const { apply: applyPending, reason } = shouldApplyPending(cfg.mode, cfg, coldCache, pending);
		const result = applyLedger(event.messages, ledger, cfg, applyPending, callIndex, reason);
		for (const d of result.appliedNow) persist(d);
		totals.applied += result.appliedNow.length;
		totals.pruned = 0;
		for (const d of ledger.values()) if (d.status === "applied") totals.pruned += d.tokensBefore;
		totals.calls++;
		// What this call would have cost without jev: every compressed result still in the prompt, plus what was pruned.
		let presentSaved = 0;
		for (const m of result.messages) {
			if (m.role !== "toolResult") continue;
			const rec = recordById.get(m.toolCallId);
			if (rec) presentSaved += Math.max(0, rec.tokensBefore - rec.tokensAfter);
		}
		cut.presend += presentSaved;
		cut.pruned += Math.max(0, result.tokensOriginal - result.tokensSent);

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
		log({ event: "context", ...stats, reason, pendingTokens: pending.tokens, tailTokens: pending.tailTokens, inflight: inflight.size, presendSavedInPrompt: presentSaved });
		status(ctx);
		return { messages: result.messages };
	});

	// Cache accounting from the provider's own usage numbers.
	pi.on("message_end", async (event, ctx) => {
		const m = event.message;
		if (m.role !== "assistant") return;
		totals.cacheRead += m.usage?.cacheRead ?? 0;
		totals.input += m.usage?.input ?? 0;
		log({ event: "usage", call: callIndex, input: m.usage?.input, cacheRead: m.usage?.cacheRead, output: m.usage?.output, model: m.model });
		if (ctx.hasUI) status(ctx);
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
	});

	// ---- pre-send compression: pick a view of a large tool result before it is ever sent ----

	pi.on("tool_result", async (event, ctx) => {
		if (!cfg.presend || !cfg.enabled || sessionAbort.signal.aborted) return;
		const epoch = generation;
		const signal = workSignal(ctx.signal);
		if (event.toolName === "recall") return;
		const text = contentText(event.content);
		const tokens = estimateTokensOfText(text);
		if (tokens < cfg.presendMinTokens) return;
		if (event.content.some((c) => c.type === "image")) return;
		presendTotals.considered++;
		const started = Date.now();
		try {
			const terms = extractTerms(latestUser, lastAssistantText, JSON.stringify(event.input ?? {}));
			const cands = await buildCandidatesAsync(event.toolName, event.input, text, terms, viewParams);
			if (epoch !== generation || signal.aborted) return;
			if (cands.views.length < 2) {
				log({ event: "presend", id: event.toolCallId, tool: event.toolName, tokens, view: "full", reason: "no-candidates" });
				return;
			}
			const totalLines = text.split("\n").length;
			const state = buildPresendState(cfg, { firstUser, latestUser, agentText: lastAssistantText, toolName: event.toolName, args: event.input, isError: event.isError, cands, totalLines, totalChars: text.length });
			const answer = await presend.choose(state, cands.views.map((v) => v.kind), signal);
			if (epoch !== generation || signal.aborted) return;
			let view = decideView(answer, cands, cfg);
			let expanded: number[] | undefined;
			if (view.kind !== "full") {
				const above = cands.kind === "command" ? cfg.presendSectionExpandAbove : cfg.presendExpandAbove;
				const ex = await expandRelevantBlocks(presend, state, text, cands, view, above, signal, cands.blocks, cfg.presendSectionFloor);
				if (epoch !== generation || signal.aborted) return;
				if (ex) { view = ex.view; expanded = ex.probs.map((p, i) => (p > above ? i : -1)).filter((i) => i >= 0); }
			}
			health.success("presend");
			status(ctx);
			log({ event: "presend", id: event.toolCallId, tool: event.toolName, kind: cands.kind, tokens, view: view.kind, viewTokens: estimateTokensOfText(view.text), chosen: answer.choice, needsFull: answer.needsFull, p: answer.probabilities, confidence: answer.confidence, expanded, candidates: cands.views.map((v) => `${v.kind}:${v.chars}`), ms: Date.now() - started });
			if (view.kind === "full") return;
			presendTotals.compressed++;
			presendTotals.tokensSaved += tokens - estimateTokensOfText(view.text);
			fullOutputs.set(event.toolCallId, { text, toolName: event.toolName, args: event.input, view: view.kind });
			remember({ id: event.toolCallId, toolName: event.toolName, args: event.input, kind: cands.kind, view: view.kind, tokensBefore: tokens, tokensAfter: estimateTokensOfText(view.text), full: text, sent: view.text, included: view.included, needsFull: answer.needsFull, pFull: answer.probabilities.full, recalls: 0, at: Date.now() });
			const details = { ...((event.details as object) ?? {}), jevLens: { full: text, view: view.kind, kind: cands.kind, args: event.input, p: answer.probabilities, needsFull: answer.needsFull, included: view.included } };
			status(ctx);
			return { content: [{ type: "text", text: view.text + footer(view, event.toolCallId, totalLines) }], details };
		} catch (err) {
			if (epoch !== generation || signal.aborted) return;
			health.failure("presend", err);
			log({ event: "presend_error", id: event.toolCallId, error: health.lines()[0] });
			status(ctx);
			return;
		}
	});

	pi.registerTool({
		name: "recall",
		label: "Recall",
		description: "Return the full output of an earlier tool call that jev-lens showed in a reduced view (or that was pruned). Pass the id from the [jev-lens: ...] note. Optionally restrict to a line range \"a-b\" or to lines matching a pattern (case-insensitive substring or /regex/).",
		parameters: Type.Object({
			id: Type.String({ description: "toolCallId from the jev-lens note" }),
			lines: Type.Optional(Type.String({ description: "Line range like 120-180 (1-based, inclusive)" })),
			pattern: Type.Optional(Type.String({ description: "Only lines matching this substring or /regex/, with 2 lines of context" })),
		}),
		async execute(_toolCallId, params) {
			presendTotals.recalls++;
			const rec = recordById.get(params.id);
			if (rec) rec.recalls++;
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

	// ---- TUI: built-in tools re-registered so compressed results show what was saved -----------

	if (process.env.JEV_LENS_UI !== "0") {
		const cwd = process.cwd();
		// Tool definitions include pi's renderers; create*Tool() strips them.
		const originals: ToolDefinition<any, any>[] = [
			createReadToolDefinition(cwd), createBashToolDefinition(cwd),
			createGrepToolDefinition(cwd), createFindToolDefinition(cwd), createLsToolDefinition(cwd),
		];
		for (const original of originals) {
			pi.registerTool({
				...original,
				renderResult(result, options, theme, context) {
					const rec = recordById.get(context.toolCallId);
					if (!rec || options.isPartial || context.isError) {
						return original.renderResult!(result, options, theme, context);
					}
					let out = savingsLine(rec, theme);
					if (options.expanded) out += "\n" + rec.sent;
					else out += "\n" + theme.fg("dim", rec.sent.split("\n").slice(0, 3).join("\n"));
					return new Text(out, 0, 0);
				},
			});
		}
	}

	// ---- commands ----------------------------------------------------------------------

	pi.registerCommand("jev-lens", {
		description: "Inspect compression and setup: stats | list | diff [n] | decisions | key | help",
		getArgumentCompletions: (prefix) => commandCompletions(prefix, records),
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim();
			if (sub === "help" || sub === "--help" || sub === "-h") {
				ctx.ui.notify(commandHelp, "info");
				return;
			}
			if (/^key(?:\s|$)/.test(sub)) {
				let key = sub.slice(3).trim();
				if (!key && (!ctx.hasUI || ctx.mode !== "tui")) { ctx.ui.notify("Masked key input requires terminal mode. Set TYPESAFE_API_KEY or run /jev-lens key in interactive pi.", "warning"); return; }
				if (!key) key = ((await ctx.ui.custom<string | undefined>((tui, theme, keys, done) =>
					new SecretInput(theme, keys, done, () => tui.requestRender()),
				)) ?? "").trim();
				if (!key) { ctx.ui.notify("Key setup cancelled. The current key is unchanged.", "info"); return; }
				let where: string;
				try { where = storeKey(key); }
				catch {
					ctx.ui.notify(`Could not store the key in ${keyFilePath()}. Check directory permissions or set TYPESAFE_API_KEY.`, "error");
					return;
				}
				useKey(key);
				keySource = where;
				const next = cfg.forceMock ? "Mock mode remains active. Unset JEV_LENS_CLASSIFIER and reload pi to use jev." : !cfg.enabled || !cfg.presend ? "Pre-send compression is disabled. See /jev-lens stats." : "jev will use this key from the next tool result. The key has not been validated.";
				ctx.ui.notify(`jev-lens: key stored in ${where}. ${next}${process.env.TYPESAFE_API_KEY ? " TYPESAFE_API_KEY takes priority again after reload." : ""}`, "info");
				status(ctx);
				return;
			}
			if (/^diff(?:\s|$)/.test(sub)) {
				const arg = sub.slice(4).trim();
				const n = Number(arg || "1");
				if ((arg && !/^\d+$/.test(arg)) || !Number.isSafeInteger(n) || n < 1) {
					ctx.ui.notify("Usage: /jev-lens diff [n]. Use a positive whole number. 1 is the newest result.", "warning");
					return;
				}
				if (!records.length) { ctx.ui.notify("No compressed results yet. Use /jev-lens stats to inspect compression settings.", "info"); return; }
				const rec = records[records.length - n];
				if (!rec) { ctx.ui.notify(`Result ${n} is not available. Choose 1-${records.length} from /jev-lens list.`, "warning"); return; }
				if (!ctx.hasUI || ctx.mode !== "tui") { ctx.ui.notify(listLines([rec], { fg: (_c, t) => t, bold: (t) => t }).join("\n"), "info"); return; }
				await ctx.ui.custom<void>((tui, theme, _kb, done) => {
					const height = Math.max(12, Math.floor(((tui as { terminalHeight?: number }).terminalHeight ?? process.stdout.rows ?? 40) * 0.85));
					const overlay = new DiffOverlay(rec, theme, height, () => done(), () => tui.requestRender());
					return { render: (w) => overlay.render(w), handleInput: (d) => overlay.handleInput(d), invalidate: () => overlay.invalidate() };
				}, { overlay: true, overlayOptions: { width: "92%", maxHeight: "90%", anchor: "center" } });
				return;
			}
			if (sub === "list") {
				ctx.ui.notify(listLines(records, { fg: (_c, t) => t, bold: (t) => t }).join("\n"), "info");
				return;
			}
			if (sub === "decisions") {
				const rows = [...ledger.values()].map((d) => `${d.status === "applied" ? "●" : "○"} ${d.bucket.padEnd(6)} n=${d.p.needed.toFixed(2)} o=${d.p.outcomeOnly.toFixed(2)} ${d.tokensBefore}t ${d.summary}`);
				ctx.ui.notify(rows.join("\n") || (cfg.mode === "off" ? "Post-send pruning is off (the default). Pre-send compression is separate: see /jev-lens stats." : "No post-send decisions yet."), "info");
				return;
			}
			if (sub && sub !== "stats") {
				ctx.ui.notify("Unknown subcommand or extra arguments. Run /jev-lens help for usage.", "warning");
				return;
			}
			const hit = totals.input + totals.cacheRead > 0 ? Math.round((100 * totals.cacheRead) / (totals.input + totals.cacheRead)) : 0;
			ctx.ui.notify(
				[
					`mode=${cfg.mode} enabled=${cfg.enabled} presend=${cfg.presend} classifier=${usingMock ? cfg.forceMock ? "mock (forced by JEV_LENS_CLASSIFIER)" : "mock (no key: /jev-lens key)" : cfg.model} key=${keySource}`,
					`presend since load: ${presendTotals.compressed}/${presendTotals.considered} large results compressed, ≈${presendTotals.tokensSaved} tokens saved, ${presendTotals.recalls} recalls`,
					`restored from session: ${restored.compressed} compressed results, ≈${restored.tokensSaved} tokens saved (included in footer savings)`,
					`post-send: calls=${totals.calls} decisions=${ledger.size} applied=${totals.applied} pruned≈${totals.pruned} tokens`,
					...health.lines(),
					`cache: read=${totals.cacheRead} uncached=${totals.input} hit=${hit}%`,
					`input cut: ${cutShare() ?? 0}% of input tokens counted since load (≈${cut.presend + cut.pruned} of ${totals.input + totals.cacheRead + cut.presend + cut.pruned}: presend ${cut.presend}, pruned ${cut.pruned}, summed over ${totals.calls} calls)`,
				].join("\n"),
				"info",
			);
		},
	});
}
