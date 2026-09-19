/**
 * PostToolUse hook: reads the event from stdin, and when the result is large, lets jev pick a view
 * of it. Prints an `updatedToolOutput` that replaces what Claude sees; the full output is stored for
 * the recall tool. Anything unexpected ends with exit 0 and no output, so Claude gets the original.
 */
import { normalizeToolResult, READ_NOTE, recallHint, type PostToolUseInput } from "./claude.ts";
import { appendLog, keyFile, pruneOutputs, saveOutput } from "./store.ts";
import { contextFromTranscript } from "./transcript.ts";

/** Below this many characters nothing is done, before any heavier module is loaded. */
const QUICK_MIN_CHARS = 4 * Number(process.env.JEV_LENS_PRESEND_MIN_TOKENS || 1200);
const HARD_TIMEOUT_MS = Number(process.env.JEV_LENS_HOOK_TIMEOUT_MS || 30000);

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const c of process.stdin) chunks.push(c as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
	let input: PostToolUseInput;
	try { input = JSON.parse(await readStdin()) as PostToolUseInput; } catch { return; }
	if (input.hook_event_name !== "PostToolUse" || !input.tool_use_id) return;
	const norm = normalizeToolResult(input);
	if (!norm || norm.text.length < QUICK_MIN_CHARS) return;

	const core = await import("jev-lens");
	const { cfg, variant } = core.loadConfigWithVariant({ keyFile: keyFile() });
	if (!cfg.enabled || !cfg.presend) return;
	const { presend, mock } = core.createPresend(cfg, core.promptsWithVariant(variant));
	const lens = new core.Lens({ cfg, presend, viewParams: variant.views ?? {}, footer: { recall: recallHint, note: norm.toolName === "read" ? READ_NOTE : undefined } });
	const context = contextFromTranscript(input.transcript_path, input.tool_use_id);
	const started = Date.now();
	const id = input.tool_use_id;
	try {
		const out = await lens.compress({ toolCallId: id, toolName: norm.toolName, args: norm.args, text: norm.text, context });
		const answer = out.answer;
		appendLog({ event: "presend", session: input.session_id, cwd: input.cwd, id, tool: input.tool_name, kind: out.kind, tokens: out.tokens, view: out.view?.kind ?? "full", sentTokens: out.sentTokens, reason: out.reason, chosen: answer?.choice, needsFull: answer?.needsFull, p: answer?.probabilities, confidence: answer?.confidence, expanded: out.expanded, candidates: out.candidates, mock, ms: out.ms, agentText: context.agentText.length > 0, agentTextSource: context.source, transcriptHasCall: context.found });
		if (!out.compressed || !out.view) return;
		saveOutput({ id, toolName: norm.toolName, args: norm.args, text: norm.text, view: out.view.kind, kind: out.kind ?? "?", sessionId: input.session_id ?? "", cwd: input.cwd ?? "", at: Date.now() });
		pruneOutputs();
		process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: norm.replace(out.text) } })}\n`);
	} catch (err) {
		const e = err as { name?: string; status?: number; message?: string };
		appendLog({ event: "presend_error", session: input.session_id, id, tool: input.tool_name, error: e?.name ?? "Error", status: e?.status, ms: Date.now() - started });
	}
}

const timer = setTimeout(() => process.exit(0), HARD_TIMEOUT_MS);
main().catch(() => {}).finally(() => { clearTimeout(timer); process.exit(0); });
