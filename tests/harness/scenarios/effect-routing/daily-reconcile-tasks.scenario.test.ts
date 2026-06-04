// scenarios/effect-routing/daily-reconcile-tasks.scenario.test.ts
//
// dome.daily.reconcile-tasks propagates a settled (resolved/dismissed) state
// from a daily note's generated source-backed open-loop copy BACK to the origin
// task line in its source file — "close it in one place, close it everywhere."

import { expect } from "bun:test";

import { scenario, TestClock } from "../../index";

scenario(
  {
    name: "effect-routing: dome.daily.reconcile-tasks closes the origin task when its daily copy is resolved",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "patch" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "signal" },
      { kind: "route", route: "garden-signal" },
    ],
    harness: {
      clock: new TestClock("2026-01-02T15:00:00.000Z"),
      bundles: ["dome.daily"],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  dome.daily:
    enabled: true
    grant:
      read: ["wiki/**/*.md"]
      patch.auto: ["wiki/**/*.md"]
      graph.write: ["dome.daily.*"]
      question.ask: true
`,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/projects/conv.md": [
          "# Conv",
          "",
          "- [ ] ship it #task",
          "",
        ].join("\n"),
        "wiki/dailies/2026-01-02.md": [
          "# 2026-01-02",
          "",
          "## Open Loops",
          "",
          "<!-- dome.daily:open-loops:start -->",
          "### Resolved Today",
          "- [x] ship it (from [[wiki/projects/conv]])",
          "<!-- dome.daily:open-loops:end -->",
          "",
          "## Notes",
          "",
        ].join("\n"),
      },
      message: "settle a source-backed open loop in the daily",
    });

    const reconciled = await h.tick();
    expect(reconciled.adopted).toBe(true);

    const adopted = await h.refs.adopted();
    expect(adopted).not.toBeNull();
    if (adopted === null) return;

    await h
      .expectFile("wiki/projects/conv.md", { atCommit: adopted })
      .toContain("- [x] ship it");
    await h
      .expectFile("wiki/projects/conv.md", { atCommit: adopted })
      .toNotContain("- [ ] ship it");

    // The daily's own generated copy is left untouched.
    await h
      .expectFile("wiki/dailies/2026-01-02.md", { atCommit: adopted })
      .toContain("- [x] ship it (from [[wiki/projects/conv]])");

    // Idempotent: a re-tick over the settled state changes nothing.
    const stable = await h.tick();
    expect(stable.adopted).toBe(true);
    const stableAdopted = await h.refs.adopted();
    expect(stableAdopted).not.toBeNull();
    if (stableAdopted === null) return;
    await h
      .expectFile("wiki/projects/conv.md", { atCommit: stableAdopted })
      .toContain("- [x] ship it");
  },
);

scenario(
  {
    name: "effect-routing: dome.daily.reconcile-tasks dismisses the origin task when its daily copy is dismissed",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "patch" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "signal" },
      { kind: "route", route: "garden-signal" },
    ],
    harness: {
      clock: new TestClock("2026-01-02T15:00:00.000Z"),
      bundles: ["dome.daily"],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  dome.daily:
    enabled: true
    grant:
      read: ["wiki/**/*.md"]
      patch.auto: ["wiki/**/*.md"]
      graph.write: ["dome.daily.*"]
      question.ask: true
`,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/projects/conv.md": [
          "# Conv",
          "",
          "- [ ] archive the thread #task",
          "",
        ].join("\n"),
        "wiki/dailies/2026-01-02.md": [
          "# 2026-01-02",
          "",
          "## Open Loops",
          "",
          "<!-- dome.daily:open-loops:start -->",
          "### Dismissed Today",
          "- [-] archive the thread (from [[wiki/projects/conv]])",
          "<!-- dome.daily:open-loops:end -->",
          "",
          "## Notes",
          "",
        ].join("\n"),
      },
      message: "dismiss a source-backed open loop in the daily",
    });

    const reconciled = await h.tick();
    expect(reconciled.adopted).toBe(true);

    const adopted = await h.refs.adopted();
    expect(adopted).not.toBeNull();
    if (adopted === null) return;

    await h
      .expectFile("wiki/projects/conv.md", { atCommit: adopted })
      .toContain("- [-] archive the thread");
    await h
      .expectFile("wiki/projects/conv.md", { atCommit: adopted })
      .toNotContain("- [ ] archive the thread");
  },
);
