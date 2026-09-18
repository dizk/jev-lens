import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type SealMode = "rolling" | "batch" | "budget";

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
	/** P(durable) above this → written to the memory file. */
	durableAbove: number;
	/** Tool results smaller than this (estimated tokens) are never touched. */
	minTokens: number;
	/** How long the context hook waits for in-flight classifications. */
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
	/** Stricter needs-full threshold for source code, where a wrong view costs an edit (jev's answers vary run to run by ±0.2). */
	presendCodeNeedsFullAbove: number;
	/** Send full when the choice confidence is below this (0 = off; a spread over acceptable views is not a reason to send everything). */
	presendMinConfidence: number;
	/** Second step for code: expand the bodies of blocks jev says the agent will need (P above this). */
	presendExpandAbove: number;
	model: string;
	/** Optional variant file (JEV_MEMORY_VARIANT): { config, prompts, views } overrides, as produced by eval/bench/autoresearch.ts. */
	variantFile: string | undefined;
	/** Force the mock classifier even when a key is present (tests, dry runs). */
	forceMock: boolean;
	logFile: boolean;
	apiKey: string | undefined;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Load KEY=VALUE lines from the extension's own .env (never from the target project). */
export function loadDotEnv(): void {
	for (const dir of [join(HERE, ".."), HERE]) {
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

export function loadConfig(): Config {
	loadDotEnv();
	const envMode = process.env.JEV_MEMORY_MODE;
	const mode: SealMode = envMode === "batch" || envMode === "budget" || envMode === "rolling" ? envMode : "budget";
	return {
		enabled: process.env.JEV_MEMORY_DISABLED !== "1",
		mode,
		budgetFraction: num("JEV_MEMORY_BUDGET_FRACTION", 0.5),
		budgetMinTokens: num("JEV_MEMORY_BUDGET_MIN_TOKENS", 1000),
		forgetBelow: num("JEV_MEMORY_FORGET_BELOW", 0.25),
		trimBelow: num("JEV_MEMORY_TRIM_BELOW", 0.5),
		trimAbove: num("JEV_MEMORY_TRIM_ABOVE", 0.6),
		durableAbove: num("JEV_MEMORY_DURABLE_ABOVE", 0.7),
		minTokens: num("JEV_MEMORY_MIN_TOKENS", 150),
		classifyWaitMs: num("JEV_MEMORY_CLASSIFY_WAIT_MS", 2500),
		cacheTtlMs: num("JEV_MEMORY_CACHE_TTL_MS", 5 * 60 * 1000),
		trimHeadLines: num("JEV_MEMORY_TRIM_HEAD", 15),
		trimTailLines: num("JEV_MEMORY_TRIM_TAIL", 15),
		stateHeadChars: num("JEV_MEMORY_STATE_HEAD", 2500),
		stateTailChars: num("JEV_MEMORY_STATE_TAIL", 800),
		presend: process.env.JEV_MEMORY_PRESEND !== "0",
		presendMinTokens: num("JEV_MEMORY_PRESEND_MIN_TOKENS", 1200),
		presendNeedsFullAbove: num("JEV_MEMORY_PRESEND_NEEDS_FULL_ABOVE", 0.5),
		presendFullMassAbove: num("JEV_MEMORY_PRESEND_FULL_MASS_ABOVE", 0.5),
		presendCodeNeedsFullAbove: num("JEV_MEMORY_PRESEND_CODE_NEEDS_FULL_ABOVE", 0.5),
		presendCommandNeedsFullAbove: num("JEV_MEMORY_PRESEND_COMMAND_NEEDS_FULL_ABOVE", 0.65),
		presendMinConfidence: num("JEV_MEMORY_PRESEND_MIN_CONFIDENCE", 0),
		presendExpandAbove: num("JEV_MEMORY_PRESEND_EXPAND_ABOVE", 0.5),
		model: process.env.JEV_MEMORY_MODEL || "jev-latest",
		variantFile: process.env.JEV_MEMORY_VARIANT || undefined,
		forceMock: process.env.JEV_MEMORY_CLASSIFIER === "mock",
		logFile: process.env.JEV_MEMORY_LOG !== "0",
		apiKey: process.env.TYPESAFE_API_KEY,
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
export function loadConfigWithVariant(): { cfg: Config; variant: VariantOverrides } {
	const base = loadConfig();
	const variant = loadVariant(base.variantFile);
	return { cfg: { ...base, ...(variant.config ?? {}) }, variant };
}
