# Autoresearch: pre-send compression

You are improving how a coding agent's large tool outputs are compressed before they are sent to the model.
Code builds candidate *views* (strict subsets of the output); a fast classifier (jev) chooses which view to send and,
for code, which block bodies to expand. Full text stays recallable. You may change only the **variant**: prompt texts,
view descriptions, thresholds and view parameters. The code that builds views is fixed for this run.

## Objective (higher is better)

`objective = saved% − 5 × edit-miss% − 2 × quote-miss% − 1 × ref-miss%`, measured on real OpenHands trajectories:

- **saved%**: tokens not sent across all large tool results (≥ presendMinTokens).
- **edit-miss%**: among large `read` results that the agent later edited (before re-reading the file), the share where the
  edit's first old-text line was not in the view. This is the harm metric; keep it near 0.
- **quote-miss%**: share of results where the agent's next message quotes a 40+ char line that only exists in the omitted part.
- **ref-miss%**: share of results where the agent's next two steps use an identifier that only existed in the omitted part
  (not in the view, the task, its own reasoning or the tool call): it learned something from what we dropped.

Kinds of results: `command` (bash output, the majority), `code`, `prose`, `data`, `listing`.
Views: `full`, `outline`, `relevant` (outline + expanded blocks), `focus`, `signals`, `sample`, `head_tail`.

## Variant format (JSON)

```json
{
  "name": "short-name",
  "hypothesis": "one sentence on why this should help",
  "config": { "presendNeedsFullAbove": 0.5, "presendFullMassAbove": 0.5, "presendMinConfidence": 0, "presendExpandAbove": 0.5, "presendMinTokens": 1200 },
  "prompts": {
    "viewInstructions": "...", "viewDescriptions": { "signals": "...", "outline": "..." },
    "needsFullInstructions": "...", "needsFullTrue": "...", "needsFullFalse": "...",
    "expandInstructions": "... block `blocks[{i}]` ...", "expandTrue": "...", "expandFalse": "..."
  },
  "views": { "headLines": 40, "tailLines": 20, "focusCtx": 3, "sampleRows": 12, "signalsCtx": 2, "signalsTail": 8, "testIds": 25, "minShrink": 0.6 }
}
```

Omitted fields keep the current best values. Instructions reach jev as text; backticked paths like `agent.args` or
`views.signals.preview` refer to fields of the state object. Keep each instruction a single clear judgment.

## Rules

- Propose ONE variant per iteration, changing one or two things, with a hypothesis grounded in the last results.
- Prefer changes that raise saved% on `command` and `code` without raising edit-miss.
- Never propose a variant identical to one already tried.
- Output only the JSON object, nothing else.
