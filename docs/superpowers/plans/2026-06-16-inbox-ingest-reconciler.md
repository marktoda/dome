# Inbox Ingest Reconciler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use `- [ ]` checkboxes.

**Goal:** Make `dome.agent.ingest` a level-triggered reconciler over the standing contents of `inbox/raw/`, so a capture is *eventually* ingested even if its `file.created` signal firing is missed — without waiting on the happy-path signal that keeps normal ingestion prompt.

**Architecture:** Add an hourly `schedule` (cron) trigger to ingest alongside its existing signals (the prompt happy path). Change ingest's worklist from the commit-delta (`ctx.changedPaths`) to the *standing set* of `inbox/raw/*.md` files (enumerated via `ctx.snapshot.listMarkdownFiles()`), sorted oldest-first (FIFO) and bounded to `MAX_CAPTURES_PER_RUN` per run. Everything downstream — the per-source loop, `sourceRefs`, and the single-`PatchEffect` `finishAgentRun` batch — is unchanged.

**Tech Stack:** TypeScript on Bun; `bun test`. Files under `assets/extensions/dome.agent/`.

**Design:** `docs/cohesive/brainstorms/2026-06-16-inbox-ingest-reconciler.md`.

**Key facts (verified):**
- Fix site: `assets/extensions/dome.agent/processors/ingest.ts`. Line 33 is `const rawPaths = ctx.changedPaths.filter(isRawCapturePath);` (early-returns `[]` if empty). `isRawCapturePath` is a local fn near the bottom: `/^inbox\/raw\/[^/]+\.md$/`.
- `ctx.snapshot.listMarkdownFiles(): Promise<ReadonlyArray<string>>` (`src/core/processor.ts:90`). Returns grant-scoped markdown paths. ingest already imports/uses it (passed into `makeIngestTools`).
- The run's edits land as ONE `PatchEffect` via `finishAgentRun({ state, ... })` at the tail (~line 168). Unchanged.
- Manifest: `assets/extensions/dome.agent/manifest.yaml`, `dome.agent.ingest` block (~lines 4-13) has two `signal` triggers. `consolidate`/`brief` show the `kind: schedule, cron: "..."` format.
- `inbox-stale-check` threshold is already 168h → NO change (design item 5).
- Tests: `tests/extensions/dome.agent/ingest.test.ts` has `makeCtx({ files, changedPaths, steps|stepFn, ... })` building a full `ProcessorContext` with a stubbed `modelInvoke.step` and `listMarkdownFiles: async () => Object.keys(files)`. `tests/extensions/dome.agent/manifest.test.ts` asserts manifest shape. `tests/harness/scenarios/capabilities/model-invoke-scheduled.scenario.test.ts` is the scheduled-tick harness template.
- The vault read grant for `dome.agent` must cover `inbox/raw/**` so `listMarkdownFiles()` surfaces captures — ingest already reads them via the same snapshot, so this is a verification, not a change.

---

### Task 1: Worklist selector (pure) + unit test

**Files:** Modify `assets/extensions/dome.agent/processors/ingest.ts`; Test: create `tests/extensions/dome.agent/ingest-worklist.test.ts`.

- [ ] **Step 1: Failing test** — `tests/extensions/dome.agent/ingest-worklist.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { selectIngestWorklist, MAX_CAPTURES_PER_RUN } from "../../../assets/extensions/dome.agent/processors/ingest";

describe("selectIngestWorklist", () => {
  test("keeps only inbox/raw/*.md, drops everything else", () => {
    const got = selectIngestWorklist([
      "inbox/raw/a.md",
      "wiki/entities/x.md",
      "inbox/processed/old.md",
      "inbox/raw/sub/nested.md", // nested under raw/ — NOT a capture
      "inbox/raw/b.md",
    ]);
    expect(got).toEqual(["inbox/raw/a.md", "inbox/raw/b.md"]);
  });
  test("sorts oldest-first by filename (timestamp-prefixed = chronological)", () => {
    const got = selectIngestWorklist([
      "inbox/raw/2026-06-16-1500-c.md",
      "inbox/raw/2026-06-16-0900-a.md",
      "inbox/raw/2026-06-16-1200-b.md",
    ]);
    expect(got).toEqual([
      "inbox/raw/2026-06-16-0900-a.md",
      "inbox/raw/2026-06-16-1200-b.md",
      "inbox/raw/2026-06-16-1500-c.md",
    ]);
  });
  test("bounds to the cap, oldest-first", () => {
    const many = Array.from({ length: MAX_CAPTURES_PER_RUN + 5 }, (_, i) =>
      `inbox/raw/2026-06-16-${String(i).padStart(4, "0")}-x.md`,
    );
    const got = selectIngestWorklist(many);
    expect(got).toHaveLength(MAX_CAPTURES_PER_RUN);
    expect(got[0]).toBe("inbox/raw/2026-06-16-0000-x.md");
  });
  test("empty when no captures", () => {
    expect(selectIngestWorklist(["wiki/a.md", "inbox/processed/x.md"])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (export missing): `bun test tests/extensions/dome.agent/ingest-worklist.test.ts`.

- [ ] **Step 3: Implement** in `ingest.ts`. Add near the top (after imports, with the other consts like `MAX_STEPS`):
```ts
/**
 * Max captures lifted per ingest run. A backlog drains over successive passes
 * (oldest-first) rather than risking the agent execution timeout in one run.
 * Ingest's analog of consolidate's MAX_CHANGED_FILES blast-radius cap.
 */
