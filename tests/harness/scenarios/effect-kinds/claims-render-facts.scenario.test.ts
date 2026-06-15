// scenarios/effect-kinds/claims-render-facts.scenario.test.ts
//
// dome.claims.render-facts is a garden patch.auto processor: a claim-rich page
// (>= current_facts_min_claims, default 3) gets a deterministic
// `## Current facts` generated block spliced in after frontmatter + first H1.
// The block is the registration's payoff — it only lands once the processor is
// wired into the manifest with its patch.auto grant (the broker fence). A
// second tick with no intervening commit reaches a fixed point with no drift:
// the rendered digest is a pure function of the adopted claims, so re-running
// produces zero further effects (idempotent).

import { expect } from "bun:test";

import { scenario } from "../../index";

// dome.claims.render-facts default min-claims threshold.
const CONFIG = `
extensions:
  dome.claims:
    enabled: true
    grant:
      read: ["wiki/**/*.md", "notes/*.md"]
      patch.auto: ["wiki/**/*.md", "notes/*.md"]
      graph.write: ["dome.claims.*"]
`;

const START = "<!-- dome.claims:current-facts:start -->";
const END = "<!-- dome.claims:current-facts:end -->";

scenario(
  {
    name: "effect-kinds: dome.claims.render-facts splices a Current facts block into a claim-rich page and is idempotent",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "patch" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: ["dome.claims"],
      initialFiles: {
        ".dome/config.yaml": CONFIG,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const path = "wiki/entities/atlas.md";

    // Beat 1: commit a claim-rich page — three bold-key claim lines, each with
    // an inline `*(as of …)*` marker. The stamper assigns anchors; render-facts
    // compiles the digest. Count (3) is at the default threshold.
    await h.userCommit({
      files: {
        [path]: [
          "---",
          "type: entity",
          "title: Atlas",
          "---",
          "",
          "# Atlas",
          "",
          "**Status:** Active *(as of 2026-06-12)*",
          "**Owner:** [[Mark]]",
          "**Stage:** Build",
          "",
          "Some prose about Atlas.",
          "",
        ].join("\n"),
      },
      message: "add atlas entity with three claims",
    });
    const created = await h.tick();
    expect(created.adopted).toBe(true);
    expect(created.hadDrift).toBe(true);

    // The generated block landed, after the frontmatter + H1, listing all three
    // facts. The block uses bold-key-WITHOUT-colon grammar, so it is never
    // re-indexed as claims.
    await h.expectFile(path).toContain(START);
    await h.expectFile(path).toContain(END);
    await h.expectFile(path).toContain("## Current facts");
    await h.expectFile(path).toContain("- **Status** — Active");
    await h.expectFile(path).toContain("- **Owner** — [[Mark]]");
    await h.expectFile(path).toContain("- **Stage** — Build");
    // The inline as-of marker renders exactly once (no doubling).
    await h.expectFile(path).toContain("*(as of 2026-06-12)*");
    // Frontmatter + H1 + original prose preserved.
    await h.expectFile(path).toContain("# Atlas");
    await h.expectFile(path).toContain("Some prose about Atlas.");
    // The digest is spliced AFTER the H1 and BEFORE the original prose.
    await h.expectFile(path).toMatch(/# Atlas[\s\S]*?<!-- dome\.claims:current-facts:start -->[\s\S]*?<!-- dome\.claims:current-facts:end -->[\s\S]*?Some prose about Atlas\./);
    // Capture the adopted commit so we can prove byte-stability across the
    // idempotent re-run.
    const adoptedAfterCreate = (await h.refs.current()).adopted;
    if (adoptedAfterCreate === null) {
      throw new Error("expected an adopted ref after the create tick");
    }

    // Beat 2: tick again with NO new commit. The garden processor re-runs on
    // the latest adopted ref, recomputes the same digest, finds it already
    // present — desired state matches — and the loop reaches a fixed point with
    // no engine write. No drift, no new closure commit (idempotent).
    const reTick = await h.tick();
    expect(reTick.hadDrift).toBe(false);
    expect(reTick.closureCommitOid).toBeNull();

    // The adopted ref did not move: the file is byte-identical to beat 1.
    expect((await h.refs.current()).adopted).toBe(adoptedAfterCreate);
    // And the block is still singular at that unchanged ref (no duplication).
    await h.expectFile(path, { atCommit: adoptedAfterCreate }).toContain(START);
    await h.expectFile(path, { atCommit: adoptedAfterCreate }).toContain(END);

    await h
      .expectLedger({ processorId: "dome.claims.render-facts" })
      .toAllHaveStatus("succeeded");
  },
);
