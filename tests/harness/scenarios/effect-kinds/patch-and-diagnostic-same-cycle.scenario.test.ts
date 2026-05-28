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

    // Step 4: at least one diagnostic row from validate-wikilinks.
    //
    // Note: the adoption loop iterates twice in this scenario — once with
    // the user's commit as the candidate (validate-wikilinks emits a
    // diagnostic anchored to that commit), then again with the closure
    // commit as the new candidate after normalize-frontmatter's patch
    // landed (validate-wikilinks runs again and emits a second diagnostic
    // anchored to the closure commit). The diagnostic-dedup constraint
    // (UNIQUE on processor_id, code, proposal_id, source_refs_hash)
    // distinguishes the two because the source ref's `commit` field
    // differs between iterations — so two rows land, not one. The
    // single-broken-link case in B2 produces exactly one row because
    // there's no patch to extend the loop.
    const diagRows = h.projection.raw
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM diagnostics WHERE code = 'dome.markdown.broken-wikilink'",
      )
      .all();
    expect(diagRows[0]?.n).toBeGreaterThanOrEqual(1);

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
