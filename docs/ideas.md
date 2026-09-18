# Ideas: where jev-lens can go

Written on 2026-09-18 after the first round of evaluations, and updated for 0.2.0. Each idea says what jev decides,
what code does, and how we would measure it. The order is our recommendation.

## 1. Compression before the first send is the cost lever (built, see STATUS.md)

Everything that is sent in full is cached at 10 % of the price for the rest of the session. Everything that is not
sent is free forever. So the decision that matters is made once, before the first send: which view of this output
does the agent need right now? Code builds candidate views that are subsets of the original (outline, focus, signals,
sample, head and tail, sections). jev picks one. A second jev step puts back the code blocks or sections that the
agent will need. The `recall` tool is the safety net, and every recall is a logged signal that the choice was too
aggressive.

Next steps: views for diffs (hunk headers only) and for build logs (the last failing target), and thresholds per tool
that are learned from recall rates.

## 2. Procedural graphs with jev as the guidance model (prototype in `eval/action-graph.ts`)

The paper by Lu et al., *Procedural Graphs: Self-Evolving Execution Structures for LLM Agents*, keeps procedural
knowledge as a graph of (procedure, relation, procedure) triples. At each step, it finds where the agent is in the
graph, and a guidance model turns the nearby part of the graph into advice. The advice biases the next action but
does not dictate it. The graph grows from successful and failed trajectories.

jev fits the role of the guidance model, because every step of that loop is a typed judgment over state that code
can assemble:

| step | what code provides | what jev answers |
|---|---|---|
| localize | the recent actions and the candidate nodes | a choice: which node is the agent at? |
| guide | the outgoing edges with counts and success rates, the task, the agent's last message | a choice over the next procedures, plus yes or no questions: is the agent looping? did it skip verification? |
| gate | the proposed next action against the graph | yes or no: does this action leave the known good path? Only then inject guidance |
| refine | a failed trajectory against the nearest successful one | yes or no per edge: was this transition where it went wrong? |

Mining is code. Sessions are JSONL files, tool calls are the actions, and hidden tests give the outcome. The prototype
mines (tool, target class) nodes from 34 runs. At 158 decision points of 6 held-out marathon runs, it asks jev what
must come next. The numbers are in `eval/runs/action-graph.md`. The useful application is not prediction accuracy but
deviation detection. The graph knows that after `edit:src` comes `bash:test` in 96 % of the passing runs. An agent
that goes from `edit:src` to `final_answer` is off the path. A nudge of one line ("run the tests before finishing"),
injected as a custom message, costs nothing when the agent is on the path.

Where it plugs in: the `before_agent_start` and `turn_end` hooks of this extension. The graph lives in
`.pi/jev-lens-graph.json` and is refined from outcomes in the style of `results.jsonl`, or from the user's own thumbs
up and down.

## 3. An episodic memory index

Version 0.1.0 had a memory file: a list of durable sentences that jev selected from each session. We removed it in
0.2.0 because we never measured its value. A better long-term store is an index of episodes. For each past session
it holds a pointer (the session file, one line that summarizes the task, the files that were touched, the outcome)
plus the durable notes. At session start, jev answers for each episode: is this episode relevant to the new task? One
request covers the last N episodes. Only the relevant episodes go into the prompt. Code keeps the index, and jev
ranks. This is the "find and judge evidence" pattern, and it needs no embeddings.

## 4. Context repair instead of compaction

pi's compaction summarizes the conversation with the main model when the context window fills. With decisions per
message already in the ledger, compaction can become a selection: keep the messages that jev marked as needed, stub
the rest, and only summarize the one-line stubs. This is cheaper, and it never loses exact text that the agent will
edit.

## 5. Working set tracking

Keep a small typed state: the files that were opened, the files that were edited, the tests that ran and their last
result, the open errors. Code maintains it from the tool calls. When the ledger considers forgetting a read of a file,
jev answers: is this file still in the working set? This closes the biggest gap that the evaluation found: a file was
forgotten two turns before the agent needed it again.

## 6. Learn thresholds from recalls and re-reads

Every recall, and every re-read after a forget, is a labeled example of a bad decision, with jev's probabilities
attached. Fit thresholds per tool and per content kind from a few hundred of them. The replay harness already
produces the rows.

## 7. Compression of user input

Long pastes from the user, such as stack traces and logs, have the shape of a tool result. The same view machinery
applies in the `input` hook, with the original kept for recall.
