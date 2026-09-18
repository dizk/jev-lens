import type { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Config } from "./config.ts";
import { truncate } from "./text.ts";
import { relevantView, splitBlocks, type Block, type Candidates, type View, type ViewKind } from "./views.ts";

export interface PresendState {
	task: { first_user_request: string; latest_user_message: string };
	agent: { text_before_call: string; tool: string; args: string };
	result: { kind: string; is_error: boolean; total_lines: number; total_chars: number };
	views: Record<string, { lines: number; chars: number; preview: string }>;
}

export interface PresendDecision {
	view: ViewKind;
	needsFull: number;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface PresendClassifier {
	choose(state: PresendState, kinds: ViewKind[], signal?: AbortSignal): Promise<{ choice: ViewKind; probabilities: Record<string, number>; confidence: number; needsFull: number }>;
	/** Second step: for each block, P(the agent will need its body). */
	expand(state: ExpandState, signal?: AbortSignal): Promise<number[]>;
}

export interface ExpandState {
	task: PresendState["task"];
	agent: PresendState["agent"];
	file: { kind: string; total_lines: number };
	blocks: { index: number; signature: string; lines: string; preview: string }[];
}

export function buildExpandState(base: PresendState, blocks: Block[], text: string): ExpandState {
	const lines = text.split("\n");
	return {
		task: base.task,
		agent: base.agent,
		file: { kind: base.result.kind, total_lines: base.result.total_lines },
		blocks: blocks.map((b, index) => ({ index, signature: b.name, lines: `${b.from}-${b.to}`, preview: truncate(lines.slice(b.from - 1, Math.min(b.to, b.from + 2)).join("\n"), 240) })),
	};
}

export function expandQuestions(n: number, prompts: PromptVariant = DEFAULT_PROMPTS) {
	const q: Record<string, { type: "noul"; instructions: string; criteria: { true: string; false: string } }> = {};
	for (let i = 0; i < n; i++) {
		q[`b${i}`] = { type: "noul", instructions: prompts.expandInstructions.replaceAll("{i}", String(i)), criteria: { true: prompts.expandTrue, false: prompts.expandFalse } };
	}
	return q;
}

const VIEW_DESCRIPTIONS: Record<ViewKind, string> = {
	full: "The complete, unmodified output. Needed when the agent will edit or quote exact text, when details anywhere in the output matter, or when nothing else clearly suffices.",
	outline: "Structure only: imports, exports, signatures, class and function headers, headings, doc comments, with line numbers. Enough to understand what a file offers and where things are, not enough to edit a body verbatim.",
	focus: "Only the lines that mention the identifiers from the task and the tool call, with a few lines of context, line-numbered. Enough when the agent is looking for specific names.",
	signals: "Command output reduced to errors, warnings, failing tests and the final summary lines with context, line-numbered. Enough for reacting to a failed or passed run.",
	sample: "Header plus a sample of rows and the total count, for tabular or log-like data. Enough to learn the shape of the data, not its contents.",
	head_tail: "The first and last lines only. Enough to see what the output is and how it ends.",
	relevant: "Outline plus the full bodies of the blocks the agent will need.",
	matches: "Search output (grep, rg) reduced to the first matches of every file with the count of further matches per file, plus any non-match lines. Enough to see which files and lines are involved; not enough to read every match.",
	log: "Script or server output with repeated lines collapsed: the first two and the last occurrence of every repeated line pattern, plus errors and the final lines. Enough to follow what happened; not enough to see every iteration.",
	tree: "A directory listing reduced to the first few entries of every directory, with the number of omitted entries per directory. Enough to learn the project layout, not enough to find one specific file in a large directory.",
	testlog: "A test run reduced to the failing tests with their assertion and traceback, the short summary and the final counts. Passing tests and decoration are dropped. Enough for reacting to a test run; not enough to see the output of passing tests.",
};

export function buildPresendState(
	cfg: Pick<Config, "stateHeadChars">,
	input: { firstUser: string; latestUser: string; agentText: string; toolName: string; args: unknown; isError: boolean; cands: Candidates; totalLines: number; totalChars: number },
): PresendState {
	const views: PresendState["views"] = {};
	for (const v of input.cands.views) {
		views[v.kind] = { lines: v.lines, chars: v.chars, preview: truncate(v.text, v.kind === "full" ? Math.min(1500, cfg.stateHeadChars) : 900) };
	}
	return {
		task: { first_user_request: truncate(input.firstUser, 600), latest_user_message: truncate(input.latestUser, 400) },
		agent: { text_before_call: truncate(input.agentText, 600), tool: input.toolName, args: truncate(JSON.stringify(input.args ?? {}), 300) },
		result: { kind: input.cands.kind, is_error: input.isError, total_lines: input.totalLines, total_chars: input.totalChars },
		views,
	};
}

/** Everything the autoresearch loop may vary: prompt texts and view descriptions. Defaults = current best. */
export interface PromptVariant {
	viewInstructions: string;
	viewDescriptions: Partial<Record<ViewKind, string>>;
	needsFullInstructions: string;
	needsFullTrue: string;
	needsFullFalse: string;
	expandInstructions: string;
	expandTrue: string;
	expandFalse: string;
}

export const DEFAULT_PROMPTS: PromptVariant = {
	viewInstructions:
		"A coding agent working on `task` just called `agent.tool` with `agent.args` (its reasoning right before the call is `agent.text_before_call`). The output is large. `views` lists candidate presentations of the same output with a preview of each. Which view is the smallest one that still gives the agent everything it needs for its next step? Prefer smaller views only when the agent's purpose is clearly served by them; when in doubt, choose full.",
	viewDescriptions: {},
	needsFullInstructions:
		"Will the agent's next step require the exact, complete text of this output, for example to make an edit whose old text must match, to copy code, or to check details that could be anywhere in it?",
	needsFullTrue: "The agent asked for this to modify it, copy from it, or review it line by line; the task is about the contents of this specific output.",
	needsFullFalse: "The agent is orienting itself, checking structure, looking for where something lives, confirming an outcome, or sampling data.",
	expandInstructions: "The agent working on `task` just read this file (`agent.args`) for the reason in `agent.text_before_call`. Will it need the full body of block `blocks[{i}]` (not just its signature) for its next step?",
	expandTrue: "The task or the agent's stated purpose concerns this block: it will edit it, call it in a specific way, explain its logic, or debug it.",
	expandFalse: "The block is unrelated to the task, or knowing its signature and existence is enough.",
};

export function presendQuestions(kinds: ViewKind[], prompts: PromptVariant = DEFAULT_PROMPTS) {
	const criteria: Record<string, string> = {};
	for (const k of kinds) criteria[k] = prompts.viewDescriptions[k] ?? VIEW_DESCRIPTIONS[k];
	return {
		view: { type: "choice" as const, instructions: prompts.viewInstructions, criteria },
		needs_full: { type: "noul" as const, instructions: prompts.needsFullInstructions, criteria: { true: prompts.needsFullTrue, false: prompts.needsFullFalse } },
	};
}

export class JevPresend implements PresendClassifier {
	constructor(private client: TypeSafeClient, private model: string, private prompts: PromptVariant = DEFAULT_PROMPTS) {}
	async expand(state: ExpandState, signal?: AbortSignal): Promise<number[]> {
		const r = await this.client.systemOne({ state: state as never, questions: expandQuestions(state.blocks.length, this.prompts), model: this.model }, { signal, timeout: 15000 });
		return state.blocks.map((_, i) => (r.answers[`b${i}`] as { noul: number }).noul);
	}
	async choose(state: PresendState, kinds: ViewKind[], signal?: AbortSignal) {
		const r = await this.client.systemOne({ state: state as never, questions: presendQuestions(kinds, this.prompts), model: this.model }, { signal, timeout: 15000 });
		return { choice: r.answers.view.choice as ViewKind, probabilities: r.answers.view.probabilities as Record<string, number>, confidence: r.answers.view.confidence, needsFull: r.answers.needs_full.noul };
	}
}

export class MockPresend implements PresendClassifier {
	async expand(state: ExpandState): Promise<number[]> {
		// deterministic: blocks whose signature mentions a term from the task
		const words = (state.task.first_user_request + " " + state.agent.args).toLowerCase();
		return state.blocks.map((b) => (b.signature.toLowerCase().split(/[^a-z0-9_]+/).some((w) => w.length > 4 && words.includes(w)) ? 0.9 : 0.1));
	}
	constructor(private pick: (state: PresendState, kinds: ViewKind[]) => ViewKind = (s, kinds) => (s.result.kind === "data" && kinds.includes("sample") ? "sample" : kinds.includes("outline") ? "outline" : "full")) {}
	async choose(state: PresendState, kinds: ViewKind[]) {
		const choice = this.pick(state, kinds);
		const probabilities: Record<string, number> = {};
		for (const k of kinds) probabilities[k] = k === choice ? 0.9 : 0.1 / Math.max(1, kinds.length - 1);
		return { choice, probabilities, confidence: 0.9, needsFull: choice === "full" ? 0.9 : 0.1 };
	}
}

/**
 * Turn jev's answers into a view, erring on the side of sending more:
 * full when needsFull is likely, when full itself carries real mass, or when the chosen view is not confident.
 */
export function decideView(
	answer: { choice: ViewKind; probabilities: Record<string, number>; confidence: number; needsFull: number },
	cands: Candidates,
	cfg: Pick<Config, "presendNeedsFullAbove" | "presendFullMassAbove" | "presendMinConfidence" | "presendCodeNeedsFullAbove" | "presendCommandNeedsFullAbove"> & Partial<Pick<Config, "presendCodePolicy">>,
): View {
	const full = cands.views[0];
	if (cands.kind === "code" && cfg.presendCodePolicy === "outline") {
		// outline-first: structure now, bodies via the expansion step, everything else via recall
		const outline = cands.views.find((v) => v.kind === "outline");
		if (outline) return outline;
	}
	const needsFullAbove = cands.kind === "code" ? Math.min(cfg.presendNeedsFullAbove, cfg.presendCodeNeedsFullAbove) : cands.kind === "command" ? cfg.presendCommandNeedsFullAbove : cfg.presendNeedsFullAbove;
	if (answer.needsFull > needsFullAbove) return full;
	// For code, "focus" alone is a locating aid; if it wins, upgrade to outline so structure comes along (the second step may expand bodies).
	if (cands.kind === "code" && answer.choice === "focus") { const outline = cands.views.find((v) => v.kind === "outline"); if (outline) return outline; }
	if ((answer.probabilities.full ?? 0) > cfg.presendFullMassAbove) return full;
	if (answer.confidence < cfg.presendMinConfidence) return full;
	return cands.views.find((v) => v.kind === answer.choice) ?? full;
}

/**
 * Second node of the pre-send graph: when a code file was reduced to its outline, ask jev which
 * block bodies the agent will need and put those back. Returns undefined when not applicable.
 */
export async function expandRelevantBlocks(
	presend: PresendClassifier,
	base: PresendState,
	text: string,
	cands: Candidates,
	chosen: View,
	threshold: number,
	signal?: AbortSignal,
	precomputed?: Block[],
): Promise<{ view: View; blocks: Block[]; probs: number[] } | undefined> {
	if (cands.kind !== "code" || (chosen.kind !== "outline" && chosen.kind !== "focus")) return undefined;
	const blocks = precomputed && precomputed.length >= 2 ? precomputed : splitBlocks(text);
	if (blocks.length < 2) return undefined;
	const probs = await presend.expand(buildExpandState(base, blocks, text), signal);
	const expand = new Set<number>();
	probs.forEach((p, i) => { if (p > threshold) expand.add(i); });
	const outline = cands.views.find((v) => v.kind === "outline");
	const view = relevantView(text, cands.kind, blocks, expand, outline?.included);
	if (view.chars >= cands.views[0].chars * 0.9) return { view: cands.views[0], blocks, probs };
	return { view, blocks, probs };
}
