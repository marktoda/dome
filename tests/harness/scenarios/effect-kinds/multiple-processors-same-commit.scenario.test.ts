// scenarios/effect-kinds/multiple-processors-same-commit.scenario.test.ts
//
// A single commit touches a file that BOTH dome.markdown processors care
// about: messy frontmatter (normalize-frontmatter rewrites) and a broken
// wikilink (validate-wikilinks diagnoses). Both processors fire from the
// same trigger dispatch; both effects land in their respective surfaces;
// the patch loop iterates so both processors run against the closure
// candidate too.
//
// Pinned behaviors:
//   - Both processors have at least one succeeded ledger row.
//   - normalize-frontmatter has exactly one contributing run (output_commit
//     populated to HEAD).
//   - validate-wikilinks's diagnostic lands exactly once (the subject_hash
//     dedup collapses the cross-iteration re-emission).
//   - The closure commit is reachable via `TickResult.closureCommitOid`
//     (no git-history scan needed).
//   - The file at HEAD has both behaviors visible: canonical key order AND
//     the broken wikilink preserved verbatim.
//
// This scenario catches "regression where ordering changes" (one processor
// silently loses effects to another's tree mutation) and validates that
// the multi-processor closure-commit accumulator works as specified.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "effect-kinds: two processors on the same commit both contribute, neither loses effects",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "patch" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "adoption" },
    ],
    harness: { bundles: ["dome.markdown"] },
  },
  async (h) => {
    // Step 0: init.
    {
      const seed = await h.tick();
      expect(seed.adopted).toBe(true);
    }

    // Step 1: a single commit touching one file that exercises BOTH
    // processors. Messy frontmatter (id-before-type) + a broken wikilink.
    await h.userCommit({
      files: {
        "wiki/both.md":
          "---\nid: both\ntype: page\n---\n# both\n\nlinks to [[no-such-target]]\n",
      },
      message: "messy frontmatter + broken wikilink",
    });

    // Step 2: adopt. The TickResult surfaces the closure commit OID; no
    // git-history scan needed to find it.
    const result = await h.tick();
    expect(result.adopted).toBe(true);
    expect(result.hadDrift).toBe(true);
    expect(result.closureCommitOid).not.toBeNull();
    // The patch loop runs at least twice: iteration 1 emits the patch +
    // diagnostic; iteration 2 re-runs against the closure candidate (no
    // new effects) and converges.
    expect(result.iterations).toBeGreaterThanOrEqual(2);

    // Step 3: HEAD is the closure commit (both refs advanced).
    const refs = await h.refs.current();
    if (result.closureCommitOid === null) throw new Error("expected non-null closureCommitOid");
    expect(refs.head).toBe(result.closureCommitOid);
    await h.expectRef("refs/heads/main").toHaveAdvanced();
    await h.expectRef("refs/dome/adopted/main").toEqualHead();

    // Step 4: both processors have succeeded ledger rows.
    await h
      .expectLedger({ processorId: "dome.markdown.normalize-frontmatter" })
      .toAllHaveStatus("succeeded");
    await h
      .expectLedger({ processorId: "dome.markdown.validate-wikilinks" })
      .toAllHaveStatus("succeeded");

    // Step 5: normalize-frontmatter has exactly one contributing run
    // (output_commit equal to HEAD); validate-wikilinks has zero
    // contributing runs (diagnostic-only processor).
    const contributing = await h
      .expectLedger({
        processorId: "dome.markdown.normalize-frontmatter",
        withOutputCommit: true,
      })
      .toHaveExactlyOne();
    expect(contributing.outputCommit).toBe(refs.head);

    await h
      .expectLedger({
        processorId: "dome.markdown.validate-wikilinks",
        withOutputCommit: true,
      })
      .toHaveCount(0);

    // Step 6: exactly one diagnostic landed for the broken wikilink (the
    // subject_hash dedup collapses the cross-iteration re-emission).
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(1);

    // Step 7: HEAD's content shows both behaviors visible:
    //   - canonical key order (type before id)
    //   - the broken wikilink preserved verbatim (validate-wikilinks
    //     diagnoses, doesn't fix)
    await h.expectFile("wiki/both.md").toMatch(/type:\s*page[\s\S]*id:\s*both/);
    await h.expectFile("wiki/both.md").toContain("[[no-such-target]]");
  },
);
