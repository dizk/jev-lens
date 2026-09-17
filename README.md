# pi-jev-memory

A [pi](https://github.com/earendil-works/pi-mono) extension that routes conversation content into three buckets using
[jev](https://docs.typesafe.ai) (TypeSafe's System One model) as a fast, calibrated classifier:

| bucket | what happens | where |
|---|---|---|
| **context** (keep) | sent to the model verbatim | the prompt |
| **trim** | head + tail only; the middle is dropped | the prompt |
| **forget** | replaced by a one-line stub; re-run the tool to get it back | the prompt |
| **file** (durable) | appended to `<project>/.pi/jev-memory.md`, injected into the system prompt at the next session start | long-term memory |

The point is not just to shrink the prompt. It is to shrink it **without breaking the provider's prompt cache**.

## The cache-aware cut

Prompt caches match on an exact prefix. Any edit to an already-sent message invalidates the cache from that point on.
So the extension follows three rules:

1. **Decide once.** Every tool result is classified exactly once, after the agent has *reacted* to it (the next assistant
   message is part of the evidence: "given what the agent did next, is this output still needed?").
2. **Apply at the next call, then freeze.** A decision is applied in pi's `context` hook right before the next LLM call and
   is persisted to the session. From then on the same transform is re-applied identically on every call, so the prefix
   never drifts. Decisions survive `/resume`, `/fork` and reload.
3. **Never move backwards.** Nothing older than the last applied decision is ever touched again. In `rolling` mode
   (default) the cut lands two turns behind the head, so each call rewrites roughly one extra turn of cache. In `batch`
   mode decisions are held and applied only when the cache is cold anyway (idle longer than the provider TTL, or at
   compaction).

Tool results are never removed, only rewritten, because every `function_call` must keep a matching output.

## Install

```sh
git clone <this repo> ~/repos/pi-jev-memory
cd ~/repos/pi-jev-memory && npm install
echo 'TYPESAFE_API_KEY=...' > .env
pi -e ~/repos/pi-jev-memory/index.ts
```

Without a key the extension runs with a mock classifier and warns at startup.

Inside pi: `/jev-memory` shows stats, `/jev-memory decisions` lists every decision with its probabilities,
`/jev-memory file` prints the memory file. Every call is logged to `<project>/.pi/jev-memory.log` (JSON lines).

### Configuration (environment)

| variable | default | meaning |
|---|---|---|
| `JEV_MEMORY_MODE` | `budget` | `rolling`, `batch` or `budget` (see above) |
| `JEV_MEMORY_BUDGET_FRACTION` / `_BUDGET_MIN_TOKENS` | `0.5` / `1000` | budget mode: apply when pending prunes remove at least this share of the tail they rewrite, and at least this many tokens |
| `JEV_MEMORY_FORGET_BELOW` | `0.25` | P(needed) below this → forget |
| `JEV_MEMORY_TRIM_BELOW` / `_TRIM_ABOVE` | `0.5` / `0.6` | P(needed) below the first and P(outcome only) above the second → trim |
| `JEV_MEMORY_DURABLE_ABOVE` | `0.7` | P(durable) above this → memory file |
| `JEV_MEMORY_MIN_TOKENS` | `150` | smaller tool results are never touched |
| `JEV_MEMORY_CLASSIFY_WAIT_MS` | `2500` | how long the context hook waits for in-flight jev calls |
| `JEV_MEMORY_CACHE_TTL_MS` | `300000` | idle longer than this counts as a cold cache |
| `JEV_MEMORY_DISABLED` | unset | `1` = classify and log, but never prune (shadow mode) |

## How jev is used

One request per tool result, three independent yes/no questions over the same state
(`src/classifier.ts`): *needed*, *outcome only*, *durable*. The state holds the task (first and latest user message),
the tool call and a head/tail excerpt of its output, and what the agent said and called next. User messages and assistant
text get a single *durable* question. jev returns probabilities, not text; everything that becomes text (stubs, trims,
memory lines) is assembled by code from the original content, so nothing is hallucinated into the prompt.

## Evaluation

```sh
npm test                                      # unit tests for the policy, ledger and memory file
node --import tsx eval/replay.ts <session.jsonl|dir>   # offline: classify a recorded session, simulate the policy
node --import tsx eval/generate.ts --cond baseline     # run the fixture tasks with pi headless
node --import tsx eval/generate.ts --cond jev
node --import tsx eval/report.ts                       # compare conditions
```

`eval/fixture` is a small dependency-free JavaScript project with planted bugs; `eval/tasks/tasks.json` holds ten
tasks (eight short, a five-part compound and an eight-part marathon), each scored by a hidden test.

Headline from the first night of runs (details and caveats in `STATUS.md`): decisions are sensible and the mechanism
holds (frozen decisions, stable prefix), but under a 10× prompt-cache discount pruning after first send is a
**context-budget** tool, not a cost tool. Rolling mode cut input tokens 19 % on long sessions and still cost 17 % more
because each prune rewrites the cached prefix; budget mode keeps the cache (65 % hit vs 70 % baseline) and passed
12/13 tasks (baseline 13/13). The savings have to come from not sending large outputs in the first place, which is the
next step.
