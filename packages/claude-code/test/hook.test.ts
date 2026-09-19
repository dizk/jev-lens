/** End to end through a real node process, the way Claude Code runs the hook (mock classifier). */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const hook = new URL("../src/hook.ts", import.meta.url).pathname;
const code = readFileSync(new URL("../../../eval/fixture/src/categories.js", import.meta.url), "utf8");

function run(event: unknown, dataDir: string) {
	const r = spawnSync(process.execPath, [hook], { input: JSON.stringify(event), encoding: "utf8", env: { ...process.env, JEV_LENS_CLASSIFIER: "mock", JEV_LENS_DATA_DIR: dataDir, TYPESAFE_API_KEY: "" }, timeout: 60000 });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const readEvent = (content: string, id = "toolu_A") => ({
	session_id: "sess", transcript_path: "/nonexistent.jsonl", cwd: "/tmp", hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: id,
	tool_input: { file_path: "/x/categories.js" },
	tool_response: { type: "text", file: { filePath: "/x/categories.js", content, numLines: content.split("\n").length, startLine: 1, totalLines: content.split("\n").length } },
});

describe("PostToolUse hook process", () => {
	it("replaces a large Read with a view in the Read output shape and stores the full text", () => {
		const dir = mkdtempSync(join(tmpdir(), "jevhook-"));
		const r = run(readEvent(code), dir);
		expect(r.status).toBe(0);
		const out = JSON.parse(r.stdout);
		const file = out.hookSpecificOutput.updatedToolOutput.file;
		expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
		expect(file.filePath).toBe("/x/categories.js");
		expect(file.totalLines).toBe(code.split("\n").length);
		expect(file.content.length).toBeLessThan(code.length);
		expect(file.content).toContain("[jev-lens: showing");
		expect(file.content).toContain('recall tool with id "toolu_A"');
		expect(file.numLines).toBe(file.content.split("\n").length);
		const stored = JSON.parse(readFileSync(join(dir, "outputs", "toolu_A.json"), "utf8"));
		expect(stored.text).toBe(code);
		expect(stored.toolName).toBe("read");
		const log = readFileSync(join(dir, "log.jsonl"), "utf8");
		expect(log).toContain('"event":"presend"');
	});
	it("takes the context from the captured events on the main thread, and from the transcript in a sub-agent", () => {
		const dir = mkdtempSync(join(tmpdir(), "jevhook-"));
		const events = [
			{ hook_event_name: "UserPromptSubmit", session_id: "sess", prompt: "Find normalizeCategory" },
			{ hook_event_name: "MessageDisplay", session_id: "sess", message_id: "m1", index: 0, final: true, delta: "Reading categories.js.\n" },
		].map((e) => JSON.stringify(e)).join("\n");
		writeFileSync(join(dir, "events.jsonl"), `${events}\n`);
		expect(run(readEvent(code), dir).status).toBe(0);
		const main = JSON.parse(readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").pop()!);
		expect(main).toMatchObject({ event: "presend", contextVia: "events", agentTextSource: "turn", agentText: true, subagent: false });
		expect(main.transcriptHasCall).toBeUndefined();
		expect(run({ ...readEvent(code, "toolu_B"), agent_id: "agent-1" }, dir).status).toBe(0);
		const sub = JSON.parse(readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").pop()!);
		expect(sub).toMatchObject({ event: "presend", id: "toolu_B", contextVia: "transcript", agentTextSource: "none", agentText: false, transcriptHasCall: false, subagent: true });
	});
	it("captures a hook's input with the shell command registered for UserPromptSubmit and MessageDisplay", () => {
		const dir = mkdtempSync(join(tmpdir(), "jevhook-"));
		const hooks = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"));
		const command = hooks.hooks.MessageDisplay[0].hooks[0].command as string;
		expect(hooks.hooks.UserPromptSubmit[0].hooks[0].command).toBe(command);
		const env = { ...process.env, JEV_LENS_DATA_DIR: join(dir, "nested", "data"), CLAUDE_PLUGIN_DATA: "/nonexistent" };
		const r = spawnSync("sh", ["-c", command], { input: '{"hook_event_name":"MessageDisplay","session_id":"sess","delta":"hi\\n"}\n', encoding: "utf8", env });
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(readFileSync(join(dir, "nested", "data", "events.jsonl"), "utf8")).toBe('{"hook_event_name":"MessageDisplay","session_id":"sess","delta":"hi\\n"}\n');
	});
	it("says nothing for a small result and leaves no trace", () => {
		const dir = mkdtempSync(join(tmpdir(), "jevhook-"));
		const r = run(readEvent("small\nfile"), dir);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(existsSync(join(dir, "log.jsonl"))).toBe(false);
	});
	it("says nothing for other events, other tools and malformed input", () => {
		const dir = mkdtempSync(join(tmpdir(), "jevhook-"));
		expect(run({ ...readEvent(code), hook_event_name: "PreToolUse" }, dir).stdout).toBe("");
		expect(run({ ...readEvent(code), tool_name: "Edit" }, dir).stdout).toBe("");
		const r = spawnSync(process.execPath, [hook], { input: "{not json", encoding: "utf8", env: { ...process.env, JEV_LENS_DATA_DIR: dir }, timeout: 60000 });
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
	});
	it("does nothing when disabled", () => {
		const dir = mkdtempSync(join(tmpdir(), "jevhook-"));
		const r = spawnSync(process.execPath, [hook], { input: JSON.stringify(readEvent(code)), encoding: "utf8", env: { ...process.env, JEV_LENS_CLASSIFIER: "mock", JEV_LENS_DATA_DIR: dir, JEV_LENS_DISABLED: "1" }, timeout: 60000 });
		expect(r.stdout).toBe("");
	});
});
