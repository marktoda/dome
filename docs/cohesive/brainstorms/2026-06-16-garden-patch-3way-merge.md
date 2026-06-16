---
type: brainstorm
tags: [design, engine, garden, adoption, convergence]
created: 2026-06-16
status: approved-design
---

# Garden patches merge instead of overwrite (root fix for the claims render↔stamp loop)

Approved approach 2026-06-16 (owner: "do A"). Diagnosed live on the work vault:
`dome.claims.render-facts` and `dome.claims.stamp` are in a non-converging garden
loop — ~2 commits/min, 2,698 `cannot lock ref` CAS races, and `dome.agent.ingest`
starved (a real capture stuck un-ingested for hours).

## Root cause

Both processors edit **disjoint regions** of the daily note — render-facts owns the
`<!-- dome.claims:current-facts -->` block (via `replaceGeneratedBlock`); stamp adds
`^c` block anchors to claim source lines — but **both emit whole-file `write`
changes**. `applyPatchToCandidate` (`src/engine/core/apply-patch.ts`) applies a write
as a **non-merging whole-blob overwrite** (its own banner: *"we overwrite the blob OID
at the path regardless of prior content … the FileChange shape is non-merging"*).

So when one processor's whole-file write — computed against the snapshot it read
(`Dome-Base`) — is applied onto a candidate the *other* processor already advanced,
it silently **reverts the other's region**. render-facts re-enriches the digest →
stamp's next whole-file write reverts it → forever. Confirmed: the daily blob
oscillates between two states (`a7a8a70` rich ↔ `991e433` stripped); 108 of the last
200 engine commits are `claims.render-facts`/`claims.stamp`. Concurrent human/Obsidian
edits move HEAD further, worsening the CAS thrash. A **fixed point exists** (anchored
claims + rendered digest, where both no-op) — the engine just never reaches it because
overwrites keep reverting.

This is the [[concurrent branch hazard]] reproduced *inside* the garden between two
cooperating processors. It is a **general** bug: any two processors that edit different
regions of the same file will livelock the same way.

## Fix

Make `applyPatchToCandidate` apply each `write` change as a **3-way merge**, not an
overwrite. The function already receives everything needed:

- **base** = file content at `opts.runContext.base` (the snapshot the processor read).
- **ours** = file content at `opts.candidate` (the tree being built up — may already
  carry a sibling processor's change).
- **theirs** = `change.content` (the processor's whole-file write).

Algorithm per write change:
1. Read `ours` (path in `candidate`) and `base` (path in `runContext.base`).
2. **Fast path:** if `ours === base` (no one else touched this path since the processor
   read it) → use `theirs` directly. This is the current behavior and the overwhelming
   common case; zero behavior change, no merge cost.
3. **Merge path:** if `ours !== base` → line-based 3-way merge (diff3) of (base, ours,
   theirs). Non-conflicting hunks compose (stamp's anchor-diff lands on render-facts's
   digest-updated `ours`, and vice-versa) → **convergence in one cascade**.
4. **Conflict path:** overlapping edits to the same lines → resolve the conflicting
   hunk to **ours** (the already-landed change wins — we never revert), and emit a
   `garden.patch.merge-conflict` diagnostic (path + processorId) so a genuine
   block-ownership collision is visible. The processor re-runs on the merged state next
   cascade and re-derives, so forward progress is guaranteed.
5. If the merged content equals `ours`, that path contributes no change (same as today's
   same-tree → `null`).

Deletes are unchanged (already a no-op when absent).

### Merge mechanism
Pure in-process line diff3 — no temp files, staying within the engine's "everything
through isomorphic-git plumbing, never touch the working tree" boundary. Reuse an
existing diff dependency if one is already vendored (check `package.json`); otherwise
vendor a minimal LCS-based diff3 (`src/engine/core/diff3.ts`) with its own unit tests.
`git merge-file` (native CLI on temp files) is explicitly rejected — it breaks the
no-working-tree isolation the banner guarantees.

## Why this is the right layer
The processors are individually correct (each reads its snapshot, edits its region,
writes back). The defect is the engine treating a whole-file write as authoritative for
the *whole file* even when the processor only changed one region. Merging the intended
diff onto the live candidate is the precise, general fix; it converges every
disjoint-region co-writer pair, not just claims.

## Scope / non-goals
- **In:** `applyPatchToCandidate` merge; a diff3 util; reproduction + convergence tests;
  the conflict diagnostic.
- **Out:** changing the claims processors (they become correct under the merge); changing
  the CAS/ref-advance logic (the human-vs-engine races are a separate, expected hazard —
  this fix drastically reduces their frequency by killing the self-inflicted loop, but
  doesn't change CAS semantics); the live-vault operational unblock (separate, optional).
- **Invariant preserved:** `ENGINE_COMMITS_CARRY_DOME_TRAILERS` (commit shape unchanged);
  the candidate-only / no-working-tree isolation; one-commit-per-tree-moving-patch.

## Testing
1. **Reproduction (must fail pre-fix):** drive two synthetic garden processors that write
   disjoint regions of one file as whole-file writes from a shared base through the apply
   path; assert both regions survive (today: the second reverts the first).
2. **Convergence:** the claims render↔stamp pair on a daily with un-anchored claims
   settles to a fixed point (anchored claims + rendered digest) and then **no further
   patches** are produced.
3. **diff3 unit tests:** disjoint hunks compose; overlapping → conflict→ours + diagnostic;
   identical theirs/base → fast path; create/delete unaffected.
4. Full suite green.
