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
Views: `full`, `outline`, `relevant` (outline + expanded blocks), `focus`, `signals`, `testlog`, `tree`, `matches`, `log`,
`sample`, `head_tail`, and `sections` (command output: the first line of every section, i.e. grep match groups, JSON
keys, headings, marker lines, paragraphs; when chosen, a second jev step asks per section whether the agent needs its
contents and puts those back, giving `relevant`).

The `sections` route has its own knobs: `config.presendCommandPolicy` (`sections`, the default, =
when jev picks full for command output with needs-full under `presendCommandNeedsFullAbove`, send sections and expand; `gate` = jev's choice stands),
`config.presendSectionExpandAbove` (P threshold per section), `config.presendSectionFloor` (send full when no section reaches this probability; 0 = headers alone are allowed), `views.sectionMinLines`, `views.sectionMaxBlocks`,
`views.sectionChunkLines` (chunk size for unstructured output, 0 = none), `views.sectionsView` (offer it at all), and the
prompt texts `sectionInstructions` / `sectionTrue` / `sectionFalse` (the per-section question; `{i}` is the section index).
Most command results that are still sent full are `grep -A/-B` context output and debug-script output; that is where
`sections` should win, and `testlog`/`signals` should keep test runs.

## Variant format (JSON)

```json
{
  "name": "short-name",
  "hypothesis": "one sentence on why this should help",
  "config": { "presendNeedsFullAbove": 0.5, "presendFullMassAbove": 0.5, "presendMinConfidence": 0, "presendExpandAbove": 0.5, "presendMinTokens": 1200, "presendCommandNeedsFullAbove": 0.65, "presendCommandPolicy": "sections", "presendSectionExpandAbove": 0.5, "presendSectionFloor": 0.3 },
  "prompts": {
    "viewInstructions": "...", "viewDescriptions": { "signals": "...", "outline": "..." },
    "needsFullInstructions": "...", "needsFullTrue": "...", "needsFullFalse": "...",
    "expandInstructions": "... block `blocks[{i}]` ...", "expandTrue": "...", "expandFalse": "...",
    "sectionInstructions": "... section `blocks[{i}]` ...", "sectionTrue": "...", "sectionFalse": "..."
  },
  "views": { "headLines": 40, "tailLines": 20, "focusCtx": 3, "sampleRows": 12, "signalsCtx": 1, "signalsTail": 8, "testIds": 25, "minShrink": 0.6, "sectionsView": true, "sectionMinLines": 3, "sectionMaxBlocks": 24, "sectionChunkLines": 50 }
}
```

Omitted fields keep the current best values. Instructions reach jev as text; backticked paths like `agent.args` or
`views.signals.preview` refer to fields of the state object. Keep each instruction a single clear judgment.

## Rules

- Propose ONE variant per iteration, changing one or two things, with a hypothesis grounded in the last results.
- Prefer changes that raise saved% on `command` and `code` without raising edit-miss.
- Never propose a variant identical to one already tried.
- Output only the JSON object, nothing else.
