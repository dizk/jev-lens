/**
 * Tree-sitter backed structure for code views: exact top-level blocks (functions, classes,
 * methods, top-level assignments) with signature lines, for the languages that ship in
 * tree-sitter-wasms. Falls back to undefined when the language is unknown or parsing fails,
 * in which case views.ts uses its regex heuristics.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import type { Block } from "./views.ts";

const require = createRequire(import.meta.url);

/** Grammars shipped by @vscode/tree-sitter-wasm (ABI-compatible with web-tree-sitter 0.27). */
const LANG_BY_EXT: Record<string, string> = {
	".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
	".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx",
	".py": "python", ".pyx": "python", ".go": "go", ".rs": "rust", ".java": "java", ".rb": "ruby",
	".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp", ".cs": "c-sharp", ".php": "php",
	".sh": "bash", ".bash": "bash", ".css": "css",
	".kt": "kotlin", ".kts": "kotlin",
};

/** Extra grammar packages: language → wasm path resolver (the VS Code bundle has no Kotlin). */
const EXTRA_WASM: Record<string, () => string | undefined> = {
	kotlin: () => {
		try {
			const dir = dirname(require.resolve("@binclusive/tree-sitter-kotlin-wasm/package.json"));
			const { readdirSync } = require("node:fs") as typeof import("node:fs");
			const walk = (d: string): string | undefined => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory() && f.name !== "node_modules") { const r = walk(p); if (r) return r; } else if (f.name.endsWith(".wasm")) return p; } return undefined; };
			return walk(dir);
		} catch { return undefined; }
	},
};

/** Node types that count as top-level blocks, per language family. */
const BLOCK_TYPES = new Set([
	"function_declaration", "function_definition", "generator_function_declaration", "class_declaration", "class_definition",
	"method_definition", "method_declaration", "abstract_class_declaration", "interface_declaration", "type_alias_declaration",
	"enum_declaration", "module", "internal_module", "lexical_declaration", "variable_declaration", "export_statement",
	"decorated_definition", "function_item", "impl_item", "struct_item", "enum_item", "trait_item", "mod_item", "const_item", "static_item",
	"type_item", "func_literal", "method_declaration", "type_declaration", "var_declaration", "const_declaration",
	"class_specifier", "struct_specifier", "namespace_definition", "template_declaration", "preproc_function_def",
	"function_signature", "singleton_method", "module", "class", "method", "object_declaration", "property_declaration",
	"companion_object", "constructor_declaration", "record_declaration", "annotation_type_declaration", "macro_definition", "extern_crate_declaration",
]);
const HEADER_TYPES = new Set(["import_statement", "import_declaration", "import_from_statement", "package_clause", "package_declaration", "use_declaration", "preproc_include", "require_call", "using_directive", "comment", "expression_statement", "attribute_item", "mod_item"]);

type TS = typeof import("web-tree-sitter");
let ts: TS | undefined;
let inited: Promise<void> | undefined;
const languages = new Map<string, Promise<import("web-tree-sitter").Language | undefined>>();

