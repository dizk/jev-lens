import type { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Config } from "./config.ts";
import { truncate } from "./text.ts";
import type { Candidates, View, ViewKind } from "./views.ts";

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
}

const VIEW_DESCRIPTIONS: Record<ViewKind, string> = {
	full: "The complete, unmodified output. Needed when the agent will edit or quote exact text, when details anywhere in the output matter, or when nothing else clearly suffices.",
	outline: "Structure only: imports, exports, signatures, class and function headers, headings, doc comments, with line numbers. Enough to understand what a file offers and where things are, not enough to edit a body verbatim.",
	focus: "Only the lines that mention the identifiers from the task and the tool call, with a few lines of context, line-numbered. Enough when the agent is looking for specific names.",
	signals: "Command output reduced to errors, warnings, failing tests and the final summary lines with context, line-numbered. Enough for reacting to a failed or passed run.",
	sample: "Header plus a sample of rows and the total count, for tabular or log-like data. Enough to learn the shape of the data, not its contents.",
	head_tail: "The first and last lines only. Enough to see what the output is and how it ends.",
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

export function presendQuestions(kinds: ViewKind[]) {
	const criteria: Record<string, string> = {};
	for (const k of kinds) criteria[k] = VIEW_DESCRIPTIONS[k];
	return {
		view: {
			type: "choice" as const,
			instructions:
				"A coding agent working on `task` just called `agent.tool` with `agent.args` (its reasoning right before the call is `agent.text_before_call`). The output is large. `views` lists candidate presentations of the same output with a preview of each. Which view is the smallest one that still gives the agent everything it needs for its next step? Prefer smaller views only when the agent's purpose is clearly served by them; when in doubt, choose full.",
			criteria,
		},
		needs_full: {
			type: "noul" as const,
			instructions:
				"Will the agent's next step require the exact, complete text of this output, for example to make an edit whose old text must match, to copy code, or to check details that could be anywhere in it?",
			criteria: {
				true: "The agent asked for this to modify it, copy from it, or review it line by line; the task is about the contents of this specific output.",
				false: "The agent is orienting itself, checking structure, looking for where something lives, confirming an outcome, or sampling data.",
			},
		},
	};
}

export class JevPresend implements PresendClassifier {
	constructor(private client: TypeSafeClient, private model: string) {}
	async choose(state: PresendState, kinds: ViewKind[], signal?: AbortSignal) {
		const r = await this.client.systemOne({ state: state as never, questions: presendQuestions(kinds), model: this.model }, { signal, timeout: 15000 });
		return { choice: r.answers.view.choice as ViewKind, probabilities: r.answers.view.probabilities as Record<string, number>, confidence: r.answers.view.confidence, needsFull: r.answers.needs_full.noul };
	}
}

export class MockPresend implements PresendClassifier {
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
	cfg: Pick<Config, "presendNeedsFullAbove" | "presendFullMassAbove" | "presendMinConfidence">,
): View {
	const full = cands.views[0];
	if (answer.needsFull > cfg.presendNeedsFullAbove) return full;
	if ((answer.probabilities.full ?? 0) > cfg.presendFullMassAbove) return full;
	if (answer.confidence < cfg.presendMinConfidence) return full;
	return cands.views.find((v) => v.kind === answer.choice) ?? full;
}
