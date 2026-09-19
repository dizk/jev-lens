import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../src/pi-types.ts";
import { STUB_PREFIX } from "../src/policy.ts";

// The test harness has no interactive keybinding manager.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
	keyText: vi.fn(() => "ctrl+o"),
}));

process.env.JEV_LENS_CLASSIFIER = "mock";
process.env.JEV_LENS_MODE = "rolling";
process.env.JEV_LENS_LOG = "0";

type Handler = (event: any, ctx: any) => Promise<any> | any;

/** Minimal stand-in for pi's ExtensionAPI: records handlers and appended entries. */
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const entries: any[] = [];
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const pi = {
		registerTool: (def: any) => tools.set(def.name, def),
		on: (event: string, h: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), h]),
		appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
		registerCommand: (name: string, def: any) => commands.set(name, def),
	};
	const emit = async (event: string, payload: any, ctx: any) => {
		let result: any;
		for (const h of handlers.get(event) ?? []) result = (await h({ type: event, ...payload }, ctx)) ?? result;
		return result;
	};
	return { pi, emit, entries, commands, tools };
}

function ctxFor(cwd: string, entries: any[]) {
	return {
		cwd,
		hasUI: false,
		mode: "print",
		signal: undefined,
		ui: { notify() {}, setStatus() {} },
		sessionManager: { getEntries: () => entries, getBranch: () => entries },
	};
}

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 }) as AgentMessage;
const assistant = (text: string, calls: { id: string; name: string; arguments: any }[] = []): AgentMessage =>
	({ role: "assistant", content: [{ type: "text", text }, ...calls.map((c) => ({ type: "toolCall", ...c }))], stopReason: calls.length ? "toolUse" : "stop", usage: { input: 0, cacheRead: 0, output: 0 }, timestamp: 1 }) as unknown as AgentMessage;
const toolResult = (id: string, text: string): AgentMessage => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 1 }) as AgentMessage;

describe("extension wiring (mock classifier, rolling mode)", () => {
	let mod: any;
	beforeAll(async () => {
		mod = await import("../index.ts");
	});

	it("classifies a tool result after the next assistant message and applies it at the following call, then freezes", async () => {
		const { pi, emit, entries } = fakePi();
		mod.default(pi);
		const cwd = mkdtempSync(join(tmpdir(), "jevext-"));
		const ctx = ctxFor(cwd, entries);
		await emit("session_start", { reason: "startup" }, ctx);

		const big = "x".repeat(12000); // > 2000 chars → mock says needed=0.1 → forget
		const msgs: AgentMessage[] = [user("do the thing")];
		await emit("message_end", { message: msgs[0] }, ctx);

		// call 1
		let r = await emit("context", { messages: [...msgs] }, ctx);
		expect(r.messages).toEqual(msgs);
		const a1 = assistant("reading", [{ id: "c1", name: "read", arguments: { path: "big.txt" } }]);
		msgs.push(a1);
		await emit("message_end", { message: a1 }, ctx);
		const r1 = toolResult("c1", big);
		msgs.push(r1);
		await emit("turn_end", { turnIndex: 1, message: a1, toolResults: [r1] }, ctx);

		// call 2: result is sent verbatim (first time seen)
		r = await emit("context", { messages: [...msgs] }, ctx);
		expect((r.messages[2] as any).content[0].text).toBe(big);
		const a2 = assistant("editing", [{ id: "c2", name: "edit", arguments: { path: "big.txt" } }]);
		msgs.push(a2);
		await emit("message_end", { message: a2 }, ctx); // launches classification of r1 with after=a2
		const r2 = toolResult("c2", "ok");
		msgs.push(r2);
		await emit("turn_end", { turnIndex: 2, message: a2, toolResults: [r2] }, ctx);

		// call 3: decision applied → stub
		r = await emit("context", { messages: [...msgs] }, ctx);
		const sent3 = (r.messages[2] as any).content[0].text as string;
		expect(sent3.startsWith(STUB_PREFIX)).toBe(true);
		expect(sent3).toContain("read big.txt");
		const applied = entries.filter((e) => e.customType === "jev-lens" && e.data.decision.status === "applied");
		expect(applied.length).toBe(1);
		expect(applied[0].data.decision.appliedAtCall).toBe(3);

		// call 4: identical transform, nothing newly applied
		const r4 = await emit("context", { messages: [...msgs] }, ctx);
		expect((r4.messages[2] as any).content[0].text).toBe(sent3);
		expect(entries.filter((e) => e.customType === "jev-lens").length).toBe(2); // pending + applied, no more
		// small result untouched
		expect((r4.messages[4] as any).content[0].text).toBe("ok");
	});

	it("rebuilds the ledger on session_start so a resumed session sends the same prompt", async () => {
		const { pi, emit, entries } = fakePi();
		mod.default(pi);
		const cwd = mkdtempSync(join(tmpdir(), "jevext-"));
		const big = "y".repeat(12000);
		entries.push({
			type: "custom",
			customType: "jev-lens",
			data: { kind: "decision", decision: { id: "c9", toolName: "read", bucket: "forget", p: { needed: 0.1, outcomeOnly: 0, durable: 0 }, summary: "read old.txt", tokensBefore: 3000, decidedAt: 1, status: "applied", appliedAtCall: 2 } },
		});
		const ctx = ctxFor(cwd, entries);
		await emit("session_start", { reason: "resume" }, ctx);
		const r = await emit("context", { messages: [user("hi"), assistant("r", [{ id: "c9", name: "read", arguments: {} }]), toolResult("c9", big)] }, ctx);
		expect((r.messages[2] as any).content[0].text).toContain("read old.txt");
	});
});

