// scenarios/garden-cascade/sub-proposal-frame-correctness.scenario.test.ts
//
// Regression scenario for the Phase 4a' sink-frame fix-up (commit
// 2307ab8 on main). The bugs being guarded:
//
//   Bug 1: `realApplyPatch` in compiler-host.ts captured `drift.base` and
//          `drift.head` via closure once at the top of `runOneAdoption`.
//          When reused for a sub-Proposal's adoption, those values were
//          still the *original* user-drift Proposal's, not the sub-
//          Proposal's. Engine commits stamped during sub-adoption (via
//          realApplyPatch → applyPatchToCandidate) thus carried wrong
//          `Dome-Base` / `Dome-Source-Head` trailers.
//
//   Bug 2: `buildSqliteSinks({ adoptedCommit: drift.head })` similarly
//          captured the original drift.head at the top. Diagnostics /
//          facts / questions emitted during sub-adoption were stamped
//          with that stale value in the projection rows'
//          `adopted_commit` column instead of the sub-Proposal's head.
//
// The fix (commit 2307ab8) extracted `sinksFor(frame)` so each
// adoption gets fresh frame-scoped closures + sinks. This scenario
// verifies the fix by exercising the cascade end-to-end and checking
// the trailer values + projection-row adopted_commit values.
//
// Cascade construction:
//   1. Test fixture bundle `test.garden-patch-emitter` emits a
//      PatchEffect creating `wiki/garden-emitted.md` when
//      `wiki/seed.md` is created.
//   2. The garden-emitted file has unsorted frontmatter (triggers
//      `dome.markdown.normalize-frontmatter` to emit a patch.auto
//      during the sub-Proposal's adoption — that patch goes through
//      `realApplyPatch`, exercising bug 1).
//   3. The garden-emitted file has a broken `[[unresolvable-target]]`
//      wikilink (triggers `dome.markdown.validate-wikilinks` to emit
//      a DiagnosticEffect during sub-adoption — that diagnostic lands
//      in projection.db.diagnostics with adopted_commit, exercising
//      bug 2).

import { expect } from "bun:test";
import { join } from "node:path";

import { scenario } from "../../index";

const FIXTURE_BUNDLE_ROOT = join(
  __dirname,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.garden-patch-emitter",
);

