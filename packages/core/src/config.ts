import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type SealMode = "off" | "rolling" | "batch" | "budget";

export interface Config {
	/** Disable all pruning (classification still runs and logs). */
	enabled: boolean;
	/**
	 * rolling: apply decisions at the next LLM call (smallest prompt, one cache rewrite per call while pruning).
	 * batch: apply only when the cache is cold or on compaction (best cache, prompt shrinks late).
	 * budget: like batch, but also apply when pending prunable tokens exceed a share of the prompt (one rewrite buys many calls).
	 */
	mode: SealMode;
	/** budget mode: apply pending decisions when they remove at least this fraction of the tail they would rewrite... */
	budgetFraction: number;
	/** ...and at least this many tokens. */
	budgetMinTokens: number;
	/** P(needed) below this → forget (stub). */
	forgetBelow: number;
	/** P(needed) below this and P(outcomeOnly) above trimAbove → trim to head+tail. */
	trimBelow: number;
	trimAbove: number;
	/** Tool results smaller than this (estimated tokens) are never touched. */
	minTokens: number;
	/** Maximum wait for in-flight classifications at context, agent end and shutdown. */
	classifyWaitMs: number;
	/** Provider prompt-cache TTL; idle longer than this means the cache is cold. */
	cacheTtlMs: number;
	/** Lines kept at head/tail when trimming. */
	trimHeadLines: number;
	trimTailLines: number;
	/** Max chars of tool output sent to jev (head + tail). */
	stateHeadChars: number;
	stateTailChars: number;
	/** Pre-send compression of large tool results (jev picks a view before the output is ever sent). */
	presend: boolean;
	/** Only results at least this large (estimated tokens) are considered for pre-send compression. */
	presendMinTokens: number;
	/** Send full when P(needs full) is above this. */
	presendNeedsFullAbove: number;
	/** Send full when the "full" option itself gets more than this probability mass. */
	presendFullMassAbove: number;
	/** Separate needs-full threshold for command output (test runs), where "exact full text" is rarely what the agent needs. */
	presendCommandNeedsFullAbove: number;
	/** Code policy: "gate" (default) = jev's needs-full/full-mass gates decide between full and a view; "outline" = code is always sent as outline plus the blocks the second step expands (17 % edit-miss on 500 real trajectories, see STATUS). */
	presendCodePolicy: "gate" | "outline";
	/** Stricter needs-full threshold for source code, where a wrong view costs an edit (jev's answers vary run to run by ±0.2). */
	presendCodeNeedsFullAbove: number;
	/** Send full when the choice confidence is below this (0 = off; a spread over acceptable views is not a reason to send everything). */
	presendMinConfidence: number;
	/** Second step for code: expand the bodies of blocks jev says the agent will need (P above this). */
	presendExpandAbove: number;
	/** Command policy: "sections" (default) = when jev picks full for command output but needs-full is under the command threshold, send section headers and let the second step expand the sections it needs; "gate" = jev's view choice stands. */
	presendCommandPolicy: "gate" | "sections";
	/** Second step for command output: expand a section when P(needed) is above this. */
	presendSectionExpandAbove: number;
	/** Command output: when no section reaches this probability the step is uninformative and full is sent (0 = headers alone are allowed). */
	presendSectionFloor: number;
	model: string;
	/** Optional variant file (JEV_LENS_VARIANT): { config, prompts, views } overrides, as produced by eval/bench/autoresearch.ts. */
	variantFile: string | undefined;
	/** Force the mock classifier even when a key is present (tests, dry runs). */
	forceMock: boolean;
	logFile: boolean;
	apiKey: string | undefined;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the pi extension stores the TypeSafe API key. Other hosts pass their own default. */
export const PI_KEY_FILE = join(homedir(), ".pi", "agent", "jev-lens.json");

/** Where the stored TypeSafe API key lives: JEV_LENS_KEY_FILE, else the host's default (pi's when none is given). */
export function keyFilePath(defaultPath: string = PI_KEY_FILE): string {
	return process.env.JEV_LENS_KEY_FILE || defaultPath;
}

/** The stored key, if any. */
export function readStoredKey(defaultPath?: string): string | undefined {
	try {
		const p = keyFilePath(defaultPath);
		if (!existsSync(p)) return undefined;
		const key = (JSON.parse(readFileSync(p, "utf8")) as { apiKey?: unknown }).apiKey;
		return typeof key === "string" && key.trim() ? key.trim() : undefined;
	} catch {
		return undefined;
	}
}

/** Store the key in the host's key file, readable only by the user. */
export function storeKey(key: string, defaultPath?: string): string {
	const p = keyFilePath(defaultPath);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, `${JSON.stringify({ apiKey: key.trim() }, null, 2)}\n`, { mode: 0o600 });
	return p;
}

/** Key resolution: environment (or the package's .env, loaded into it), then the stored key. */
export function resolveApiKey(defaultPath?: string): string | undefined {
	return process.env.TYPESAFE_API_KEY || readStoredKey(defaultPath);
}

