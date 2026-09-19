# jev-lens for Claude Code

A plugin that compresses large `Read`, `Bash` and `Grep` results before Claude sees them. A PostToolUse hook builds
candidate views from the output's own lines, [jev](https://docs.typesafe.ai) picks the smallest one that still serves
Claude's next step, and the hook replaces the tool result with that view plus a footer. The full output is stored,
and the bundled MCP server's `recall` tool serves it back, whole or as a slice, when Claude asks. Nothing is
generated or summarized: every line Claude sees is a line of the original output.

The core, the views and the thresholds are the same as in the pi extension, which was measured on 500 real agent
trajectories (79 % fewer tokens for large tool results, 2 of 26 later edits missed their block). See the
[repository README](https://github.com/dizk/jev-lens#what-the-numbers-say). The plugin itself has not been measured on
Claude Code sessions yet; the `stats` tool shows what it does in yours.

## Install

Needs Node.js 22.18 or newer on your PATH (the hook and the MCP server are TypeScript files that node runs directly)
and a TypeSafe API key from [console.typesafe.ai](https://console.typesafe.ai).

```
/plugin marketplace add dizk/jev-lens
/plugin install jev-lens@jev-lens
```

Then give the plugin the key, either as `TYPESAFE_API_KEY` in the environment Claude Code runs in, or in a key file:

```sh
mkdir -p ~/.claude/jev-lens && echo '{"apiKey":"ts_..."}' > ~/.claude/jev-lens/key.json && chmod 600 ~/.claude/jev-lens/key.json
```

Without a key the plugin uses a deterministic mock classifier, which follows fixed rules instead of judging each
result. Restart Claude Code or run `/reload-plugins` after installing. `/jev-lens:stats` (or the `stats` MCP tool)
shows what has been compressed.

For development, clone the repository and load the plugin in place:

```sh
git clone https://github.com/dizk/jev-lens.git && cd jev-lens && npm install
claude --plugin-dir ./packages/claude-code
```

## What Claude sees

A 600-line file read with `Read` becomes, when jev decides the task does not need all of it:

```
  1│ import { parse } from "./parse.js";
     ⋯ 14 lines omitted
 16│ export function normalizeCategory(raw) {
 17│   const key = raw.trim().toLowerCase();
 18│   return ALIASES[key] ?? key;
 19│ }
     ⋯ 61 lines omitted

[jev-lens: showing the "relevant" view, 9 of 102 lines. Omitted lines are marked ⋯. Call the jev-lens recall tool
with id "toolu_01..." for the full output, or add lines: "a-b" or pattern: "..." for a slice. The numbers before │
are the file's own line numbers; any other numbers in front of them count lines of this view only.]
```

The last sentence is there because Claude Code prefixes every line of a `Read` result with its own sequential line
number, so a view with gaps carries the file's real numbers inside the line. Edits in Claude Code match on text, not
line numbers, so this does not affect them. `Bash` and `Grep` output is passed through as the hook returns it.

## What it does and does not do

- Compresses `Read` results of text files, `Bash` stdout, and `Grep` results in content mode, when the output is about
  1200 tokens or more. Images, `Edit` and `Write` results, other tools and MCP tools are untouched.
- Decides once, before the first send, so the prompt cache is not disturbed. It never rewrites earlier messages;
  Claude Code has no hook for that, and the pi extension's optional post-send pruning does not exist here.
- Reads the task, the latest user message and what Claude wrote before the call from the session transcript, the
  way the pi extension reads them from the session. The text before the call is the text of the message that holds
  the call; when Claude called the tool without saying anything (common, and its thinking is stored empty), the
  latest text of the same turn is used, then the latest text of an earlier turn. The log records which
  (`agentTextSource`). Sub-agents have their own transcript files next to the session's, and the hook finds a
  sub-agent's call there. The transcript is written asynchronously and can lag the current turn
  (`transcriptHasCall: false` in the log); the hook uses whatever is there.
- Runs as one node process per large tool result: about 0.1 s of startup plus one or two jev requests of 0.4 to
  0.8 s. Small results exit before the core is loaded. Anything unexpected ends with the original output.
- Stores full outputs and the log in `$CLAUDE_PLUGIN_DATA` (Claude Code's persistent plugin directory), or
  `~/.claude/jev-lens` when that is not set. The key file is always `~/.claude/jev-lens/key.json`. Stored outputs older than `JEV_LENS_KEEP_DAYS` (90) days are removed. `JEV_LENS_DATA_DIR`
  overrides the location.

## Status line

Claude Code has no plugin-provided status line, but the plugin ships a segment you can add to your own
`statusLine` command. It reads the session id from the JSON Claude Code passes on stdin and prints this
session's totals in the same shape as the pi extension's status line:

```
jev-lens −12.3k · 5/8 · 1 recall
```

Tokens kept out of the prompt, results compressed of results considered, and recalls. `(mock)` means the mock
classifier decided, `(degraded)` that a compression failed this session. Append it to the script behind
`statusLine.command` in `~/.claude/settings.json` (create one with `/statusline` if you have none):

```sh
input=$(cat)
# ... your own segments ...
jev=$(ls -t "$HOME"/.claude/plugins/cache/jev-lens/jev-lens/*/src/statusline.ts 2>/dev/null | head -1)
[ -n "$jev" ] && printf ' %s' "$(printf '%s' "$input" | node "$jev")"
```

The `ls` finds the installed plugin version; with `claude --plugin-dir` point at `packages/claude-code/src/statusline.ts`
in your checkout instead. Claude Code refreshes the status line when an assistant message arrives (and on a
`refreshInterval`, if you set one), so the numbers move once per turn, not per tool call. The segment costs one
node start (about 0.05 s) per refresh. It looks for the log in `JEV_LENS_DATA_DIR`, every `~/.claude/plugins/data/jev-lens-*` directory
and `~/.claude/jev-lens`, because the status line command runs without `CLAUDE_PLUGIN_DATA`.

## Collecting data for the benchmark

The stored outputs and the log are the raw material for scoring changes offline, the way the pi extension's
defaults were tuned (see [Evaluation](https://github.com/dizk/jev-lens/tree/main/packages/pi-jev-lens#evaluation)).
`src/trajectory.ts` turns Claude Code transcripts into trajectories the benchmark replays, putting every compressed
result back to its full text from the store and keeping the view Claude saw in `details.view`:

```sh
node packages/claude-code/src/trajectory.ts ~/.claude/projects/-Users-me-repos-app > sessions.jsonl
node --import tsx eval/bench/run.ts --file sessions.jsonl --from 0 --to 50
```

A directory is searched recursively and sub-agent transcripts become trajectories of their own. Run the export
before the retention expires: stored outputs are kept for `JEV_LENS_KEEP_DAYS` (90) days, and Claude Code removes
transcripts after its own `cleanupPeriodDays` (30). The benchmark scores a recall the same way as an edit of a
dropped line: `recall-miss` is a recorded recall that the replayed view would still not have answered.

## Configuration

The same `JEV_LENS_*` environment variables as the pi extension, read from the environment Claude Code runs in.
The ones that matter most:

| variable | default | effect |
|---|---|---|
| `JEV_LENS_DISABLED=1` | | the hook does nothing |
| `JEV_LENS_PRESEND_MIN_TOKENS` | `1200` | smaller results are never touched |
| `JEV_LENS_PRESEND_CODE_NEEDS_FULL_ABOVE` | `0.5` | code is sent in full when jev's "needs the exact text" is above this |
| `JEV_LENS_PRESEND_COMMAND_NEEDS_FULL_ABOVE` | `0.65` | the same for command output |
| `JEV_LENS_CLASSIFIER=mock` | | force the mock classifier |
| `JEV_LENS_MODEL` | `jev-latest` | the jev model |
| `JEV_LENS_KEY_FILE` | `~/.claude/jev-lens/key.json` | where the key file lives |
| `JEV_LENS_HOOK_TIMEOUT_MS` | `30000` | the hook gives up and returns the original after this |
| `JEV_LENS_KEEP_DAYS` | `90` | how long stored outputs are kept for the recall tool and the benchmark export |

The full list is in the [pi extension's README](https://github.com/dizk/jev-lens/tree/main/packages/pi-jev-lens#configuration-environment).

## Files

```
.claude-plugin/plugin.json   manifest
hooks/hooks.json             PostToolUse on ^(Read|Bash|Grep)$ → node src/hook.ts
.mcp.json                    the recall/stats MCP server → node src/mcp.ts
commands/stats.md            /jev-lens:stats
src/hook.ts                  the hook: normalize the result, ask the core, print updatedToolOutput
src/claude.ts                Claude Code's tool output shapes ↔ the core's canonical tools
src/transcript.ts            task and agent text from the session transcript, main or sub-agent
src/trajectory.ts            export transcripts as benchmark trajectories, full outputs restored
src/store.ts                 outputs, log, key file, pruning
src/mcp.ts                   a dependency-free MCP server over stdio
src/statusline.ts            the status line segment: this session's totals from the log
```

MIT.
