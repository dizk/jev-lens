/**
 * Candidate views of a tool result. Every view is a deterministic subset of the original
 * text (never generated), with line numbers so the agent can ask for exact ranges later.
 */

export type ViewKind = "full" | "outline" | "relevant" | "focus" | "signals" | "testlog" | "tree" | "matches" | "log" | "sample" | "head_tail";

export interface View {
	kind: ViewKind;
	text: string;
	lines: number;
	chars: number;
	/** 1-based line numbers of the original that are included. */
	included: number[];
}

export type ContentKind = "code" | "data" | "prose" | "command" | "listing";

const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|kt|kts|rb|php|c|h|cc|cpp|hpp|cs|swift|scala|sh|bash|zsh|lua|sql)$/i;
const DATA_EXT = /\.(csv|tsv|jsonl|ndjson|log|json|xml|yaml|yml|toml)$/i;
const PROSE_EXT = /\.(md|txt|rst|adoc)$/i;

/** Guess what kind of content this is from the tool, its arguments and the text itself. */
export function detectKind(toolName: string, args: unknown, text: string): ContentKind {
	const a = (args ?? {}) as Record<string, unknown>;
	const path = typeof a.path === "string" ? a.path : "";
	if (/^Here's the files and directories up to \d+ levels deep/.test(text) || looksLikePathList(text)) return "listing";
	if (toolName === "bash" || toolName === "powershell") return "command";
	if (toolName === "ls" || toolName === "find" || toolName === "grep") return "listing";
	if (CODE_EXT.test(path)) return "code";
	if (DATA_EXT.test(path)) return "data";
	if (PROSE_EXT.test(path)) return "prose";
	if (looksRepetitive(text)) return "data";
	if (SIG_RE.test(text)) return "code";
	return "prose";
}

/** Mostly lines that are file paths → a directory listing or find output. */
export function looksLikePathList(text: string): boolean {
	const lines = text.split("\n").filter((l) => l.trim()).slice(0, 300);
	if (lines.length < 15) return false;
	const pathy = lines.filter((l) => /^\s*[\w./-]+\/[\w./-]*$/.test(l.trim()) || /^\s*\S+\.(py|js|ts|md|json|txt|yml|yaml|toml|cfg|ini|rs|go|java|c|h)$/.test(l.trim())).length;
	return pathy / lines.length > 0.7;
}

/** Many lines with the same delimiter count → tabular or log-like data. */
export function looksRepetitive(text: string): boolean {
	const lines = text.split("\n").filter((l) => l.trim()).slice(0, 200);
	if (lines.length < 20) return false;
	const counts = new Map<string, number>();
	for (const l of lines) {
		const sig = `${(l.match(/,/g) || []).length}|${(l.match(/\t/g) || []).length}|${(l.match(/\|/g) || []).length}`;
		counts.set(sig, (counts.get(sig) || 0) + 1);
	}
	const top = Math.max(...counts.values());
	return top / lines.length > 0.7 && !/^[\s]*[,|\t]*$/.test(lines[0]) && lines[0].length > 0 && (lines[0].includes(",") || lines[0].includes("\t") || lines[0].includes("|"));
}

const SIG_RE = /^\s*(export\s+|pub\s+|public\s+|private\s+|protected\s+|static\s+|async\s+|default\s+)*(function|class|interface|type|enum|struct|impl|trait|fn|def|const|let|var|module|namespace|import|from|require|package|use)\b|^\s*(export\s+)?(async\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{?\s*$|^\s*(get|set)\s+\w+\s*\(|^\s*(\w+)\s*[:=]\s*(async\s*)?(\([^)]*\)|\w+)\s*=>|^\s*@\w+|^\s*#\s|^\s*\/\*\*|^\s*\*\/|^[A-Za-z_][\w]*\s*=\s*(function|class|\(|require)/;
const HEADING_RE = /^\s*(#{1,6}\s|=+\s*$|-+\s*$|\d+\.\s+[A-Z])/;
const SIGNAL_RE = /\b(error|fail(ed|ing|ure)?|exception|traceback|panic|fatal|warn(ing)?|not ok|✖|✗|denied|refused|missing|cannot|undefined is not|is not defined|no such file|ENOENT|EACCES|timeout|timed out|assert|expected|actual)\b|^\s*at\s+\S+\s+\(|^ℹ\s|^#\s(pass|fail|tests)|failing|Tests:|Suites:|\d+\s+(passed|failed)/i;

/** Collapse decorative runs (=====, -----, ......) and very long lines so views stay small. */
export function tidyLine(l: string): string {
	let out = l.replace(/([=\-_.*#~])\1{24,}/g, (m) => m.slice(0, 24) + "…").replace(/((?:[=\-_.*#~] ){12,})/g, (m) => m.slice(0, 24) + "…").replace(/(\S)[ \t]{8,}(?=\S)/g, "$1  ").trimEnd();
	if (out.length > 400) out = out.slice(0, 400) + " …";
	return out;
}

function numbered(lines: string[], idx: number[]): string {
	const width = String(lines.length).length;
	const out: string[] = [];
	let prev = -1;
	for (const i of idx) {
		if (prev >= 0 && i > prev + 1) out.push(`${" ".repeat(width)}  ⋯ ${i - prev - 1} lines omitted`);
		out.push(`${String(i + 1).padStart(width)}│ ${tidyLine(lines[i])}`);
		prev = i;
	}
	if (prev >= 0 && prev < lines.length - 1) out.push(`${" ".repeat(width)}  ⋯ ${lines.length - 1 - prev} lines omitted`);
	return out.join("\n");
}

function withContext(lines: string[], hits: Set<number>, ctx: number): number[] {
	const keep = new Set<number>();
	for (const h of hits) for (let i = Math.max(0, h - ctx); i <= Math.min(lines.length - 1, h + ctx); i++) keep.add(i);
	return [...keep].sort((a, b) => a - b);
}

function make(kind: ViewKind, lines: string[], idx: number[]): View {
	const text = numbered(lines, idx);
	return { kind, text, lines: idx.length, chars: text.length, included: idx.map((i) => i + 1) };
}

export function fullView(text: string): View {
	const lines = text.split("\n");
	return { kind: "full", text, lines: lines.length, chars: text.length, included: lines.map((_, i) => i + 1) };
}

export function headTailView(text: string, head = 40, tail = 20): View {
	const lines = text.split("\n");
	if (lines.length <= head + tail + 5) return fullView(text);
	const idx = [...Array.from({ length: head }, (_, i) => i), ...Array.from({ length: tail }, (_, i) => lines.length - tail + i)];
	return make("head_tail", lines, idx);
}

/** Code and prose structure: signatures, exports, imports, doc comments, headings. */
export function outlineView(text: string, kind: ContentKind): View {
	const lines = text.split("\n");
	const hits = new Set<number>();
	const re = kind === "prose" ? HEADING_RE : SIG_RE;
	for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) hits.add(i);
	if (kind === "prose") for (let i = 0; i < lines.length; i++) if (hits.has(i) && i + 1 < lines.length && lines[i + 1].trim()) hits.add(i + 1);
	if (hits.size < 3) return headTailView(text);
	return make("outline", lines, withContext(lines, hits, 0));
}

/** Lines mentioning any of the given terms, with context. */
export function focusView(text: string, terms: string[], ctx = 3): View | undefined {
	const t = terms.map((x) => x.trim()).filter((x) => x.length >= 3);
	if (t.length === 0) return undefined;
	const lines = text.split("\n");
	const hits = new Set<number>();
	const lowered = t.map((x) => x.toLowerCase());
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i].toLowerCase();
		if (lowered.some((x) => l.includes(x))) hits.add(i);
	}
	if (hits.size === 0) return undefined;
	const idx = withContext(lines, hits, ctx);
	if (idx.length >= lines.length * 0.8) return undefined;
	return make("focus", lines, idx);
}

/** Command output: error/warning/summary lines with context, plus the tail. */
export function signalsView(text: string, ctx = 2, tail = 8): View {
	const lines = text.split("\n");
	const hits = new Set<number>();
	for (let i = 0; i < lines.length; i++) if (SIGNAL_RE.test(lines[i])) hits.add(i);
	for (let i = Math.max(0, lines.length - tail); i < lines.length; i++) hits.add(i);
	const idx = withContext(lines, hits, ctx);
	if (idx.length >= lines.length * 0.8) return fullView(text);
	return make("signals", lines, idx);
}

const TEST_MARKERS = /test session starts|passed|failed|FAILED|ERROR|✖|✔|not ok|^ok \d|Tests:|Test Suites:|# (pass|fail|tests)|PASS |FAIL |AssertionError|assert /m;
const TEST_FAIL_LINE = /^(FAILED|ERROR) |^E\s{2,}|AssertionError|^\s*assert |✖|not ok|^\s+at .*\(|Error:|Exception|Traceback|^\s*File ".*", line \d+/;
const TEST_SECTION = /^=+ (FAILURES|ERRORS|short test summary info|warnings summary) =+|^_{3,} .* _{3,}$|^(_ ){5,}_?\s*$|^\[\.\.\. Observation truncated|^(ℹ|✖) |^# (Subtest|Failure)/;
const TEST_SUMMARY = /^=+ .*(passed|failed|error|skipped|deselected|xfailed|no tests ran).* =+$|^(Tests:|Test Suites:|Time:|Ran \d+ tests|OK|FAILED \(|ℹ (pass|fail|tests|duration)|# (pass|fail|tests))/;

/** Is this command output a test run? */
export function looksLikeTestLog(text: string): boolean {
	const m = text.match(TEST_MARKERS);
	return !!m && (text.match(/\b(passed|failed|✔|✖|not ok|ok \d)\b/gi) ?? []).length >= 2;
}

/**
 * Test run output reduced to what the agent acts on: the session header, every failing test's
 * section (test id, assertion, the last frames of its traceback), the short summary, and the
 * final counts. Passing tests, dots and decorative bars are dropped.
 */
export function testlogView(text: string, ctx = 2, maxFailLines = 60, maxIds = 25): View | undefined {
	if (!looksLikeTestLog(text)) return undefined;
	const lines = text.split("\n");
	const keep = new Set<number>();
	let inFailures = false;
	let failLines = 0;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		if (i < 3) keep.add(i);
		if (TEST_SECTION.test(l)) { keep.add(i); inFailures = /FAILURES|ERRORS|_{3,}/.test(l) ? true : false; failLines = 0; continue; }
		if (TEST_SUMMARY.test(l)) { keep.add(i); inFailures = false; continue; }
		if (TEST_FAIL_LINE.test(l)) {
			for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) keep.add(j);
			continue;
		}
		if (inFailures && failLines < maxFailLines && l.trim()) { keep.add(i); failLines++; }
	}
	// inside failure sections, drop traceback paragraphs that end in a library frame (site-packages, /opt/conda, /usr/lib):
	// the agent cannot edit those, and the repo frame plus the E-lines carry the information
	const LIB = /(site-packages|dist-packages|\/opt\/conda|\/usr\/lib|\/usr\/local\/lib|\.pyenv|\/node_modules\/)/;
	// A frame runs from the previous boundary (section marker, chain separator or previous footer) to its
	// footer line "path:line: Error". Library frames lose their source lines; their E-lines (the message) stay.
	const FOOTER = /^\S+\.(py|js|ts|rb|go|rs|java):\d+: ?\w*$|^\s*File "[^"]+", line \d+/;
	let boundary = -1;
	for (let i = 0; i < lines.length; i++) {
		if (TEST_SECTION.test(lines[i]) || TEST_SUMMARY.test(lines[i])) { boundary = i; continue; }
		if (!FOOTER.test(lines[i])) continue;
		if (LIB.test(lines[i])) {
			for (let j = boundary + 1; j <= i; j++) if (keep.has(j) && !/^E\s{2,}/.test(lines[j])) keep.delete(j);
		}
		boundary = i;
	}
	// keep a compact index of test ids (agents pick one to re-run), capped so verbose runs stay small
	let ids = 0;
	for (let i = 0; i < lines.length && ids < maxIds; i++) {
		if (keep.has(i)) continue;
		if (/^\S+\.(py|js|ts|rb|go|rs)::\S+ (PASSED|FAILED|ERROR|SKIPPED|XFAIL)/.test(lines[i]) || /^(✔|✓|ok \d+ -) /.test(lines[i])) { keep.add(i); ids++; }
	}
	// always keep the last 5 lines (final summary)
	for (let i = Math.max(0, lines.length - 5); i < lines.length; i++) keep.add(i);
	const idx = [...keep].sort((a, b) => a - b);
	if (idx.length >= lines.length * 0.8) return undefined;
	return make("testlog", lines, idx);
}

/**
 * Directory listings and find output: group paths by directory, keep the first entries of each
 * directory and say how many more there are. Directories with many files (tests, fixtures) collapse.
 */
export function treeView(text: string, perDir = 8, terms: string[] = []): View | undefined {
	const lines = text.split("\n");
	const lowered = terms.map((t) => t.toLowerCase()).filter((t) => t.length >= 4);
	const byDir = new Map<string, number[]>();
	for (let i = 0; i < lines.length; i++) {
		const t = lines[i].trim();
		if (!t) continue;
		const path = t.replace(/\/$/, "");
		const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (!byDir.has(dir)) byDir.set(dir, []);
		byDir.get(dir)!.push(i);
	}
	if (byDir.size < 2) return undefined;
	const keep = new Set<number>();
	for (let i = 0; i < Math.min(2, lines.length); i++) if (!/^\s*[\w./-]+\/?$/.test(lines[i].trim())) keep.add(i);
	for (const idx of byDir.values()) for (const i of idx.slice(0, perDir)) keep.add(i);
	if (lowered.length) {
		// match terms against the basename only, and ignore terms that match a large share of entries (repo names, common dirs)
		const bases = lines.map((l) => l.trim().replace(/\/$/, "").split("/").pop()?.toLowerCase() ?? "");
		for (const t of lowered) {
			const hits = bases.map((b, i) => (b.includes(t) ? i : -1)).filter((i) => i >= 0);
			if (hits.length === 0 || hits.length > Math.max(5, lines.length * 0.2)) continue;
			for (const i of hits) keep.add(i);
		}
	}
	const idx = [...keep].sort((a, b) => a - b);
	if (idx.length >= lines.length * 0.8) return undefined;
	return make("tree", lines, idx);
}

const GREP_LINE = /^([^:\s][^:]*?):(\d+)[:-]/;

/**
 * grep / rg / git grep output (path:line:content): keep the first matches of every file and say how
 * many more each file has. Files are what the agent navigates by; the tail of a long match list rarely matters.
 */
export function matchesView(text: string, perFile = 6): View | undefined {
	const lines = text.split("\n");
	let grepLines = 0;
	const byFile = new Map<string, number[]>();
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(GREP_LINE);
		if (!m) continue;
		grepLines++;
		if (!byFile.has(m[1])) byFile.set(m[1], []);
		byFile.get(m[1])!.push(i);
	}
	const nonEmpty = lines.filter((l) => l.trim()).length;
	if (grepLines < 10 || grepLines < nonEmpty * 0.6 || byFile.size < 1) return undefined;
	const keep = new Set<number>();
	for (let i = 0; i < lines.length; i++) if (!GREP_LINE.test(lines[i]) && lines[i].trim() && !/^--$/.test(lines[i])) keep.add(i); // non-match lines (headers, errors)
	for (const idx of byFile.values()) for (const i of idx.slice(0, perFile)) keep.add(i);
	const idx = [...keep].sort((a, b) => a - b);
	if (idx.length >= lines.length * 0.8) return undefined;
	return make("matches", lines, idx);
}

/** Normalise a log line to its template: numbers, hex, timestamps and quoted strings removed. */
function lineTemplate(l: string): string {
	return l.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.,]?\d*/g, "<ts>").replace(/0x[0-9a-f]+/gi, "<hex>").replace(/\b\d+(\.\d+)?/g, "<n>").replace(/(["']).*?\1/g, "<str>").trim();
}

/**
 * Log-like output (scripts, servers, repeated progress lines): keep the first two and the last
 * occurrence of every line template, so repeated lines collapse while the story stays readable.
 */
export function logView(text: string): View | undefined {
	const lines = text.split("\n");
	if (lines.length < 40) return undefined;
	const seen = new Map<string, number[]>();
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].trim()) continue;
		const t = lineTemplate(lines[i]);
		if (!seen.has(t)) seen.set(t, []);
		seen.get(t)!.push(i);
	}
	// only worth it when templates repeat a lot
	const repeated = [...seen.values()].filter((v) => v.length >= 3).reduce((a, v) => a + v.length, 0);
	if (repeated < lines.length * 0.3) return undefined;
	const keep = new Set<number>();
	for (const idx of seen.values()) { keep.add(idx[0]); if (idx.length > 1) keep.add(idx[1]); keep.add(idx[idx.length - 1]); }
	for (let i = 0; i < lines.length; i++) if (SIGNAL_RE.test(lines[i])) keep.add(i);
	for (let i = Math.max(0, lines.length - 5); i < lines.length; i++) keep.add(i);
	const idx = [...keep].sort((a, b) => a - b);
	if (idx.length >= lines.length * 0.8) return undefined;
	return make("log", lines, idx);
}

/** Data files: header plus a sample of rows and the count. */
export function sampleView(text: string, rows = 12): View {
	const lines = text.split("\n");
	if (lines.length <= rows + 6) return fullView(text);
	const idx = [...Array.from({ length: rows }, (_, i) => i), lines.length - 2, lines.length - 1].filter((i, k, arr) => i >= 0 && arr.indexOf(i) === k);
	return make("sample", lines, idx);
}

/** Pull identifier-like terms out of task text and tool arguments to drive the focus view. */
export function extractTerms(...texts: string[]): string[] {
	const found = new Map<string, number>();
	for (const t of texts) {
		for (const m of t.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{3,}/g)) {
			const w = m[0];
			if (STOP.has(w.toLowerCase())) continue;
			if (/^[A-Z][a-z]+$/.test(w) && w.length < 8) continue; // capitalised common words
			found.set(w, (found.get(w) || 0) + 1);
		}
		for (const m of t.matchAll(/`([^`\n]{3,60})`/g)) found.set(m[1], (found.get(m[1]) || 0) + 3);
		for (const m of t.matchAll(/["']([^"'\n]{4,60})["']/g)) found.set(m[1], (found.get(m[1]) || 0) + 2);
	}
	return [...found.entries()]
		.filter(([w]) => /[a-z]/.test(w) && (/[A-Z_.$]/.test(w.slice(1)) || w.length >= 8))
		.sort((a, b) => b[1] - a[1])
		.slice(0, 25)
		.map(([w]) => w);
}

const STOP = new Set("this that with from have will would should could there their about which where when what make sure does into then than only also just some more most such each other after before because while please tests test file files function functions module modules code change changes changed running return returns using used uses need needs needed does must keep keeps always never every existing behaviour behavior following current update updated added adding delete remove rename renamed read write import export const class type string number object array value values default defaults lines line".split(/\s+/));

export interface ViewParams {
	headLines: number;
	tailLines: number;
	focusCtx: number;
	sampleRows: number;
	signalsCtx: number;
	signalsTail: number;
	/** How many passing test ids the testlog view keeps as an index (0 = none). */
	testIds: number;
	/** Max lines kept per failure section in testlog. */
	testFailLines: number;
	/** grep-style output: matches kept per file in the "matches" view. */
	matchesPerFile: number;
	/** Log-like output: offer the "log" view that collapses repeated line templates. */
	logView: boolean;
	minShrink: number;
}
export const DEFAULT_VIEW_PARAMS: ViewParams = { headLines: 40, tailLines: 20, focusCtx: 3, sampleRows: 12, signalsCtx: 2, signalsTail: 8, testIds: 25, testFailLines: 60, matchesPerFile: 6, logView: true, minShrink: 0.6 };

export interface Candidates {
	kind: ContentKind;
	views: View[];
}

/** Build the candidate views for a tool result. Full is always first. Views that do not shrink the text enough are dropped. */
export function buildCandidates(toolName: string, args: unknown, text: string, terms: string[], params: Partial<ViewParams> = {}): Candidates {
	const P = { ...DEFAULT_VIEW_PARAMS, ...params };
	const kind = detectKind(toolName, args, text);
	const full = fullView(text);
	const cands: View[] = [full];
	const add = (v: View | undefined) => {
		if (!v || v.kind === "full") return;
		if (v.chars > full.chars * P.minShrink) return;
		if (cands.some((c) => c.kind === v.kind)) return;
		cands.push(v);
	};
	if (kind === "code" || kind === "prose") add(outlineView(text, kind));
	if (kind === "command") add(testlogView(text, P.signalsCtx, P.testFailLines, P.testIds));
	if (kind === "command" || kind === "listing") add(matchesView(text, P.matchesPerFile));
	if (kind === "command" && P.logView) add(logView(text));
	if (kind === "listing") add(treeView(text, 8, terms));
	if (kind === "command" || kind === "listing") add(signalsView(text, P.signalsCtx, P.signalsTail));
	if (kind === "data") add(sampleView(text, P.sampleRows));
	add(focusView(text, terms, P.focusCtx));
	add(headTailView(text, P.headLines, P.tailLines));
	return { kind, views: cands };
}

export function footer(view: View, toolCallId: string, total: number): string {
	if (view.kind === "full") return "";
	return `\n\n[jev-memory: showing the "${view.kind}" view, ${view.lines} of ${total} lines. Omitted lines are marked ⋯. Call recall(id: "${toolCallId}") for the full output, or recall(id, lines: "a-b") / recall(id, pattern: "...") for a slice.]`;
}

export interface Block {
	/** The signature line (trimmed). */
	name: string;
	/** 1-based inclusive line range. */
	from: number;
	to: number;
}

/**
 * Split code into top-level blocks: each block starts at a signature line with no indentation
 * (or the least indentation seen) and runs until the next one. Leading imports form one block.
 */
export function splitBlocks(text: string, maxBlocks = 32): Block[] {
	const lines = text.split("\n");
	const starts: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		if (!l.trim()) continue;
		if (/^\S/.test(l) && SIG_RE.test(l) && !/^\s*(import|from|require|use|package)\b/.test(l) && !/^\s*(\/\*\*|\*\/|\*|#|\/\/)/.test(l)) starts.push(i);
	}
	if (starts.length < 2) return [];
	const blocks: Block[] = [];
	if (starts[0] > 0) blocks.push({ name: "(header: imports, constants)", from: 1, to: starts[0] });
	for (let k = 0; k < starts.length; k++) {
		const from = starts[k];
		let to = k + 1 < starts.length ? starts[k + 1] - 1 : lines.length - 1;
		// give a preceding doc comment to the block it documents
		blocks.push({ name: lines[from].trim().slice(0, 120), from: from + 1, to: to + 1 });
	}
	for (let k = 1; k < blocks.length; k++) {
		const prevEnd = blocks[k - 1].to;
		let j = prevEnd - 1;
		while (j >= blocks[k - 1].from && /^\s*(\/\*\*|\*|\/\/|#)/.test(lines[j])) j--;
		if (j < prevEnd - 1 && j + 1 > blocks[k - 1].from - 1) { blocks[k].from = j + 2; blocks[k - 1].to = j + 1; }
	}
	return blocks.slice(0, maxBlocks);
}

/** Outline plus the full bodies of the chosen blocks. */
export function relevantView(text: string, kind: ContentKind, blocks: Block[], expand: Set<number>, outlineIncluded?: number[]): View {
	const lines = text.split("\n");
	const outline = outlineIncluded ? { included: outlineIncluded } : outlineView(text, kind);
	const idx = new Set(outline.included.map((n) => n - 1));
	for (const b of expand) {
		const blk = blocks[b];
		if (!blk) continue;
		for (let i = blk.from - 1; i <= blk.to - 1; i++) idx.add(i);
	}
	return make("relevant", lines, [...idx].sort((a, b) => a - b));
}

/**
 * Async variant of buildCandidates that uses tree-sitter for the outline of code files when the
 * grammar is available, and returns the blocks so the second step can reuse them.
 */
export async function buildCandidatesAsync(toolName: string, args: unknown, text: string, terms: string[], params: Partial<ViewParams> = {}): Promise<Candidates & { blocks?: Block[] }> {
	const minShrink = params.minShrink ?? DEFAULT_VIEW_PARAMS.minShrink;
	const base = buildCandidates(toolName, args, text, terms, params);
	const path = typeof (args as { path?: unknown })?.path === "string" ? ((args as { path: string }).path) : "";
	if (base.kind !== "code" || !path) return base;
	try {
		const { treeSitterBlocks, treeSitterOutline } = await import("./treesitter.ts");
		const [blocks, outlineIdx] = await Promise.all([treeSitterBlocks(path, text), treeSitterOutline(path, text)]);
		if (!outlineIdx || outlineIdx.length < 2) return { ...base, blocks: blocks ?? undefined };
		const lines = text.split("\n");
		const full = base.views[0];
		const outline = make("outline", lines, outlineIdx);
		const views = base.views.filter((v) => v.kind !== "outline");
		if (outline.chars <= full.chars * minShrink) views.splice(1, 0, outline);
		return { kind: base.kind, views, blocks: blocks ?? undefined };
	} catch {
		return base;
	}
}
