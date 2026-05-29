// scenarios/effect-kinds/daily-task-index-facts.scenario.test.ts
//
// dome.daily.task-index projects explicit daily checkbox observations into
// page-scoped facts. The processor intentionally does not assign stable task
// identities yet; this scenario locks the current projection lifecycle:
// re-inspecting a changed/deleted daily replaces stale facts for that page.

import { expect } from "bun:test";

import { scenario } from "../../index";

const CONFIG = `
extensions:
  dome.daily:
    enabled: true
    grant:
      read: ["wiki/dailies/*.md"]
      patch.auto: ["wiki/dailies/*.md"]
      graph.write: ["dome.daily.*"]
`;

scenario(
  {
    name: "effect-kinds: dome.daily.task-index replaces task facts on edit and delete",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "fact" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "graph.write" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: ["dome.daily"],
      initialFiles: {
        ".dome/config.yaml": CONFIG,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/dailies/2026-01-03.md": [
          "---",
          "type: daily",
          "recurrence: 2026-01-03",
          "---",
          "",
          "# 2026-01-03",
          "",
          "- [ ] #followup Send Ada notes",
          "- [ ] Draft launch memo",
          "",
        ].join("\n"),
      },
      message: "add daily tasks",
    });
    const created = await h.tick();
    expect(created.adopted).toBe(true);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: "wiki/dailies/2026-01-03.md",
      })
      .toHaveCount(2);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.followup",
        subjectId: "wiki/dailies/2026-01-03.md",
      })
      .toHaveCount(1);

    await h.userCommit({
      files: {
        "wiki/dailies/2026-01-03.md": [
          "---",
          "type: daily",
          "recurrence: 2026-01-03",
          "---",
          "",
          "# 2026-01-03",
          "",
          "- [x] #followup Send Ada notes",
          "- [ ] Draft launch memo revised",
          "",
        ].join("\n"),
      },
      message: "complete followup task",
    });
    const edited = await h.tick();
    expect(edited.adopted).toBe(true);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: "wiki/dailies/2026-01-03.md",
      })
      .toHaveCount(1);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: "wiki/dailies/2026-01-03.md",
        objectString: "Draft launch memo revised",
      })
      .toHaveCount(1);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: "wiki/dailies/2026-01-03.md",
        objectString: "#followup Send Ada notes",
      })
      .toHaveCount(0);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.followup",
        subjectId: "wiki/dailies/2026-01-03.md",
      })
      .toHaveCount(0);

    await h.userCommit({
      files: {
        "wiki/dailies/2026-01-03.md": null,
      },
      message: "delete daily task page",
    });
    const deleted = await h.tick();
    expect(deleted.adopted).toBe(true);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: "wiki/dailies/2026-01-03.md",
      })
      .toHaveCount(0);

    await h
      .expectLedger({ processorId: "dome.daily.task-index" })
      .toAllHaveStatus("succeeded");
  },
);
