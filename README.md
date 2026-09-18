# pi-jev-lens

**Your coding agent reads a 600-line file to change one function. jev-lens sends the model the outline and that
function.** The rest is one `recall` away, and the agent knows it.

A [pi](https://github.com/earendil-works/pi-mono) extension. Tool output is most of what a coding agent pays for:
every `cat`, every test run, every `grep` lands in the prompt in full and stays there, cached, for the rest of the
session. jev-lens steps in before that first send. Code builds a handful of candidate views of the output, and
[jev](https://docs.typesafe.ai), TypeSafe's System One judgment model, picks the smallest one that still lets the agent
do its next step. Nothing is generated or summarized: every view is lines of the original, with line numbers, so the
agent can ask for exactly the part it is missing.

What the model sees instead of a 1.5k-token file:

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

We did not guess the defaults; we measured them on 500 real agent trajectories (OpenHands on SWE-rebench, 3300 large
tool results, 11.6 million tokens) and on our own day-to-day pi sessions. The research log is STATUS.md; the headlines:

| | |
|---|---|
| **79 % fewer tokens** sent for large tool results across the 500 benchmark trajectories | 11.6M → 2.4M |
| **88 % on command output** (test runs, grep, build logs), 58 % on docs, 47 % on listings, 31 % on code | per kind |
| **31 % of large-result tokens** in our own sessions with gpt-6-astra, which reads code through `cat` and runs few tests | real use |
| **2 of 26 later edits** missed their block; 0.3 % of results had a dropped line quoted; 2.2 % had a dropped identifier used | the harm side |
| **8 % lower cost, 17 % smaller final prompt, same pass rate, zero recalls** on live end-to-end runs where big files get read | pi headless, 3 runs each |

Read the two savings numbers together. The benchmark agent spends its output budget on pytest runs and grep, which
compress to almost nothing; an agent that mostly reads source code sits closer to the code number, because code is
the one thing we refuse to compress unless jev is confident. And both are shares of *large tool results*: over a
whole session, with the system prompt, the conversation and every small result counted, the footer will show a lower
percentage. What you save depends on what your agent reads.

Three things we learned that shaped the design:

- **Compress before the first send, not after.** Pruning old results later looks great on token counts (−19 %) and costs
  *more* money (+17 %), because every rewrite breaks the prompt cache. Post-send pruning is still in the code, off by default.
- **Code is different.** Test logs and grep output can lose 90 % and nobody misses it. Code is edited from, and an edit
  whose old text the model never saw fails. So code views keep every retained line byte-exact, and code is sent full
  unless jev is confident. The tempting always-outline policy saved more and missed 17 % of later edits; it is opt-in.
- **Views built in code beat prompt tuning.** Four rounds of letting a researcher model rewrite jev's prompts and
  thresholds moved nothing that held up on held-out data. Every gain that lasted was a new kind of view: failing tests
  only, grep match groups, JSON keys, the file the agent `cat`-ed through bash.

## Install

```sh
pi install npm:pi-jev-lens                    # from npm
pi install git:github.com/dizk/pi-jev-lens    # or straight from GitHub
```

jev needs a TypeSafe API key (get one at [console.typesafe.ai](https://console.typesafe.ai)). Three ways to provide it,
in the order they are tried:

1. `TYPESAFE_API_KEY` in the environment.
2. `/jev-lens key` inside pi: prompts for the key (or `/jev-lens key ts_...`) and stores it in
   `~/.pi/agent/jev-lens.json`, readable only by you. jev is active from the next tool result, no restart.
3. A `.env` file next to the installed package (development).

Without a key the extension warns at startup and runs a mock classifier that compresses nothing. For development,
clone the repo and load it directly:

```sh
git clone https://github.com/dizk/pi-jev-lens.git && cd pi-jev-lens && npm install
echo 'TYPESAFE_API_KEY=...' > .env
pi -e ./index.ts
```

## How it works

Every text tool result of at least 1200 estimated tokens (about 5 kB) passes through pi's `tool_result` hook before
it is stored or sent. Small results are never touched. Code builds candidate **views**: strict subsets of the output,
with line numbers and omission markers, never generated text.

| view | for | keeps |
|---|---|---|
| `outline` | code, prose | imports, exports, signatures, headings, doc comments |
| `relevant` | code, command output | outline or section headers plus the full bodies jev says the agent will need (second jev step) |
| `sections` | command output | the first line of every section: grep match groups, JSON keys, headings, `COMMAND:`-style markers, paragraphs |
| `signals` | command output | errors, warnings, failing tests, summary lines, the tail |
| `testlog` | test output | failures, assertions, tracebacks and summaries |
| `matches` | search output | first matches per file, with omission counts |
| `log` | repetitive output | representative repeated lines, errors and the tail |
| `tree` | directory listings | a sample of entries per directory, with omission counts |
| `focus` | anything | lines mentioning identifiers from the task and the tool call, with context |
| `sample` | tabular or log-like data | header, a dozen rows, the count |
| `head_tail` | anything | first and last lines |

jev then answers two questions over the task, the assistant's text before the call and a preview of each view:
*which view is the smallest that still suffices* (a Choice) and *will the next step need the exact full text* (a
yes/no). When an outline or `sections` view is chosen, a second request asks, per block or section, whether the agent
will need its body, and those bodies are put back. If that reaches 90 % of the original, full text is sent instead.

What makes it safe to edit from a view:

- Views of code and prose keep every retained line exactly, so an edit whose old text was copied from the view still
  matches the file. Views of command output shorten decorative bars and very long lines.
- Files the agent reads through bash (`cat a.py b.py`, `sed -n '1,80p' x.ts`, `head`, brace groups, globs) are typed as
  code or prose and get the same views as `read`. Anything mixed with other commands stays command output.
- The agent's own `edit` and `write` results are never reduced.
- Code is sent full unless jev is confident a view suffices (`gate` policy). The always-outline policy saves more but
  missed 17 % of later edits on real trajectories, so it is opt-in.

Code structure comes from tree-sitter (grammars from `@vscode/tree-sitter-wasm` plus `@binclusive/tree-sitter-kotlin-wasm`):
TypeScript, TSX, JavaScript, Kotlin, Java, Rust, Python, Go, C, C++, C#, Ruby, PHP, Bash, CSS. Large classes are split
into their members. Other languages fall back to regex heuristics.

**Recall.** When a result is compressed, its full output is kept in the result's `details` (persisted in the session,
never sent to the model). The footer names a `recall` tool that serves it back by id, line range or pattern. Every
recall is logged as feedback that a view was too small.

## In pi

The footer shows the share of the session's input tokens jev kept out of the prompt, and what it did:

```
jev-lens −38% of input (presend −12.3k · 5/8 · 1 recalls)
```

The share is cut / (sent + cut): sent is the provider's own input plus cache-read counts over all calls, cut is what
every compressed result saved on every call it was part of.

In the transcript a compressed result shows a header like `⌁ jev-lens outline · 179 of 1524 tokens (−88 %)` and,
expanded (ctrl+e), exactly what the model saw. Commands:

- `/jev-lens` stats, and where the key comes from
- `/jev-lens list` the latest 200 compressed results with tokens before and after
- `/jev-lens diff [n]` overlay of the n-th latest: the original with the lines the model did not get marked `−`
  (`t` switches to what was sent, `Esc` closes)
- `/jev-lens key` store the API key

Every decision is logged to `<project>/.pi/jev-lens.log` (JSON lines). `JEV_LENS_UI=0` keeps pi's own tool rendering.

### Configuration (environment)

| variable | default | meaning |
|---|---|---|
| `JEV_LENS_PRESEND` | `1` | `0` turns compression off |
| `JEV_LENS_PRESEND_MIN_TOKENS` | `1200` | smaller results are always sent in full |
| `JEV_LENS_PRESEND_NEEDS_FULL_ABOVE` / `_FULL_MASS_ABOVE` | `0.5` / `0.5` | send full when P(needs full) or P(full view) exceeds these |
| `JEV_LENS_PRESEND_CODE_POLICY` | `gate` | `outline`: always send an outline plus expanded bodies (more savings, more edit-misses) |
| `JEV_LENS_PRESEND_CODE_NEEDS_FULL_ABOVE` | `0.5` | code uses the minimum of this and the general needs-full threshold |
| `JEV_LENS_PRESEND_EXPAND_ABOVE` | `0.5` | expand a code block's body when P(needed) exceeds this |
| `JEV_LENS_PRESEND_COMMAND_NEEDS_FULL_ABOVE` | `0.65` | needs-full threshold for command output |
| `JEV_LENS_PRESEND_COMMAND_POLICY` | `sections` | when jev picks full for command output but needs-full is low, send section headers and expand the needed sections. `gate`: jev's choice stands |
| `JEV_LENS_PRESEND_SECTION_EXPAND_ABOVE` | `0.5` | expand a section when P(needed) exceeds this |
| `JEV_LENS_PRESEND_SECTION_FLOOR` | `0.3` | send full when no section reaches this probability (jev could not tell); `0` allows headers alone |
| `JEV_LENS_PRESEND_MIN_CONFIDENCE` | `0` | send full below this choice confidence (0 = off) |
| `JEV_LENS_MODEL` | `jev-latest` | jev model |
| `JEV_LENS_CLASSIFIER` | unset | `mock` forces the deterministic classifier, no API calls |
| `JEV_LENS_LOG` | `1` | `0` disables logging |
| `JEV_LENS_UI` | `1` | `0` disables the custom tool rendering |
| `JEV_LENS_VARIANT` | unset | JSON file with `config`, `prompts` and `views` overrides, as produced by the autoresearch loop |
| `JEV_LENS_MODE` | `off` | optional post-send pruning, see below |

## Evaluation

Every change here is scored against what the agent actually did next in a recorded trajectory, which is the only
honest judge of "did it need that text". The benchmark is real OpenHands trajectories (`eval/bench/`, data fetched by
`eval/bench/fetch.sh`), and the metrics are: **edit-miss** (it edited a line the view had dropped), **quote-miss** (it quoted dropped text),
**ref-miss** (it used an identifier that only existed in the dropped part). Edit-misses are weighted five times in
the objective, and they are rare, so anything that touches code views must be scored on the 500-trajectory slice:

| slice | large results | saved | edit-miss | quote-miss | ref-miss |
|---|---|---|---|---|---|
| 100 trajectories (rows 200-299) | 681 | 77.8 % | 0/7 | 0.6 % | 2.3 % |
| 500 trajectories (rows 300-799) | 3296 | 79.0 % | 2/26 | 0.3 % | 2.2 % |

```sh
npm test                                                # unit tests, mock classifier
node --import tsx eval/bench/run.ts --from 200 --to 300 # holdout, ~4 min
node --import tsx eval/bench/run.ts --from 300 --to 800 # the 500-trajectory slice, ~20 min
node --import tsx eval/presend-replay.ts <session dir>  # replay your own pi sessions from ~/.pi/agent/sessions
node --import tsx eval/bench/autoresearch.ts --iterations 8   # a researcher model tunes prompts and thresholds
```

STATUS.md is the research log: every variant tried, its numbers, and why the defaults are what they are. The short
version: new code-built views moved the numbers, prompt wording did not, and the small holdout was wrong about code
until the slice was five times larger.

## Optional: post-send pruning

`JEV_LENS_MODE=budget` (or `rolling`, `batch`) turns on a second layer: after the agent has reacted to a tool result,
jev judges whether it is still needed, and the result is trimmed to head and tail or replaced by a one-line stub in
later prompts. Decisions are persisted and frozen once applied, so the cached prefix is rewritten as rarely as
possible; `budget` mode only rewrites when the pending prunes remove at least half of the tail they would touch.
Measured on real sessions this frees context but does not save money under prompt-cache pricing, which is why it is
off by default. Its settings: `JEV_LENS_BUDGET_FRACTION` / `_BUDGET_MIN_TOKENS` (`0.5` / `1000`), `JEV_LENS_FORGET_BELOW`
(`0.25`), `JEV_LENS_TRIM_BELOW` / `_TRIM_ABOVE` (`0.5` / `0.6`), `JEV_LENS_MIN_TOKENS` (`150`), `JEV_LENS_TRIM_HEAD` /
`_TRIM_TAIL` (`15` / `15`), `JEV_LENS_CLASSIFY_WAIT_MS` (`2500`), `JEV_LENS_CACHE_TTL_MS` (`300000`),
`JEV_LENS_STATE_HEAD` / `_STATE_TAIL` (`2500` / `800`), `JEV_LENS_DISABLED=1` (new decisions become `keep`).
`/jev-lens decisions` lists them. Tool results are never removed, only rewritten.

## Using this as a reference

The pieces are independent of pi and can be lifted into another agent:

| piece | file | depends on |
|---|---|---|
| candidate views | `src/views.ts` | nothing; async code views optionally load `src/treesitter.ts` |
| tree-sitter blocks and signatures | `src/treesitter.ts` | `web-tree-sitter`, `@vscode/tree-sitter-wasm`, `@binclusive/tree-sitter-kotlin-wasm` |
| the jev questions, state shape, decision rule, block expansion | `src/presend.ts` | `@typesafe-ai/sdk` |
| bash display-command parser | `src/shell-display.ts` | nothing |
| the hook wiring for pi (tool_result, recall tool, UI) | `index.ts`, `src/ui.ts` | pi |
| benchmark and metrics on real trajectories | `eval/presend-score.ts`, `eval/bench/` | run `eval/bench/fetch.sh` first |
| post-send decisions and the frozen ledger | `src/classifier.ts`, `src/policy.ts`, `src/ledger.ts` | `@typesafe-ai/sdk` |

In one paragraph: when a large tool result arrives, build views from the text (code, no model), ask jev which view
suffices and whether exact text is needed, apply the selection policy, and optionally expand blocks or sections in a
second request. If a reduced view wins, replace the content with that view plus a footer naming `recall`, and keep the
full text in the result's details.

## Contributing and license

Issues and pull requests are welcome at [github.com/dizk/pi-jev-lens](https://github.com/dizk/pi-jev-lens).
`npm test` runs the unit tests with the mock classifier; `npm run typecheck` runs tsc. Changes to how views are built
or chosen should come with benchmark numbers, on the 500-trajectory slice when they touch code.

MIT, see LICENSE.
