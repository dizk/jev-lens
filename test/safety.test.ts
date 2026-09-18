import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../index.ts";
import { JevClassifier, MockClassifier } from "../src/classifier.ts";
import { loadConfig } from "../src/config.ts";
import { MockPresend } from "../src/presend.ts";
import { transformToolResult } from "../src/policy.ts";
import { buildCandidates, displayedFiles, kindOfFiles, relevantView } from "../src/views.ts";
import { scoreMessages } from "../eval/presend-score.ts";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "jev-safety-")); dirs.push(dir); return dir; };
const result = (id = "r") => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "x".repeat(8000) }], isError: false, timestamp: 1 });
const assistant = (calls: any[] = []) => ({ role: "assistant", content: [{ type: "text", text: "done" }, ...calls], stopReason: "stop", timestamp: 1 });
const call = (name: string, args: any, id = "c") => ({ type: "toolCall", id, name, arguments: args });
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}
function harness() {
	const handlers = new Map<string, any[]>(), entries: any[] = [], tools = new Map<string, any>(), commands = new Map<string, any>();
	extension({ on: (n: string, h: any) => handlers.set(n, [...(handlers.get(n) ?? []), h]), registerTool: (t: any) => tools.set(t.name, t), registerCommand: (name: string, def: any) => commands.set(name, def), appendEntry: (customType: string, data: any) => entries.push({ customType, data }) } as any);
	const ctx = { cwd: temp(), hasUI: false, sessionManager: { getEntries: () => [], getBranch: () => [] } };
	const emit = async (n: string, event: any = {}, context = ctx) => {
		let returned: any;
		for (const h of handlers.get(n) ?? []) returned = (await h(event, context)) ?? returned;
		return returned;
	};
	return { emit, ctx, entries, tools, commands };
}