export const MAX_CAPTURES_PER_RUN = 10;

/**
 * The ingest worklist = the standing contents of inbox/raw/, oldest-first,
 * bounded. Pure: a function of the snapshot's markdown listing, not of the
 * commit delta — so a scheduled (cron) run reconciles lingering captures a
 * missed signal left behind. Captures are timestamp-prefixed, so a lexical
 * sort is chronological (FIFO) and deterministic (no mtime).
 */
export function selectIngestWorklist(
  markdownPaths: ReadonlyArray<string>,
  max: number = MAX_CAPTURES_PER_RUN,
): string[] {
  return markdownPaths.filter(isRawCapturePath).sort().slice(0, max);
}
```
(`isRawCapturePath` already exists in the file. If it's declared *below* this point with `function` hoisting it's fine; if the linter complains about use-before-declaration ordering, move `isRawCapturePath` up next to these — keep its body identical.)

- [ ] **Step 4: Run, expect PASS.** `bun test tests/extensions/dome.agent/ingest-worklist.test.ts` → green.
- [ ] **Step 5: Commit**
```bash
git add assets/extensions/dome.agent/processors/ingest.ts tests/extensions/dome.agent/ingest-worklist.test.ts
git commit -m "feat(agent): pure ingest worklist selector (standing inbox/raw, FIFO, bounded)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Drive ingest from the standing worklist (the reconciler behavior)

**Files:** Modify `assets/extensions/dome.agent/processors/ingest.ts`; Test: extend `tests/extensions/dome.agent/ingest.test.ts`.

- [ ] **Step 1: Failing recovery test.** Read `tests/extensions/dome.agent/ingest.test.ts` first to reuse `makeCtx` and copy the step-stub pattern from an existing *successful-ingest* test (one whose stubbed `steps`/`stepFn` drive the agent to create a task and archive the source — i.e. produce a `PatchEffect` that deletes/moves the `inbox/raw/...` file). Add a test that proves reconciliation on a cron-like trigger (empty `changedPaths`):
```ts
test("reconciles a standing inbox/raw capture even with no changedPaths (cron trigger)", async () => {
  const ctx = makeCtx({
    files: { "inbox/raw/2026-06-08-0900-note.md": "<capture body that the stubbed steps lift+archive>" },
    changedPaths: [], // a scheduled tick carries no delta
    // steps/stepFn: copy from the existing successful-ingest test so the agent
    // creates the task and archives the source.
    steps: [ /* ...same canned steps an existing passing ingest test uses... */ ],
  });
  const effects = await ingest.run(ctx);
  const patch = effects.find((e): e is PatchEffect => e.kind === "patch");
  expect(patch).toBeDefined();
  // the capture was archived out of inbox/raw (the change set no longer writes it there)
  const stillRaw = patch!.changes.some((c) => c.path === "inbox/raw/2026-06-08-0900-note.md" && c.kind === "write");
  expect(stillRaw).toBe(false);
});
```

- [ ] **Step 2: Run, expect FAIL.** Pre-change, ingest reads `ctx.changedPaths` (empty) → returns `[]` → no patch. `bun test tests/extensions/dome.agent/ingest.test.ts -t "reconciles a standing"`.

