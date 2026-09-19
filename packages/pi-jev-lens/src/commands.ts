import type { AutocompleteItem } from "@earendil-works/pi-tui";

const commands = [
	{ value: "stats", label: "stats", description: "Show statistics and active configuration" },
	{ value: "list", label: "list", description: "List recent compressed results" },
	{ value: "decisions", label: "decisions", description: "Show post-send pruning decisions" },
	{ value: "key", label: "key", description: "Store a TypeSafe API key" },
	{ value: "help", label: "help", description: "Show commands and usage" },
];

export const commandHelp = [
	"/jev-lens [stats] — Show statistics and active configuration.",
	...commands.slice(1).map((c) => `/jev-lens ${c.value} — ${c.description}.`),
	"ctrl+o to expand tool output and compare full and compressed output (default keybinding).",
	"Press Tab after /jev-lens to complete a subcommand.",
].join("\n");

export function commandCompletions(prefix: string): AutocompleteItem[] | null {
	const items = commands.filter((c) => c.value.startsWith(prefix.trimStart()));
	return items.length ? items : null;
}
