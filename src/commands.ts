import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { CompressedRecord } from "./ui.ts";

const commands = [
	{ value: "stats", label: "stats", description: "Show statistics and active configuration" },
	{ value: "list", label: "list", description: "List recent compressed results" },
	{ value: "diff", label: "diff", description: "Compare original and sent output: diff [n], newest = 1" },
	{ value: "decisions", label: "decisions", description: "Show post-send pruning decisions" },
	{ value: "key", label: "key", description: "Store a TypeSafe API key" },
	{ value: "help", label: "help", description: "Show commands and usage" },
];

export const commandHelp = [
	"/jev-lens [stats] — Show statistics and active configuration.",
	...commands.slice(1).map((c) => `/jev-lens ${c.value === "diff" ? "diff [n]" : c.value} — ${c.description}.`),
	"For diff, 1 is the newest result. Use /jev-lens list to find a number.",
	"Press Tab after /jev-lens to complete a subcommand.",
].join("\n");

/** Pi replaces the entire argument prefix, so diff values include the subcommand. */
export function commandCompletions(prefix: string, records: CompressedRecord[]): AutocompleteItem[] | null {
	const input = prefix.trimStart();
	const diff = /^diff\s+(\d*)$/.exec(input);
	let items: AutocompleteItem[];
	if (diff) {
		items = [...records].reverse().map((r, i) => ({
			value: `diff ${i + 1}`,
			label: `diff ${i + 1}`,
			description: `${r.toolName} · ${r.view} · ${r.tokensBefore} → ${r.tokensAfter} tokens`,
		})).filter((_, i) => String(i + 1).startsWith(diff[1]));
	} else {
		items = commands.filter((c) => c.value.startsWith(input));
	}
	return items.length ? items : null;
}