- [ ] **Step 3: Implement.** In `ingest.run` replace lines 33-35:
```ts
    // BEFORE:
    // const rawPaths = ctx.changedPaths.filter(isRawCapturePath);
    // if (rawPaths.length === 0) return Object.freeze([]);
    // const sourceRefs = rawPaths.map((p) => ctx.sourceRef(p));

    // AFTER: reconcile the STANDING inbox/raw set (works for both signal and
    // scheduled triggers; a missed signal is recovered on the next pass).
    const rawPaths = selectIngestWorklist(await ctx.snapshot.listMarkdownFiles());
    if (rawPaths.length === 0) return Object.freeze([]);
    const sourceRefs = rawPaths.map((p) => ctx.sourceRef(p));
```
Nothing else in `run` changes — the per-source loop, `finishAgentRun`, diagnostics all consume `rawPaths`/`sourceRefs` as before.

- [ ] **Step 4: Run, expect PASS.** The recovery test passes. Also run the FULL ingest test file — `bun test tests/extensions/dome.agent/ingest.test.ts` — and fix any fallout. NOTE: the existing `makeCtx` sets `listMarkdownFiles: async () => Object.keys(files)`, so tests that put the capture in BOTH `files` and `changedPaths` still work (the file is in the listing). The "no-op when no model step is wired" test has `files: {"inbox/raw/x.md": "body"}` → worklist now non-empty → it will reach the preamble and (no model) return `[]` via the `pre.kind === "no-model"` path, so it should still yield `[]` — confirm; if its assertion depended on the *early* changedPaths return, verify the no-model path still gives `[]` (it should). Adjust only if an assertion encoded the old early-return mechanism rather than the `[]` outcome.

- [ ] **Step 5: Add idle + bound + idempotent tests** in the same file:
  - **idle:** `files: {}` (or only non-raw), `changedPaths: []`, a `stepFn` that throws if ever called → `expect(await ingest.run(ctx)).toEqual([])` and the step was never invoked (proves no model call when inbox empty).
  - **bound:** `files` with `MAX_CAPTURES_PER_RUN + 2` raw captures → assert the run touches only the oldest `MAX_CAPTURES_PER_RUN` (e.g. count distinct source paths referenced in the patch / sourceRefs, or assert the 2 newest are untouched). Keep it light if full step-stubbing per source is heavy — at minimum assert `selectIngestWorklist(Object.keys(files))` is what the run iterates by checking the emitted `sourceRefs`/diagnostics cover exactly the oldest N.
  - **idempotent:** after a successful archive, a second run with the file absent from `files` (already moved) → `[]`, no duplicate.

- [ ] **Step 6: Commit**
```bash
git add assets/extensions/dome.agent/processors/ingest.ts tests/extensions/dome.agent/ingest.test.ts
git commit -m "fix(agent): ingest reconciles the standing inbox/raw set, not the commit delta

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Hourly schedule trigger on the manifest

**Files:** Modify `assets/extensions/dome.agent/manifest.yaml`; Test: extend `tests/extensions/dome.agent/manifest.test.ts`.

- [ ] **Step 1: Failing test.** Read `manifest.test.ts` for its loader + assertion style. Add a test asserting `dome.agent.ingest` has a `schedule` trigger with `cron: "0 * * * *"` in addition to its signal triggers:
```ts
test("ingest has an hourly schedule trigger (level-triggered backstop)", () => {
  const ingest = <load manifest, find processor id "dome.agent.ingest" as the file does>;
  const sched = ingest.triggers.filter((t) => t.kind === "schedule");
  expect(sched).toHaveLength(1);
  expect(sched[0].cron).toBe("0 * * * *");
  // signals preserved (the prompt happy path)
  expect(ingest.triggers.some((t) => t.kind === "signal" && t.pathPattern === "inbox/raw/*.md")).toBe(true);
});
```

- [ ] **Step 2: Run, expect FAIL.** `bun test tests/extensions/dome.agent/manifest.test.ts -t "hourly schedule"`.

- [ ] **Step 3: Implement.** In `manifest.yaml`, add to the `dome.agent.ingest` `triggers:` list (after the two existing `signal` entries):
```yaml
      - kind: schedule
        cron: "0 * * * *"