describe("pre-send compression and recall (mock)", () => {
	it("replaces a large code read with an outline, stores the full text, and recall serves slices", async () => {
		const mod: any = await import("../index.ts");
		const { pi, emit, entries, tools } = fakePi();
		mod.default(pi);
		const cwd = mkdtempSync(join(tmpdir(), "jevext-"));
		const ctx = ctxFor(cwd, entries);
		await emit("session_start", { reason: "startup" }, ctx);
		const { readFileSync } = await import("node:fs");
		const code = readFileSync(new URL("../../../eval/fixture/src/categories.js", import.meta.url), "utf8");
		const r = await emit("tool_result", { toolName: "read", toolCallId: "c7", input: { path: "src/categories.js" }, content: [{ type: "text", text: code }], details: undefined, isError: false }, ctx);
		expect(r).toBeDefined();
		const sent = r.content[0].text as string;
		expect(sent.length).toBeLessThan(code.length * 0.6);
		expect(sent).toContain("export function normalizeCategory");
		expect(sent).toContain('recall(id: "c7")');
		expect(r.details.jevLens.full).toBe(code);
		expect(["outline", "relevant"]).toContain(r.details.jevLens.view);

		const recall = tools.get("recall");
		expect(recall).toBeDefined();
		const full = await recall.execute("x", { id: "c7" });
		expect(full.content[0].text).toBe(code);
		const slice = await recall.execute("x", { id: "c7", lines: "1-3" });
		expect(slice.content[0].text).toContain("1│ /**");
		expect(slice.details.lines).toBe(3);
		const grep = await recall.execute("x", { id: "c7", pattern: "sectionOf" });
		expect(grep.content[0].text).toContain("export function sectionOf");
		const missing = await recall.execute("x", { id: "nope" });
		expect(missing.content[0].text).toContain("No stored output");
	});

	it("leaves small results and recall results alone", async () => {
		const mod: any = await import("../index.ts");
		const { pi, emit, entries } = fakePi();
		mod.default(pi);
		const ctx = ctxFor(mkdtempSync(join(tmpdir(), "jevext-")), entries);
		await emit("session_start", { reason: "startup" }, ctx);
		expect(await emit("tool_result", { toolName: "read", toolCallId: "s", input: { path: "a.js" }, content: [{ type: "text", text: "short" }], isError: false }, ctx)).toBeUndefined();
		expect(await emit("tool_result", { toolName: "recall", toolCallId: "r", input: { id: "c7" }, content: [{ type: "text", text: "x".repeat(20000) }], isError: false }, ctx)).toBeUndefined();
	});
});

