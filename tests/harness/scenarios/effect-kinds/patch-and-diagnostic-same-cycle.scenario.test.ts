// scenarios/effect-kinds/patch-and-diagnostic-same-cycle.scenario.test.ts
//
// One file with BOTH messy frontmatter and a broken wikilink. Two
// processors (normalize-frontmatter, validate-wikilinks) fire in the
// same cycle; one emits a patch, the other emits a diagnostic. The
// closure commit lands; the diagnostic also lands; and crucially the
// broken wikilink is preserved through the patch (validate-wikilinks
// diagnoses but does not fix).

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "effect-kinds: patch + diagnostic from the same file in one adoption cycle",
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

    // Step 1: one file carrying BOTH issues.
    await h.userCommit({
      files: {
        "wiki/mixed.md":
          "---\nid: mixed\ntype: page\n---\n# body\n\nrefers to [[nonexistent-target]]\n",
      },
      message: "messy + broken link",
    });

    // Step 2: adopt.
    const result = await h.tick();
    expect(result.adopted).toBe(true);

    // Step 3: closure commit landed (the patch from normalize-frontmatter).
    const closureCommits = await h.git.commitsMatching(/^(engine\(|adopt:)/);
    expect(closureCommits.length).toBe(1);
    await h.expectRef("refs/heads/main").toHaveAdvanced();

    // Step 4: exactly one diagnostic row from validate-wikilinks.
    //
    // The adoption loop iterates twice here — once with the user's commit
    // as the candidate (validate-wikilinks emits a diagnostic), then
    // again with the closure commit as the new candidate after
    // normalize-frontmatter's patch landed (validate-wikilinks re-emits
    // an equivalent diagnostic anchored to the new candidate).
    //
    // After H3, the diagnostic-dedup constraint (UNIQUE on processor_id,
    // code, proposal_id, subject_hash) collapses cross-iteration
    // re-emissions: subject_hash projects each SourceRef to
    // {path, range, stableId} — dropping `commit` and `blob` — so the
    // two emissions hash identically and the second is a silent no-op
    // via INSERT OR IGNORE. Exactly one row lands.
    //
    // Pre-H3 (when subject_hash hashed the full SourceRef including
    // commit), this assertion was relaxed to `>= 1` because the source
    // ref's `commit` field varied per iteration and two rows landed.
    const diagRows = h.projection.raw
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM diagnostics WHERE code = 'dome.markdown.broken-wikilink'",
      )
      .all();
    expect(diagRows[0]?.n).toBe(1);

    // Step 5: both processors have succeeded ledger rows.
    await h
      .expectLedger({ processorId: "dome.markdown.normalize-frontmatter" })
      .toAllHaveStatus("succeeded");
    await h
      .expectLedger({ processorId: "dome.markdown.validate-wikilinks" })
      .toAllHaveStatus("succeeded");

    // Step 6: the file at HEAD has canonical frontmatter (type before id)
    // AND the broken wikilink is preserved verbatim.
    await h
      .expectFile("wiki/mixed.md")
      .toMatch(/type:\s*page[\s\S]*id:\s*mixed/);
    await h.expectFile("wiki/mixed.md").toContain("[[nonexistent-target]]");
  },
);
