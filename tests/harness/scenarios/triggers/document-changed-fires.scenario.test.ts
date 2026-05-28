// scenarios/triggers/document-changed-fires.scenario.test.ts
//
// The `document.changed` signal fires for modified .md files (vs.
// `file.created` for added paths). Pre-seed a file in the initial commit,
// then edit it via userCommit: compileRange emits `file.modified` +
// `document.changed`, validate-wikilinks runs against the new content.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "triggers: document.changed on a modified .md fires validate-wikilinks",
    tags: [
      { kind: "group", group: "triggers" },
      { kind: "trigger", trigger: "signal" },
      { kind: "effect", effect: "diagnostic" },
    ],
    harness: {
      bundles: ["dome.markdown"],
      // Seed file has no broken links — the diagnostic must come from
      // the second commit, proving the trigger fired on the edit.
      initialFiles: { "wiki/seeded.md": "# seeded\n\nclean content\n" },
    },
  },
  async (h) => {
    // Step 0: init the adopted ref against the seed (which already
    // contains wiki/seeded.md).
    {
      const seed = await h.tick();
      expect(seed.adopted).toBe(true);
    }

    // The seed commit was processed during init; no diagnostics yet.
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(0);

    // Step 1: MODIFY the existing file by introducing a broken link.
    // compileRange emits `file.modified` + `document.changed`.
    const secondCommit = await h.userCommit({
      files: { "wiki/seeded.md": "# seeded\n\nnow [[broken]]\n" },
      message: "edit seeded file",
    });

    // Step 2: adopt.
    const result = await h.tick();
    expect(result.adopted).toBe(true);

    // Step 3: validate-wikilinks ran with input_commit equal to the
    // second commit (the edit), proving document.changed fired against
    // the new content.
    const row = await h
      .expectLedger({ processorId: "dome.markdown.validate-wikilinks" })
      .toHaveAtLeastOne();
    expect(row.inputCommit).toBe(secondCommit);
    expect(row.status).toBe("succeeded");

    // Step 4: one diagnostic for the broken link.
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(1);
  },
);
