# pi-jev-lens

The pi extension of [jev-lens](https://github.com/dizk/jev-lens). The core that builds and chooses views is the
`jev-lens` package in the same repository; a Claude Code plugin uses the same core.

Your coding agent reads a 600-line file to change one function. jev-lens sends the model the outline of the file and
that one function. The agent can ask for the rest with the `recall` tool, and the footer of the result tells it so.

jev-lens is an extension for [pi](https://github.com/earendil-works/pi-mono), the coding agent. Tool output is most
of what a coding agent pays for. Every `cat`, every test run and every `grep` goes into the prompt in full and stays
there for the rest of the session. jev-lens acts before that first send. Code builds a small set of candidate views
of the output. A view is a subset of the lines of the output, with line numbers. Then [jev](https://docs.typesafe.ai),
the judgment model from TypeSafe, picks the smallest view that still lets the agent do its next step. Nothing is
generated or summarized. Every view is made of lines from the original, so the agent can ask for exactly the part
that it does not have.

This is what the model sees instead of a file of 1.5k tokens:

```
  1│ import { parse } from "./parse.js";
     ⋯ 14 lines omitted
 16│ export function normalizeCategory(raw) {
 17│   const key = raw.trim().toLowerCase();
 18│   return ALIASES[key] ?? key;
 19│ }
     ⋯ 61 lines omitted
 81│ export function categoryReport(entries) {
     ⋯ 20 lines omitted

[jev-lens: showing the "relevant" view, 9 of 102 lines. Omitted lines are marked ⋯. Call recall(id: "…") for the
full output, or recall(id, lines: "a-b") / recall(id, pattern: "...") for a slice.]
```

## What the numbers say

We measured the defaults on 500 real agent trajectories (OpenHands on SWE-rebench: 3300 large tool results, 11.6
million tokens) and on our own daily pi sessions. A token is the unit that a model provider bills. The research log
is STATUS.md. These are the main results:

| result | source |
|---|---|
| 79 % fewer tokens sent for large tool results (11.6M became 2.4M) | the 500 benchmark trajectories |
| 88 % fewer on command output (test runs, grep, build logs), 58 % on docs, 47 % on listings, 31 % on code | the same, per kind of output |
| 31 % fewer tokens for large tool results | our own sessions with gpt-6-astra, which reads code with `cat` and runs few tests |
| 2 of 26 later edits missed their block, 0.3 % of results had a dropped line quoted, 2.2 % had a dropped identifier used | the harm side, same 500 trajectories |
| 8 % lower cost, 17 % smaller final prompt, the same pass rate, zero recalls | live end-to-end runs in pi where the agent reads big files, 3 runs each |

Read the two savings numbers together. The benchmark agent spends its output budget on pytest runs and grep, and
those compress to almost nothing. An agent that mostly reads source code sits closer to the code number, because
code is the one thing that jev-lens does not compress unless jev is confident. Both numbers are shares of large tool
results only. Over a whole session, the footer counts the system prompt, the conversation and every small result too,
so it will show a lower percentage. What you save depends on what your agent reads.

Three results shaped the design:

1. Compress before the first send, not after. Pruning old results later removes 19 % of the tokens and costs 17 %
   more money, because every rewrite of an old message breaks the prompt cache. The prompt cache is the provider's
   discount for a prompt prefix that did not change since the last call. Post-send pruning is still in the code, but
   it is off by default.
2. Code is different. Test logs and grep output can lose 90 % of their lines and the agent does not miss them. The
   agent edits from code, and an edit fails when its old text is a line that the model never saw. So views of code
   keep every retained line byte for byte, and code is sent in full unless jev is confident. The policy that always
   sends an outline saved more and missed 17 % of later edits. It is available, but you must turn it on.
3. Views built in code beat prompt tuning. In four rounds, a researcher model rewrote the questions to jev and the
   thresholds. None of its changes held up on data that it had not seen. Every gain that held was a new kind of view:
   only the failing tests, grep match groups, JSON keys, the file that the agent read with `cat`.

## Install

Use pi 0.84.3 or newer. The extension uses pi's built-in tool renderers for results that it does not compress.

```sh
pi install npm:pi-jev-lens
```

jev needs a TypeSafe API key. You can get one at [console.typesafe.ai](https://console.typesafe.ai). jev-lens looks
for the key in this order:

1. `TYPESAFE_API_KEY` in the environment.
2. A `.env` file next to the installed package. This is for development and supplies environment values that are not already set.
3. The key that you stored with `/jev-lens key` inside pi. In terminal mode, the command opens a masked input field.
   The key is stored in `~/.pi/agent/jev-lens.json`. New files are readable only by you.

Use `/jev-lens key` without an argument to keep the key out of command history. The field displays only `*` characters.
Type or paste the key, then press Enter to save. Press Esc to cancel without changing the stored key.
In RPC or noninteractive mode, set `TYPESAFE_API_KEY`. These modes do not fall back to a visible input field.
The key file still stores the key as plain text. Masking protects the terminal display, not the file.

You can still use `/jev-lens key ts_...`, but that exposes the key in the editor and can retain it in command history.
A new key takes effect without a restart, but the command does not validate it.
If `TYPESAFE_API_KEY` is set, that value takes priority again after reload.
If mock mode is forced or compression is disabled, storing a key does not change those settings.

If no key is found, the extension shows a warning at startup and uses a deterministic mock classifier.
The mock can compress results without API calls. It is not the jev model.

For development, clone the repository and load it directly:

```sh
git clone https://github.com/dizk/jev-lens.git && cd jev-lens && npm install
echo 'TYPESAFE_API_KEY=...' > .env
pi -e ./packages/pi-jev-lens/index.ts
```

## How it works

Every text tool result of at least 1200 estimated tokens (about 5 kB) goes through pi's `tool_result` hook before
pi stores it or sends it. jev-lens never touches smaller results. Code builds the candidate views. Each view is a
subset of the lines of the output, with line numbers and markers for the omitted lines. No text is generated.

| view | for | keeps |
|---|---|---|
| `outline` | code, prose | imports, exports, signatures, headings, doc comments |
| `relevant` | code, command output | the outline or the section headers, plus the full bodies that jev says the agent will need (second jev step) |
| `sections` | command output | the first line of every section: grep match groups, JSON keys, headings, markers like `COMMAND:`, paragraphs |
| `signals` | command output | errors, warnings, failing tests, summary lines, the tail |
| `testlog` | test output | failures, assertions, tracebacks and summaries |
| `matches` | search output | the first matches per file, with a count of the omitted ones |
| `log` | repetitive output | representative repeated lines, errors and the tail |
| `tree` | directory listings | a sample of entries per directory, with a count of the omitted ones |
| `focus` | anything | the lines that mention identifiers from the task and the tool call, with context |
| `sample` | tabular or log-like data | the header, a dozen rows, the count |
| `head_tail` | anything | the first and the last lines |

jev then answers two questions. It sees the task, the text that the assistant wrote before the call, and a preview of
each view. The questions are: which view is the smallest one that is still enough (a choice), and will the next step
need the exact full text (yes or no). If jev chose an outline or a `sections` view, a second request asks, for each
block or section, whether the agent will need its body. Those bodies go back into the view. If the result reaches
90 % of the original size, jev-lens sends the full text instead.

These rules make it safe for the agent to edit from a view:

- Views of code and prose keep every retained line exactly as it is. An edit whose old text was copied from the view
  still matches the file. Views of command output shorten decorative bars and very long lines.
- Files that the agent reads through bash (`cat a.py b.py`, `sed -n '1,80p' x.ts`, `head`, brace groups, globs) count
  as code or prose and get the same views as the `read` tool. If the command also does something else, the output
  stays command output.
- jev-lens never reduces the results of the agent's own `edit` and `write` tools.
- jev-lens sends code in full unless jev is confident that a view is enough. This is the `gate` policy. The
  `outline` policy always sends an outline plus expanded bodies. It saves more, but it missed 17 % of later edits on
  real trajectories, so you must turn it on yourself.

The code structure comes from tree-sitter (grammars from `@vscode/tree-sitter-wasm` and
`@binclusive/tree-sitter-kotlin-wasm`): TypeScript, TSX, JavaScript, Kotlin, Java, Rust, Python, Go, C, C++, C#,
Ruby, PHP, Bash, CSS. Large classes are split into their members. For other languages, jev-lens uses regular
expressions that know the common declaration keywords.

When jev-lens compresses a result, it keeps the full output in the result's `details`. pi persists that in the
session but never sends it to the model. The footer names the `recall` tool, which serves the full output back by
id, by line range or by pattern. jev-lens logs every recall as a signal that a view was too small.

## In pi

The footer shows the share of the session's input tokens that jev kept out of the prompt, and what it did:

```
jev-lens −38% of input (presend −12.3k · 5/8 · 1 recalls)
```

The share is cut divided by sent plus cut. Sent counts input and cache-read tokens reported by the provider since the last load.
Cut estimates what compressed results saved on those calls, including results restored from the session.
The percentage counts repeated savings when the same result appears in later prompts. The `presend` total counts each result once.

After `/reload` or resume, the footer includes saved tokens from restored compressed results.
For example, `0/3 new · 5 restored` means no new compressions among three candidates, plus five restored compressed results.
New-result counts and recall counts start at zero after loading. `/jev-lens stats` shows new and restored savings separately.

In the transcript, a compressed result shows a header like `⌁ jev-lens outline · 179 of 1524 tokens (−88 %)`. When
you press ctrl+o to expand, you see full output on the left and compressed output on the right.
Retained lines align with their originals. A `−` marks each omitted line in the full output.
Long lines wrap. On narrow terminals, the two versions appear one below the other.
The collapsed result ends with a hint such as `… (48 lines pruned, 50 original, ctrl+o for diff)`.
The compressed version includes omission markers but excludes the recall footer. Press ctrl+o again to collapse.
This uses pi's tool expansion keybinding, including any custom binding.

Type `/jev-lens ` and press Tab to complete subcommands.
Use `/reload` after installing the package in a running pi session.

- `/jev-lens` or `/jev-lens stats` shows the statistics, active configuration, and key source.
- `/jev-lens help` shows command usage.
- `/jev-lens decisions` shows post-send pruning decisions. Post-send pruning is off by default.
- `/jev-lens list` lists the latest 200 compressed results with the tokens before and after.
- `/jev-lens key` stores the API key.

If compression fails, jev-lens keeps the full output and shows a warning. A failed post-send classification leaves that result unchanged.
Warnings appear at most once per stage per session. The footer shows `degraded` until a later attempt in that stage succeeds.
Use `/jev-lens stats` to see failure counts and recovery status. Cancellation does not count as a failure.

Uncompressed results, errors, and streaming updates use pi's built-in tool renderers.
jev-lens logs every decision to `<project>/.pi/jev-lens.log` as JSON lines. Set `JEV_LENS_UI=0` to disable the
custom savings headers and tool overrides.

### Configuration (environment)

| variable | default | meaning |
|---|---|---|
| `JEV_LENS_PRESEND` | `1` | `0` turns compression off |
| `JEV_LENS_PRESEND_MIN_TOKENS` | `1200` | smaller results are always sent in full |
| `JEV_LENS_PRESEND_NEEDS_FULL_ABOVE` / `_FULL_MASS_ABOVE` | `0.5` / `0.5` | send full when P(needs full) or P(full view) is above these |
| `JEV_LENS_PRESEND_CODE_POLICY` | `gate` | `outline`: always send an outline plus expanded bodies (more savings, more missed edits) |
| `JEV_LENS_PRESEND_CODE_NEEDS_FULL_ABOVE` | `0.5` | code uses the lower of this and the general needs-full threshold |
| `JEV_LENS_PRESEND_EXPAND_ABOVE` | `0.5` | expand the body of a code block when P(needed) is above this |
| `JEV_LENS_PRESEND_COMMAND_NEEDS_FULL_ABOVE` | `0.65` | the needs-full threshold for command output |
| `JEV_LENS_PRESEND_COMMAND_POLICY` | `sections` | when jev picks full for command output but needs-full is low, send the section headers and expand the needed sections. `gate`: keep jev's choice |
| `JEV_LENS_PRESEND_SECTION_EXPAND_ABOVE` | `0.5` | expand a section when P(needed) is above this |
| `JEV_LENS_PRESEND_SECTION_FLOOR` | `0.3` | send full when no section reaches this probability, because jev could not tell. `0` allows headers alone |
| `JEV_LENS_PRESEND_MIN_CONFIDENCE` | `0` | send full below this choice confidence. `0` turns the check off |
| `JEV_LENS_MODEL` | `jev-latest` | the jev model |
| `JEV_LENS_CLASSIFIER` | unset | `mock` forces the deterministic classifier, with no API calls |
| `JEV_LENS_LOG` | `1` | `0` turns logging off |
| `JEV_LENS_UI` | `1` | `0` turns the custom tool rendering off |
| `JEV_LENS_VARIANT` | unset | a JSON file with `config`, `prompts` and `views` overrides, as the autoresearch loop writes it |
| `JEV_LENS_MODE` | `off` | optional post-send pruning, see below |

## Evaluation

Every change is scored against what the agent did next in a recorded trajectory. That is the only honest judge of
whether the agent needed the text. The benchmark uses real OpenHands trajectories in `eval/bench/`. The script
`eval/bench/fetch.sh` downloads the data. The metrics are:

- edit-miss: the agent later edited a line that the view had dropped.
- quote-miss: the agent quoted text that the view had dropped.
- ref-miss: the agent used an identifier that only existed in the dropped part.

An edit-miss counts five times in the objective, and edit-misses are rare. So you must score every change that
touches code views on the 500-trajectory slice, not only on the 100-trajectory holdout.

| slice | large results | saved | edit-miss | quote-miss | ref-miss |
|---|---|---|---|---|---|
| 100 trajectories (rows 200-299) | 681 | 77.8 % | 0/7 | 0.6 % | 2.3 % |
| 500 trajectories (rows 300-799) | 3296 | 79.0 % | 2/26 | 0.3 % | 2.2 % |

```sh
npm test                                                # unit tests, mock classifier
node --import tsx eval/bench/run.ts --from 200 --to 300 # the holdout, about 4 minutes
node --import tsx eval/bench/run.ts --from 300 --to 800 # the 500-trajectory slice, about 20 minutes
node --import tsx eval/presend-replay.ts <session dir>  # replay your own pi sessions from ~/.pi/agent/sessions
node --import tsx eval/bench/autoresearch.ts --iterations 8   # a researcher model tunes the prompts and thresholds
```

[STATUS.md](../../STATUS.md) at the repository root is the research log. It lists every variant that we tried, its numbers, and why the defaults are what they
are. In short: new code-built views moved the numbers, prompt wording did not, and the small holdout was wrong about
code until the slice was five times larger.

## Optional: post-send pruning

`JEV_LENS_MODE=budget` (or `rolling`, or `batch`) turns on a second layer. After the agent reacted to a tool result,
jev judges whether the result is still needed. In later prompts, a result that is not needed is cut to its head and
tail, or replaced by a stub of one line. jev-lens persists each decision and freezes it after the first use, so the
cached prefix is rewritten as rarely as possible. The `budget` mode only rewrites when the pending cuts remove at least
half of the tail that they would touch. On real sessions, this layer frees context but does not save money under
prompt-cache pricing. That is why it is off by default.

Its settings are `JEV_LENS_BUDGET_FRACTION` and `JEV_LENS_BUDGET_MIN_TOKENS` (`0.5` and `1000`), `JEV_LENS_FORGET_BELOW`
(`0.25`), `JEV_LENS_TRIM_BELOW` and `JEV_LENS_TRIM_ABOVE` (`0.5` and `0.6`), `JEV_LENS_MIN_TOKENS` (`150`),
`JEV_LENS_TRIM_HEAD` and `JEV_LENS_TRIM_TAIL` (`15` and `15`), `JEV_LENS_CLASSIFY_WAIT_MS` (`2500`),
`JEV_LENS_CACHE_TTL_MS` (`300000`), `JEV_LENS_STATE_HEAD` and `JEV_LENS_STATE_TAIL` (`2500` and `800`), and
`JEV_LENS_DISABLED=1` (new decisions become `keep`). The command `/jev-lens decisions` lists the decisions. jev-lens
never removes a tool result. It only rewrites it.

## Using this as a reference

The pieces that do not depend on pi live in the `jev-lens` core package (`packages/core`), which any agent can use
as a library; its README shows the API. What is where:

| piece | file | depends on |
|---|---|---|
| the pre-send pipeline: candidates, jev's choice, expansion, footer | `packages/core/src/lens.ts` | the rows below |
| candidate views | `packages/core/src/views.ts` | nothing. The async code views can load `treesitter.ts` |
| tree-sitter blocks and signatures | `packages/core/src/treesitter.ts` | `web-tree-sitter`, `@vscode/tree-sitter-wasm`, `@binclusive/tree-sitter-kotlin-wasm` |
| the jev questions, the state shape, the decision rule, block expansion | `packages/core/src/presend.ts` | `@typesafe-ai/sdk` |
| the parser for bash display commands | `packages/core/src/shell-display.ts` | nothing |
| the recall tool's slicing | `packages/core/src/recall.ts` | nothing |
| the wiring for pi (tool_result, the recall tool, the UI) | `packages/pi-jev-lens/index.ts`, `packages/pi-jev-lens/src/ui.ts` | pi |
| the wiring for Claude Code (PostToolUse hook, MCP server) | `packages/claude-code/src/` | Claude Code |
| the benchmark and the metrics on real trajectories | `eval/presend-score.ts`, `eval/bench/` | run `eval/bench/fetch.sh` first |
| post-send decisions and the frozen ledger (pi only) | `packages/core/src/classifier.ts`, `packages/pi-jev-lens/src/policy.ts`, `packages/pi-jev-lens/src/ledger.ts` | `@typesafe-ai/sdk` |

The sequence is this. When a large tool result arrives, code builds the views from the text. jev says which view is
enough and whether the exact text is needed. Code applies the selection policy. If needed, a second request expands
blocks or sections. If a reduced view wins, the content becomes that view plus a footer that names `recall`, and the
full text stays in the details of the result.

## Contributing and license

Issues and pull requests are welcome at [github.com/dizk/jev-lens](https://github.com/dizk/jev-lens).
`npm test` runs the unit tests with the mock classifier. `npm run typecheck` runs tsc. A change to how views are
built or chosen must come with benchmark numbers. If the change touches code views, you must use the 500-trajectory
slice.

For npm publication through GitHub Releases, see [Release to npm](../../docs/releasing.md).

MIT, see LICENSE.
