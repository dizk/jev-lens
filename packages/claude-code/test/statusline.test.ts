import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sessionTotals, statusText } from "../src/statusline.ts";

const records = [
	{ t: 1, event: "presend", session: "A", id: "t1", tool: "Bash", view: "focus", tokens: 2000, sentTokens: 500 },
	{ t: 2, event: "presend", session: "A", id: "t2", tool: "Read", view: "full", tokens: 3000, sentTokens: 3000 },
	{ t: 3, event: "recall", id: "t1", found: true },
	{ t: 4, event: "presend", session: "B", id: "t3", tool: "Bash", view: "signals", tokens: 9000, sentTokens: 100, mock: true },
	{ t: 5, event: "recall", id: "t3", found: true },
	{ t: 6, event: "recall", id: "t3", found: true, lines: "1-3" },
	{ t: 7, event: "presend_error", session: "B", id: "t4", tool: "Bash", error: "TimeoutError" },
];

describe("status line segment", () => {
	it("sums one session's records and counts the recalls of its results", () => {
		expect(sessionTotals(records, "A")).toEqual({ considered: 2, compressed: 1, tokensSaved: 1500, recalls: 1, errors: 0, mock: false });
		expect(sessionTotals(records, "B")).toEqual({ considered: 1, compressed: 1, tokensSaved: 8900, recalls: 2, errors: 1, mock: true });
		expect(sessionTotals(records, "C")).toEqual({ considered: 0, compressed: 0, tokensSaved: 0, recalls: 0, errors: 0, mock: false });
	});
	it("reads like the pi extension's status line", () => {
		expect(statusText(sessionTotals(records, "A"))).toBe("jev-lens −1.5k · 1/2 · 1 recall");
		expect(statusText(sessionTotals(records, "B"))).toBe("jev-lens(mock)(degraded) −8.9k · 1/1 · 2 recalls");
		expect(statusText(sessionTotals(records, "C"))).toBe("jev-lens −0.0k · 0/0 · 0 recalls");
	});
	it("prints the segment for the session in the statusLine JSON on stdin, and nothing for bad input", () => {
		const dir = mkdtempSync(join(tmpdir(), "jevstatus-"));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "log.jsonl"), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
		const script = new URL("../src/statusline.ts", import.meta.url).pathname;
		const env = { ...process.env, JEV_LENS_DATA_DIR: dir, JEV_LENS_DISABLED: "" };
		const run = (input: string) => spawnSync(process.execPath, [script], { input, env, encoding: "utf8" });
		expect(run(JSON.stringify({ session_id: "A", model: { display_name: "x" } })).stdout).toBe("jev-lens −1.5k · 1/2 · 1 recall");
		expect(run("not json").stdout).toBe("");
		expect(run("{}").status).toBe(0);
	});
});
