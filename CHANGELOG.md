# Changelog

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