scenario(
  {
    name: "garden-cascade: sub-Proposal adoption stamps frame-correct trailers + adopted_commit",
    tags: [
      { kind: "group", group: "garden-cascade" },
      { kind: "effect", effect: "patch" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "garden" },
    ],
    harness: {
      bundles: [
        "dome.markdown",
        { id: "test.garden-patch-emitter", root: FIXTURE_BUNDLE_ROOT },
      ],
    },
  },
  async (h) => {
    // Step 0: init adopted ref. The empty-diff init pass produces no
    // garden work (no signals).
    {
      const seed = await h.tick();
      expect(seed.adopted).toBe(true);
    }

    // Step 1: user commits wiki/seed.md. Intentionally minimal content
    // (no frontmatter, no wikilinks) so the primary adoption converges
    // WITHOUT a closure commit. This makes the adoptedRef after primary
    // adoption == the user's commit SHA — exactly what sub-Proposal.base
    // should be after the fix. With the bug, drift.base = the previous
    // adopted ref (= the initial harness commit), and the closure
    // commit's Dome-Base would be wrong.
    const userCommitSha = await h.userCommit({
      files: { "wiki/seed.md": "# Seed\n\nNothing here.\n" },
      message: "seed for garden cascade",
    });

    // Step 2: tick — drives primary adoption + garden + sub-Proposal
    // adoption all synchronously.
    const result = await h.tick();
    expect(result.adopted).toBe(true);
    expect(result.hadDrift).toBe(true);

    // Step 3: the current adopted ref has advanced past the user's
    // commit. This must be true if the cascade fired: the sub-Proposal's
    // adoption produced a closure commit (because
    // dome.markdown.normalize-frontmatter emitted a patch.auto).
    const refs = await h.refs.current();
    expect(refs.head).not.toBe(userCommitSha);
    expect(refs.adopted).toBe(refs.head);

    // Step 4: the closure commit at `refs.head` carries the four
    // canonical trailers (existing test guarantee, kept as a regression
    // sentinel).
    await h
      .expectCommit(refs.head)
      .toHaveAllTrailers([
        "Dome-Run",
        "Dome-Extension",
        "Dome-Base",
        "Dome-Source-Head",
      ]);

    // Step 5: **bug 1 catch.** The closure commit's `Dome-Base` trailer
    // must equal the SUB-PROPOSAL's base — which is `userCommitSha`
    // (the adopted ref after primary adoption). With the pre-fix bug,
    // it would equal `drift.base` (= the harness's initial commit
    // SHA, NOT userCommitSha). The strong positive assertion catches
    // the bug class structurally.
    await h
      .expectCommit(refs.head)
      .toHaveTrailerValues({ "Dome-Base": userCommitSha });

    // Step 6: **bug 1 catch (Dome-Source-Head half).** With the bug,
    // the closure commit's `Dome-Source-Head` would equal userCommitSha
    // (drift.head). With the fix, it equals the sub-Proposal's head
    // (a distinct orphan commit). Use `commitsMatching` to read the
    // closure commit's parsed trailers and assert NOT-equal — the
    // bug-distinguishing check, since we don't have the orphan commit's
    // SHA from outside.
    const closureCommits = await h.git.commitsMatching(/^(engine\(|adopt:)/);
    expect(closureCommits.length).toBeGreaterThanOrEqual(1);
    const closure = closureCommits[0]!;
    expect(closure.trailers["Dome-Source-Head"]).toBeDefined();
    expect(closure.trailers["Dome-Source-Head"]).not.toBe(userCommitSha);
  },
);

scenario(
  {
    name: "garden-cascade: sub-Proposal diagnostics carry frame-correct adopted_commit",
    tags: [
      { kind: "group", group: "garden-cascade" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "garden" },
    ],
    harness: {
      bundles: [
        "dome.markdown",
        { id: "test.garden-patch-emitter", root: FIXTURE_BUNDLE_ROOT },
      ],
    },
  },
  async (h) => {
    // Step 0: init.
    {
      const seed = await h.tick();
      expect(seed.adopted).toBe(true);
    }

    // Step 1: user commits seed file.
    const userCommitSha = await h.userCommit({
      files: { "wiki/seed.md": "# Seed\n\nNothing here.\n" },
      message: "seed for garden cascade (diag)",
    });

    // Step 2: tick drives the cascade.
    const result = await h.tick();
    expect(result.adopted).toBe(true);

    // Step 3: dome.markdown.validate-wikilinks fired during the
    // sub-Proposal's adoption and emitted a diagnostic for the broken
    // wikilink in garden-emitted.md. That diagnostic lands in
    // projection.db.diagnostics. The row count + content check
    // confirms the diagnostic exists.
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(1);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toContainMessage("unresolvable-target");

    // Step 4: **bug 2 catch.** The diagnostic's `adopted_commit` column
    // must NOT equal userCommitSha. With the pre-fix bug, the sinks
    // were built once with `adoptedCommit: drift.head` (= userCommitSha)
    // and reused for the sub-adoption — the diagnostic row would be
    // tagged with userCommitSha. After the fix, sinks are built per-
    // Proposal with `adoptedCommit: subProposal.head` (= the orphan
    // garden-emitted commit, NOT userCommitSha).
    //
    // The strongest positive assertion would be `adopted_commit ==
    // garden-emitted-orphan-commit SHA`, but we don't have that SHA
    // directly. The bug-distinguishing assertion `!= userCommitSha`
    // is sufficient: the pre-fix bug always produced userCommitSha
    // here; the post-fix code never does.
    const rows = h.projection.raw
      .query<{ adopted_commit: string }, []>(
        "SELECT adopted_commit FROM diagnostics WHERE code = 'dome.markdown.broken-wikilink'",
      )
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0]?.adopted_commit).not.toBe(userCommitSha);
  },
);
