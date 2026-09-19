# jev-lens (core)

The host-independent part of [jev-lens](https://github.com/dizk/jev-lens): given one large tool result and what the
agent is doing, build candidate views from the output's own lines, let [jev](https://docs.typesafe.ai) pick one,
expand the blocks or sections the agent will need, and return the view to send. Used by the pi extension
`pi-jev-lens` and by the Claude Code plugin. Nothing here depends on either host.

```sh
npm install jev-lens
```

```ts
import { createPresend, Lens, loadConfig, sliceRecall } from "jev-lens";

const cfg = loadConfig();                       // JEV_LENS_* environment, TYPESAFE_API_KEY or a key file
const { presend, mock } = createPresend(cfg);   // jev, or a deterministic mock when there is no key
const lens = new Lens({ cfg, presend, footer: { recall: (id) => `Call recall with id "${id}".` } });

const out = await lens.compress({
	toolCallId: "call_1",
	toolName: "read",                             // canonical names: read, bash, grep, find, ls, edit, write
	args: { path: "src/auth.ts" },                // canonical args: { path }, { command }, { pattern, path }
	text: fullOutput,
	context: { firstUser: task, latestUser: lastPrompt, agentText: textBeforeTheCall },
});
if (out.compressed) send(out.text); else send(fullOutput);   // out.text = view + footer

// later, when the agent calls recall:
sliceRecall({ text: fullOutput, toolName: "read", args }, { lines: "120-180" }).text;
```

`Lens.compress` returns what was decided and why (`kind`, `view`, `answer`, `expanded`, `candidates`, `reason`,
`ms`) so a host can log it. It throws when jev fails; the host then sends the full output.

What else is exported:

| export | purpose |
|---|---|
| `buildCandidates`, `buildCandidatesAsync`, `detectKind`, the `*View` functions | the views, synchronously or with tree-sitter outlines and blocks for code |
| `languageForPath`, `treeSitterBlocks`, `treeSitterOutline` | tree-sitter over the grammars in `@vscode/tree-sitter-wasm` (plus Kotlin) |
| `displayedFiles` | which files a shell command like `cat a.py; sed -n 1,40p b.py` displays, so the output gets code views |
| `buildPresendState`, `presendQuestions`, `expandQuestions`, `decideView`, `expandRelevantBlocks`, `DEFAULT_PROMPTS` | the jev questions, the state they see, and the thresholds |
| `JevPresend`, `MockPresend`, `createPresend`, `promptsWithVariant` | the classifiers |
| `loadConfig`, `loadConfigWithVariant`, `keyFilePath`, `storeKey`, `resolveApiKey` | configuration from `JEV_LENS_*` variables and a host-chosen key file |
| `sliceRecall`, `recallMissText`, `RECALL_DESCRIPTION`, `RECALL_PARAM_DESCRIPTIONS` | the recall tool, identical in every host |
| `JevClassifier`, `MockClassifier`, `buildItemState` | the post-send "is this still needed" questions the pi extension uses for optional pruning |
| `Health`, `estimateTokensOfText`, `contentText`, `truncate`, `describeToolCall` | helpers |

The environment variables are documented in the [pi extension's README](https://github.com/dizk/jev-lens/tree/main/packages/pi-jev-lens#configuration-environment);
the core reads the same ones. Research log and benchmark numbers: [STATUS.md](https://github.com/dizk/jev-lens/blob/main/STATUS.md).

MIT.
