// scenarios/effect-kinds/duplicate-detection-questions.scenario.test.ts
//
// dome.markdown.duplicate-detection is the first shipped QuestionEffect
// processor. This scenario pins the high-level contract: duplicate-looking
// pages ask a durable, non-blocking question and adoption still succeeds.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "effect-kinds: dome.markdown.duplicate-detection asks about suspected duplicates",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "question" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "question.ask" },
      { kind: "capability", capability: "read" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: { bundles: ["dome.markdown"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const duplicateBody =
      "# Platform ownership\n\n" +
      "We decided that the platform team owns shared deployment tooling and release reliability.\n";

    await h.userCommit({
      files: {
        "wiki/platform-ownership.md": `---\ntype: note\n---\n${duplicateBody}`,
        "wiki/platform-ownership-copy.md": `---\ntype: note\n---\n${duplicateBody}`,
      },
      message: "add suspected duplicate pages",
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h.expectProjection().questions().toHaveCount(1);
    await h
      .expectProjection()
      .questions()
      .toContainQuestion("wiki/platform-ownership.md");
    await h
      .expectProjection()
      .questions()
      .toContainQuestion("wiki/platform-ownership-copy.md");

    await h
      .expectLedger({ processorId: "dome.markdown.duplicate-detection" })
      .toAllHaveStatus("succeeded");

    await h.userCommit({
      files: {
        "wiki/unrelated.md":
          "---\ntype: note\n---\n" +
          "# Release checklist\n\n" +
          "The release checklist is about package validation and operator handoff.\n",
      },
      message: "add unrelated page",
    });

    const unrelated = await h.tick();
    expect(unrelated.adopted).toBe(true);
    await h.expectProjection().questions().toHaveCount(1);
  },
);