/**
 * Load KEY=VALUE lines from this package's own .env, and from the monorepo root when running from a
 * source checkout. Never from the target project: an installed copy under node_modules reads only its own directory.
 */
export function loadDotEnv(): void {
	const pkgRoot = join(HERE, "..");
	const dirs = [pkgRoot];
	if (!HERE.includes("node_modules")) dirs.push(join(pkgRoot, "..", ".."));
	for (const dir of dirs) {
		const p = join(dir, ".env");
		if (!existsSync(p)) continue;
		for (const line of readFileSync(p, "utf8").split("\n")) {
			const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
			if (!m || !m[2] || process.env[m[1]]) continue;
			process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
		}
	}
}

function num(name: string, fallback: number): number {
	const v = process.env[name];
	if (v === undefined || v === "") return fallback;
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

export interface ConfigOptions {
	/** The host's default key file (JEV_LENS_KEY_FILE still wins). */
	keyFile?: string;
}

export function loadConfig(opts: ConfigOptions = {}): Config {
	loadDotEnv();
	const envMode = process.env.JEV_LENS_MODE;
	const mode: SealMode = envMode === "batch" || envMode === "budget" || envMode === "rolling" ? envMode : "off";
	return {
		enabled: process.env.JEV_LENS_DISABLED !== "1",
		mode,
		budgetFraction: num("JEV_LENS_BUDGET_FRACTION", 0.5),
		budgetMinTokens: num("JEV_LENS_BUDGET_MIN_TOKENS", 1000),
		forgetBelow: num("JEV_LENS_FORGET_BELOW", 0.25),
		trimBelow: num("JEV_LENS_TRIM_BELOW", 0.5),
		trimAbove: num("JEV_LENS_TRIM_ABOVE", 0.6),
		minTokens: num("JEV_LENS_MIN_TOKENS", 150),
		classifyWaitMs: num("JEV_LENS_CLASSIFY_WAIT_MS", 2500),
		cacheTtlMs: num("JEV_LENS_CACHE_TTL_MS", 5 * 60 * 1000),
		trimHeadLines: num("JEV_LENS_TRIM_HEAD", 15),
		trimTailLines: num("JEV_LENS_TRIM_TAIL", 15),
		stateHeadChars: num("JEV_LENS_STATE_HEAD", 2500),
		stateTailChars: num("JEV_LENS_STATE_TAIL", 800),
		presend: process.env.JEV_LENS_PRESEND !== "0",
		presendMinTokens: num("JEV_LENS_PRESEND_MIN_TOKENS", 1200),
		presendNeedsFullAbove: num("JEV_LENS_PRESEND_NEEDS_FULL_ABOVE", 0.5),
		presendFullMassAbove: num("JEV_LENS_PRESEND_FULL_MASS_ABOVE", 0.5),
		presendCodeNeedsFullAbove: num("JEV_LENS_PRESEND_CODE_NEEDS_FULL_ABOVE", 0.5),
		presendCommandNeedsFullAbove: num("JEV_LENS_PRESEND_COMMAND_NEEDS_FULL_ABOVE", 0.65),
		presendCodePolicy: process.env.JEV_LENS_PRESEND_CODE_POLICY === "outline" ? "outline" : "gate",
		presendMinConfidence: num("JEV_LENS_PRESEND_MIN_CONFIDENCE", 0),
		presendExpandAbove: num("JEV_LENS_PRESEND_EXPAND_ABOVE", 0.5),
		presendCommandPolicy: process.env.JEV_LENS_PRESEND_COMMAND_POLICY === "gate" ? "gate" : "sections",
		presendSectionExpandAbove: num("JEV_LENS_PRESEND_SECTION_EXPAND_ABOVE", 0.5),
		presendSectionFloor: num("JEV_LENS_PRESEND_SECTION_FLOOR", 0.3),
		model: process.env.JEV_LENS_MODEL || "jev-latest",
		variantFile: process.env.JEV_LENS_VARIANT || undefined,
		forceMock: process.env.JEV_LENS_CLASSIFIER === "mock",
		logFile: process.env.JEV_LENS_LOG !== "0",
		apiKey: resolveApiKey(opts.keyFile),
	};
}

export interface VariantOverrides {
	name?: string;
	config?: Partial<Config>;
	prompts?: Record<string, unknown>;
	views?: Record<string, number>;
}

/** Read a variant file (either a bare variant or an autoresearch best.json with { variant }). */
export function loadVariant(path: string | undefined): VariantOverrides {
	if (!path) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as VariantOverrides & { variant?: VariantOverrides };
		return raw.variant ?? raw;
	} catch {
		return {};
	}
}

/** Config with a variant's config overrides applied. */
export function loadConfigWithVariant(opts: ConfigOptions = {}): { cfg: Config; variant: VariantOverrides } {
	const base = loadConfig(opts);
	const variant = loadVariant(base.variantFile);
	return { cfg: { ...base, ...(variant.config ?? {}) }, variant };
}