describe("TUI integration", () => {
	it("re-registers built-in tools and renders a savings header for compressed results", async () => {
		const mod: any = await import("../index.ts");
		const { pi, emit, entries, tools, commands } = fakePi();
		mod.default(pi);
		for (const t of ["read", "bash", "grep", "find", "ls", "recall"]) expect(tools.has(t), t).toBe(true);
		const ctx = ctxFor(mkdtempSync(join(tmpdir(), "jevext-")), entries);
		await emit("session_start", { reason: "startup" }, ctx);
		const { readFileSync } = await import("node:fs");
		const code = readFileSync(new URL("../../../eval/fixture/src/categories.js", import.meta.url), "utf8");
		const r = await emit("tool_result", { toolName: "read", toolCallId: "c9", input: { path: "src/categories.js" }, content: [{ type: "text", text: code }], details: undefined, isError: false }, ctx);
		expect(r.details.jevLens.included.length).toBeGreaterThan(3);
		const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
		const comp = tools.get("read").renderResult({ content: r.content }, { expanded: false }, theme, { toolCallId: "c9" });
		const text = String(comp.render(200).join("\n"));
		expect(text).toContain("jev-lens");
		expect(text).toMatch(/of \d+ tokens \(−\d+ %\)/);
		expect(text).toMatch(/… \(\d+ lines pruned, \d+ original, ctrl\+o for diff\)/);
		// Native read results are hidden when collapsed; the built-in call header carries the path.
		const plain = tools.get("read").renderResult({ content: [{ type: "text", text: "a\nb" }] }, { expanded: false, isPartial: false }, theme, { toolCallId: "nope", args: { path: "a.txt" }, cwd: ctx.cwd, state: {} });
		expect(String(plain.render(80).join("\n"))).toBe("");
		const notes: string[] = [];
		const cmdCtx = { ...ctx, hasUI: false, mode: "print", ui: { notify: (m: string) => notes.push(m), setStatus() {} } };
		const expanded = tools.get("read").renderResult(r, { expanded: true }, theme, { toolCallId: "c9" });
		expect(expanded.render(160).join("\n")).toMatch(/Full output.*Compressed output/);
		expect(expanded.render(60).join("\n")).toContain("Compressed output");
		// Persisted details also work without an entry in the recent-results index.
		const older = tools.get("read").renderResult(r, { expanded: true }, theme, { toolCallId: "older" });
		expect(older.render(160)).toEqual(expanded.render(160));
		await commands.get("jev-lens").handler("list", cmdCtx);
		expect(notes[0]).toContain("src/categories.js");
		expect(notes[0]).toMatch(/outline|relevant/);
		expect(commands.get("jev-lens").getArgumentCompletions("diff ")).toBeNull();
		await commands.get("jev-lens").handler("diff", cmdCtx);
		expect(notes[1]).toContain("Unknown subcommand");
	});
});