```

- [ ] **Step 4: Run, expect PASS.** `bun test tests/extensions/dome.agent/manifest.test.ts` (whole file — manifest lockstep tests may assert trigger counts elsewhere; update any count that legitimately changed).
- [ ] **Step 5: Commit**
```bash
git add assets/extensions/dome.agent/manifest.yaml tests/extensions/dome.agent/manifest.test.ts
git commit -m "feat(agent): hourly schedule trigger on ingest (recovery backstop)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: End-to-end scheduled-tick recovery scenario

**Files:** Test: create `tests/harness/scenarios/effect-kinds/ingest-scheduled-recovery.scenario.test.ts` (mirror `tests/harness/scenarios/capabilities/model-invoke-scheduled.scenario.test.ts` for the model stub + clock advance + scheduled drain, and `claims-render-facts.scenario.test.ts` for bundle/config setup).

This proves the wiring end-to-end: a committed capture that the signal path did not lift is ingested by a scheduled tick.

- [ ] **Step 1: Test.** Enable the `dome.agent` bundle with a stub `modelProvider` whose steps lift the capture and archive it (copy the scheduled-model stub shape from `model-invoke-scheduled.scenario`). Seed a committed `inbox/raw/<ts>-note.md`. Then drive a **scheduled** tick (advance `h.clock` past the top of the hour and run the operational/scheduled drain the harness exposes — follow exactly how `model-invoke-scheduled.scenario` triggers its cron processor). Assert: a task landed in today's daily and the capture is no longer in `inbox/raw/` (moved to `processed/`).
  - If faithfully stubbing the multi-step ingest agent loop in the harness proves heavy, scope this test to the **trigger wiring** only: assert a scheduled tick *invokes* `dome.agent.ingest` (a run row appears in the ledger for it) against the standing capture — the per-step lift behavior is already covered by Task 2's processor-level tests. Note in the test which level you chose and why.

- [ ] **Step 2: Run, expect PASS** on this branch. `bun test tests/harness/scenarios/effect-kinds/ingest-scheduled-recovery.scenario.test.ts`.
- [ ] **Step 3: Commit**
```bash
git add tests/harness/scenarios/effect-kinds/ingest-scheduled-recovery.scenario.test.ts
git commit -m "test(agent): scheduled tick recovers a capture the signal path missed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Full-suite gate

- [ ] **Step 1:** `bun test 2>&1 | tail -10` → 0 fail. Watch `tests/extensions/dome.agent/**`, the manifest lockstep, and `tests/integration/agent-prompt-regression.test.ts` (it snapshots agent prompts — unaffected, but confirm). Investigate any failure: classify regression vs pre-existing (this branch forked from current `main`). Do not weaken a test to pass; if a manifest count/lockstep legitimately changed (the new trigger), update it as the intended change.
- [ ] **Step 2:** `bunx tsc --noEmit 2>&1 | grep -E "ingest|dome.agent"` → no NEW errors from this work (pre-existing unrelated errors may exist; add none).
- [ ] **Step 3: Commit** (only if Step 1/2 required a fix not already committed).

## Self-review notes
- **Root, not symptom:** ingest's trigger model becomes level-triggered (reconcile standing state); signals stay as the prompt latency path. Generalizes the eventual-consistency guarantee for the inbox without touching the engine.
- **Cohesion:** reuses the entire shared agent harness (`agentPreamble`/`runAgentLoop`/`finishAgentRun`), `isRawCapturePath`, `listMarkdownFiles`, and the `consolidate`/`brief` schedule-trigger pattern. New surface = one manifest trigger + one worklist swap + one bounded-batch const.
- **No over-engineering:** no ledger (the inbox dir is the queue); `inbox-stale-check` unchanged (168h already a valid poison threshold).
- **Type consistency:** `selectIngestWorklist(ReadonlyArray<string>, max?) → string[]`; `MAX_CAPTURES_PER_RUN` shared between the selector and its default. `await listMarkdownFiles()` feeds it; `rawPaths`/`sourceRefs` types unchanged downstream.
- **Well-tested:** pure selector unit test (Task 1), processor-level recovery/idle/bound/idempotent via `makeCtx` (Task 2), manifest assertion (Task 3), end-to-end scheduled recovery (Task 4), full suite (Task 5).
- **Operational:** after merge, the work-vault daemon restart picks this up; the currently-stranded capture is then ingested on the next scheduled pass (no manual `dome run` needed).
