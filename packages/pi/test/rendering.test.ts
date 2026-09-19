import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTheme, createBashToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

const theme = { fg: (_c: string, text: string) => text, bg: (_c: string, text: string) => text, bold: (text: string) => text } as any;
const factories = [createReadToolDefinition, createBashToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition];
const args: Record<string, any> = { read: { path: "a.txt" }, bash: { command: "echo hello" }, grep: { pattern: "hello", path: "." }, find: { pattern: "*.txt", path: "." }, ls: { path: "." } };

beforeEach(() => {
	vi.useFakeTimers();
	initTheme("dark", false);
	vi.stubEnv("JEV_LENS_UI", "1");
	vi.stubEnv("JEV_LENS_CLASSIFIER", "mock");
	vi.stubEnv("JEV_LENS_VARIANT", "");
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("native tool rendering", () => {
	it.each(factories.map((factory) => [factory.name, factory] as const))("preserves the built-in renderers for %s", (_name, factory) => {
		const tools = new Map<string, ToolDefinition<any, any>>();
		extension({ on() {}, registerCommand() {}, registerTool: (tool: ToolDefinition<any, any>) => tools.set(tool.name, tool) } as any);
		const original: ToolDefinition<any, any> = factory(process.cwd());
		const wrapped = tools.get(original.name)!;
		expect(wrapped.promptSnippet).toEqual(original.promptSnippet);
		expect(wrapped.promptGuidelines).toEqual(original.promptGuidelines);
		expect(wrapped.parameters).toEqual(original.parameters);
		for (const expanded of [false, true]) for (const isError of [false, true]) for (const isPartial of [false, true]) {
			const context = () => ({ toolCallId: "untouched", args: args[original.name], cwd: process.cwd(), state: {}, lastComponent: undefined, invalidate() {}, executionStarted: true, argsComplete: true, isPartial, expanded, isError, showImages: true });
			const options = { expanded, isPartial };
			const result = { content: [{ type: "text" as const, text: Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n") }], details: undefined };
			for (const width of [40, 120]) {
				expect(wrapped.renderCall!(args[original.name], theme, context()).render(width)).toEqual(original.renderCall!(args[original.name], theme, context()).render(width));
				expect(wrapped.renderResult!(result, options, theme, context()).render(width)).toEqual(original.renderResult!(result, options, theme, context()).render(width));
			}
		}
	});
});
