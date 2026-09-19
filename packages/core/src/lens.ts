/**
 * The pre-send pipeline, host-independent: given one large tool result and what the agent is doing,
 * build candidate views, let jev pick one, expand the blocks or sections it will need, and return the
 * view to send. Hosts (pi, Claude Code) wrap this with their own storage, recall tool and UI.
 */
import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Config, VariantOverrides } from "./config.ts";
import { buildPresendState, decideView, DEFAULT_PROMPTS, expandRelevantBlocks, JevPresend, MockPresend, type PresendClassifier, type PromptVariant } from "./presend.ts";
import { estimateTokensOfText } from "./text.ts";
import { buildCandidatesAsync, extractTerms, footer, type ContentKind, type FooterOptions, type View, type ViewParams } from "./views.ts";

export interface LensContext {
	/** The first user request of the session (the task). */
	firstUser: string;
	/** The latest user message. */
	latestUser: string;
	/** What the agent wrote right before the tool call, if anything. */
	agentText: string;
}

export interface LensInput {
	/** Id the recall tool will be given (pi's toolCallId, Claude Code's tool_use_id). */
	toolCallId: string;
	/** Canonical tool name: read, bash, grep, find, ls, edit, write. Hosts map their own names to these. */
	toolName: string;
	/** Canonical arguments: { path } for reads, { command } for shells, { pattern, path } for searches. */
	args: unknown;
	/** The full text of the result. */
	text: string;
	isError?: boolean;
	context: LensContext;
}

export interface LensAnswer {
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
	needsFull: number;
}

export interface LensOutcome {
	/** True when `text` is a reduced view; false when the full output should be sent unchanged. */
	compressed: boolean;
	kind: ContentKind | undefined;
	view: View | undefined;
	/** The view plus the recall footer when compressed, otherwise the original text. */
	text: string;
	/** Estimated tokens of the full output and of what is sent. */
	tokens: number;
	sentTokens: number;
	totalLines: number;
	/** Why nothing was compressed: too small, no smaller candidate, or jev chose full. */
	reason?: "small" | "no-candidates" | "full";
	answer?: LensAnswer;
	/** Indices of the blocks or sections the second step put back. */
	expanded?: number[];
	/** Candidate views as "kind:chars", for logs. */
	candidates?: string[];
	ms: number;
}

export interface LensOptions {
	cfg: Config;
	presend: PresendClassifier;
	viewParams?: Partial<ViewParams>;
	/** How the footer names the recall tool; defaults to pi's phrasing. */
	footer?: FooterOptions;
}

export class Lens {
	constructor(private readonly o: LensOptions) {}

	/** Decide what to send for one tool result. Throws when jev fails; the host then sends the full output. */
	async compress(input: LensInput, signal?: AbortSignal): Promise<LensOutcome> {
		const { cfg, presend } = this.o;
		const started = Date.now();
		const text = input.text;
		const tokens = estimateTokensOfText(text);
		const totalLines = text.split("\n").length;
		const base = { compressed: false as const, kind: undefined, view: undefined, text, tokens, sentTokens: tokens, totalLines };
		if (tokens < cfg.presendMinTokens) return { ...base, reason: "small", ms: Date.now() - started };
		const terms = extractTerms(input.context.latestUser, input.context.agentText, JSON.stringify(input.args ?? {}));
		const cands = await buildCandidatesAsync(input.toolName, input.args, text, terms, this.o.viewParams ?? {});
		const candidates = cands.views.map((v) => `${v.kind}:${v.chars}`);
		if (cands.views.length < 2) return { ...base, kind: cands.kind, reason: "no-candidates", candidates, ms: Date.now() - started };
		const state = buildPresendState(cfg, { firstUser: input.context.firstUser, latestUser: input.context.latestUser, agentText: input.context.agentText, toolName: input.toolName, args: input.args, isError: input.isError ?? false, cands, totalLines, totalChars: text.length });
		const answer = await presend.choose(state, cands.views.map((v) => v.kind), signal);
		let view = decideView(answer, cands, cfg);
		let expanded: number[] | undefined;
		if (view.kind !== "full") {
			const above = cands.kind === "command" ? cfg.presendSectionExpandAbove : cfg.presendExpandAbove;
			const ex = await expandRelevantBlocks(presend, state, text, cands, view, above, signal, cands.blocks, cfg.presendSectionFloor);
			if (ex) { view = ex.view; expanded = ex.probs.map((p, i) => (p > above ? i : -1)).filter((i) => i >= 0); }
		}
		const common = { kind: cands.kind, view, tokens, totalLines, answer, expanded, candidates, ms: Date.now() - started };
		if (view.kind === "full") return { ...common, compressed: false, text, sentTokens: tokens, reason: "full" };
		const sent = view.text + footer(view, input.toolCallId, totalLines, this.o.footer);
		return { ...common, compressed: true, text: sent, sentTokens: estimateTokensOfText(view.text) };
	}
}

/** jev when a key is available (or the mock when forced or keyless), so every host makes the same choice. */
export function createPresend(cfg: Config, prompts: PromptVariant = DEFAULT_PROMPTS): { presend: PresendClassifier; mock: boolean } {
	const mock = cfg.forceMock || !cfg.apiKey;
	return { presend: mock ? new MockPresend() : new JevPresend(new TypeSafeClient({ apiKey: cfg.apiKey }), cfg.model, prompts), mock };
}

/** The default prompts with a variant file's overrides applied (autoresearch output). */
export function promptsWithVariant(variant: VariantOverrides): PromptVariant {
	const v = (variant.prompts ?? {}) as Partial<PromptVariant>;
	return { ...DEFAULT_PROMPTS, ...v, viewDescriptions: { ...DEFAULT_PROMPTS.viewDescriptions, ...(v.viewDescriptions ?? {}) } };
}
