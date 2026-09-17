import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Config } from "./config.ts";
import type { Probabilities } from "./types.ts";
import { head, tail, truncate } from "./text.ts";

/** Everything jev sees about one tool result. Built identically by the extension and the replay harness. */
export interface ItemState {
	task: { first_user_request: string; latest_user_message: string };
	item: {
		tool: string;
		args: string;
		is_error: boolean;
		total_chars: number;
		output_head: string;
		output_tail: string;
	};
	after: {
		assistant_text: string;
		next_tool_calls: { name: string; args: string }[];
	};
}

export interface TextState {
	task: { first_user_request: string };
	message: string;
	role: "user" | "agent";
}

export interface Classifier {
	classifyToolResult(state: ItemState, signal?: AbortSignal): Promise<Probabilities>;
	classifyText(state: TextState, signal?: AbortSignal): Promise<number>;
}

export function buildItemState(
	cfg: Pick<Config, "stateHeadChars" | "stateTailChars">,
	input: {
		firstUser: string;
		latestUser: string;
		toolName: string;
		args: unknown;
		isError: boolean;
		output: string;
		afterText: string;
		afterCalls: { name: string; arguments: unknown }[];
	},
): ItemState {
	return {
		task: {
			first_user_request: truncate(input.firstUser, 600),
			latest_user_message: truncate(input.latestUser, 400),
		},
		item: {
			tool: input.toolName,
			args: truncate(JSON.stringify(input.args ?? {}), 300),
			is_error: input.isError,
			total_chars: input.output.length,
			output_head: head(input.output, cfg.stateHeadChars),
			output_tail: input.output.length > cfg.stateHeadChars ? tail(input.output, cfg.stateTailChars) : "",
		},
		after: {
			assistant_text: truncate(input.afterText, 800),
			next_tool_calls: input.afterCalls.slice(0, 8).map((c) => ({ name: c.name, args: truncate(JSON.stringify(c.arguments ?? {}), 150) })),
		},
	};
}

export const TOOL_RESULT_QUESTIONS = {
	needed: {
		type: "noul" as const,
		instructions:
			"`item` is the output of a tool the coding agent ran while working on `task`. `after` shows what the agent said and which tools it called right after seeing this output. Will the agent still need the full text of `item.output_head` and `item.output_tail` verbatim in its upcoming steps?",
		criteria: {
			true: "The agent is still working on what this output shows: it will edit, quote, compare against, or reason over specific lines of it; or it has not acted on it yet; or the output holds details (line numbers, exact error text, exact code) it will need again.",
			false: "The agent already acted on it (edited the file, fixed the error, answered from it), moved on to a different area, the output was a dead end or irrelevant, or it is cheap to regenerate by running the same tool again.",
		},
	},
	outcome_only: {
		type: "noul" as const,
		instructions:
			"Is the useful information in `item` limited to its outcome, such as success or failure, the final status lines, an error message, or a count, so that the middle of the output could be dropped without losing anything the agent needs?",
		criteria: {
			true: "Command output, logs, install or build noise, test runs where only the pass/fail summary or the failing case matters.",
			false: "Source code, file contents, search results, directory listings, or any output where specific lines in the middle carry the information.",
		},
	},
	durable: {
		type: "noul" as const,
		instructions:
			"Does `item` reveal a stable fact about this project (its structure, conventions, how to build, test or run it, a known pitfall) or about the user's preferences, that would still be true and useful in a future, unrelated session?",
		criteria: {
			true: "Build or test commands that work, project layout, conventions, configuration quirks, recurring gotchas.",
			false: "Task-specific content, transient state, one-off command output, file contents that change with every edit.",
		},
	},
};

export const TEXT_QUESTIONS = {
	durable_user: {
		type: "noul" as const,
		instructions:
			"`message` was written by the user to a coding agent. Does it state a preference, standing instruction, or fact about the user or the project that should be remembered in future sessions, rather than a one-off task instruction?",
		criteria: {
			true: "Coding style preferences, tools or workflows the user wants used, facts about the project's purpose, constraints that will keep applying.",
			false: "A task for right now, a question, feedback about one specific change, small talk.",
		},
	},
	durable_agent: {
		type: "noul" as const,
		instructions:
			"`message` was written by a coding agent. Does it state a conclusion, decision, or discovered fact about the project that will remain true and be useful in future unrelated sessions?",
		criteria: {
			true: "How the project is structured, where things live, what command runs the tests, a root cause that explains recurring behaviour, a design decision that was made.",
			false: "Progress narration, a plan for the current task, a question to the user, a summary of edits just made.",
		},
	},
};

export class JevClassifier implements Classifier {
	private client: TypeSafeClient;
	private model: string;
	constructor(cfg: Pick<Config, "apiKey" | "model">) {
		this.client = new TypeSafeClient({ apiKey: cfg.apiKey });
		this.model = cfg.model;
	}
	async classifyToolResult(state: ItemState, signal?: AbortSignal): Promise<Probabilities> {
		const r = await this.client.systemOne({ state: state as never, questions: TOOL_RESULT_QUESTIONS, model: this.model }, { signal, timeout: 15000 });
		return { needed: r.answers.needed.noul, outcomeOnly: r.answers.outcome_only.noul, durable: r.answers.durable.noul };
	}
	async classifyText(state: TextState, signal?: AbortSignal): Promise<number> {
		const q = state.role === "user" ? { durable: TEXT_QUESTIONS.durable_user } : { durable: TEXT_QUESTIONS.durable_agent };
		const r = await this.client.systemOne({ state: { task: state.task, message: state.message }, questions: q, model: this.model }, { signal, timeout: 15000 });
		return r.answers.durable.noul;
	}
}

/** Deterministic stand-in for tests and dry runs. Never touches the network. */
export class MockClassifier implements Classifier {
	constructor(private rule: (state: ItemState) => Probabilities = defaultMockRule) {}
	async classifyToolResult(state: ItemState): Promise<Probabilities> {
		return this.rule(state);
	}
	async classifyText(): Promise<number> {
		return 0;
	}
}

export function defaultMockRule(state: ItemState): Probabilities {
	const big = state.item.total_chars > 2000;
	const cmd = state.item.tool === "bash";
	return { needed: big ? 0.1 : 0.9, outcomeOnly: cmd ? 0.9 : 0.1, durable: 0 };
}
