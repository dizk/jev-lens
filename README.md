# jev-lens

Your coding agent reads a 600-line file to change one function. jev-lens sends the model the outline of the file and
that one function. The agent can ask for the rest with a `recall` tool, and the footer of the result tells it so.

Tool output is most of what a coding agent pays for. Every `cat`, every test run and every `grep` goes into the
prompt in full and stays there for the rest of the session. jev-lens acts before that first send. Code builds a
small set of candidate views of the output. A view is a subset of the lines of the output, with line numbers. Then
[jev](https://docs.typesafe.ai), the judgment model from TypeSafe, picks the smallest view that still lets the agent
do its next step. Nothing is generated or summarized. Every view is made of lines from the original, so the agent
can ask for exactly the part that it does not have.

This repository holds three packages that share one core:

| package | what it is | install |
|---|---|---|
| [`jev-lens`](packages/core) | the host-independent core: candidate views, tree-sitter outlines, the jev questions and decision rule, the recall slicing | `npm install jev-lens` |
| [`pi-jev-lens`](packages/pi) | the extension for [pi](https://github.com/earendil-works/pi-mono): pre-send compression, the `recall` tool, a comparison view in the TUI, optional post-send pruning | `pi install npm:pi-jev-lens` |
| [`jev-lens` plugin for Claude Code](packages/claude-code) | a PostToolUse hook that replaces large Read, Bash and Grep results before Claude sees them, plus an MCP server with `recall` and `stats` | `/plugin marketplace add dizk/jev-lens` then `/plugin install jev-lens@jev-lens` |

## What the numbers say

We measured the defaults on 500 real agent trajectories (OpenHands on SWE-rebench: 3300 large tool results, 11.6
million tokens) and on our own daily pi sessions. The research log is [STATUS.md](STATUS.md). The main results:

| result | source |
|---|---|
| 79 % fewer tokens sent for large tool results (11.6M became 2.4M) | the 500 benchmark trajectories |
| 88 % fewer on command output (test runs, grep, build logs), 58 % on docs, 47 % on listings, 31 % on code | the same, per kind of output |
| 31 % fewer tokens for large tool results | our own pi sessions with gpt-6-astra, which reads code with `cat` and runs few tests |
| 2 of 26 later edits missed their block, 0.3 % of results had a dropped line quoted, 2.2 % had a dropped identifier used | the harm side, same 500 trajectories |

These numbers were measured through pi and the benchmark harness. The Claude Code plugin runs the same core with
the same defaults, but it has not been measured on Claude Code sessions yet. See the plugin's README for what is
different there.

Three results shaped the design:

1. Compress before the first send, not after. Pruning old results later breaks the prompt cache on every rewrite
   and cost 17 % more money in our runs. Post-send pruning exists in the pi extension but is off by default.
2. Code is different. Test logs and grep output can lose 90 % of their lines and the agent does not miss them. The
   agent edits from code, and an edit fails when its old text is a line the model never saw. So views of code keep
   every retained line byte for byte, and code is sent in full unless jev is confident.
3. New code-built views moved the numbers. Prompt wording did not.

## How it works

1. A large tool result arrives (about 1200 tokens or more).
2. Code detects the kind of content (code, prose, data, command output, listing) and builds candidate views from the
   output's own lines: outline, focus, signals, testlog, matches, tree, log, sample, sections, head and tail.
3. jev gets the task, what the agent wrote before the call, the tool call and a preview of every candidate. It
   answers two questions: which view is the smallest that still serves the agent's next step, and does the next step
   need the exact full text. Code applies the thresholds.
4. For code and for sectioned command output, a second jev step decides which blocks or sections to put back.
5. The result becomes the view plus a footer that names the recall tool. The full text is stored for recall.

## Repository layout

```
packages/core         jev-lens on npm: src/views.ts, presend.ts, lens.ts, recall.ts, treesitter.ts, config.ts
packages/pi           pi-jev-lens on npm: index.ts (pi wiring), src/ui.ts, src/policy.ts (post-send pruning)
packages/claude-code  the Claude Code plugin: hooks/hooks.json, .mcp.json, src/hook.ts, src/mcp.ts
eval/                 the benchmark harness, replay scripts and fixtures (see packages/pi/README.md, Evaluation)
STATUS.md             the research log: every variant tried, its numbers, and why the defaults are what they are
```

## Development

```sh
git clone https://github.com/dizk/jev-lens.git && cd jev-lens
npm install                      # links the workspaces and builds packages/core/dist
echo 'TYPESAFE_API_KEY=...' > .env
npm test                         # all packages, mock classifier where no key is needed
npm run typecheck
pi -e ./packages/pi/index.ts                    # try the pi extension
claude --plugin-dir ./packages/claude-code      # try the Claude Code plugin
```

The core is consumed as built JavaScript (`packages/core/dist`) by both hosts; `npm install` and `npm test` build it.
Tests import the core sources directly. A change to how views are built or chosen must come with benchmark numbers;
if it touches code views, use the 500-trajectory slice (`eval/bench/run.ts --from 300 --to 800`).

Releases go to npm through GitHub Releases, see [docs/releasing.md](docs/releasing.md). MIT, see LICENSE.
