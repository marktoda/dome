// scenarios/convergence/diagnostics-auto-resolve.scenario.test.ts
//
// Phase 14: when a processor re-checks a changed path and no longer emits a
// prior diagnostic for that path, the projection row is marked resolved and
// disappears from current diagnostic views.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "convergence: diagnostics auto-resolve after the changed file is fixed",
    tags: [
      { kind: "group", group: "convergence" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: { bundles: ["dome.markdown"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/ref.md":
          "---\n" +
          "type: note\n" +
          "updated: 2026-05-28\n" +
          "---\n" +
          "# Ref\n\n" +
          "See [[missing-target]].\n",
      },
      message: "add broken wikilink",
    });

    const broken = await h.tick();
    expect(broken.adopted).toBe(true);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(1);

    await h.userCommit({
      files: {
        "wiki/ref.md":
          "---\n" +
          "type: note\n" +
          "updated: 2026-05-28\n" +
          "---\n" +
          "# Ref\n\n" +
          "No broken links remain.\n",
      },
      message: "fix broken wikilink",
    });

    const fixed = await h.tick();
    expect(fixed.adopted).toBe(true);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(0);
    const resolvedRows = h.projection.raw
      .query<{ resolved_at: string | null }, []>(
        "SELECT resolved_at FROM diagnostics WHERE code = 'dome.markdown.broken-wikilink'",
    )
      .all();
    expect(resolvedRows.length).toBe(1);
    expect(typeof resolvedRows[0]?.resolved_at).toBe("string");
  },
);
