// tests/harness/scenarios/phase-12c-regression.scenario.test.ts —
// the first real scenario. Locks in the Phase 12c fix and validates the
// harness end-to-end.
//
// Pre-fix: when a closure commit landed (the engine's accumulated patches
// advanced the candidate beyond P.head), the engine wrote the new commit
// to `refs/dome/adopted/<branch>` but left `refs/heads/<branch>` pointing
// at the user's pre-closure commit. The closure commit floated as an
// unreachable object on `main`, and the NEXT tick saw drift in the wrong
// direction — entering a hard error loop because `setAdoptedRef`'s
// fast-forward check refused to advance to a sibling.
//
// Fix (Phase 12c, in `src/engine/adopt.ts`): advance `refs/heads/<branch>`
// to the closure commit BEFORE advancing the adopted ref. Both refs land
// at the same closure commit; the next tick is a no-op.
//
// This scenario reproduces the failure mode by committing a file with
// non-canonical YAML frontmatter that `dome.markdown.normalize-frontmatter`
// rewrites. The closure commit lands, both refs advance, the trailers
// are present, the projection ledger has a succeeded run, and a second
// tick is in-sync.

import { expect } from "bun:test";

import { scenario } from "../index";

scenario(
  {
    name: "Phase 12c regression: closure commit advances both refs",
    tags: [
      { kind: "group", group: "regression" },
      { kind: "effect", effect: "patch" },
      { kind: "phase", phase: "adoption" },
      { kind: "trigger", trigger: "signal" },
      { kind: "capability", capability: "patch.auto" },
    ],
    harness: { bundles: ["dome.markdown"] },
  },
  async (h) => {
    // Step 0: initialize the adopted ref against the harness's seed
    // commit via an empty-diff init tick. Without this, the first
    // adoption cycle after the user's commit would still be the
    // empty-diff init (adopted is null), and the normalize-frontmatter
    // processor would not fire — no `compileRange` signals to subscribe
    // to.
    {
      const seed = await h.tick();
      expect(seed.adopted).toBe(true);
    }

    // Step 1: user commits a file with non-canonical frontmatter key
    // order. `dome.markdown.normalize-frontmatter` will rewrite this
    // into `type / id / aliases / ...` order.
    await h.userCommit({
      files: {
        "wiki/foo.md":
          "---\nid: foo\naliases: []\ntype: test\n---\n# body\n",
      },
      message: "messy frontmatter",
    });

    // Step 2: daemon runs adoption. The processor emits a PatchEffect,
    // applyPatch lands a closure commit, both refs advance.
    const result = await h.tick();
    expect(result.adopted).toBe(true);
    expect(result.hadDrift).toBe(true);

    // Step 3 (the load-bearing assertions): both refs advanced. Pre-fix,
    // refs/heads/main would still be at the user's pre-closure commit.
    await h.expectRef("refs/heads/main").toHaveAdvanced();
    await h.expectRef("refs/dome/adopted/main").toEqualHead();

    // Step 4: the file's frontmatter is now in canonical order. The
    // canonical block puts `type` before `id`; the messy input had `id`
    // first. We check both the new ordering (regex captures the `type:`
    // line appearing before the `id:` line) and the bare presence of
    // each key — robust to gray-matter's exact whitespace.
    await h.expectFile("wiki/foo.md").toContain("type: test");
    await h.expectFile("wiki/foo.md").toContain("id: foo");
    await h
      .expectFile("wiki/foo.md")
      .toMatch(/type:\s*test[\s\S]*id:\s*foo/);

    // Step 5: the closure commit carries the four Dome-* trailers.
    const refs = await h.refs.current();
    await h
      .expectCommit(refs.head)
      .toHaveAllTrailers([
        "Dome-Run",
        "Dome-Extension",
        "Dome-Base",
        "Dome-Source-Head",
      ]);

    // Step 6: the ledger has the expected run for the normalizer.
    await h
      .expectLedger({ processorId: "dome.markdown.normalize-frontmatter" })
      .toAllHaveStatus("succeeded");

    // Step 7: a second tick is a no-op. Pre-fix, this would have either
    // failed the always-true invariant ADOPTED_REF_IS_ANCESTOR_OF_HEAD
    // (closure commit sibling of main) or surfaced a fresh divergence
    // diagnostic. Post-fix, it's `in-sync` and nothing moves.
    const secondTick = await h.tick();
    expect(secondTick.hadDrift).toBe(false);
    await h.expectRef("refs/heads/main").toBeUnchanged();
    await h.expectRef("refs/dome/adopted/main").toBeUnchanged();
  },
);
