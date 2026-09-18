import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DurableNote } from "./types.ts";

export const MEMORY_MAX_LINES = 150;
export const MEMORY_MAX_CHARS = 8000;

function hash(s: string): string {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(16);
}

export function readMemoryFile(path: string): string {
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Append durable notes as bullet lines, dedup by normalized text, cap size keeping the newest. */
export function appendNotes(path: string, notes: DurableNote[]): number {
	if (notes.length === 0) return 0;
	const existing = readMemoryFile(path);
	const lines = existing.split("\n").filter((l) => l.startsWith("- "));
	const seen = new Set(lines.map((l) => hash(l.replace(/^- \(\S+, \w+\) /, "").trim().toLowerCase())));
	let added = 0;
	for (const n of notes) {
		const text = n.text.replace(/\s+/g, " ").trim();
		if (!text) continue;
		const key = hash(text.toLowerCase());
		if (seen.has(key)) continue;
		seen.add(key);
		const date = new Date(n.at).toISOString().slice(0, 10);
		lines.push(`- (${date}, ${n.source}) ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`);
		added++;
	}
	if (added === 0) return 0;
	let kept = lines.slice(-MEMORY_MAX_LINES);
	while (kept.join("\n").length > MEMORY_MAX_CHARS && kept.length > 1) kept = kept.slice(1);
	const header = "# jev-context\n\nDurable notes selected by jev from earlier sessions. Newest last.\n\n";
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${header}${kept.join("\n")}\n`, "utf8");
	return added;
}

export function memoryPromptSection(snapshot: string): string {
	const body = snapshot
		.split("\n")
		.filter((l) => l.startsWith("- "))
		.join("\n");
	if (!body) return "";
	return `\n\n# Memory from earlier sessions (jev-context)\nThese notes were kept from previous sessions in this project. Treat them as likely but verify before relying on details.\n${body}\n`;
}
