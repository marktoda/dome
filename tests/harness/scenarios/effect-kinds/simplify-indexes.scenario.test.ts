import { expect } from "bun:test";

import { scenario, TestClock } from "../../index";

const CLOCK = new TestClock("2026-01-01T05:11:00.000Z");

scenario(
  {
    name: "convergence: dome.markdown.simplify-indexes settles small wiki indexes",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "group", group: "convergence" },
      { kind: "effect", effect: "patch" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "schedule" },
      { kind: "route", route: "garden-schedule" },
    ],
    harness: {
      bundles: ["dome.markdown"],
      clock: CLOCK,
      initialFiles: {
        "wiki/entities/index.md": "# Entities\n\nHuman overview stays here.\n",
        "wiki/entities/ada-lovelace.md":
          "---\nname: Ada Lovelace\n---\n\n# Ada\n",
        "wiki/entities/grace-hopper.md": "# Grace Hopper\n",
      },
    },
  },
  async (h) => {
    const first = await h.tick();
    expect(first.adopted).toBe(true);

    await h.expectFile("wiki/entities/index.md").toContain(
      "<!-- dome:index:start -->",
    );
    await h.expectFile("wiki/entities/index.md").toContain(
      "- [[wiki/entities/ada-lovelace|Ada Lovelace]]",
    );
    await h.expectFile("wiki/entities/index.md").toContain(
      "- [[wiki/entities/grace-hopper|Grace Hopper]]",
    );
    await h.expectFile("wiki/entities/index.md").toContain(
      "Human overview stays here.",
    );
    await h
      .expectLedger({ processorId: "dome.markdown.simplify-indexes" })
      .toHaveExactlyOne();

    const beforeRepeat = await h.refs.current();
    expect(beforeRepeat.adopted).toBe(beforeRepeat.head);

    await h.advance(24 * 60 * 60 * 1000);
    const repeat = await h.tick();
    expect(repeat.hadDrift).toBe(false);
    expect(repeat.adopted).toBe(true);
    expect(repeat.diagnosticCount).toBe(0);

    const afterRepeat = await h.refs.current();
    expect(afterRepeat).toEqual(beforeRepeat);
    await h
      .expectLedger({ processorId: "dome.markdown.simplify-indexes" })
      .toHaveCount(2);
    await h.expectFile("wiki/entities/index.md").toContain(
      "<!-- dome:index:start -->",
    );
  },
);
