# pi-jev-context

A [pi](https://github.com/earendil-works/pi-mono) extension that **compresses large tool results before they reach the
model**, using [jev](https://docs.typesafe.ai) (TypeSafe's System One model) to select useful views and code blocks.
The agent gets a smaller result now and can use `recall` to retrieve omitted text when needed.

**Pre-send compression is the main cost lever.** Avoiding the first send saves uncached input tokens without rewriting
an already-cached message. Pruning later can free context, but may cost more by invalidating part of the prompt cache.

The extension has three complementary layers, all enabled by default:

1. **Pre-send compression:** send outlines, relevant code blocks or filtered output instead of the entire result.
2. **Cache-aware post-send pruning:** after the agent reacts, keep, trim or stub results when the pruning policy permits.
3. **Durable notes:** retain selected project facts and preferences for future sessions.

## Pre-send compression (the cost lever)

Large text tool results (default: at least 1200 estimated tokens, estimated as characters / 4) are considered for
compression in pi's `tool_result` hook. Results containing images and calls to `recall` are excluded. Code builds
candidate **views** from the output, with line numbers and omission markers. Views of code and prose preserve
retained lines exactly, so edits copied from a view still match the file; views of command output, listings and
data shorten decorative bars, long runs of spaces and very long lines. Full text is still sent when no suitable reduced view
is available or classification fails. A conservative subset of bash file displays (`cat a.py b.py`,
`sed -n '1,80p' x.ts`, line-limited `head`/`tail`, brace groups and globs) gets code or prose views when all displayed
files have that type. Pipelines may only filter stdin with recognized options. Redirections, substitutions, modifying
`sed` scripts, mixed code/non-code files and unsupported syntax retain ordinary command handling:

| view | for | keeps |
|---|---|---|
| `outline` | code, prose | imports, exports, signatures, headings, doc comments |
| `relevant` | code | outline plus the full bodies of the blocks jev says the agent will need (second jev step) |
| `focus` | anything | lines mentioning identifiers from the task and the tool call, with context |
| `signals` | command output | errors, warnings, failing tests, summary lines, the tail |
| `sample` | tabular or log-like data | header, a dozen rows, the count |
| `head_tail` | anything | first and last lines |
| `testlog` | test output | failures, assertions, tracebacks and summaries |
| `tree` | directory listings | a sample of entries per directory, with omission counts |
| `matches` | search output | first matches per file, with omission counts |
| `log` | repetitive output | representative repeated lines, errors and the tail |
| `sections` | command output | the first line of every section (grep match groups, JSON keys, headings, `COMMAND:`-style markers, paragraphs); a second jev step puts back the sections the agent needs, giving `relevant` |

Code structure comes from tree-sitter (grammars from `@vscode/tree-sitter-wasm` plus `@binclusive/tree-sitter-kotlin-wasm`):
TypeScript, TSX, JavaScript, Kotlin, Java, Rust, Python, Go, C, C++, C#, Ruby, PHP, Bash, CSS. Large classes and impl blocks
are split into their members. Other languages fall back to regex heuristics that know the common declaration keywords.

jev answers two questions over the task, the assistant's text before the call (not hidden thinking), and a preview of
each view: *which view is the smallest that still suffices* (Choice) and *will the next step need the exact full text*
(Noul). Thresholds decide when to send full text. For code, when a reduced view is chosen (or with the `outline`
policy, always), a second step asks jev which block bodies to expand. If the expanded view reaches 90 % of the
original character count, full text is sent instead.

When a result is compressed, its full output is kept in `details` (persisted in the session, not included in the model
prompt) and served by a `recall` tool using an id, a line range or a pattern. This storage covers pre-send compression,
not results that were only pruned post-send; those must be obtained by re-running the original tool. Every recall is
logged as feedback on the reduced view. Set `JEV_CONTEXT_PRESEND=0` to turn pre-send compression off.

## Post-send pruning (the context-budget layer)

This is a secondary pass, not the source of the initial pre-send savings. It classifies the result the agent saw
(which may already be compressed) after the agent has reacted to it:

| decision | what happens in later prompts |
|---|---|
| **keep** | leave the result unchanged, including any pre-send compression |
| **trim** | keep the head and tail; drop the middle |
| **forget** | replace the result with a one-line stub; re-run the tool if needed |

Prompt caches match on an exact prefix. Any edit to an already-sent message invalidates the cache from that point on.
The extension limits repeated rewrites using persisted decisions:

1. **Classify after reaction.** Text-only tool results of at least `JEV_CONTEXT_MIN_TOKENS` are queued for classification after
   the next assistant message supplies evidence of what happened next. Results still buffered at agent end are
   classified without that reaction. Results with an existing decision or an in-flight classification are skipped.
2. **Apply, then freeze the decision.** The `context` hook waits briefly for in-flight classifications and applies
   pending decisions when the selected mode permits. Decisions are persisted and restored at session start; applied
   decisions are re-applied on later calls. Transforms remain identical for unchanged input and configuration
   (changing trim settings can change the rendered text).
3. **Choose when to rewrite.** `budget` (default) applies pending prunes when their savings meet both the configured
   minimum and a fraction of the tail they would rewrite. `rolling` applies them at the next context hook; `batch`
   waits for a cold cache. All modes allow application after the configured idle TTL, and compaction marks pending
   decisions as applied.

There is no monotonic cut boundary: a late classification can still rewrite an older result after a newer decision
has been applied. Persisted decisions prevent repeated reclassification, but do not guarantee an unchanged cache prefix.

Tool results are never removed, only rewritten, because every `function_call` must keep a matching output.

## Durable notes (cross-session memory)

Separately from compression and pruning, jev assesses whether content is worth remembering across sessions.
Selected notes are written to `<project>/.pi/jev-context.md` as classifications complete and injected into the system
prompt from a snapshot taken at the next session start. Agent end and session shutdown wait up to
`JEV_CONTEXT_CLASSIFY_WAIT_MS` for outstanding classifications. Requests still unfinished at shutdown are aborted and
late responses discarded, so a slow request may not produce a note. This is not a fourth pruning bucket: saving a
note does not remove its source from the prompt.

## Install

```sh
git clone https://github.com/dizk/pi-jev-context.git ~/repos/pi-jev-context
cd ~/repos/pi-jev-context && npm install
echo 'TYPESAFE_API_KEY=...' > .env
pi -e ~/repos/pi-jev-context/index.ts
```

Without a key the extension runs with a mock classifier and warns at startup.

Inside pi: `/jev-context` shows stats, `/jev-context list` lists the latest 200 pre-send-compressed tool results with tokens
before and after, `/jev-context diff [n]` opens an overlay for the n-th latest one showing the original output with the
lines the model did not get marked `−` (press `t` to switch to exactly what was sent, `Esc` to close),
`/jev-context decisions` lists post-send decisions with probabilities, `/jev-context file` prints the memory file.
In the transcript, a compressed `read`/`bash`/`grep`/`find`/`ls` result shows a header line
`⌁ jev-context outline · 179 of 1524 tokens (−88 %)` and, expanded (ctrl+e), the text the model saw. The footer shows
session totals, leading with the share of the session's input tokens jev kept out of the prompt:
`jev-context −38% of input (presend −12.3k · 5/8 · 1 recalls, pruned −4.0k · 3, 2 notes)`. The share is
cut / (sent + cut), where sent is the provider's own input plus cache-read counts over all calls and cut is what every
compressed or pruned result saved on every call it was part of, so a result compressed early counts on each later call. Set `JEV_CONTEXT_UI=0` to keep pi's own tool rendering. Every call is logged to
`<project>/.pi/jev-context.log` (JSON lines).

### Configuration (environment)

| variable | default | meaning |
|---|---|---|
| `JEV_CONTEXT_MODE` | `budget` | `rolling`, `batch` or `budget` (see above) |
| `JEV_CONTEXT_BUDGET_FRACTION` / `_BUDGET_MIN_TOKENS` | `0.5` / `1000` | budget mode: apply when pending prunes remove at least this share of the tail they rewrite, and at least this many tokens |
| `JEV_CONTEXT_FORGET_BELOW` | `0.25` | P(needed) below this → forget |
| `JEV_CONTEXT_TRIM_BELOW` / `_TRIM_ABOVE` | `0.5` / `0.6` | P(needed) below the first and P(outcome only) above the second → trim |
| `JEV_CONTEXT_DURABLE_ABOVE` | `0.7` | text notes require P(durable) above this; tool pointers require P(durable) above `max(this, 0.85)` |
| `JEV_CONTEXT_MIN_TOKENS` | `150` | smaller tool results are never touched |
| `JEV_CONTEXT_CLASSIFY_WAIT_MS` | `2500` | maximum wait for in-flight classification at context, agent end and shutdown |
| `JEV_CONTEXT_CACHE_TTL_MS` | `300000` | idle longer than this counts as a cold cache |
| `JEV_CONTEXT_DISABLED` | unset | `1` skips pre-send compression and makes new post-send decisions `keep`; classification, logging and memory notes remain active. Previously applied decisions are still replayed. |
| `JEV_CONTEXT_PRESEND` | `1` | `0` turns pre-send compression off |
| `JEV_CONTEXT_PRESEND_MIN_TOKENS` | `1200` | smaller results are always sent in full |
| `JEV_CONTEXT_PRESEND_NEEDS_FULL_ABOVE` / `_FULL_MASS_ABOVE` | `0.5` / `0.5` | send full when P(needs full) or P(full view) exceeds these |
| `JEV_CONTEXT_PRESEND_EXPAND_ABOVE` | `0.5` | expand a code block's body when P(needed) exceeds this |
| `JEV_CONTEXT_PRESEND_COMMAND_NEEDS_FULL_ABOVE` | `0.65` | needs-full threshold for command output; the question is phrased for edits, and test runs rarely need exact full text (+3.3 points on the benchmark, no extra misses) |
| `JEV_CONTEXT_PRESEND_COMMAND_POLICY` | `sections` | when jev picks full for command output but needs-full is under the command threshold, send the section headers and let the second step expand the needed sections (full again if that reaches 90 %). `gate`: jev's view choice stands. |
| `JEV_CONTEXT_PRESEND_SECTION_EXPAND_ABOVE` | `0.5` | expand a section of command output when P(needed) exceeds this |
| `JEV_CONTEXT_PRESEND_SECTION_FLOOR` | `0.3` | send full when no section of command output reaches this probability (the expansion step could not tell, typical for docs read for orientation); `0` allows headers alone |
| `JEV_CONTEXT_PRESEND_CODE_POLICY` | `gate` | jev's needs-full and full-mass gates decide between full and a view; when a view is chosen, selected block bodies are expanded. `outline`: always send an outline plus expanded bodies (saves more, but 17 % of later edits missed their block on 500 real trajectories). |
| `JEV_CONTEXT_PRESEND_CODE_NEEDS_FULL_ABOVE` | `0.5` | code gate uses the minimum of this and the general needs-full threshold |
| `JEV_CONTEXT_PRESEND_MIN_CONFIDENCE` | `0` | send full below this choice confidence (0 disables the check); bypassed by outline-first code selection |
| `JEV_CONTEXT_TRIM_HEAD` / `_TRIM_TAIL` | `15` / `15` | lines retained at each end for post-send trimming |
| `JEV_CONTEXT_STATE_HEAD` / `_STATE_TAIL` | `2500` / `800` | maximum output characters in post-send classifier excerpts |
| `JEV_CONTEXT_MODEL` | `jev-latest` | classifier model |
| `JEV_CONTEXT_CLASSIFIER` | unset | `mock` forces deterministic classifiers without API calls |
| `JEV_CONTEXT_LOG` | `1` | `0` disables JSON-lines logging |
| `JEV_CONTEXT_UI` | `1` | `0` disables custom built-in tool rendering |
| `JEV_CONTEXT_VARIANT` | unset | JSON file with `config`, `prompts` and `views` overrides (also accepts autoresearch's `{ variant }` wrapper); config overrides take precedence over environment settings |

`TYPESAFE_API_KEY` enables the real classifier. The extension loads `.env` from its own directory (and `src/`), not
from the target project; existing nonempty environment values take precedence.

## How jev is used

Post-send classification uses one request per eligible tool result, with three yes/no questions over the same state
(`src/classifier.ts`): *needed*, *outcome only*, *durable*. The state holds the task (first and latest user message),
the tool call and a head/tail excerpt of its output, and what the agent said and called next. User messages and assistant
text between 40 and 6000 characters get a single *durable* question (disabled with the mock classifier). jev returns
probabilities, not generated prose: stubs, trims and memory notes are assembled by code. Tool memory notes store only
a call summary and success/failure marker; user and assistant notes are truncated excerpts. Notes are deduplicated,
capped at 150 bullets / 8000 characters of bullet text, and loaded as a stable snapshot at session start.

Pre-send selection and optional block expansion use separate requests, in addition to post-send classification.

## Evaluation

```sh
npm test                                      # unit tests for the policy, ledger and memory file
node --import tsx eval/replay.ts <session.jsonl|dir>   # offline: classify a recorded session, simulate post-send pruning
node --import tsx eval/presend-replay.ts <dir>          # offline: pre-send views vs what the agent did next (edit/quote misses)
node --import tsx eval/action-graph.ts                  # procedural graph mined from runs, jev as guidance model
node --import tsx eval/bench/run.ts --from 200 --to 300 # pre-send benchmark on 100 real OpenHands trajectories (holdout)
node --import tsx eval/bench/run.ts --from 300 --to 800 # the 500-trajectory slice (46 editable code results; use it for anything that touches code views)
node --import tsx eval/bench/autoresearch.ts --iterations 8   # let a researcher model tune prompts/thresholds on the train slice
node --import tsx eval/generate.ts --cond baseline     # run the fixture tasks with pi headless
node --import tsx eval/generate.ts --cond jev
node --import tsx eval/report.ts                       # compare conditions
```

`eval/fixture` is a small dependency-free JavaScript project with planted bugs; `eval/tasks/tasks.json` holds ten
tasks (eight short, a five-part compound and an eight-part marathon), each scored by a hidden test.

Benchmark on 100 real OpenHands trajectories (685 large tool results, 2.26M tokens, `eval/bench/`): the default
pre-send configuration sends 78.6 % fewer tokens for large results with 0 of 15 later edits missing their old text,
0.6 % quote-misses and 2.3 % ref-misses (an identifier the agent then used that only existed in the dropped part).
Details, the metric definitions and the autoresearch loop are in `STATUS.md`.

Headline from the first night of runs (details and caveats in `STATUS.md`): decisions are sensible and the mechanism
holds (frozen decisions, stable prefix), but under a 10× prompt-cache discount pruning after first send is a
**context-budget** tool, not a cost tool. Rolling mode cut input tokens 19 % on long sessions and still cost 17 % more
because each prune rewrites the cached prefix; budget mode keeps the cache (65 % hit vs 70 % baseline) and passed
12/13 tasks (baseline 13/13). The pre-send compression implemented here targets those costs by avoiding the initial
send of unnecessary output.

## Using this as a reference

The pieces are independent of pi and can be lifted into another agent:

| piece | file | depends on |
|---|---|---|
| candidate views (outline, focus, signals, testlog, tree, matches, log, sample, head/tail) | `src/views.ts` | regex views need no external packages; async code views optionally load `src/treesitter.ts` |
| tree-sitter blocks and signatures | `src/treesitter.ts` | `web-tree-sitter`, `@vscode/tree-sitter-wasm`, `@binclusive/tree-sitter-kotlin-wasm` |
| the jev questions, state shape, decision rule, block expansion | `src/presend.ts` | `@typesafe-ai/sdk` |
| post-send decisions and the frozen, cache-aware ledger | `src/classifier.ts`, `src/policy.ts`, `src/ledger.ts` | `@typesafe-ai/sdk` |
| the hook wiring for pi (tool_result, context, recall tool, UI) | `index.ts`, `src/ui.ts` | pi |
| benchmark and metrics on real trajectories | `eval/presend-score.ts`, `eval/bench/` | run `eval/bench/fetch.sh` first |

The order of operations that matters, in one paragraph: when a tool result arrives and is large, build views from the
text (code, no model), ask jev which view suffices and whether exact text is needed, apply the configured selection
policy, and optionally expand code blocks in a second request. If a reduced view wins, replace the content with that
view plus a footer naming `recall`, and keep the full text in result details. Post-send classification then decides
whether to keep, trim or stub eligible results. Persist and re-apply those decisions to avoid repeated changes to
already-transformed messages. Never remove a tool result, only rewrite it.
