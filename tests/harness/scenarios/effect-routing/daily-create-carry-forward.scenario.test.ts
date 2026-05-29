import { expect } from "bun:test";

import { capabilityUsesByRun } from "../../../../src/ledger/capability-uses";
import type { RunId } from "../../../../src/engine/runner-contract";
import { TestClock, scenario } from "../../index";

scenario(
  {
    name: "effect-routing: dome.daily creates daily note and carries open tasks",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "patch" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "schedule" },
      { kind: "trigger", trigger: "signal" },
      { kind: "route", route: "garden-schedule" },
    ],
    harness: {
      clock: new TestClock("2026-01-02T15:00:00.000Z"),
      bundles: ["dome.daily", "dome.markdown"],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  dome.daily:
    enabled: true
    grant:
      read: ["wiki/dailies/*.md"]
      patch.auto: ["wiki/dailies/*.md"]
      graph.write: ["dome.daily.*"]
      question.ask: true
  dome.markdown:
    enabled: true
    grant:
      read:
        - "**/*.md"
        - ".dome/page-types.yaml"
      patch.auto: ["**/*.md"]
`,
        "wiki/dailies/2026-01-01.md": `---
type: daily
recurrence: 2026-01-01
---

# 2026-01-01

## Notes

- [ ] #task #followup Follow up with [[wiki/entities/Ada]]
- [x] Completed task should stay behind
* [ ] Review launch plan
- [ ] Already carried once (from [[wiki/dailies/2025-12-31]])
`,
      },
    },
  },
  async (h) => {
    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h.expectFile("wiki/dailies/2026-01-02.md").toContain("type: daily");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("created: 2026-01-02");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("updated: 2026-01-02");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("recurrence: '2026-01-02'");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("<!-- dome.daily:carried-forward:start -->");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("- [ ] #task #followup Follow up with [[wiki/entities/Ada]] (from [[wiki/dailies/2026-01-01]])");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("* [ ] Review launch plan (from [[wiki/dailies/2026-01-01]])");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("- [ ] Already carried once (from [[wiki/dailies/2025-12-31]])");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toNotContain("Completed task should stay behind");

    const createRun = await h
      .expectLedger({
        processorId: "dome.daily.create-daily",
        status: "succeeded",
      })
      .toHaveExactlyOne();
    const carryRun = await h
      .expectLedger({
        processorId: "dome.daily.carry-forward",
        status: "succeeded",
      })
      .toHaveExactlyOne();
    await h
      .expectLedger({
        processorId: "dome.daily.task-index",
        status: "succeeded",
      })
      .toHaveAtLeastOne();

    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: "wiki/dailies/2026-01-02.md",
      })
      .toHaveCount(3);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.followup",
        subjectId: "wiki/dailies/2026-01-02.md",
        objectString: "#task #followup Follow up with [[wiki/entities/Ada]]",
      })
      .toHaveCount(1);

    expect(capabilityUsesByRun(h.ledger, createRun.id as RunId)).toEqual([
      expect.objectContaining({
        capability: "patch.auto",
        resource: "wiki/dailies/2026-01-02.md",
        outcome: "allowed",
      }),
    ]);
    expect(capabilityUsesByRun(h.ledger, carryRun.id as RunId)).toEqual([
      expect.objectContaining({
        capability: "patch.auto",
        resource: "wiki/dailies/2026-01-02.md",
        outcome: "allowed",
      }),
    ]);

    const second = await h.tick();
    expect(second.adopted).toBe(true);
    await h
      .expectLedger({
        processorId: "dome.daily.create-daily",
        status: "succeeded",
      })
      .toHaveExactlyOne();
  },
);
