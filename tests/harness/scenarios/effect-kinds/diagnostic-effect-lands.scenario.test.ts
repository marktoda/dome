// scenarios/effect-kinds/diagnostic-effect-lands.scenario.test.ts
//
// A DiagnosticEffect lands a row in projection.diagnostics. Unlike a
// PatchEffect, a diagnostic does NOT advance refs/heads/<branch> — there
// is no closure commit. The adopted ref still advances (to the user's
// commit) so the drift detector sees `in-sync` on the next tick.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "effect-kinds: DiagnosticEffect lands one row and does not advance the source branch",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "adoption" },
    ],
    harness: { bundles: ["dome.markdown"] },
  },
  async (h) => {
    // Step 0: init adopted ref.
    {
      const seed = await h.tick();
      expect(seed.adopted).toBe(true);
    }

    // Step 1: commit a markdown file with one broken wikilink. The
    // normalize-frontmatter processor will see no frontmatter and skip;
    // validate-wikilinks will emit one diagnostic.
    const userHead = await h.userCommit({
      files: {
        "wiki/p.md": "# page\n\nsee [[nonexistent-page]]\n",
      },
      message: "broken link",
    });

    // Step 2: adopt.
    const result = await h.tick();
    expect(result.adopted).toBe(true);

    // Step 3: exactly one diagnostic row with the expected code, and the
    // message contains the broken target.
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(1);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toContainMessage("nonexistent-page");

    // Step 4: the ledger has a succeeded run for validate-wikilinks.
    await h
      .expectLedger({ processorId: "dome.markdown.validate-wikilinks" })
      .toAllHaveStatus("succeeded");

    // Step 5: NO closure commit on the source branch — validate-wikilinks
    // emits diagnostics only.
    const closureCommits = await h.git.commitsMatching(/^(engine\(|adopt:)/);
    expect(closureCommits.length).toBe(0);

    // refs/heads/main is still at the user's commit, and the adopted ref
    // is now at the same commit (init-style advance).
    await h.expectRef("refs/heads/main").toEqual(userHead);
    await h.expectRef("refs/dome/adopted/main").toEqual(userHead);
  },
);
