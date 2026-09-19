import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveOutput, type StoredOutput } from "../src/store.ts";
import { convertTranscript, listTranscripts, mapToolCall, trajectoryId } from "../src/trajectory.ts";

const line = (o: unknown) => JSON.stringify(o);
const full = Array.from({ length: 80 }, (_, i) => `export const v${i} = ${i};`).join("\n");
const view = "export const v0 = 0;\n⋯ 78 lines omitted\nexport const v79 = 79;\n\n[jev-lens: showing the \"outline\" view]";
const numbered = view.split("\n").map((l, i) => `${String(i + 1).padStart(6)}→${l}`).join("\n");
const ts = (s: number) => new Date(1789800000000 + s * 1000).toISOString();

const transcript = [
	line({ type: "mode", mode: "normal" }),
	line({ type: "user", cwd: "/repo", timestamp: ts(0), message: { role: "user", content: "Rename v79" } }),
	line({ type: "assistant", timestamp: ts(1), message: { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: "" }] } }),
	line({ type: "assistant", timestamp: ts(1), message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Reading the file." }] } }),
	line({ type: "assistant", timestamp: ts(1), message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/a.ts", limit: 100 } }] } }),
	// the compressed Read: Claude saw the numbered view, toolUseResult holds the view, the store holds the full text
	line({ type: "user", timestamp: ts(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: numbered }] }, toolUseResult: { type: "text", file: { filePath: "/repo/a.ts", content: view } } }),
	line({ type: "assistant", timestamp: ts(3), message: { id: "m2", role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } }, { type: "tool_use", id: "t3", name: "mcp__plugin_jev-lens_jev-lens__recall", input: { id: "t1", lines: "70-80" } }] } }),
	line({ type: "user", timestamp: ts(4), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "a.ts\nb.ts\nwarn" }] }, toolUseResult: { stdout: "a.ts\nb.ts", stderr: "warn", interrupted: false } }),
	line({ type: "user", timestamp: ts(4), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: [{ type: "text", text: "70│ ..." }], is_error: false }] }, toolUseResult: [{ type: "text", text: "70│ ..." }] }),
	line({ type: "assistant", timestamp: ts(5), message: { id: "m3", role: "assistant", content: [{ type: "tool_use", id: "t4", name: "Edit", input: { file_path: "/repo/a.ts", old_string: "export const v79 = 79;", new_string: "export const last = 79;" } }] } }),
	line({ type: "user", timestamp: ts(6), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t4", content: "The file has been updated.", is_error: true }] } }),
	line({ type: "user", isMeta: true, timestamp: ts(7), message: { role: "user", content: "meta" } }),
	line({ type: "user", timestamp: ts(8), message: { role: "user", content: [{ type: "text", text: "Thanks" }] } }),
	"not json",
];

const stored: StoredOutput = { id: "t1", toolName: "read", args: { path: "/repo/a.ts" }, text: full, view: "outline", kind: "code", sessionId: "s", cwd: "/repo", at: 1 };

describe("trajectory export", () => {
	it("maps Claude Code's tools to the canonical ones", () => {
		expect(mapToolCall("Read", { file_path: "x", offset: 5 })).toEqual({ name: "read", arguments: { path: "x", offset: 5 } });
		expect(mapToolCall("Grep", { pattern: "foo" })).toEqual({ name: "grep", arguments: { pattern: "foo", path: "." } });
		expect(mapToolCall("MultiEdit", { file_path: "x", edits: [{ old_string: "a", new_string: "b" }] })).toEqual({ name: "edit", arguments: { path: "x", edits: [{ oldText: "a", newText: "b" }] } });
		expect(mapToolCall("Write", { file_path: "x", content: "c" })).toEqual({ name: "write", arguments: { path: "x", content: "c" } });
		expect(mapToolCall("mcp__plugin_jev-lens_jev-lens__recall", { id: "t", pattern: "p" })).toEqual({ name: "recall", arguments: { id: "t", pattern: "p" } });
		expect(mapToolCall("WebFetch", { url: "u" })).toEqual({ name: "WebFetch", arguments: { url: "u" } });
	});
	it("rebuilds the conversation with full outputs where the plugin compressed, in pi's message shape", () => {
		const t = convertTranscript(transcript, "sess", (id) => (id === "t1" ? stored : undefined));
		expect(t.id).toBe("sess");
		expect(t.cwd).toBe("/repo");
		const roles = t.messages.map((m) => (m as { role: string }).role);
		expect(roles).toEqual(["user", "assistant", "toolResult", "assistant", "toolResult", "toolResult", "assistant", "toolResult", "user"]);
		const m = t.messages as any[];
		expect(m[0].content).toEqual([{ type: "text", text: "Rename v79" }]);
		// thinking is dropped, text and the call are kept, blocks of one message are merged
		expect(m[1].content).toEqual([{ type: "text", text: "Reading the file." }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "/repo/a.ts", limit: 100 } }]);
		expect(m[1].stopReason).toBe("toolUse");
		expect(m[1].timestamp).toBe(Date.parse(ts(1)));
		// the compressed Read carries the full text and the recorded view
		expect(m[2]).toMatchObject({ role: "toolResult", toolCallId: "t1", toolName: "read", isError: false, details: { view: "outline", kind: "code" } });
		expect(m[2].content[0].text).toBe(full);
		expect(m[3].content.map((c: any) => c.name)).toEqual(["bash", "recall"]);
		expect(m[3].content[1].arguments).toEqual({ id: "t1", lines: "70-80" });
		// an uncompressed Bash result is stdout plus stderr from the structured result, no details
		expect(m[4]).toMatchObject({ toolName: "bash", isError: false });
		expect(m[4].content[0].text).toBe("a.ts\nb.ts\nwarn");
		expect(m[4].details).toBeUndefined();
		expect(m[5]).toMatchObject({ toolName: "recall" });
		expect(m[5].content[0].text).toBe("70│ ...");
		expect(m[6].content[0]).toEqual({ type: "toolCall", id: "t4", name: "edit", arguments: { path: "/repo/a.ts", edits: [{ oldText: "export const v79 = 79;", newText: "export const last = 79;" }] } });
		expect(m[7]).toMatchObject({ toolName: "edit", isError: true });
		expect(m[8].content[0].text).toBe("Thanks");
	});
	it("exports a project directory and its sub-agent transcripts as a process, restoring from the outputs store", () => {
		const home = mkdtempSync(join(tmpdir(), "jevhome-"));
		const data = mkdtempSync(join(tmpdir(), "jevdata-"));
		process.env.JEV_LENS_DATA_DIR = data;
		saveOutput(stored);
		const proj = join(home, "projects", "-repo");
		mkdirSync(join(proj, "sess", "subagents"), { recursive: true });
		writeFileSync(join(proj, "sess.jsonl"), transcript.join("\n"));
		writeFileSync(join(proj, "sess", "subagents", "agent-1.jsonl"), [
			line({ type: "user", isSidechain: true, message: { role: "user", content: "Sub task" } }),
			line({ type: "assistant", isSidechain: true, message: { id: "s1", role: "assistant", content: [{ type: "tool_use", id: "t7", name: "Bash", input: { command: "pwd" } }] } }),
			line({ type: "user", isSidechain: true, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t7", content: "/repo" }] }, toolUseResult: { stdout: "/repo", stderr: "" } }),
		].join("\n"));
		writeFileSync(join(proj, "empty.jsonl"), line({ type: "user", message: { role: "user", content: "no tools here" } }));
		expect(listTranscripts([proj]).map((f) => trajectoryId(f))).toEqual(["empty", "sess", "sess/agent-1"]);
		const script = new URL("../src/trajectory.ts", import.meta.url).pathname;
		const r = spawnSync(process.execPath, [script, proj], { encoding: "utf8", env: { ...process.env, HOME: home, JEV_LENS_DATA_DIR: data } });
		expect(r.status).toBe(0);
		const out = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
		expect(out.map((t) => t.id)).toEqual(["sess", "sess/agent-1"]);
		expect(out[0].messages[2].content[0].text).toBe(full);
		expect(out[1].messages[2]).toMatchObject({ role: "toolResult", toolName: "bash" });
		expect(r.stderr).toContain("2 trajectories, 5 tool results, 1 restored from the outputs store");
		expect(spawnSync(process.execPath, [script], { encoding: "utf8" }).status).toBe(2);
	});
});
