# Changelog

## Unreleased

- Claude Code plugin: stored outputs are kept for 90 days (`JEV_LENS_KEEP_DAYS`), up from 14, so sessions can be
  replayed offline. `src/trajectory.ts` exports transcripts as benchmark trajectories with the full outputs restored
  from the store; sub-agent transcripts are exported too.
- Claude Code plugin: the text before the call now comes from the message that holds the call, then the same turn,
  then an earlier turn, and the log says which. A sub-agent's call is looked up in its own transcript file; before,
  sub-agent calls got the main conversation's context.
- Benchmark: `recall-miss`, a recorded recall that the replayed view would not have answered, joins the metrics and
  the objective (weight 2).
- Claude Code plugin: `stats` reports how many compressed results Claude recalled, the number to watch while testing
  whether the views hide what the task needed. Recall log records now carry the session of the stored output.

## 0.5.1 (2026-09-19)

- Claude Code plugin: `src/statusline.ts` prints a status line segment for the current session, in the shape of the
  pi extension's status text (`jev-lens −12.3k · 5/8 · 1 recall`). Claude Code has no plugin-provided status line,
  so the README shows how to append it to your own `statusLine` command.
- Compression rules, views and thresholds are unchanged. The core and the pi extension are republished at 0.5.1 only
  because all packages share one version.

## 0.5.0 (2026-09-19)

The repository is now `dizk/jev-lens`, a monorepo with three packages that share one core. Compression rules,
views, thresholds and the model input are unchanged.

- `jev-lens` (new, npm): the host-independent core. Candidate views, tree-sitter outlines, the jev questions and
  decision rule, block and section expansion, and the recall slicing, behind a small `Lens` class.
- `pi-jev-lens` (npm): the pi extension, now a thin host over `jev-lens`. Same commands, footer, UI and settings.
  Install stays `pi install npm:pi-jev-lens`.
- Claude Code plugin (new, `packages/claude-code`): a PostToolUse hook replaces large Read, Bash and Grep results
  with the view jev picks, in the tool's own output shape; a bundled MCP server serves `recall` and `stats`.
  Install with `/plugin marketplace add dizk/jev-lens` and `/plugin install jev-lens@jev-lens`. Not yet measured
  on Claude Code sessions.
- The key file path is a host choice: pi keeps `~/.pi/agent/jev-lens.json`, the Claude Code plugin uses
  `~/.claude/jev-lens/key.json` or its plugin data directory. `JEV_LENS_KEY_FILE` still overrides both.
- The `.env` the core reads for development is the repository root's (or the package's own), never the target
  project's.


## 0.4.1 (2026-09-19)

- Compression warnings and statistics now show the HTTP status when available.
- HTTP 402 errors now point to TypeSafe credits and billing. Authentication, permission, usage-limit, request-format, and server errors have separate advice.
- Timeout, connection, SDK, and unclassified errors no longer share one generic connection warning.
- Provider response bodies, headers, and credentials remain hidden.

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
