// scenarios/triggers/file-created-fires.scenario.test.ts
//
// The `file.created` signal fires for newly-added paths. validate-wikilinks
// is subscribed to both `file.created` and `document.changed`; adding a
// new .md file produces both signals, but the processor's single run per
// dispatch dedups internally — exactly one ledger row, exactly one
// diagnostic for the broken link.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "triggers: file.created on a new .md fires validate-wikilinks",
    tags: [
      { kind: "group", group: "triggers" },
      { kind: "trigger", trigger: "signal" },
      { kind: "effect", effect: "diagnostic" },
    ],
    harness: { bundles: ["dome.markdown"] },
  },
  async (h) => {
    // Step 0: init adopted ref against the seed commit.
    {
      const seed = await h.tick();
      expect(seed.adopted).toBe(true);
    }

    // Step 1: add a NEW markdown file with a broken wikilink. compileRange
    // emits `file.created` + `document.changed` for this path.
    await h.userCommit({
      files: { "wiki/new.md": "# new\n\n[[unknown-target]]\n" },
      message: "new file with broken link",
    });

    // Step 2: adopt.
    const result = await h.tick();
    expect(result.adopted).toBe(true);

    // Step 3: validate-wikilinks ran successfully.
    await h
      .expectLedger({ processorId: "dome.markdown.validate-wikilinks" })
      .toAllHaveStatus("succeeded");

    // Step 4: one diagnostic landed for the broken link.
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(1);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toContainMessage("unknown-target");
  },
);
