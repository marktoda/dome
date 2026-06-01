// scenarios/effect-kinds/lint-frontmatter-diagnostics.scenario.test.ts
//
// dome.markdown.lint-frontmatter (Phase 13a) emits one diagnostic per
// frontmatter defect across the changed markdown files. This scenario
// covers four of the five lint codes (missing-frontmatter, missing-type,
// invalid-date, tags-not-list) — malformed-yaml is harder to surface in
// a Bun integration without an explicit invalid-YAML fixture, and is
// covered by the per-processor unit tests.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "effect-kinds: lint-frontmatter emits one diagnostic per defect across changed markdown",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "adoption" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: { bundles: ["dome.markdown"] },
  },
  async (h) => {
    // Step 0: init adopted ref.
    {
      const seed = await h.tick();
      expect(seed.adopted).toBe(true);
    }

    // Step 1: commit three markdown files exercising three lint codes:
    //   - missing-type:   frontmatter present but no `type:` key.
    //   - invalid-date:   `updated:` set to a non-date string.
    //   - missing-fm:     no frontmatter block at all.
    await h.userCommit({
      files: {
        "wiki/missing-type.md":
          "---\nid: foo\ntags: [a, b]\n---\n# missing type\n",
        "wiki/bad-date.md":
          "---\ntype: note\nupdated: \"not a date\"\n---\n# bad date\n",
        "wiki/no-fm.md": "# no frontmatter at all\n",
      },
      message: "frontmatter defects",
    });

    // Step 2: adopt — lint-frontmatter fires; broker records the
    // diagnostics into projection.diagnostics. (normalize-frontmatter
    // also fires on these files; its `null` return for malformed/empty
    // frontmatter means no patch is emitted, so no closure commit.)
    const result = await h.tick();
    expect(result.adopted).toBe(true);

    // Step 3: exactly three diagnostics (one per defect), with the
    // correct codes.
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.missing-type" })
      .toHaveCount(1);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.invalid-date" })
      .toHaveCount(1);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.missing-frontmatter" })
      .toHaveCount(1);

    // Step 4: the ledger records a succeeded run for lint-frontmatter.
    await h
      .expectLedger({ processorId: "dome.markdown.lint-frontmatter" })
      .toAllHaveStatus("succeeded");
  },
);

scenario(
  {
    name: "effect-kinds: lint-frontmatter respects managed and user-owned markdown roots",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "adoption" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: { bundles: ["dome.markdown"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/no-frontmatter.md": "# Managed page\n",
        "wiki/sources/internal-scan.md":
          "---\n" +
          "type: source\n" +
          "---\n" +
          "# Internal scan\n\n" +
          "This source is internal and has no URL.\n",
        "notes/legacy-note.md": "# Legacy note\n",
        "raw/legacy-source.md": "# Legacy raw source\n",
        "inbox/raw/capture.md": "# Unstructured capture\n",
        "templates/Meeting.md": "# Template\n",
        "slides/workshop.md": "# Workshop\n",
        "notes/bad-tags.md":
          "---\n" +
          "tags: management\n" +
          "---\n" +
          "# Optional frontmatter with malformed tags\n",
      },
      message: "add mixed markdown roots",
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.missing-frontmatter" })
      .toHaveCount(1);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.tags-not-list" })
      .toHaveCount(1);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.missing-type" })
      .toHaveCount(0);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.missing-required-field" })
      .toHaveCount(0);
  },
);
