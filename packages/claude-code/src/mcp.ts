/**
 * The plugin's MCP server over stdio: `recall` serves the full output (or a slice) of a compressed
 * result by id, `stats` summarizes the log. Plain JSON-RPC 2.0, one message per line, no dependencies.
 */
import { createInterface } from "node:readline";
import { RECALL_DESCRIPTION, RECALL_PARAM_DESCRIPTIONS, recallMissText, sliceRecall } from "jev-lens";
import { statsText } from "./stats.ts";
import { appendLog, loadOutput } from "./store.ts";

const VERSION = "0.5.1";

interface Request { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> }

const TOOLS = [
	{
		name: "recall",
		description: RECALL_DESCRIPTION,
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: RECALL_PARAM_DESCRIPTIONS.id },
				lines: { type: "string", description: RECALL_PARAM_DESCRIPTIONS.lines },
				pattern: { type: "string", description: RECALL_PARAM_DESCRIPTIONS.pattern },
			},
			required: ["id"],
		},
	},
	{
		name: "stats",
		description: "What jev-lens compressed in recent sessions and how many tokens it kept out of the prompt.",
		inputSchema: { type: "object", properties: {} },
	},
];

function text(t: string, isError = false) {
	return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

export function callTool(name: string, args: Record<string, unknown>): { content: { type: string; text: string }[]; isError?: boolean } {
	if (name === "stats") return text(statsText());
	if (name !== "recall") return text(`Unknown tool ${name}`, true);
	const id = typeof args.id === "string" ? args.id : "";
	const hit = loadOutput(id);
	appendLog({ event: "recall", id, found: !!hit, lines: args.lines, pattern: args.pattern });
	if (!hit) return text(recallMissText(id), true);
	const slice = sliceRecall(hit, { lines: typeof args.lines === "string" ? args.lines : undefined, pattern: typeof args.pattern === "string" ? args.pattern : undefined });
	return text(slice.text, !!slice.error);
}

export function handle(req: Request): unknown {
	const { id, method, params = {} } = req;
	const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
	const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
	switch (method) {
		case "initialize":
			return reply({ protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "jev-lens", version: VERSION } });
		case "ping":
			return reply({});
		case "tools/list":
			return reply({ tools: TOOLS });
		case "tools/call": {
			const name = typeof params.name === "string" ? params.name : "";
			const args = params.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
			try { return reply(callTool(name, args)); }
			catch (err) { return reply(text(`recall failed: ${(err as Error).message}`, true)); }
		}
		default:
			if (id === undefined || id === null) return undefined; // a notification
			return fail(-32601, `Method not found: ${method}`);
	}
}

export function serve(): void {
	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
	rl.on("line", (line) => {
		if (!line.trim()) return;
		let req: Request;
		try { req = JSON.parse(line) as Request; } catch { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`); return; }
		const res = handle(req);
		if (res !== undefined) process.stdout.write(`${JSON.stringify(res)}\n`);
	});
	rl.on("close", () => process.exit(0));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) serve();
