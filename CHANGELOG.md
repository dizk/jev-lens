# Changelog

## 0.1.0 (2026-09-19)

First public release.

- Pre-send compression of large tool results: code-built views (`outline`, `relevant`, `focus`, `signals`, `testlog`, `tree`, `matches`, `log`, `sample`, `sections`, `head_tail`), jev chooses, a second jev step expands the blocks or sections the agent needs, full text stays recallable with the `recall` tool.
- Bash file displays (`cat`, `sed -n`, `head`) are typed as code or prose; the agent's own `edit`/`write` results are never reduced.
- `/jev-lens key` stores the TypeSafe API key in `~/.pi/agent/jev-lens.json` (user-only); `TYPESAFE_API_KEY` in the environment takes precedence.
- Cache-aware post-send pruning ledger (`budget` mode by default) and durable notes in `.pi/jev-lens.md`.
- Benchmark on real OpenHands trajectories (`eval/bench/`) and an autoresearch loop; findings in STATUS.md.
