# Changelog

## 0.4.0 (2026-09-19)

Use ctrl+o to compare full and compressed tool output. The `/jev-lens diff` command is removed.

- Expanded results show full and compressed output side by side, with retained lines aligned and omitted lines marked.
- Long lines wrap. Narrow terminals show the two versions one below the other.
- Collapsed results show pruned and original line counts, plus a `ctrl+o for diff` hint that follows your configured keybinding.
- Older results retain their comparison through stored result details, even after they leave the recent-results list.
- Removed the diff overlay and result-number completion. Updated help and documentation.

Compression rules and model input are unchanged. Use pi 0.84.3 or newer.

## 0.3.0 (2026-09-19)

Use pi 0.84.3 or newer with this release.

- Added subcommand completion, available `diff` result numbers, and `/jev-lens help`.
- Invalid commands and result numbers now show usage errors instead of unrelated statistics or results.
- `/jev-lens key` now masks terminal input and supports paste and cancellation. Nonterminal modes do not use a visible input fallback.
- Key setup now reports storage failures, forced mock mode, disabled compression, and environment-key precedence.
- Compression failures now show a warning and a degraded status. Statistics include failure counts and recovery status without repeated warnings.
- Uncompressed results, errors, and streaming updates now use pi's built-in tool renderers.
- The footer now includes restored token savings after reload or resume and labels restored results separately from new attempts.
- Corrected setup documentation, including key resolution order and mock behavior.

## 0.2.1 (2026-09-19)

- The README and the other documentation are rewritten in plain English. No code changed.

## 0.2.0 (2026-09-19)

jev-lens now does one thing: compression before the first send.

- Removed the durable notes: the file `.pi/jev-lens.md`, the text that was added to the system prompt, and the jev call for every message. We never measured their value, and a compressor that writes notes about your conversation is a surprise. The idea stays in docs/ideas.md.
- Post-send pruning is off by default. `JEV_LENS_MODE` is `off`. Set it to `budget`, `rolling` or `batch` to turn it on. The post-send classifier now asks two questions: needed, and outcome only.
- The status line reads `jev-lens −38% of input (presend −12.3k · 5/8 · 1 recalls)`. The `pruned` part is only shown when post-send pruning is on.
- Removed `/jev-lens file` and `JEV_LENS_DURABLE_ABOVE`.

## 0.1.0 (2026-09-19)

First public release.

- Compression of large tool results before the first send. Code builds the views (`outline`, `relevant`, `focus`, `signals`, `testlog`, `tree`, `matches`, `log`, `sample`, `sections`, `head_tail`). jev chooses one. A second jev step puts back the blocks or sections that the agent needs. The full text stays available through the `recall` tool.
- Files that the agent reads with `cat`, `sed -n` or `head` count as code or prose. The results of the agent's own `edit` and `write` tools are never reduced.
- `/jev-lens key` stores the TypeSafe API key in `~/.pi/agent/jev-lens.json`, readable only by the user. `TYPESAFE_API_KEY` in the environment takes precedence.
- A cache-aware post-send pruning ledger (`budget` mode by default) and durable notes in `.pi/jev-lens.md`.
- A benchmark on real OpenHands trajectories (`eval/bench/`) and an autoresearch loop. The findings are in STATUS.md.
