import type { AgentMessage } from "./pi-types.ts";

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("\n");
}

export function toolCallsOf(message: AgentMessage): { name: string; arguments: unknown }[] {
	if (message.role !== "assistant") return [];
	const out: { name: string; arguments: unknown }[] = [];
	for (const block of message.content) {
		if (block.type === "toolCall") out.push({ name: block.name, arguments: block.arguments });
	}
	return out;
}

export function head(s: string, n: number): string {
	return s.length <= n ? s : s.slice(0, n);
}

export function tail(s: string, n: number): string {
	return s.length <= n ? "" : s.slice(-n);
}

export function truncate(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** Rough token estimate matching pi's heuristic (chars / 4). */
export function estimateTokensOfText(s: string): number {
	return Math.ceil(s.length / 4);
}

/** Short, stable description of a tool call for stubs and memory pointers. */
export function describeToolCall(toolName: string, args: unknown, outputChars: number, lines: number): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const pick = (k: string): string | undefined => (typeof a[k] === "string" ? (a[k] as string) : undefined);
	let what = "";
	switch (toolName) {
		case "read":
			what = pick("path") ?? "";
			break;
		case "bash":
			what = truncate((pick("command") ?? "").replace(/\s+/g, " "), 80);
			break;
		case "grep":
			what = `${pick("pattern") ?? ""} in ${pick("path") ?? "."}`;
			break;
		case "find":
		case "ls":
			what = pick("path") ?? pick("pattern") ?? "";
			break;
		case "edit":
		case "write":
			what = pick("path") ?? "";
			break;
		default:
			what = truncate(JSON.stringify(a), 80);
	}
	return `${toolName} ${what}`.trim() + ` (${lines} lines, ${outputChars} chars)`;
}
