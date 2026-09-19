import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { callTool, handle } from "../src/mcp.ts";
import { saveOutput } from "../src/store.ts";

const text = Array.from({ length: 60 }, (_, i) => `line ${i + 1}${i === 9 ? " needle" : ""}`).join("\n");

describe("recall MCP server", () => {
	beforeAll(() => {
		process.env.JEV_LENS_DATA_DIR = mkdtempSync(join(tmpdir(), "jevmcp-"));
		saveOutput({ id: "toolu_X", toolName: "bash", args: { command: "ls" }, text, view: "signals", kind: "command", sessionId: "s", cwd: "/", at: Date.now() });
	});
	it("answers initialize, lists both tools and rejects unknown methods", () => {
		const init = handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) as any;
		expect(init.result.protocolVersion).toBe("2024-11-05");
		expect(init.result.capabilities.tools).toEqual({});
		expect((handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as any).result.tools.map((t: any) => t.name)).toEqual(["recall", "stats"]);
		expect((handle({ jsonrpc: "2.0", id: 3, method: "nope" }) as any).error.code).toBe(-32601);
		expect(handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
	});
	it("recalls the whole output, a line range and a pattern, and reports a missing id as an error", () => {
		expect(callTool("recall", { id: "toolu_X" }).content[0].text).toBe(text);
		expect(callTool("recall", { id: "toolu_X", lines: "3-4" }).content[0].text).toBe("[2 of 60 lines from bash {\"command\":\"ls\"}]\n 3│ line 3\n 4│ line 4");
		const p = callTool("recall", { id: "toolu_X", pattern: "needle" });
		expect(p.content[0].text.split("\n")).toHaveLength(6);
		expect(p.content[0].text).toContain("10│ line 10 needle");
		expect(callTool("recall", { id: "../../etc/passwd" }).isError).toBe(true);
		expect(callTool("recall", { id: "toolu_X", lines: "x" }).isError).toBe(true);
	});
	it("summarizes the log through stats", () => {
		expect(callTool("stats", {}).content[0].text).toContain("jev-lens");
	});
	it("speaks newline-delimited JSON-RPC over stdio as a process", () => {
		const server = new URL("../src/mcp.ts", import.meta.url).pathname;
		const input = [
			{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recall", arguments: { id: "toolu_X", lines: "1-2" } } },
		].map((m) => JSON.stringify(m)).join("\n") + "\n";
		const r = spawnSync(process.execPath, [server], { input, encoding: "utf8", env: { ...process.env }, timeout: 60000 });
		const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
		expect(lines).toHaveLength(2);
		expect(lines[0].result.serverInfo.name).toBe("jev-lens");
		expect(lines[1].result.content[0].text).toContain("1│ line 1");
	});
});
