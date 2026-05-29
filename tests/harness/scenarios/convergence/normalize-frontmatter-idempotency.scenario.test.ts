// scenarios/convergence/normalize-frontmatter-idempotency.scenario.test.ts
//
// The fixed-point adoption loop: when a patch-emitting processor applies
// a closure commit, the engine re-runs the processor against the new
// candidate to verify convergence. normalize-frontmatter is the canonical
// idempotent processor — re-running it on its own output produces zero
// effects.
//
// Asserts: the tick that ran the normalizer reports `iterations >= 2`
// (iteration 1 emitted the patch; iteration 2 saw no effects and stopped),
// and a separate follow-up tick is in-sync (drift detector says no work).

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "convergence: normalize-frontmatter converges in <=2 iterations",
    tags: [
      { kind: "group", group: "convergence" },
      { kind: "effect", effect: "patch" },
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

    // Step 1: commit a file whose frontmatter normalize-frontmatter will rewrite.
    await h.userCommit({
      files: {
        "wiki/note.md":
          "---\nupdated: 2026-05-28\nid: note\ncreated: 2026-05-27\ntype: page\n---\n# body\n",
      },
      message: "messy frontmatter",
    });

    // Step 2: the adoption loop runs at least two iterations before
    // converging — iteration 1 produces the patch, iteration 2 sees no
    // further effects and exits.
    const tick1 = await h.tick();
    expect(tick1.adopted).toBe(true);
    expect(tick1.iterations).toBeGreaterThanOrEqual(2);

    // Step 3: a follow-up tick is an in-sync no-op (drift detector
    // returns `in-sync` because adopted now equals HEAD post-closure).
    const tick2 = await h.tick();
    expect(tick2.hadDrift).toBe(false);

    // Step 4: the file is normalized (type before id).
    await h.expectFile("wiki/note.md").toMatch(/type:\s*page[\s\S]*id:\s*note/);
    await h.expectFile("wiki/note.md").toContain("created: 2026-05-27\n");
    await h.expectFile("wiki/note.md").toContain("updated: 2026-05-28\n");
    await h.expectFile("wiki/note.md").toNotContain("T00:00:00.000Z");
  },
);
