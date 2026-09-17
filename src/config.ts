import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type SealMode = "rolling" | "batch";

export interface Config {
	/** Disable all pruning (classification still runs and logs). */
	enabled: boolean;
	/** rolling: apply decisions at the next LLM call. batch: apply only when the cache is cold or on compaction. */
	mode: SealMode;
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
	model: string;
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
	const mode = process.env.JEV_MEMORY_MODE === "batch" ? "batch" : "rolling";
	return {
		enabled: process.env.JEV_MEMORY_DISABLED !== "1",
		mode,
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
		model: process.env.JEV_MEMORY_MODEL || "jev-latest",
		logFile: process.env.JEV_MEMORY_LOG !== "0",
		apiKey: process.env.TYPESAFE_API_KEY,
	};
}