beforeEach(() => {
	vi.stubEnv("JEV_LENS_CLASSIFIER", "mock");
	vi.stubEnv("JEV_LENS_MODE", "rolling"); // post-send is off by default; these tests exercise it
	vi.stubEnv("JEV_LENS_VARIANT", "");
	vi.stubEnv("JEV_LENS_UI", "0");
	vi.stubEnv("JEV_LENS_LOG", "0");
	vi.stubEnv("JEV_LENS_CLASSIFY_WAIT_MS", "30");
});
afterEach(() => {
	vi.restoreAllMocks(); vi.unstubAllEnvs();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("content safety", () => {
	it("preserves spaces, trailing whitespace and long literals in expanded code", () => {
		const body = ['function f() {', '  return "a        b' + '='.repeat(500) + '";  ', '}'];
		const view = relevantView(body.join("\n"), "code", [{ name: "f", from: 1, to: 3 }], new Set([0]), [1]);
		expect(view.text.split("\n").map((l) => l.replace(/^\d+│ /, ""))).toEqual(body);
	});
	it("preserves mixed image results even with a restored pruning decision", () => {
		const m = { ...result(), content: [...result().content, { type: "image", data: "abc", mimeType: "image/png" }] };
		for (const bucket of ["trim", "forget"]) expect(transformToolResult(m as any, { bucket } as any, loadConfig())).toBe(m);
	});
	it("does not classify mixed image results", async () => {
		const spy = vi.spyOn(MockClassifier.prototype, "classifyToolResult");
		const h = harness(); await h.emit("session_start");
		await h.emit("turn_end", { toolResults: [{ ...result(), content: [...result().content, { type: "image", data: "abc", mimeType: "image/png" }] }] });
		await h.emit("agent_end");
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("visible failures", () => {
	const code = readFileSync(new URL("../eval/fixture/src/categories.js", import.meta.url), "utf8");
	const event = { toolName: "read", toolCallId: "r", input: { path: "a.js" }, content: [{ type: "text", text: code }], isError: false };
	function ui(h: ReturnType<typeof harness>) {
		return { ...h.ctx, hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn() } };
	}
	it("keeps full output on failure, warns once, and clears degraded status on success", async () => {
		const choose = vi.spyOn(MockPresend.prototype, "choose").mockRejectedValue({ status: 401, message: "ts_secret" });
		const h = harness(), ctx = ui(h);
		await h.emit("session_start", {}, ctx);
		for (let i = 0; i < 3; i++) expect(await h.emit("tool_result", event, ctx)).toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify.mock.calls[0][0]).toContain("Full output was kept");
		expect(ctx.ui.setStatus.mock.lastCall?.[1]).toContain("degraded");
		choose.mockResolvedValue({ choice: "full", probabilities: { full: 1 }, needsFull: 1, confidence: 1 });
		expect(await h.emit("tool_result", event, ctx)).toBeUndefined();
		expect(ctx.ui.setStatus.mock.lastCall?.[1]).not.toContain("degraded");
		await h.commands.get("jev-lens").handler("stats", ctx);
		expect(ctx.ui.notify.mock.lastCall?.[0]).toContain("presend failures: 3 (a later attempt succeeded)");
		expect(JSON.stringify(ctx.ui.notify.mock.calls)).not.toContain("ts_secret");
	});
	it("also reports block expansion failures without sending a partial view", async () => {
		vi.spyOn(MockPresend.prototype, "choose").mockResolvedValue({ choice: "outline", probabilities: { outline: 1 }, needsFull: 0, confidence: 1 });
		vi.spyOn(MockPresend.prototype, "expand").mockRejectedValue(new Error("offline"));
		const h = harness(), ctx = ui(h);
		await h.emit("session_start", {}, ctx);
		expect(await h.emit("tool_result", event, ctx)).toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
	});
	it("ignores cancelled and stale failures and resets counters for a new session", async () => {
		let reject!: (e: unknown) => void;
		const choose = vi.spyOn(MockPresend.prototype, "choose").mockImplementation(() => new Promise((_resolve, r) => { reject = r; }));
		const h = harness(), ctx = ui(h), abort = new AbortController();
		await h.emit("session_start", {}, ctx);
		const work = h.emit("tool_result", event, { ...ctx, signal: abort.signal } as any);
		await vi.waitFor(() => expect(choose).toHaveBeenCalledTimes(1));
		abort.abort(); reject(new Error("cancelled")); await work;
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		const stale = h.emit("tool_result", event, ctx);
		await vi.waitFor(() => expect(choose).toHaveBeenCalledTimes(2));
		await h.emit("session_start", {}, ctx);
		reject(new Error("old session")); await stale;
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		choose.mockRejectedValue(new Error("new failure"));
		await h.emit("tool_result", event, ctx);
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		await h.emit("session_start", {}, ctx);
		await h.commands.get("jev-lens").handler("stats", ctx);
		expect(ctx.ui.notify.mock.lastCall?.[0]).toContain("presend failures: 0");
	});
	it("reports post-send failures from a headless context on the next UI update", async () => {
		vi.spyOn(MockClassifier.prototype, "classifyToolResult").mockRejectedValue(new Error("offline"));
		const h = harness(), ctx = ui(h);
		await h.emit("session_start", {}, ctx);
		await h.emit("turn_end", { toolResults: [result()] });
		await h.emit("agent_end"); // this context has no UI
		await h.emit("context", { messages: [] }, ctx);
		expect(ctx.ui.notify.mock.lastCall?.[0]).toContain("Post-send classification failed");
	});
	it("reports post-send failures at agent end without waiting for another turn", async () => {
		vi.spyOn(MockClassifier.prototype, "classifyToolResult").mockRejectedValue(new Error("offline"));
		const h = harness(), ctx = ui(h);
		await h.emit("session_start", {}, ctx);
		await h.emit("turn_end", { toolResults: [result()] }, ctx);
		await h.emit("agent_end", {}, ctx);
		expect(ctx.ui.notify.mock.lastCall?.[0]).toContain("Post-send classification failed");
	});
});

describe("conservative shell recognition", () => {
	it.each([
		"cat a.ts|python processor.py", "cat a.ts | cat report.txt", "cat a.ts|head -n 10 report.txt",
		"cat a.ts > /tmp/copy; cat report.txt", "cat a.ts 2>&1", "sed -i 's/a/b/' x.ts",
		"sed -n '1p;2p' x.ts", "cat $(echo x.ts)", "cat x.ts || cat y.ts", "cat x.ts &",
		"cat x.ts &&", "cat x.ts|", "cat 'x.ts", "cat -n x.ts", "nl x.ts", "/tmp/cat x.ts",
	])("rejects unsafe or unsupported syntax: %s", (command) => expect(displayedFiles(command)).toBeUndefined());
	it("understands pipelines without spaces and quoted separators", () => {
		expect(displayedFiles("cat src/{a,b}.ts|head -n 20|tail -5")).toEqual(["src/a.ts", "src/b.ts"]);
		expect(displayedFiles("cat 'a;b.ts' && sed -n '1,80p' x.ts")).toEqual(["a;b.ts", "x.ts"]);
	});
	it("does not force mixed source/log output into code policy", () => {
		expect(kindOfFiles(["a.ts", "report.txt"])).toBeUndefined();
		expect(kindOfFiles(["a.ts", "LICENSE"])).toBeUndefined();
		const text = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n' + 'ERROR failure\n'.repeat(100);
		expect(buildCandidates("bash", { command: "cat a.ts report.txt" }, text, []).kind).toBe("command");
	});
});

describe("asynchronous session isolation", () => {
	it("discards old responses without deleting new in-flight work with the same id", async () => {
		const old = deferred<any>(), fresh = deferred<any>();
		vi.spyOn(MockClassifier.prototype, "classifyToolResult").mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
		const h = harness(); await h.emit("session_start");
		await h.emit("turn_end", { toolResults: [result()] });
		await h.emit("message_end", { message: assistant() });
		await h.emit("session_start");
		await h.emit("turn_end", { toolResults: [result()] });
		await h.emit("message_end", { message: assistant() });
		old.resolve({ needed: 0, outcomeOnly: 0, durable: 1 });
		await new Promise((r) => setTimeout(r, 0));
		expect(h.entries).toHaveLength(0);
		const finish = h.emit("agent_end");
		fresh.resolve({ needed: 1, outcomeOnly: 0, durable: 0 });
		await finish;
		expect(h.entries).toHaveLength(1);
		expect(h.entries[0].data.decision.bucket).toBe("keep");
	});
	it("discards a pre-send result completed after session replacement", async () => {
		const d = deferred<any>();
		const choose = vi.spyOn(MockPresend.prototype, "choose").mockReturnValue(d.promise);
		const h = harness(); await h.emit("session_start");
		const code = readFileSync(new URL("../eval/fixture/src/categories.js", import.meta.url), "utf8");
		const work = h.emit("tool_result", { toolName: "read", toolCallId: "old", input: { path: "a.js" }, content: [{ type: "text", text: code }], isError: false });
		await vi.waitFor(() => expect(choose).toHaveBeenCalled());
		await h.emit("session_start");
		d.resolve({ choice: "outline", probabilities: { outline: 1 }, needsFull: 0, confidence: 1 });
		expect(await work).toBeUndefined();
		const recall = await h.tools.get("recall").execute("r", { id: "old" });
		expect(recall.content[0].text).toContain("No stored output");
	});
	it("bounds shutdown and ignores responses after its deadline", async () => {
		const d = deferred<any>(); let signal: AbortSignal | undefined;
		vi.spyOn(MockClassifier.prototype, "classifyToolResult").mockImplementation((...args: any[]) => { signal = args[1]; return d.promise; });
		const h = harness(); await h.emit("session_start");
		await h.emit("turn_end", { toolResults: [result()] });
		await h.emit("message_end", { message: assistant() });
		await h.emit("session_shutdown");
		expect(signal?.aborted).toBe(true);
		d.resolve({ needed: 0, outcomeOnly: 0, durable: 1 });
		await new Promise((r) => setTimeout(r, 0));
		expect(h.entries).toHaveLength(0);
	});
});

describe("bash edit-miss scoring", () => {
	it.each(["cat a.ts", "cat a.ts b.ts", "cat *.ts", "cat {a,b}.ts"])("checks edits after %s", async (command) => {
		const text = Array.from({ length: 8 }, (_, i) => `export function fn${i}() {\n  return \"unique body content ${i} that should not disappear\";\n${'  work();\n'.repeat(80)}}`).join("\n");
		const messages = [
			assistant([call("bash", { command }, "r")]),
			{ ...result(), toolName: "bash", content: [{ type: "text", text }] },
			// Neither another file's read nor an unrelated recall restores a.ts.
			assistant([call("read", { path: "b.ts" }, "read-b")]),
			assistant([call("recall", { id: "unrelated" }, "recall-other")]),
			assistant([call("edit", { path: "a.ts", edits: [{ oldText: '  return "unique body content 3 that should not disappear";', newText: "fixed" }] })]),
		];
		const rows = await scoreMessages("test", messages as any, {
			choose: async () => ({ choice: "outline", probabilities: { outline: 1 }, confidence: 1, needsFull: 0 }),
			expand: async (state) => state.blocks.map(() => 0),
		}, loadConfig());
		expect(rows[0].editsChecked).toBe(1);
		expect(rows[0].editMiss).toBe(true);
	});
});
