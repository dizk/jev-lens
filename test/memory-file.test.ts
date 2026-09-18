import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendNotes, memoryPromptSection, readMemoryFile } from "../src/memory-file.ts";

describe("memory file", () => {
	it("appends, dedups and renders a prompt section", () => {
		const dir = mkdtempSync(join(tmpdir(), "jevmem-"));
		const p = join(dir, "x", "jev-lens.md");
		expect(appendNotes(p, [{ source: "user", text: "Always use pnpm here", p: 0.9, at: 0 }])).toBe(1);
		expect(appendNotes(p, [{ source: "user", text: "always   use pnpm here", p: 0.9, at: 0 }])).toBe(0);
		expect(appendNotes(p, [{ source: "agent", text: "Tests run with `npm test`", p: 0.8, at: 0 }])).toBe(1);
		const text = readFileSync(p, "utf8");
		expect(text.split("\n").filter((l) => l.startsWith("- ")).length).toBe(2);
		const section = memoryPromptSection(readMemoryFile(p));
		expect(section).toContain("Always use pnpm here");
		expect(section).toContain("Memory from earlier sessions");
		expect(memoryPromptSection("")).toBe("");
	});
});
