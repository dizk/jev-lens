import { describe, expect, it } from "vitest";
import { normalizeToolResult } from "../src/claude.ts";

const base = { session_id: "s", hook_event_name: "PostToolUse", tool_use_id: "toolu_1" };

describe("normalizeToolResult", () => {
	it("maps Read to read and keeps the output shape when replacing", () => {
		const file = { filePath: "/p/a.ts", content: "a\nb\nc", numLines: 3, startLine: 1, totalLines: 3 };
		const n = normalizeToolResult({ ...base, tool_name: "Read", tool_input: { file_path: "/p/a.ts", offset: 1 }, tool_response: { type: "text", file } })!;
		expect(n.toolName).toBe("read");
		expect(n.args).toEqual({ path: "/p/a.ts", offset: 1 });
		expect(n.text).toBe("a\nb\nc");
		expect(n.replace("x\ny")).toEqual({ type: "text", file: { ...file, content: "x\ny", numLines: 2 } });
	});
	it("maps Bash stdout and leaves stderr and flags alone", () => {
		const r = { stdout: "out", stderr: "err", interrupted: false, isImage: false, extra: 1 };
		const n = normalizeToolResult({ ...base, tool_name: "Bash", tool_input: { command: "ls" }, tool_response: r })!;
		expect(n.toolName).toBe("bash");
		expect(n.args).toEqual({ command: "ls" });
		expect(n.replace("view")).toEqual({ ...r, stdout: "view" });
	});
	it("maps Grep content mode only", () => {
		const n = normalizeToolResult({ ...base, tool_name: "Grep", tool_input: { pattern: "foo", path: "src" }, tool_response: { mode: "content", numFiles: 1, filenames: ["a"], content: "a:1:foo", numLines: 1 } })!;
		expect(n.toolName).toBe("grep");
		expect(n.args).toEqual({ pattern: "foo", path: "src" });
		expect(n.replace("a:1:foo\n⋯")).toMatchObject({ mode: "content", content: "a:1:foo\n⋯", numLines: 2, filenames: ["a"] });
		expect(normalizeToolResult({ ...base, tool_name: "Grep", tool_input: {}, tool_response: { mode: "files_with_matches", numFiles: 1, filenames: ["a"] } })).toBeUndefined();
	});
	it("ignores images, non-text reads, other tools and unknown shapes", () => {
		expect(normalizeToolResult({ ...base, tool_name: "Bash", tool_input: {}, tool_response: { stdout: "x", isImage: true } })).toBeUndefined();
		expect(normalizeToolResult({ ...base, tool_name: "Read", tool_input: {}, tool_response: { type: "image", file: { content: "x" } } })).toBeUndefined();
		expect(normalizeToolResult({ ...base, tool_name: "Edit", tool_input: {}, tool_response: { filePath: "a" } })).toBeUndefined();
		expect(normalizeToolResult({ ...base, tool_name: "Read", tool_input: {}, tool_response: "plain string" })).toBeUndefined();
	});
});
