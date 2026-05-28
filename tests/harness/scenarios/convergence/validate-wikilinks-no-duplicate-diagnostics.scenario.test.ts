// scenarios/convergence/validate-wikilinks-no-duplicate-diagnostics.scenario.test.ts
//
// Diagnostic dedup: re-running the same processor against the same content
// (same source_refs) must not insert a duplicate row. The diagnostics
// table's `UNIQUE (processor_id, code, proposal_id, subject_hash)`
// constraint enforces this at the SQL boundary; this scenario verifies the
// behavior end-to-end.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "convergence: re-running validate-wikilinks does not duplicate diagnostics",
    tags: [
      { kind: "group", group: "convergence" },
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

    // Step 1: commit a markdown file with one broken wikilink.
    await h.userCommit({
      files: {
        "wiki/page.md": "# page\n\nrefers to [[nonexistent-target]]\n",
      },
      message: "add page with broken link",
    });

    // Step 2: first tick — the diagnostic lands.
    const tick1 = await h.tick();
    expect(tick1.adopted).toBe(true);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(1);

    // Step 3: second tick — drift detector says in-sync (no new commits
    // to process), but even if we forced a re-run the dedup constraint
    // would prevent a duplicate row.
    const tick2 = await h.tick();
    expect(tick2.hadDrift).toBe(false);

    // Step 4: still exactly one diagnostic row for the broken link.
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(1);
  },
);
