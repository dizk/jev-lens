import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentMessage } from "../src/pi-types.ts";
import { STUB_PREFIX } from "../src/policy.ts";

process.env.JEV_MEMORY_CLASSIFIER = "mock";
process.env.JEV_MEMORY_MODE = "rolling";
process.env.JEV_MEMORY_LOG = "0";

type Handler = (event: any, ctx: any) => Promise<any> | any;

/** Minimal stand-in for pi's ExtensionAPI: records handlers and appended entries. */
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const entries: any[] = [];
	const commands = new Map<string, any>();
	const pi = {
		on: (event: string, h: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), h]),
		appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
		registerCommand: (name: string, def: any) => commands.set(name, def),
	};
	const emit = async (event: string, payload: any, ctx: any) => {
		let result: any;
		for (const h of handlers.get(event) ?? []) result = (await h({ type: event, ...payload }, ctx)) ?? result;
		return result;
	};
	return { pi, emit, entries, commands };
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
		const applied = entries.filter((e) => e.customType === "jev-memory" && e.data.decision.status === "applied");
		expect(applied.length).toBe(1);
		expect(applied[0].data.decision.appliedAtCall).toBe(3);

		// call 4: identical transform, nothing newly applied
		const r4 = await emit("context", { messages: [...msgs] }, ctx);
		expect((r4.messages[2] as any).content[0].text).toBe(sent3);
		expect(entries.filter((e) => e.customType === "jev-memory").length).toBe(2); // pending + applied, no more
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
			customType: "jev-memory",
			data: { kind: "decision", decision: { id: "c9", toolName: "read", bucket: "forget", durable: false, p: { needed: 0.1, outcomeOnly: 0, durable: 0 }, summary: "read old.txt", tokensBefore: 3000, decidedAt: 1, status: "applied", appliedAtCall: 2 } },
		});
		const ctx = ctxFor(cwd, entries);
		await emit("session_start", { reason: "resume" }, ctx);
		const r = await emit("context", { messages: [user("hi"), assistant("r", [{ id: "c9", name: "read", arguments: {} }]), toolResult("c9", big)] }, ctx);
		expect((r.messages[2] as any).content[0].text).toContain("read old.txt");
	});
});