describe("status line", () => {
	it("restores saved tokens after reload and labels restored results separately from new attempts", async () => {
		const mod = await import("../index.ts");
		const { pi, emit, entries, commands } = fakePi();
		mod.default(pi as any);
		const full = "x".repeat(8000), sent = "y".repeat(400);
		const savedResult = { ...toolResult("old", sent + '\n\n[jev-lens: recall(id: "old")]'), details: { jevLens: { full, view: "outline", args: { path: "old.txt" } } } };
		entries.push({ type: "message", message: savedResult });
		const statuses: string[] = [], notes: string[] = [];
		const ctx = { ...ctxFor(mkdtempSync(join(tmpdir(), "jevext-")), entries), hasUI: true, ui: {
			notify: (text: string) => notes.push(text), setStatus: (_key: string, text: string) => statuses.push(text),
		} };
		for (const reason of ["reload", "resume"]) {
			await emit("session_start", { reason }, ctx);
			expect(statuses.at(-1)).toContain("presend −1.9k · 0/0 new · 1 restored");
			await emit("context", { messages: [savedResult] }, ctx);
			await emit("message_end", { message: { ...assistant("done"), usage: { input: 1000, cacheRead: 0, output: 0 } } }, ctx);
			expect(statuses.at(-1)).toMatch(/−\d+% of input \(presend −1.9k/);
			await commands.get("jev-lens").handler("stats", ctx);
			expect(notes.at(-1)).toContain("restored from session: 1 compressed results, ≈1900 tokens saved");
		}
		entries.length = 0;
		await emit("session_start", { reason: "new" }, ctx);
		expect(statuses.at(-1)).toContain("presend −0.0k · 0/0");
		expect(statuses.at(-1)).not.toContain("restored");
	});
	it("leads with the share of the session's input tokens kept out of the prompt", async () => {
		const { readFileSync } = await import("node:fs");
		const mod: any = await import("../index.ts");
		const { pi, emit, entries } = fakePi();
		mod.default(pi);
		const cwd = mkdtempSync(join(tmpdir(), "jevext-"));
		const statuses: string[] = [];
		const ctx = { ...ctxFor(cwd, entries), hasUI: true, ui: { notify() {}, setStatus: (_k: string, t: string) => statuses.push(t) } };
		await emit("session_start", {}, ctx);
		const code = readFileSync(new URL("../../../eval/fixture/src/categories.js", import.meta.url), "utf8");
		const reduced = await emit("tool_result", { toolName: "read", toolCallId: "r1", input: { path: "src/categories.js" }, content: [{ type: "text", text: code }], isError: false }, ctx);
		expect(reduced?.content?.[0]?.text.length).toBeLessThan(code.length);
		expect(statuses.at(-1)).toMatch(/^jev-lens\(mock\) \(presend −\d/); // no usage yet: no percentage
		const r1 = { ...toolResult("r1", reduced.content[0].text), details: reduced.details } as any;
		const msgs = [user("task"), assistant("reading", [{ id: "r1", name: "read", arguments: { path: "src/categories.js" } }]), r1];
		await emit("context", { messages: msgs }, ctx);
		const a = { ...assistant("done"), usage: { input: 1000, cacheRead: 0, output: 10 } } as any;
		await emit("message_end", { message: a }, ctx);
		const last = statuses.at(-1)!;
		const m = /^jev-lens\(mock\) −(\d+)% of input \(presend −[\d.]+k · 1\/1 · 0 recalls, pruned −0\.0k · 0\)$/.exec(last);
		expect(m, last).not.toBeNull();
		const saved = Math.round(code.length / 4) - Math.round(reduced.content[0].text.length / 4);
		const expected = Math.round((100 * saved) / (1000 + saved));
		expect(Math.abs(Number(m![1]) - expected)).toBeLessThanOrEqual(2);
	});
});

describe("command UX", () => {
	it("completes subcommands and reports invalid commands instead of showing stats", async () => {
		const mod = await import("../index.ts");
		const { pi, commands } = fakePi();
		mod.default(pi as any);
		const cmd = commands.get("jev-lens");
		expect(cmd.getArgumentCompletions("").map((i: any) => i.value)).toEqual(["stats", "list", "decisions", "key", "help"]);
		expect(cmd.getArgumentCompletions("di")).toBeNull();
		for (const prefix of ["key ts_secret", "stats ", "unknown", "diff "]) expect(cmd.getArgumentCompletions(prefix)).toBeNull();
		const notes: { text: string; level: string }[] = [];
		const ctx = { ...ctxFor("/tmp", []), ui: { notify: (text: string, level: string) => notes.push({ text, level }), setStatus() {} } };
		for (const arg of ["dif", "different", "stats extra", "diff 0", "diff -1", "diff 1.5", "diff NaN", "diff 1 extra"]) {
			await cmd.handler(arg, ctx);
			expect(notes.at(-1)?.level).toBe("warning");
		}
		await cmd.handler("help", ctx);
		expect(notes.at(-1)?.text).toContain("ctrl+o");
		await cmd.handler("stats", ctx);
		expect(notes.at(-1)?.text).toContain("mock (forced by JEV_LENS_CLASSIFIER)");
		await cmd.handler("key", ctx); // no input dialog in print mode
		expect(notes.at(-1)?.text).toContain("TYPESAFE_API_KEY");
	});
});

describe("/jev-lens key", () => {
	it("stores a key given as argument and reports where", async () => {
		const mod: any = await import("../index.ts");
		const { pi, emit, entries, commands } = fakePi();
		mod.default(pi);
		const cwd = mkdtempSync(join(tmpdir(), "jevext-"));
		process.env.JEV_LENS_KEY_FILE = join(cwd, "jev-lens.json");
		const notes: string[] = [];
		const { KeybindingsManager, TUI_KEYBINDINGS } = await import("@earendil-works/pi-tui");
		const ctx = { ...ctxFor(cwd, entries), hasUI: true, mode: "tui", ui: {
			notify: (m: string) => notes.push(m), setStatus() {},
			input: async () => { throw new Error("Plaintext input must not be used"); },
			custom: async (factory: any) => {
				let result: string | undefined;
				const component = factory({ requestRender() {} }, { fg: (_c: string, t: string) => t }, new KeybindingsManager(TUI_KEYBINDINGS), (value: string | undefined) => { result = value; });
				component.handleInput("ts_typed");
				expect(component.render(80).join("\n")).not.toContain("ts_typed");
				component.handleInput("\r");
				return result;
			},
		} };
		await emit("session_start", {}, ctx);
		await commands.get("jev-lens").handler("key ts_given", ctx);
		const { readFileSync } = await import("node:fs");
		expect(JSON.parse(readFileSync(join(cwd, "jev-lens.json"), "utf8"))).toEqual({ apiKey: "ts_given" });
		expect(notes.at(-1)).toContain("key stored in");
		expect(notes.at(-1)).toContain("Mock mode remains active");
		await commands.get("jev-lens").handler("key", ctx); // prompts when no argument
		expect(JSON.parse(readFileSync(join(cwd, "jev-lens.json"), "utf8"))).toEqual({ apiKey: "ts_typed" });
		await commands.get("jev-lens").handler("key", { ...ctx, ui: { ...ctx.ui, custom: async () => undefined } });
		expect(notes.at(-1)).toContain("cancelled");
		expect(JSON.parse(readFileSync(join(cwd, "jev-lens.json"), "utf8"))).toEqual({ apiKey: "ts_typed" });
		await commands.get("jev-lens").handler("key", { ...ctx, mode: "rpc" });
		expect(notes.at(-1)).toContain("Masked key input requires terminal mode");
		expect(JSON.parse(readFileSync(join(cwd, "jev-lens.json"), "utf8"))).toEqual({ apiKey: "ts_typed" });
		process.env.JEV_LENS_KEY_FILE = cwd; // writing over a directory fails
		await commands.get("jev-lens").handler("key ts_secret", ctx);
		expect(notes.at(-1)).toContain("Could not store the key");
		expect(notes.at(-1)).not.toContain("ts_secret");
		delete process.env.JEV_LENS_KEY_FILE;
	});
});
