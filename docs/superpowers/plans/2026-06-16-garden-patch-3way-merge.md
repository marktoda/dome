# Garden Patch 3-Way Merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use `- [ ]` checkboxes.

**Goal:** Stop the non-converging garden loop (and its whole class) by making `applyPatchToCandidate` apply a processor's `write` change as a **3-way merge of its intended (base→content) diff onto the live candidate**, instead of a whole-blob overwrite that reverts sibling processors' regions.

**Architecture:** Pure in-process line diff3 (no temp files, no working tree). `applyPatchToCandidate` gains a new optional `runContext.mergeBase` (the commit the emitting processor *read*). For each `write` it reads `ours` (path@candidate) and `base` (path@mergeBase); when `mergeBase` is absent or equals `candidate` it overwrites (today's behavior, byte-identical); otherwise it diff3-merges `theirs`=`change.content` onto `ours`, conflicts resolving to `ours` (never revert) + optional diagnostic. The garden orchestrator and the non-signal garden dispatch then *feed* `mergeBase` = the snapshot their processors read; `proposal.base`/`candidate`/`Dome-Base` are untouched. Convergence proven by test.

**Tech Stack:** TypeScript on Bun; isomorphic-git plumbing; `bun test`. Files under `src/engine/core/` and `src/engine/garden/`.

**Design:** `docs/cohesive/brainstorms/2026-06-16-garden-patch-3way-merge.md` (see "the three bases" note).

**Key facts (verified by reading the code):**
- Fix site: `src/engine/core/apply-patch.ts` → `applyPatchToCandidate`. Loop (lines 126–143) hashes `change.content` to a blob unconditionally (overwrite).
- **The merge base is NOT `runContext.base` today.** In the garden sub-proposal path (`src/engine/garden/garden-sub-proposals.ts:55-64`) the call sets `candidate: opts.base` AND `runContext.base: opts.base` — i.e. base === candidate === the *live* adopted ref. `proposal.base` is also set from the same `opts.base` (line 76) and **must** stay equal to the new commit's parent because `adopt()` compiles signals over `compileRange({ base: proposal.base, head: candidate })` (`src/engine/core/adopt.ts:330-334`). → We must add a NEW field for the merge base, not repurpose `base`.
- The snapshot the garden processors read = the orchestrator's `adopted` param (`src/engine/garden/garden.ts:327` passes it to `runGardenProcessors`); for the non-signal path it's `dispatchGardenPatchEffect`'s `opts.adopted` (`garden-patch-dispatch.ts`). The live candidate is `resolveCurrentAdopted(currentAdopted, adopted)`.
- The adoption-phase sink (`src/engine/host/compiler-host.ts:964-973`) already passes a distinct `base`/`candidate` and is NOT wired for merge in this change (its own fixpoint loop self-heals); leave it untouched.
- Read a file at a commit: `git.readBlob({ fs, dir: root, oid: <commitOid>, filepath: <repo-rel path> })` resolves the path within that commit's tree; throws a `NotFoundError` when absent → treat as `null`.
- Paths in the loop are already prefix-joined to outer-repo-relative (`fullPath`).
- `tests/engine/` is FLAT — no `tests/engine/core/` subdir. Existing apply-patch tests: `tests/engine/apply-patch.test.ts`. diff3 tests landed at `tests/engine/diff3.test.ts` (Task 1, done).
- Banner at lines 32–36 documents the current "non-merging overwrite" — UPDATE it.

---

### Task 1: Pure diff3 line-merge utility

**Files:** Create `src/engine/core/diff3.ts`; Test `tests/engine/core/diff3.test.ts`.

First check for an existing diff dependency: run `grep -E '"diff"|diff3|node-diff3' package.json`. If a suitable one is vendored, wrap it; otherwise implement a minimal LCS-based diff3 as below.

- [ ] **Step 1: Failing test** — `tests/engine/core/diff3.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { merge3 } from "../../../src/engine/core/diff3";

describe("merge3", () => {
  test("disjoint edits compose cleanly", () => {
    const base = "L1\nL2\nL3\nL4\n";
    const ours = "L1\nOURS\nL3\nL4\n";     // edited line 2
    const theirs = "L1\nL2\nL3\nTHEIRS\n"; // edited line 4
    const r = merge3({ base, ours, theirs });
    expect(r.conflict).toBe(false);
    expect(r.text).toBe("L1\nOURS\nL3\nTHEIRS\n");
  });
  test("identical theirs===base is a no-op merge (keeps ours)", () => {
    const base = "A\nB\n", ours = "A\nX\n", theirs = "A\nB\n";
    const r = merge3({ base, ours, theirs });
    expect(r.conflict).toBe(false);
    expect(r.text).toBe("A\nX\n");
  });
  test("overlapping edits → conflict, resolves to ours", () => {
    const base = "A\nB\nC\n", ours = "A\nOURS\nC\n", theirs = "A\nTHEIRS\nC\n";
    const r = merge3({ base, ours, theirs });
    expect(r.conflict).toBe(true);
    expect(r.text).toBe("A\nOURS\nC\n"); // ours wins; never reverts a landed change
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module missing): `bun test tests/engine/core/diff3.test.ts`.
- [ ] **Step 3: Implement** `src/engine/core/diff3.ts`:

```ts
// Pure line-based 3-way merge. No IO. Used by applyPatchToCandidate so a
// processor's whole-file write composes with sibling edits instead of
// overwriting them. Conflicting hunks resolve to `ours` (we never revert a
// landed change); the caller surfaces a diagnostic.
export type Merge3Result = { readonly text: string; readonly conflict: boolean };

export function merge3(input: {
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
}): Merge3Result {
  // Implement via a standard diff3 over line arrays:
  //  1. LCS(base, ours) and LCS(base, theirs) → aligned change regions.
  //  2. Walk regions: where only one side changed a base region, take that
  //     side; where both sides changed the SAME base region differently →
  //     conflict (take `ours`); where both made the identical change → take it.
  //  3. Preserve trailing-newline shape of `ours`.
  // Keep it small and well-commented; this is the merge core.
}
```
Implement the LCS + diff3 region walk (line-split on `\r?\n`, rejoin preserving `ours`'s trailing newline). Conflict ⇒ `conflict:true`, region resolved to ours' lines.

- [ ] **Step 4: Run, expect PASS.** Add a few more cases (insertions at top/bottom, empty base = pure concat-or-conflict, theirs===ours).
- [ ] **Step 5: Commit**
```bash
git add src/engine/core/diff3.ts tests/engine/core/diff3.test.ts
git commit -m "feat(engine): pure line-based 3-way merge (diff3) util"
```

---

### Task 2: 3-way merge in `applyPatchToCandidate` (gated on a new `mergeBase`)

**Files:** Modify `src/engine/core/apply-patch.ts`; Test: extend `tests/engine/apply-patch.test.ts`.

The merge is keyed on a NEW optional field `runContext.mergeBase: CommitOid`. When it's absent or equal to `candidate`, behavior is byte-identical to today (overwrite). When it differs (a sibling advanced the candidate since the processor read `mergeBase`), we diff3-merge. Task 3 wires the garden callers to set it; this task makes apply-patch honor it and proves the merge at the apply layer.

- [ ] **Step 1: Add the optional field.** In `ApplyPatchInput.runContext` (apply-patch.ts:72-80), add after `sourceHead`:
```ts
    /**
     * The commit the emitting processor READ (its input snapshot), used as the
     * 3-way merge base when `candidate` has advanced past it (a sibling patch
     * landed in between). Absent or `=== candidate` → plain overwrite (no
     * sibling divergence to reconcile). Distinct from `base` (the Dome-Base
     * trailer / `proposal.base`), which must stay equal to the new commit's
     * parent. See docs/cohesive/brainstorms/2026-06-16-garden-patch-3way-merge.md.
     */
    readonly mergeBase?: CommitOid;
```
Also add to `ApplyPatchInput` (top-level, after `now?`):
```ts
  /** Called once per write whose 3-way merge had a true conflict (resolved to `ours`). */
  readonly onMergeConflict?: (info: { readonly path: string; readonly processorId: string }) => void;
```

- [ ] **Step 2: Failing reproduction test** — the exact bug at the apply layer. In `tests/engine/apply-patch.test.ts` (reuse its existing fixture helpers — read the file first for the repo-setup/commit/readBlob patterns), add a test `"3-way merges disjoint-region writes against mergeBase (no sibling-region revert)"`:
  - Create a file `daily.md` with two clearly disjoint regions (e.g. a top line `TOP: base` and a bottom line `BOTTOM: base`, with filler lines between). Commit → `c0`.
  - Build patch A = whole-file content of `c0` with the TOP region changed (`TOP: from-A`), bottom unchanged. Apply with `candidate: c0, runContext.mergeBase: c0` → `c1`. (mergeBase===candidate → overwrite; c1 has A's top.)
  - Build patch B = whole-file content of `c0` with the BOTTOM region changed (`BOTTOM: from-B`), top unchanged (as in `c0`). Apply with `candidate: c1, runContext.mergeBase: c0` → `c2`.
  - Read `daily.md` @ `c2`; assert it contains BOTH `TOP: from-A` AND `BOTTOM: from-B`.
  - Pre-implementation (overwrite) this FAILS: B reverts TOP back to `TOP: base`.

- [ ] **Step 3: Run, expect FAIL:** `bun test tests/engine/apply-patch.test.ts -t "3-way merges disjoint"` → the TOP assertion fails (reverted).

- [ ] **Step 4: Implement.** Add the import `import { merge3 } from "./diff3";`. Add a helper near the path helpers:
```ts
/** Read a file's UTF-8 content at a commit; `null` when the path is absent there. */
async function readBlobUtf8(root: string, oid: string, filepath: string): Promise<string | null> {
  try {
    const { blob } = await git.readBlob({ fs, dir: root, oid, filepath });
    return Buffer.from(blob).toString("utf8");
  } catch (e) {
    if (e instanceof git.Errors.NotFoundError) return null;
    throw e;
  }
}
```
Replace the `change.kind === "write"` branch (apply-patch.ts:129-137) body so the blob written is the merged content:
```ts
    if (change.kind === "write") {
      let finalContent = change.content;
      const mergeBase = opts.runContext.mergeBase;
      // Only reconcile when a sibling advanced the candidate past the snapshot
      // the processor read. Same-commit (or unset) mergeBase → overwrite, the
      // common case and byte-identical to pre-merge behavior.
      if (mergeBase !== undefined && mergeBase !== opts.candidate) {
        const ours = await readBlobUtf8(root, opts.candidate, fullPath);
        const base = await readBlobUtf8(root, mergeBase, fullPath);
        if (ours !== null && ours !== base) {
          const m = merge3({ base: base ?? "", ours, theirs: change.content });
          finalContent = m.text;
          if (m.conflict) {
            opts.onMergeConflict?.({
              path: change.path,
              processorId: opts.runContext.processorId,
            });
          }
        }
      }
      const blobOid = await git.writeBlob({
        fs,
        dir: root,
        blob: Buffer.from(finalContent, "utf8"),
      });
      writes.set(fullPath, blobOid);
      deletes.delete(fullPath);
    } else {
```
Update the file banner (apply-patch.ts:32-36): replace the "There is no 'patch failed to apply' path — the FileChange shape is non-merging" wording with a description of the `mergeBase`-gated 3-way merge (disjoint regions compose; conflicts resolve to `ours` and fire `onMergeConflict`; absent/equal `mergeBase` = overwrite).

- [ ] **Step 5: Run, expect PASS.** Reproduction test passes (both regions survive). Add two more cases in the same file:
  - **conflict path:** A changes the TOP line, B (mergeBase=c0, candidate=c1) ALSO changes the TOP line differently → result keeps A's TOP (`ours`), and an `onMergeConflict` spy fires once with `path: "daily.md"`.
  - **fast path unchanged:** mergeBase omitted entirely → plain overwrite (B's whole content wins), proving back-compat.
  Run the whole file: `bun test tests/engine/apply-patch.test.ts` → all green (existing tests unaffected — they don't set `mergeBase`).

- [ ] **Step 6: Commit**
```bash
git add src/engine/core/apply-patch.ts tests/engine/apply-patch.test.ts
git commit -m "fix(engine): apply patch writes as a mergeBase-gated 3-way merge

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Feed `mergeBase` from the garden paths

**Files:** Modify `src/engine/garden/garden-sub-proposals.ts`, `src/engine/garden/garden.ts`, `src/engine/garden/garden-patch-dispatch.ts`; Test: a garden-level test (extend an existing one — `grep -rln "spawnGardenSubProposal\|runGardenPhase" tests/`).

Goal: pass the read-snapshot as `mergeBase` so apply-patch's new branch actually fires in production. `candidate`, `proposal.base`, and the `Dome-Base` trailer stay exactly as they are.

- [ ] **Step 1: Thread `mergeBase` through `spawnGardenSubProposal`.** In `garden-sub-proposals.ts`, add to the `opts` of `spawnGardenSubProposal` a field `readonly mergeBase: CommitOid;` (required — every garden caller knows the read snapshot). In the `applyPatch({...})` call (lines 55-67) pass `mergeBase: opts.mergeBase` inside `runContext` (alongside the existing `base: opts.base`). Do NOT change `candidate: opts.base`, `base: opts.base`, `sourceHead`, or `makeGardenProposal({ base: opts.base, ... })`.

- [ ] **Step 2: Orchestrator caller.** In `garden.ts` (the spawn loop at ~542-556), the snapshot all processors in this pass read is the orchestrator's `adopted` param. Pass `mergeBase: adopted` to `spawnGardenSubProposal` (the existing `base`/`sourceHead` keep using `resolveCurrentAdopted(currentAdopted, adopted)` — the live candidate). So: `base` advances per sibling; `mergeBase` is the fixed pass snapshot.

- [ ] **Step 3: Non-signal dispatch caller.** In `garden-patch-dispatch.ts` (~104-117), `opts.adopted` is the snapshot the scheduled/queued/answer processor read; `adopted = resolveCurrentAdopted(opts.currentAdopted, opts.adopted)` is the live candidate. Pass `mergeBase: opts.adopted` to `spawnGardenSubProposal` (keep `base: adopted`, `sourceHead: adopted`).

- [ ] **Step 4: Test the wiring.** Add a garden-level test that two garden processors emitting whole-file writes to **disjoint regions** of one file from the same `adopted` snapshot both survive after the spawn loop (i.e. the second sub-proposal does not revert the first). Drive it through `runGardenPhase` with a stub `GardenPhaseRunner` returning the two patch effects and a real (or in-memory) `adoptSubProposal` that advances `currentAdopted`. Assert the final adopted tree's file contains both regions. Pre-Task-2+3 this reverts; now it composes. If the existing garden test harness makes a full `runGardenPhase` drive heavy, instead unit-test `spawnGardenSubProposal` twice in sequence against a tiny repo (first spawn advances a `currentAdopted` stub; second spawn's `mergeBase` = original snapshot, `candidate` = advanced) and assert both regions survive — this directly exercises the new plumbing.

- [ ] **Step 5: Run + commit.** `bun test <the garden test file>` green, plus `bun test tests/engine/garden 2>&1 | tail -5` (or wherever garden tests live) to confirm no regression.
```bash
git add src/engine/garden/garden-sub-proposals.ts src/engine/garden/garden.ts src/engine/garden/garden-patch-dispatch.ts tests/
git commit -m "fix(garden): feed processor read-snapshot as mergeBase so sub-proposal writes merge

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Convergence test — the claims render↔stamp loop settles

**Files:** Test only — create `tests/extensions/dome.claims/render-stamp-convergence.test.ts` (confirm the dir; `grep -rln "render-facts\|stampClaimAnchors\|dome.claims" tests/` for an existing claims test to mirror harness + import paths).

This is the end-to-end proof that the production loop now reaches a fixed point.

- [ ] **Step 1: Test.** Build a daily-note fixture with ≥3 **un-anchored** claim lines (so `dome.claims.stamp` wants to add `^c` anchors and `dome.claims.render-facts` wants to render the `current-facts` digest — and, once anchored, add `([[page#^anchor]])` backlinks). Drive both processors through the garden cascade to its fixed point using the same harness Task 3 used (real `runGardenPhase` + recursive `adoptSubProposal`, or the direct `spawnGardenSubProposal`-sequence harness). Assert:
  - the settled daily has all claim lines anchored (`^c…`) AND a rendered `<!-- dome.claims:current-facts -->` block whose lines carry backlinks, AND
  - one more garden pass over the settled state produces **zero** sub-proposals / patches (the fixed point — the assertion that never holds today because the two processors revert each other forever).
  Keep iteration count bounded and assert it stays under the cascade cap (settling should take only 2-3 rounds).

- [ ] **Step 2: Run, expect PASS** on this branch (pre-fix it would diverge/hit the cap). `bun test tests/extensions/dome.claims/render-stamp-convergence.test.ts`.
- [ ] **Step 3: Commit**
```bash
git add tests/extensions/dome.claims/render-stamp-convergence.test.ts
git commit -m "test(claims): render-facts<->stamp converges to a fixed point under garden merge

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Spec note + full-suite gate

**Files:** the adoption/effects spec (`grep -rln "applyPatch\|apply_patches\|PatchEffect" docs/wiki/specs/`; likely `docs/wiki/specs/adoption.md` and/or `docs/wiki/specs/effects.md`).

- [ ] **Step 1:** Add a normative paragraph: a garden sub-proposal's whole-content `write` is applied as a 3-way merge onto the live candidate, using the emitting processor's read-snapshot (`mergeBase`) as the base, so disjoint-region co-writers compose and the garden reaches its fixed point instead of livelocking; overlapping edits resolve to the already-landed change (`ours`) and fire `onMergeConflict`. Note the adoption-phase sink is unchanged (its own fixpoint loop covers it). Match the file's wikilink/voice conventions; link `[[cohesive/brainstorms/2026-06-16-garden-patch-3way-merge]]`.
- [ ] **Step 2: Full suite** `bun test 2>&1 | tail -8` → 0 fail. Watch `tests/engine/**`, garden, adoption, and the claims suite. If a pre-existing test asserted overwrite-revert behavior, confirm whether it's a legitimate behavior change (a garden test that set base===candidate is unaffected; only tests that newly set `mergeBase` should see merging) — update only if it's the intended new behavior, never to paper over a regression.
- [ ] **Step 3: Commit**
```bash
git add docs/wiki/specs
git commit -m "docs(adoption): garden patch writes are 3-way merged onto the candidate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Self-review notes
- **Root, not symptom:** the merge is general (every disjoint-region garden co-writer pair); the claims processors are unchanged.
- **Safety / back-compat:** `mergeBase` absent or `=== candidate` → byte-identical overwrite. Only the two garden callers set it; the adoption sink, `proposal.base`, `candidate`, and the `Dome-Base` trailer are untouched. Conflicts resolve to the *landed* change (never revert) → guaranteed forward progress + convergence.
- **The merge base was the one real unknown** — verified by reading the code: it is NOT `runContext.base` (which equals `candidate`/`proposal.base` in the garden path and must stay so for `compileRange`), hence the new `mergeBase` field + the Task 3 plumbing. This reshaped Tasks 2-3 from the original single-task sketch.
- **No working tree / isolation preserved:** pure in-process diff3; only isomorphic-git plumbing.
- **Type consistency:** `merge3`/`Merge3Result` (Task 1) ← `runContext.mergeBase`/`onMergeConflict`/`readBlobUtf8` (Task 2) ← `spawnGardenSubProposal({ mergeBase })` (Task 3). Field names match across tasks.
- **Operational:** after merge, the live work daemon needs a restart to pick up the fix; the currently-stuck capture + oscillating daily are a separate operational unblock (offered separately).
