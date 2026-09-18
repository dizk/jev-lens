/** A deliberately small shell subset, not a general shell parser. Unknown syntax fails closed. */
export function displayedFiles(command: string): string[] | undefined {
	if (command.length > 16384 || /[<>`$\\()#\r]/.test(command)) return undefined;
	const tokens: { value: string; operator?: boolean }[] = [];
	for (let i = 0; i < command.length;) {
		const c = command[i];
		if (c === " " || c === "\t") { i++; continue; }
		if (";|&\n".includes(c)) {
			let value = c;
			if (command[i + 1] === c && (c === "&" || c === "|")) { value += c; i++; }
			if (value === "&" || value === "||") return undefined;
			tokens.push({ value, operator: true }); i++; continue;
		}
		if (c === "'" || c === '"') {
			const end = command.indexOf(c, i + 1);
			if (end < 0 || (end + 1 < command.length && !/[\s;|&]/.test(command[end + 1]))) return undefined;
			const value = command.slice(i + 1, end);
			// Quoted wildcard/brace paths need literal matching, not shell expansion.
			if (/[{}*?\[\]\n]/.test(value)) return undefined;
			tokens.push({ value }); i = end + 1; continue;
		}
		let end = i;
		while (end < command.length && !/[\s;|&]/.test(command[end])) end++;
		const value = command.slice(i, end);
		if (!value || /['"]/.test(value)) return undefined;
		tokens.push({ value }); i = end;
	}
	const files: string[] = [];
	let stage: string[] = [], filter = false;
	const finish = () => {
		const paths = displayStage(stage);
		if (!paths || (filter ? paths.length !== 0 : paths.length === 0)) return false;
		files.push(...paths);
		stage = [];
		return files.length <= 256;
	};
	for (const token of tokens) {
		if (!token.operator) { stage.push(token.value); continue; }
		if (!stage.length) {
			if (token.value === "\n" && !filter) continue;
			return undefined;
		}
		if (!finish()) return undefined;
		filter = token.value === "|";
	}
	if (stage.length) { if (!finish()) return undefined; }
	else if (filter || tokens.at(-1)?.value === "&&") return undefined;
	return files.length ? files : undefined;
}

/** Only content-preserving cat, line-limited head/tail, and sed -n range-p are recognized. */
function displayStage(words: string[]): string[] | undefined {
	const [executable, ...args] = words;
	if (!executable || !/^(?:(?:\/usr)?\/bin\/)?(?:cat|head|tail|sed)$/.test(executable)) return undefined;
	const cmd = executable.split("/").pop();
	let i = 0;
	if (cmd === "sed") {
		if (args[i++] !== "-n" || !/^\d+(?:,(?:\d+|\$))?p$/.test(args[i++] ?? "")) return undefined;
	} else if (cmd === "head" || cmd === "tail") {
		if (args[i] === "-n") { i++; if (!/^\d+$/.test(args[i++] ?? "")) return undefined; }
		else if (/^-\d+$/.test(args[i] ?? "")) i++;
	}
	if (args[i] === "--") i++;
	const paths: string[] = [];
	for (const arg of args.slice(i)) {
		if (!arg || arg.startsWith("-") || /[~!]/.test(arg)) return undefined;
		const expanded = expandBraces(arg);
		if (!expanded) return undefined;
		paths.push(...expanded);
	}
	return paths;
}

function expandBraces(word: string): string[] | undefined {
	let pending = [word];
	for (;;) {
		const next: string[] = [];
		let expanded = false;
		for (const item of pending) {
			const m = /^(.*?)\{([^{}]+)\}(.*)$/.exec(item);
			if (!m) { if (/[{}]/.test(item)) return undefined; next.push(item); continue; }
			if (!m[2].includes(",")) return undefined;
			for (const alt of m[2].split(",")) next.push(m[1] + alt + m[3]);
			expanded = true;
			if (next.length > 256) return undefined;
		}
		if (!expanded) return next;
		pending = next;
	}
}
