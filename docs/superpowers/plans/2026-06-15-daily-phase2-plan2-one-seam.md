# Daily Phase 2 — Plan 2: One Task-Creation Seam (brief joins ingest) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use `- [ ]` checkboxes.

**Goal:** Let `dome.agent.brief` create source-linked, short `#task` lines from actionable Slack/meeting findings — through the SAME captured-task seam ingest uses, with deterministic per-task origin stamping (decision B) — without breaking the brief's safety-critical "only brief-marker content lands" splice.

**Architecture:** A dedicated deterministic `addTask({ task, sourceUrl? })` tool stamps the Plan 1 `([↗](sourceUrl))` origin marker and appends the line into the captured block of the brief's working daily overlay (via the shared `appendCapturedTaskLines`/`appendOriginMarker`). The brief processor's splice — which today rebuilds `composed` from the deterministic `prepared` and adopts only brief-marker blocks — gains ONE more adopted region: the **validated captured-block task-line delta** (lines present in the model's captured block but not in `prepared`'s, each passing `isCapturedTaskLine`). Everything else the model wrote is still discarded. Brevity + the already-duplicated charter fragments move into one shared `charter-fragments.ts`. The daily-surface block-ownership + section-contract tables gain the brief as a captured-block co-writer (the spec's own governance rule).

**Tech Stack:** TypeScript on Bun; `bun test`; `dome.agent` + `dome.daily` bundles.

**Design:** `docs/cohesive/brainstorms/2026-06-15-daily-phase2.md` §"P2"; decision B (deterministic per-task origin) confirmed by the owner 2026-06-15.

**Key facts (verified):**
- The captured seam lives in `dome.daily/processors/captured-block.ts`: `appendCapturedTaskLines({content, lines})`, `isCapturedTaskLine(line)`, `appendOriginMarker(line, target)` (re-exported; canonical in action-extraction), `CAPTURED_LINE_MAX_CHARS=500`, `CAPTURED_APPEND_MAX_LINES=10`.
- The brief's tools (`makeBriefTools`, `brief-tools.ts`) = readPage/listPages/searchVault/writePage/appendToPage/askOwner over `BRIEF_WRITABLE_PATHS`, guarded by `signalsAppendOnlyGuard`.
- The brief processor (`brief.ts`) rebuilds `composed` from `prepared` and adopts ONLY brief-marker blocks (TODAY/YESTERDAY/MEETINGS via `extractBriefBlockBody`/`replaceBriefBlock`) + deterministic SOURCES/questions/integrated blocks (brief.ts:374-415). `modelContent = state.edits.get(todayPath)`.
- The brief charter (`brief-charter.ts`) is a static string array; it FORBIDS `- [ ]` checkboxes in brief blocks. `ingest-charter.ts` and `consolidate-charter.ts` duplicate the preference-signals / superseded / untrusted-input fragments.
- Captured block markers: `CAPTURED_START`/`CAPTURED_END`/`CAPTURED_BLOCK`/`DAILY_OWNER` in `dome.daily/processors/daily-types.ts`; `findGeneratedBlock` locates the block; the open-loops block excludes from extraction but the captured block is included (origins).
- Plan 1: origin is the `([↗](target))` marker → parsed to a `dome.daily.task_origin` fact → `TodayTaskRow.origin` → one `↗` render. Brief-created tasks must use this same grammar.

---

### Task 1: Shared captured-task helpers + a deterministic per-task `addTask` builder

Extract the splice-side helpers the brief needs into one shared module so brief and ingest share the grammar. (Ingest's existing per-source `capturedAwareAppendTool` stays; this adds a per-TASK builder the brief uses, since each brief finding has its own permalink.)

**Files:**
- Create: `assets/extensions/dome.agent/lib/captured-task-seam.ts`
- Test: `tests/extensions/dome.agent/captured-task-seam.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { spliceCapturedTask } from "../../../assets/extensions/dome.agent/lib/captured-task-seam";

const SKELETON = "# 2026-06-15\n\n## Captured today\n\n<!-- dome.daily:captured:start -->\n<!-- dome.daily:captured:end -->\n";

describe("spliceCapturedTask", () => {
  test("stamps the origin marker and splices a valid task into the captured block", () => {
    const r = spliceCapturedTask({ content: SKELETON, task: "- [ ] #task reply to Jane", sourceUrl: "https://slk/p1" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.content).toContain("- [ ] #task reply to Jane ([↗](https://slk/p1))");
  });
  test("a non-task line is rejected (ok:false, error)", () => {
    const r = spliceCapturedTask({ content: SKELETON, task: "not a task" });
    expect(r.ok).toBe(false);
  });
  test("an over-long line is rejected", () => {
    const r = spliceCapturedTask({ content: SKELETON, task: `- [ ] #task ${"x".repeat(600)}` });
    expect(r.ok).toBe(false);
  });
  test("no sourceUrl → task lands with no marker", () => {
    const r = spliceCapturedTask({ content: SKELETON, task: "- [ ] #task plain" });
    expect(r.ok && r.content).toContain("- [ ] #task plain");
    expect(r.ok && r.content).not.toContain("↗");
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module missing): `bun test tests/extensions/dome.agent/captured-task-seam.test.ts`.

- [ ] **Step 3: Implement** `assets/extensions/dome.agent/lib/captured-task-seam.ts`:

```ts
// Shared captured-task splice — the single task-creation grammar for agents.
// ingest uses its per-source capturedAwareAppendTool; the brief uses
// spliceCapturedTask per finding (each finding carries its own source URL).
import {
  appendCapturedTaskLines,
  appendOriginMarker,
  isCapturedTaskLine,
  CAPTURED_LINE_MAX_CHARS,
} from "../../dome.daily/processors/captured-block";

export type SpliceCapturedTaskResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly error: string };

/** Validate one model-authored task line, stamp the ([↗](sourceUrl)) origin
 *  marker (Plan 1 grammar) when sourceUrl is given, and splice it into the
 *  captured block of `content`. The CAPTURED_LINE_MAX_CHARS cap measures the
 *  model-authored text; the marker is seam overhead (added after validation). */
export function spliceCapturedTask(input: {
  readonly content: string;
  readonly task: string;
  readonly sourceUrl?: string;
}): SpliceCapturedTaskResult {
  const line = input.task.trimEnd();
  if (line.length > CAPTURED_LINE_MAX_CHARS) {
    return { ok: false, error: `task line exceeds ${CAPTURED_LINE_MAX_CHARS} chars` };
  }
  if (!isCapturedTaskLine(line)) {
    return { ok: false, error: "not an open `- [ ] #task …` (or `#followup`) line" };
  }
  const stamped = input.sourceUrl !== undefined && input.sourceUrl !== ""
    ? appendOriginMarker(line, input.sourceUrl)
    : line;
  return { ok: true, content: appendCapturedTaskLines({ content: input.content, lines: [stamped] }) };
}
```

- [ ] **Step 4: Run, expect PASS:** `bun test tests/extensions/dome.agent/captured-task-seam.test.ts`.

- [ ] **Step 5: Commit**
```bash
git add assets/extensions/dome.agent/lib/captured-task-seam.ts tests/extensions/dome.agent/captured-task-seam.test.ts
git commit -m "feat(dome.agent): shared spliceCapturedTask — deterministic per-task origin stamping"
```

---

### Task 2: The brief's `addTask` tool

**Files:**
- Modify: `assets/extensions/dome.agent/lib/brief-tools.ts`
- Test: `tests/extensions/dome.agent/brief.test.ts` (or a brief-tools test file — read which exists)

- [ ] **Step 1: Write the failing test**

In the brief tools test, assert the tool set includes `addTask`, and that calling it on a state whose `todayPath` holds the skeleton appends a stamped task into the captured block of `state.edits[todayPath]`:

```ts
test("addTask stamps origin and writes the captured task into the daily overlay", async () => {
  const today = "wiki/dailies/2026-06-15.md";
  const skeleton = "# 2026-06-15\n\n## Captured today\n\n<!-- dome.daily:captured:start -->\n<!-- dome.daily:captured:end -->\n";
  const tools = makeBriefTools({ reader: reader({ [today]: skeleton }), capturedTasks: { path: today } });
  const addTask = tools.find((t) => t.schema.name === "addTask")!;
  const state = { edits: new Map(), questions: [] };
  const out = await addTask.execute({ task: "- [ ] #task reply to Jane", sourceUrl: "https://slk/p1" }, state);
  const edit = state.edits.get(today);
  expect(edit?.kind === "write" && edit.content).toContain("- [ ] #task reply to Jane ([↗](https://slk/p1))");
});
```
(Match the test file's existing `reader`/`makeBriefTools` helpers — read it; `makeBriefTools` currently takes only `{ reader }`, so this adds an optional `capturedTasks: { path }`.)

- [ ] **Step 2: Run, expect FAIL** (`addTask` not in tool set / option absent).

- [ ] **Step 3: Implement.** In `brief-tools.ts`, extend `makeBriefTools` to accept `capturedTasks?: { readonly path: string }`. When present, add an `addTask` tool:

```ts
import { spliceCapturedTask } from "./captured-task-seam";
import { currentContent } from "./vault-tools"; // overlay-aware read (confirm export)
// …in makeBriefTools, when capturedTasks !== undefined, push:
{
  schema: {
    name: "addTask",
    description: "Surface ONE actionable finding as an open `- [ ] #task <short label>` line in today's daily, with its source URL (e.g. a Slack permalink). Use only for genuinely actionable items; everything else is a summary bullet.",
    inputSchema: objectSchema({ task: STRING, sourceUrl: STRING_OPTIONAL }, ["task"]),
  },
  execute: async (input, state) => {
    const { task, sourceUrl } = input as { task: string; sourceUrl?: string };
    const content = (await currentContent(capturedTasks.path, state, reader)) ?? "";
    const r = spliceCapturedTask({ content, task, ...(sourceUrl ? { sourceUrl } : {}) });
    if (!r.ok) return `error: ${r.error}`;
    state.edits.set(capturedTasks.path, { kind: "write", path: capturedTasks.path, content: r.content });
    return `added captured task to ${capturedTasks.path}`;
  },
}
```
(Use the file's actual schema-builder helpers — `objectSchema`, `STRING`, and an optional-string form; read the imports. If the daily is absent the brief processor seeds the skeleton — but the brief always runs against a prepared daily, so `content` will hold the captured block.)

- [ ] **Step 4: Run, expect PASS.** Existing brief-tools tests unchanged (addTask only present when `capturedTasks` is passed).

- [ ] **Step 5: Commit**
```bash
git add assets/extensions/dome.agent/lib/brief-tools.ts tests/extensions/dome.agent/brief.test.ts
git commit -m "feat(dome.agent): brief addTask tool — create a source-linked captured task"
```

---

### Task 3: Brief processor adopts the validated captured-block delta

The safety-critical splice change: after adopting brief-marker blocks, the brief processor ALSO adopts the captured-block task-line delta the model added — and nothing else.

**Files:**
- Modify: `assets/extensions/dome.agent/processors/brief.ts` (the splice section ~374-415; pass `capturedTasks` to `makeBriefTools`)
- Test: `tests/extensions/dome.agent/brief.test.ts`

- [ ] **Step 1: Write the failing test**

In `brief.test.ts` (uses a `makeCtx`-style harness with scripted model steps), script the model to call `addTask`, and assert the brief's PatchEffect on the daily contains the captured task with its marker AND that the summary blocks remain checkbox-free:

```ts
test("brief surfaces an actionable finding as a captured task via addTask", async () => {
  // arrange a brief run (slack source present) whose model step calls:
  //   addTask({ task: "- [ ] #task reply to alice re: outbox PR", sourceUrl: "https://slk/p9" })
  // and writes its normal brief blocks.
  const patch = /* run brief, find the daily PatchEffect */;
  expect(patch.content).toContain("- [ ] #task reply to alice re: outbox PR ([↗](https://slk/p9))");
  // summary blocks stay checkbox-free:
  const yesterday = /* extract dome.agent.brief:yesterday block body */;
  expect(yesterday).not.toContain("- [ ]");
});
test("the brief never adopts captured edits that aren't valid task lines", async () => {
  // model writePage smuggles prose / a heading into the captured block (not via addTask)
  // assert composed's captured block does NOT contain the smuggled content
});
```
(Match the brief test harness; read it for how to script steps and extract the patch + block bodies.)

- [ ] **Step 2: Run, expect FAIL** (captured task not adopted).

- [ ] **Step 3: Implement.**
(a) Pass `capturedTasks` to the brief's tools: `makeBriefTools({ reader, capturedTasks: { path: todayPath } })`.
(b) In the splice section, AFTER the brief-marker block loop and BEFORE the SOURCES block splice, adopt the captured-block delta:

```ts
import { appendCapturedTaskLines, isCapturedTaskLine } from "../../dome.daily/processors/captured-block";
import { capturedBlockBodyLines } from "../../dome.daily/processors/captured-block"; // add a tiny exported helper if absent (returns the task lines inside the captured block)
// …after the spliceBlocks loop:
// Adopt ONLY captured-block task-line APPENDS the model made (deterministic,
// validated). Everything else the model wrote is still discarded.
const preparedTasks = capturedBlockBodyLines(prepared);
const modelTasks = capturedBlockBodyLines(modelContent);
const appended = modelTasks.slice(preparedTasks.length)
  .filter((l) => l.trim() !== "" && isCapturedTaskLine(l));
