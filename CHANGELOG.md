# Changelog

## 0.2.0 (2026-09-19)

Pre-send only.

- Removed durable notes (`.pi/jev-lens.md`, system-prompt injection, per-message text classification): never measured, one jev call per message, and a surprise for users who installed a compressor. The idea stays in docs/ideas.md.
- Post-send pruning is off by default (`JEV_LENS_MODE=off`); enable with `budget`, `rolling` or `batch`. The post-send classifier now asks two questions (*needed*, *outcome only*).
- Status line: `jev-lens −38% of input (presend −12.3k · 5/8 · 1 recalls)`; the `pruned` part appears only with post-send on.
- Removed `/jev-lens file` and `JEV_LENS_DURABLE_ABOVE`.

## 0.1.0 (2026-09-19)

First public release.

- Pre-send compression of large tool results: code-built views (`outline`, `relevant`, `focus`, `signals`, `testlog`, `tree`, `matches`, `log`, `sample`, `sections`, `head_tail`), jev chooses, a second jev step expands the blocks or sections the agent needs, full text stays recallable with the `recall` tool.
- Bash file displays (`cat`, `sed -n`, `head`) are typed as code or prose; the agent's own `edit`/`write` results are never reduced.
- `/jev-lens key` stores the TypeSafe API key in `~/.pi/agent/jev-lens.json` (user-only); `TYPESAFE_API_KEY` in the environment takes precedence.
- Cache-aware post-send pruning ledger (`budget` mode by default) and durable notes in `.pi/jev-lens.md`.
- Benchmark on real OpenHands trajectories (`eval/bench/`) and an autoresearch loop; findings in STATUS.md.
