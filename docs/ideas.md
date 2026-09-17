# Ideas: where this memory system can go

Written 2026-09-18 after the first round of evals. Each idea says what jev decides, what code does, and how it would be measured. Order is my recommendation.

## 1. Pre-send compression is the cost lever (built, see STATUS.md)

Everything sent verbatim is cached at 10 % for the rest of the session; everything not sent is free forever. So the decision that matters is made once, before first send: *which view of this output does the agent need right now?* Code builds candidate views that are strict subsets of the original (outline, focus, signals, sample, head/tail); jev picks; a second jev step expands the code blocks the agent will need; a `recall` tool is the safety net, and every recall is a logged signal that the choice was too aggressive.

Next steps here: views for `grep`/`find` output (group by file, collapse repeated matches), for diffs (hunk headers only), and for `bash` build logs (last failing target). Learn per-tool thresholds from recall rates.

## 2. Procedural graphs with jev as the guidance model (prototype in `eval/action-graph.ts`)

The paper (Lu et al., *Procedural Graphs: Self-Evolving Execution Structures for LLM Agents*) keeps procedural knowledge as a graph of (procedure, relation, procedure) triples, localizes the agent in it at each step, and has a guidance model translate the surrounding subgraph into advice that biases, but does not dictate, the solver's next action. The graph evolves from successful and failed trajectories.

jev is a natural guidance model because every step of that loop is a typed judgment over state the code can assemble:

| step | what code provides | what jev answers |
|---|---|---|
| localize | recent actions, current node candidates | Choice: which node is the agent at? |
| guide | outgoing edges with counts and success rates, the task, the agent's last message | Choice over next procedures, plus Nouls: "is the agent looping?", "has it skipped verification?" |
| gate | the proposed next action vs the graph | Noul: does this action leave the known-good path? (only then inject guidance) |
| refine | a failed trajectory vs the nearest successful one | Noul per edge: was this transition where it went wrong? |

Mining is code: sessions are JSONL, tool calls are the actions, hidden tests give the outcome. The prototype mines (tool, target class) nodes from 34 runs and asks jev, at 158 decision points of the 6 held-out marathon runs, what should come next. See the numbers in `eval/runs/action-graph.md`. The interesting use is not prediction accuracy but *deviation detection*: the graph knows that after `edit:src` comes `bash:test` in 96 % of passing runs; an agent that goes `edit:src → final_answer` is off the path, and a one-line nudge ("run the tests before finishing") injected as a custom message costs nothing when the agent is on the path.

Where it plugs in: `before_agent_start` / `turn_end` in this extension; the graph lives in `.pi/jev-memory-graph.json` and is refined from `results.jsonl`-style outcomes or from the user's own thumbs-up/down.

## 3. Episodic memory index instead of a flat memory file

The current memory file is a list of durable sentences. A better long-term store is an index of *episodes*: for each past session, a pointer (session file, task summary line, files touched, outcome) plus the durable notes. At session start jev answers, per episode, "is this episode relevant to the new task?" (Noul, batched over the last N episodes in one request) and only the relevant ones are injected. Code keeps the index; jev ranks. This is the "find and judge evidence" pattern and needs no embeddings.

## 4. Context repair instead of compaction

pi's compaction summarizes with the main model when the window fills. With per-message decisions already in the ledger, compaction can become a *selection*: keep the messages jev marked needed, stub the rest, and only summarize the stubs' one-liners. Cheaper, and it never loses exact text the agent will edit.

## 5. Working set tracking

Keep a small typed state: files opened, files edited, tests run and their last result, open errors. Code maintains it from tool calls; jev answers "is `file` still in the working set?" when the ledger considers forgetting a read of it. This closes the biggest gap found in the eval: forgetting a file two turns before the agent needs it again.

## 6. Learn thresholds from recalls and re-reads

Every recall and every re-read after a forget is a labelled example of a bad decision, with jev's probabilities attached. Fit thresholds per tool and content kind from a few hundred of them. The replay harness already produces the rows.

## 7. Pre-send on user input

Long pastes (stack traces, logs) from the user are tool-result-shaped. The same view machinery applies in the `input` hook, with the original kept for recall.