function wasmDir(): string | undefined {
	try {
		return join(dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")), "wasm");
	} catch {
		return undefined;
	}
}

async function init(): Promise<TS | undefined> {
	if (ts) return ts;
	if (!inited) {
		inited = (async () => {
			try {
				const mod = (await import("web-tree-sitter")) as TS;
				await mod.Parser.init();
				ts = mod;
			} catch {
				ts = undefined;
			}
		})();
	}
	await inited;
	return ts;
}

async function language(name: string) {
	if (!languages.has(name)) {
		languages.set(name, (async () => {
			const mod = await init();
			const dir = wasmDir();
			if (!mod || !dir) return undefined;
			const file = EXTRA_WASM[name]?.() ?? join(dir, `tree-sitter-${name}.wasm`);
			if (!file || !existsSync(file)) return undefined;
			try { return await mod.Language.load(file); } catch { return undefined; }
		})());
	}
	return languages.get(name)!;
}

export function languageForPath(path: string): string | undefined {
	return LANG_BY_EXT[extname(path).toLowerCase()];
}

/**
 * Top-level blocks from the syntax tree: each named child of the root that is a declaration
 * becomes a block spanning its full line range (including a directly preceding comment).
 * Leading imports and other non-block statements are folded into a header block.
 */
export async function treeSitterBlocks(path: string, text: string, maxBlocks = 48): Promise<Block[] | undefined> {
	const lang = languageForPath(path);
	if (!lang) return undefined;
	const mod = await init();
	const L = await language(lang);
	if (!mod || !L) return undefined;
	const parser = new mod.Parser();
	parser.setLanguage(L);
	const tree = parser.parse(text);
	if (!tree) return undefined;
	const lines = text.split("\n");
	const root = tree.rootNode;
	// Python and Ruby put everything under "module"/"program"; unwrap one level when the root has a single block child.
	let children = root.namedChildren;
	if (children.length === 1 && (children[0].type === "module" || children[0].type === "program")) children = children[0].namedChildren;
	const blocks: Block[] = [];
	let pendingComment: number | undefined;
	let headerEnd = 0;
	for (const c of children) {
		if (!c) continue;
		const startLine = c.startPosition.row;
		const endLine = c.endPosition.row;
		if (c.type === "comment") { if (pendingComment === undefined) pendingComment = startLine; continue; }
		let node = c;
		// export const x = ...; export default class ...; decorated defs
		if ((c.type === "export_statement" || c.type === "decorated_definition") && c.namedChildren.length) {
			const inner = c.namedChildren.find((n) => n && BLOCK_TYPES.has(n.type));
			if (inner) node = inner;
		}
		// Multi-line top-level assignments (config dicts, tables, constants) are blocks too.
		const isBigAssignment = (node.type === "expression_statement" || node.type === "assignment") && endLine - startLine >= 3;
		// one-line declarations (type aliases, Kotlin data classes, Rust consts) are blocks too: they belong in the outline
		const isBlock = BLOCK_TYPES.has(node.type) || isBigAssignment;
		if (!isBlock) { pendingComment = undefined; if (blocks.length === 0) headerEnd = endLine; continue; }
		const from = (pendingComment ?? startLine) + 1;
		pendingComment = undefined;
		const sig = lines[startLine].trim().slice(0, 120);
		// Large classes: expose their methods as blocks so the second step can pick individual bodies.
		const body = node.namedChildren.find((n) => n && (n.type === "class_body" || n.type === "block" || n.type === "declaration_list" || n.type === "field_declaration_list"));
		const methods = body ? body.namedChildren.filter((n) => n && (n.type === "method_definition" || n.type === "function_definition" || n.type === "method_declaration" || n.type === "constructor_declaration" || n.type === "decorated_definition" || n.type === "function_item" || n.type === "function_declaration" || n.type === "companion_object" || n.type === "property_declaration")) : [];
		if (endLine - startLine > 40 && methods.length >= 2) {
			blocks.push({ name: sig, from, to: methods[0]!.startPosition.row });
			for (let k = 0; k < methods.length; k++) {
				const mm = methods[k]!;
				const mEnd = k + 1 < methods.length ? methods[k + 1]!.startPosition.row : endLine + 1;
				blocks.push({ name: `${sig.replace(/[{:]\s*$/, "")} › ${lines[mm.startPosition.row].trim().slice(0, 80)}`, from: mm.startPosition.row + 1, to: mEnd });
			}
			continue;
		}
		blocks.push({ name: sig, from, to: endLine + 1 });
	}
	tree.delete();
	parser.delete();
	if (blocks.length < 2) return blocks.length === 0 ? [] : undefined;
	// fill gaps so the block list partitions the file
	const out: Block[] = [];
	if (blocks[0].from > 1) out.push({ name: "(header: imports, constants)", from: 1, to: blocks[0].from - 1 });
	for (let i = 0; i < blocks.length; i++) {
		const b = { ...blocks[i] };
		const next = blocks[i + 1];
		if (next && next.from > b.to + 1) b.to = next.from - 1;
		if (!next && b.to < lines.length) b.to = lines.length;
		out.push(b);
	}
	void headerEnd;
	return out.slice(0, maxBlocks);
}

/** Signature lines (block starts) as an outline index list, 0-based. */
export async function treeSitterOutline(path: string, text: string): Promise<number[] | undefined> {
	const blocks = await treeSitterBlocks(path, text);
	if (!blocks) return undefined;
	const idx: number[] = [];
	const lines = text.split("\n");
	for (const b of blocks) {
		if (b.name.startsWith("(header")) {
			// imports plus any one-line declarations (Kotlin data classes, type aliases, constants) that were too short to be blocks
			for (let i = b.from - 1; i < b.to; i++) if (/^\s*(import|from|require|use|package|#include|using)\b/.test(lines[i]) || /^(export\s+)?(const|let|var|val|type|typealias|data class|sealed class|enum class|class|interface|object|fun|def|pub|static|final)\b/.test(lines[i])) idx.push(i);
			continue;
		}
		// the signature line is the first non-comment line of the block
		for (let i = b.from - 1; i < b.to; i++) { if (!/^\s*(\/\/|\/\*|\*|#|"""|''')/.test(lines[i]) && lines[i].trim()) { idx.push(i); break; } }
	}
	return idx;
}