if (appended.length > 0 && modelTasks.slice(0, preparedTasks.length).join("\n") === preparedTasks.join("\n")) {
  composed = appendCapturedTaskLines({ content: composed, lines: appended });
}
```
The guard `modelTasks.slice(0, preparedTasks.length) === preparedTasks` ensures the model only APPENDED (didn't rewrite existing captured lines). `isCapturedTaskLine` filters anything non-task (prose/headings/smuggled markers — the injection fence). Markers are already stamped by `addTask`, so `appended` lines carry `([↗](url))`; `isCapturedTaskLine` accepts marker-bearing lines (Plan 1).

If `capturedBlockBodyLines` doesn't exist in captured-block.ts, add it (a small pure helper: locate the `dome.daily:captured` block via `findGeneratedBlock`, return its non-blank body lines) with its own unit test.

- [ ] **Step 4: Run, expect PASS:** `bun test tests/extensions/dome.agent/brief.test.ts`. Both new tests pass; existing brief tests unchanged (no captured delta → no change).

- [ ] **Step 5: Commit**
```bash
git add assets/extensions/dome.agent/processors/brief.ts assets/extensions/dome.daily/processors/captured-block.ts tests/extensions/dome.agent/brief.test.ts
git commit -m "feat(dome.agent): brief adopts validated captured-block task appends (safety splice preserved)"
```

---

### Task 4: Charter — findings-as-tasks + shared brevity fragment

**Files:**
- Create: `assets/extensions/dome.agent/lib/charter-fragments.ts`
- Modify: `assets/extensions/dome.agent/lib/brief-charter.ts`, `ingest-charter.ts`
- Test: `tests/integration/agent-prompt-regression.test.ts` (snapshots) + the no-accreting-registries invariant must still pass

- [ ] **Step 1: Write/extend the failing test**

Add to the agent-prompt-regression test a check (or rely on its snapshot) that the brief charter contains the brevity instruction and an `addTask` instruction, and the ingest charter contains the SAME brevity fragment string (proving it's shared). E.g.:

```ts
test("brief and ingest share one brevity fragment", () => {
  expect(BRIEF_CHARTER.join("\n")).toContain(BREVITY_FRAGMENT);
  expect(INGEST_CHARTER.join("\n")).toContain(BREVITY_FRAGMENT);
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** Create `charter-fragments.ts` exporting `BREVITY_FRAGMENT` and the already-duplicated `PREFERENCE_SIGNALS_FRAGMENT`, `SUPERSEDED_PAGES_FRAGMENT`, `UNTRUSTED_INPUT_FRAGMENT` (copy the current exact wording from the existing charters so snapshots change minimally). `BREVITY_FRAGMENT`:

> "Write task labels SHORT and scannable: the imperative + who/what, ideally ≤ 80 characters. The long context belongs in the linked note or source, never the task line — an over-long line is rejected by the captured seam."

Add to `brief-charter.ts`: the `BREVITY_FRAGMENT` and an `addTask` instruction:
> "When the Slack digest or a meeting lists a genuinely ACTIONABLE item (a message that asks you to do something, a meeting prep action), surface it as ONE captured task via `addTask({ task: '- [ ] #task <short label>', sourceUrl: <the entry's permalink> })`. Everything else stays a plain `-` summary bullet — never put `- [ ]` checkboxes in your brief blocks."

Replace the inline duplicated fragments in `brief-charter.ts` and `ingest-charter.ts` with the shared imports.

- [ ] **Step 4: Update snapshots + run.** Regenerate the agent-prompt-regression snapshots (only the affected charters). Run `bun test tests/integration/agent-prompt-regression.test.ts tests/invariants/no-accreting-registries.test.ts` → PASS. Verify the snapshot diff is only the intended charter wording.

- [ ] **Step 5: Commit**
```bash
git add assets/extensions/dome.agent/lib tests/integration/__snapshots__ tests/integration/agent-prompt-regression.test.ts
git commit -m "feat(dome.agent): brief findings-as-tasks instruction + shared charter fragments (brevity deduped)"
```

---

### Task 5: Governance — claim the brief as a captured-block co-writer

**Files:**
- Modify: `docs/wiki/specs/daily-surface.md` (block-ownership + section-contract tables)

- [ ] **Step 1: Locate the tables**

Run: `grep -n "Block ownership\|section contract\|Captured today\|dome.daily:captured\|writer" docs/wiki/specs/daily-surface.md`.

- [ ] **Step 2: Update the rows**

In the `dome.daily:captured` block-ownership row, add the brief as a writer: "…Skeleton + `dome.agent.ingest` seam + `dome.agent.brief` (`addTask` — actionable findings, same validated splice) + human task lines." In the `## Captured today` section-contract row, mirror it. Add a sentence to the section's prose: "The brief may surface actionable Slack/meeting findings as captured `#task` lines via `addTask`; it writes them through the same validated captured splice (origins, not copies), and its summary blocks stay checkbox-free."

- [ ] **Step 3: Run** `bun test tests/integration 2>&1 | tail -5` (wikilink/spec lockstep; no-retired-symbol checks) → PASS.

- [ ] **Step 4: Commit**
```bash
git add docs/wiki/specs/daily-surface.md
git commit -m "docs(daily-surface): claim the brief as a captured-block co-writer (Phase 2 P2 governance)"
```

---

### Task 6: Full suite gate

- [ ] **Step 1: Run** `bun test 2>&1 | tail -6` → PASS, 0 fail. Watch `tests/extensions/dome.agent/*`, `tests/extensions/daily-*`, `tests/integration` (charter snapshots + invariants).
- [ ] **Step 2:** Do NOT merge yet — Plan 3 follows on this branch (or merge per the controller's plan).

## Self-review notes
- **Safety preserved:** the brief still rebuilds `composed` from `prepared`; the ONLY new adopted region is the validated captured-block task-line append (guarded by append-only check + `isCapturedTaskLine` per line). Smuggled prose/headings are filtered (injection fence).
- **One grammar:** brief tasks use the Plan 1 `([↗])` marker via `spliceCapturedTask` → the `task_origin` fact → one `↗` render. No new inline-link form.
- **No accreting registry:** cross-night dedup rides the existing `^id` anchoring + reconcile (a re-seen finding matches an anchored task); no new ledger.
- **Brevity once:** one shared `BREVITY_FRAGMENT` used by brief + ingest.
- **Governance:** the block-ownership + section-contract tables are updated (the spec's own anti-accretion rule).
