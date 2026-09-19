/**
 * Claude Code's tool results, mapped to the core's canonical tools (read, bash, grep) and back. The
 * replacement must keep the tool's output shape: Claude Code ignores an `updatedToolOutput` that does
 * not match the built-in tool's schema and sends the original instead.
 */
export interface PostToolUseInput {
	session_id?: string;
	transcript_path?: string;
	cwd?: string;
	hook_event_name?: string;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	tool_response?: unknown;
	tool_use_id?: string;
}

export interface Normalized {
	/** Canonical tool name the core understands. */
	toolName: "read" | "bash" | "grep";
	args: Record<string, unknown>;
	/** The text the views are built from. */
	text: string;
	/** The original response with `text` replaced by a view, in the tool's own shape. */
	replace: (text: string) => unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Undefined when the result is not one this plugin compresses (images, empty files, non-content grep modes, unknown shapes). */
export function normalizeToolResult(input: PostToolUseInput): Normalized | undefined {
	const r = input.tool_response;
	const a = isObj(input.tool_input) ? input.tool_input : {};
	if (!isObj(r)) return undefined;
	switch (input.tool_name) {
		case "Read": {
			const file = r.file;
			if (r.type !== "text" || !isObj(file) || typeof file.content !== "string") return undefined;
			const path = typeof file.filePath === "string" ? file.filePath : typeof a.file_path === "string" ? a.file_path : "";
			return {
				toolName: "read",
				args: { path, ...(a.offset !== undefined ? { offset: a.offset } : {}), ...(a.limit !== undefined ? { limit: a.limit } : {}) },
				text: file.content,
				replace: (text) => ({ ...r, file: { ...file, content: text, numLines: text.split("\n").length } }),
			};
		}
		case "Bash": {
			if (typeof r.stdout !== "string" || r.isImage === true) return undefined;
			return {
				toolName: "bash",
				args: { command: typeof a.command === "string" ? a.command : "" },
				text: r.stdout,
				replace: (text) => ({ ...r, stdout: text }),
			};
		}
		case "Grep": {
			if (r.mode !== "content" || typeof r.content !== "string") return undefined;
			return {
				toolName: "grep",
				args: { pattern: typeof a.pattern === "string" ? a.pattern : "", path: typeof a.path === "string" ? a.path : "." },
				text: r.content,
				replace: (text) => ({ ...r, content: text, numLines: text.split("\n").length }),
			};
		}
		default:
			return undefined;
	}
}

/** How the footer tells Claude to get the rest. */
export function recallHint(id: string): string {
	return `Call the jev-lens recall tool with id "${id}" for the full output, or add lines: "a-b" or pattern: "..." for a slice.`;
}

/** Claude Code prefixes every line of a Read result with its own sequential number, so a gapped view needs this. */
export const READ_NOTE = "The numbers before │ are the file's own line numbers; any other numbers in front of them count lines of this view only.";
