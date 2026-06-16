# Garden Patch 3-Way Merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use `- [ ]` checkboxes.

**Goal:** Stop the non-converging garden loop (and its whole class) by making `applyPatchToCandidate` apply a processor's `write` change as a **3-way merge of its intended (base→content) diff onto the live candidate**, instead of a whole-blob overwrite that reverts sibling processors' regions.

**Architecture:** Pure in-process line diff3 (no temp files, no working tree). `applyPatchToCandidate` reads `ours` (path@candidate) and `base` (path@runContext.base); fast-path when equal (today's behavior), else diff3-merge `theirs`=`change.content`; conflicting hunks resolve to `ours` (never revert) + optional diagnostic. Convergence proven by test.

**Tech Stack:** TypeScript on Bun; isomorphic-git plumbing; `bun test`. Files under `src/engine/core/`.

**Design:** `docs/cohesive/brainstorms/2026-06-16-garden-patch-3way-merge.md`.

**Key facts (verified):**
- Fix site: `src/engine/core/apply-patch.ts` → `applyPatchToCandidate`. Loop (lines 126–143) hashes `change.content` to a blob unconditionally (overwrite). It already has `opts.candidate` (CommitOid) and `opts.runContext.base` (CommitOid).
- Read a file at a commit: `git.readBlob({ fs, dir: root, oid: <commitOid>, filepath: <repo-rel path> })` resolves the path within that commit's tree; throws/`NotFoundError` when absent → treat as `null`.
- Paths in the loop are already prefix-joined to outer-repo-relative (`fullPath`).
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

### Task 2: Apply `write` changes as a 3-way merge in `applyPatchToCandidate`

**Files:** Modify `src/engine/core/apply-patch.ts`; Test `tests/engine/core/apply-patch.test.ts` (find the existing test file — `grep -rl applyPatchToCandidate tests/` — extend it; create if none).

First **verify the base**: confirm `opts.runContext.base` is the commit the emitting processor *read* (its snapshot), not an older loop-start commit, for the garden path — read `src/engine/garden/garden.ts` + `src/processors/runtime.ts` where the garden runContext is built. If garden passes a different field as the snapshot commit, merge against THAT (the merge base must be the processor's input snapshot). Document the finding in a code comment. (A too-old base is safe — it only causes spurious conflicts, never silent revert — but the correct base gives clean merges.)

- [ ] **Step 1: Failing reproduction test** — the exact bug, at the apply layer. In `apply-patch.test.ts`, set up a tiny git repo with a file `daily.md` having two disjoint regions; build a candidate commit `C0`. Simulate two processors that each read `C0` and emit a whole-file `write`:
  - patch A (runContext.base = C0): content = C0 with **region 1** changed.
  - apply A → C1.
  - patch B (runContext.base = C0): content = C0 with **region 2** changed (region 1 as in C0).
  - apply B onto candidate **C1**.
  Assert the resulting tree has **both** region 1 (from A) **and** region 2 (from B). Pre-fix this fails (B's whole-file overwrite reverts region 1 to C0). Use the existing test's repo-fixture helpers.

```ts
// pseudocode shape — adapt to the file's existing harness
const c1 = await applyPatchToCandidate({ vaultPath, candidate: c0, patch: patchA, runContext: { ...rc, base: c0 } });
const c2 = await applyPatchToCandidate({ vaultPath, candidate: c1!, patch: patchB, runContext: { ...rc, base: c0 } });
const merged = await readFileAt(c2!, "daily.md");
expect(merged).toContain("REGION1_FROM_A");
expect(merged).toContain("REGION2_FROM_B");
```

- [ ] **Step 2: Run, expect FAIL** (region 1 reverted): `bun test tests/engine/core/apply-patch.test.ts -t disjoint`.
- [ ] **Step 3: Implement the merge.** In the write branch (apply-patch.ts ~129–135), replace the unconditional overwrite:

```ts
import { merge3 } from "./diff3";
// ... inside the `if (change.kind === "write")` branch:
const ours = await readBlobUtf8(root, opts.candidate, fullPath);   // null if absent
const base = await readBlobUtf8(root, opts.runContext.base, fullPath);
let finalContent = change.content;
if (ours !== null && ours !== base) {
  // Someone advanced this path since the processor read it: merge the
  // processor's intended diff (base→content) onto the live candidate.
  const m = merge3({ base: base ?? "", ours, theirs: change.content });
  finalContent = m.text;
  if (m.conflict) opts.onMergeConflict?.({ path: change.path, processorId: opts.runContext.processorId });
}
const blobOid = await git.writeBlob({ fs, dir: root, blob: Buffer.from(finalContent, "utf8") });
writes.set(fullPath, blobOid);
deletes.delete(fullPath);
```
Add a `readBlobUtf8(root, commitOid, filepath): Promise<string | null>` helper (wraps `git.readBlob`; returns `null` on `NotFoundError`). Add `onMergeConflict?: (i: { path: string; processorId: string }) => void` to `ApplyPatchInput` (optional — adoption-path callers may omit it). Update the file banner (lines 32–36) to describe the merge semantics.

- [ ] **Step 4: Run, expect PASS** — reproduction test passes (both regions survive). Add a conflict-path test (both patches edit the SAME line → result keeps the first/`ours`, `onMergeConflict` fired). Confirm the fast path (`ours === base`) still yields a plain overwrite (existing tests unchanged).
- [ ] **Step 5: Commit**
```bash
git add src/engine/core/apply-patch.ts tests/engine/core/apply-patch.test.ts
git commit -m "fix(engine): apply patch writes as 3-way merge onto candidate (no sibling-region revert)"
```

---

### Task 3: Convergence test — the claims render↔stamp loop settles

**Files:** Test only — `tests/extensions/dome.claims/render-stamp-convergence.test.ts` (or an existing claims integration test; `grep -rl "render-facts\|stampClaimAnchors" tests/`).

- [ ] **Step 1: Failing/guard test.** Build a daily-note fixture with ≥3 **un-anchored** claim lines (so render-facts wants backlinks once anchored, and stamp wants to anchor). Drive the two processors through the garden settle (use the existing garden/runtime test harness — `grep -rl "runGardenPhase\|gardenRunner\|garden" tests/` for the pattern). Run the cascade to fixpoint and assert:
  - the daily ends with all claims anchored AND the `current-facts` block rendered with backlinks, AND
  - a subsequent garden pass produces **zero patches** (the fixed point — this is the assertion that fails today, where it never stops).
  If a full garden-harness is too heavy, assert the narrower invariant directly: applying `stampClaimAnchors`' write then `render-facts`' write (each based on the shared pre-anchor snapshot) through `applyPatchToCandidate` yields a state where re-running BOTH produces no change.

- [ ] **Step 2: Run** — pre-fix this loops/diverges (no fixpoint); post-fix it converges. Confirm PASS on the fix branch.
- [ ] **Step 3: Commit**
```bash
git add tests/extensions/dome.claims/render-stamp-convergence.test.ts
git commit -m "test(claims): render-facts↔stamp converges to a fixed point under garden merge"
```

---

### Task 4: Spec note + full-suite gate

**Files:** `docs/wiki/specs/adoption.md` (the `candidate = apply_patches(...)` step) and/or `docs/wiki/specs/effects.md` (PatchEffect): note that whole-content writes are applied as a 3-way merge onto the candidate (base = the processor's read snapshot), so disjoint-region co-writers compose and the garden converges; overlaps resolve to the landed change + a `garden.patch.merge-conflict` diagnostic.

- [ ] **Step 1:** Add the normative paragraph; match the file's wikilink/voice conventions; link `[[cohesive/brainstorms/2026-06-16-garden-patch-3way-merge]]`.
- [ ] **Step 2: Full suite** `bun test 2>&1 | tail -6` → 0 fail. Watch `tests/engine/**`, adoption/garden tests, and the claims suite. Investigate any failure (existing apply-patch tests that asserted overwrite-revert behavior may legitimately need updating — confirm each is the intended new behavior, not a regression).
- [ ] **Step 3: Commit**
```bash
git add docs/wiki/specs
git commit -m "docs(adoption): patch writes are 3-way merged onto the candidate (garden convergence)"
```

## Self-review notes
- **Root, not symptom:** fixes every disjoint-region co-writer pair, not just claims; the claims processors are unchanged.
- **Safety:** fast path (`ours===base`) is byte-identical to today; conflicts resolve to the *landed* change (never revert) → guaranteed forward progress + convergence; commit shape/trailers unchanged.
- **No working tree / isolation preserved:** pure in-process diff3; only isomorphic-git plumbing.
- **Verify the merge base** (Task 2 pre-step) — the one correctness-critical unknown.
- **Operational:** after merge, the live work daemon needs a restart to pick up the fix; the currently-stuck capture + oscillating daily are a separate operational unblock (offered separately).
