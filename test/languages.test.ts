import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { languageForPath, treeSitterBlocks, treeSitterOutline } from "../src/treesitter.ts";
import { buildCandidatesAsync, splitBlocks } from "../src/views.ts";

const sample = (f: string) => readFileSync(new URL(`./samples/${f}`, import.meta.url), "utf8");

describe("language support (tree-sitter + regex fallback)", () => {
	it("maps the required languages to grammars", () => {
		for (const f of ["a.kt", "a.kts", "a.ts", "a.tsx", "a.java", "a.rs", "a.py", "a.go", "a.js"]) expect(languageForPath(f), f).toBeDefined();
	});

	it("Kotlin: classes, objects, functions as blocks; methods inside large classes", async () => {
		const t = sample("Sample.kt");
		const blocks = (await treeSitterBlocks("Sample.kt", t))!;
		const names = blocks.map((b) => b.name);
		expect(names.some((n) => n.startsWith("sealed interface Result"))).toBe(true);
		expect(names.some((n) => n.startsWith("object Categories"))).toBe(true);
		expect(names.some((n) => n.startsWith("class Ledger"))).toBe(true);
		expect(names.some((n) => n.startsWith("fun formatMoney"))).toBe(true);
		const outline = (await treeSitterOutline("Sample.kt", t))!.map((i) => t.split("\n")[i]);
		expect(outline.some((l) => l.startsWith("data class Entry"))).toBe(true);
		// a big class splits into its members
		const big = "class Big {\n" + Array.from({ length: 6 }, (_, i) => `    fun m${i}(): Int {\n${"        val x = 1\n".repeat(8)}        return x\n    }\n`).join("") + "}\n";
		const bb = (await treeSitterBlocks("Big.kt", big))!;
		expect(bb.filter((b) => b.name.includes("› fun m")).length).toBe(6);
		// regex fallback also understands Kotlin
		expect(splitBlocks(t).map((b) => b.name).some((n) => n.startsWith("fun formatMoney"))).toBe(true);
	});

	it("Java: class, interface, enum; methods inside large classes", async () => {
		const t = sample("Sample.java");
		const names = (await treeSitterBlocks("Sample.java", t))!.map((b) => b.name);
		expect(names.some((n) => n.startsWith("public class Ledger"))).toBe(true);
		expect(names.some((n) => n.startsWith("interface Formatter"))).toBe(true);
		expect(names.some((n) => n.startsWith("enum Section"))).toBe(true);
		const big = "public class Big {\n" + Array.from({ length: 6 }, (_, i) => `    public int m${i}() {\n${"        int x = 1;\n".repeat(8)}        return x;\n    }\n`).join("") + "}\n";
		expect((await treeSitterBlocks("Big.java", big))!.filter((b) => b.name.includes("› public int m")).length).toBe(6);
	});

	it("Rust: struct, enum, trait, impl, fn, const; impl methods split when large", async () => {
		const t = sample("sample.rs");
		const names = (await treeSitterBlocks("sample.rs", t))!.map((b) => b.name);
		for (const sig of ["pub struct Entry", "pub enum Section", "pub trait Format", "impl Ledger", "pub fn format_money"]) expect(names.some((n) => n.startsWith(sig)), sig).toBe(true);
		const big = "impl Big {\n" + Array.from({ length: 6 }, (_, i) => `    pub fn m${i}(&self) -> i32 {\n${"        let x = 1;\n".repeat(8)}        x\n    }\n`).join("") + "}\n";
		expect((await treeSitterBlocks("big.rs", big))!.filter((b) => b.name.includes("› pub fn m")).length).toBe(6);
	});

	it("TypeScript: interface, type, const, class, functions, default export", async () => {
		const t = sample("sample.ts");
		const names = (await treeSitterBlocks("sample.ts", t))!.map((b) => b.name);
		for (const sig of ["export interface Entry", "export const ALIASES", "export class Ledger", "export function formatMoney", "export default function loadConfig"]) expect(names.some((n) => n.startsWith(sig)), sig).toBe(true);
		const outline = (await treeSitterOutline("sample.ts", t))!.map((i) => t.split("\n")[i]);
		expect(outline.some((l) => l.startsWith("export type Section"))).toBe(true);
		const c = await buildCandidatesAsync("read", { path: "sample.ts" }, t, []);
		expect(c.views.map((v) => v.kind)).toContain("outline");
		expect(c.blocks!.length).toBeGreaterThanOrEqual(5);
	});
});
