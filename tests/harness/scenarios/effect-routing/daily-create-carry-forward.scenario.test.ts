import { expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { capabilityUsesByRun } from "../../../../src/ledger/capability-uses";
import type { RunId } from "../../../../src/engine/runner-contract";
import { TestClock, scenario } from "../../index";

scenario(
  {
    name: "effect-routing: dome.daily creates daily note and surfaces open loops",
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
      read: ["wiki/**/*.md"]
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

## Decisions

- Keep the manager packet in the weekly plan.

## Done

- Sent Ada the staffing note.

## Story of the Day

The staffing packet landed and hiring budget follow-up remains open.
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
      .toContain("recurrence: 2026-01-02");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("## Start Here");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("<!-- dome.daily:start-context:start -->");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("- Previous daily: [[wiki/dailies/2026-01-01]]");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("- Done yesterday: Sent Ada the staffing note.");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("- Decisions yesterday: Keep the manager packet in the weekly plan.");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("- Story: The staffing packet landed and hiring budget follow-up remains open.");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("## Open Loops");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("<!-- dome.daily:open-loops:start -->");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("- [ ] #followup Follow up with [[wiki/entities/Ada]] (from [[wiki/dailies/2026-01-01]])");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("- [ ] Review launch plan (from [[wiki/dailies/2026-01-01]])");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("- [ ] Already carried once (from [[wiki/dailies/2026-01-01]])");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toNotContain("Completed task should stay behind");

    const createRun = await h
      .expectLedger({
        processorId: "dome.daily.create-daily",
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
        subjectId: "wiki/dailies/2026-01-01.md",
      })
      .toHaveCount(3);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.followup",
        subjectId: "wiki/dailies/2026-01-01.md",
        objectString: "Follow up with [[wiki/entities/Ada]]",
      })
      .toHaveCount(1);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: "wiki/dailies/2026-01-02.md",
      })
      .toHaveCount(0);

    expect(capabilityUsesByRun(h.ledger, createRun.id as RunId)).toEqual([
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

scenario(
  {
    name: "effect-routing: dome.daily uses configured daily note path",
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
      bundles: ["dome.daily"],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  dome.daily:
    enabled: true
    config:
      daily_path: notes/{date}.md
    grant:
      read: ["notes/*.md"]
      patch.auto: ["notes/*.md"]
      graph.write: ["dome.daily.*"]
      question.ask: true
`,
        "notes/2026-01-01.md": [
          "# 2026-01-01",
          "",
          "## Notes",
          "",
          "- [ ] Carry configured task",
          "",
        ].join("\n"),
      },
    },
  },
  async (h) => {
    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h.expectFile("notes/2026-01-02.md").toContain("type: daily");
    await h
      .expectFile("notes/2026-01-02.md")
      .toContain('prev: "[[notes/2026-01-01]]"');
    await h
      .expectFile("notes/2026-01-02.md")
      .toContain("- Previous daily: [[notes/2026-01-01]]");
    await h
      .expectFile("notes/2026-01-02.md")
      .toContain("- [ ] Carry configured task (from [[notes/2026-01-01]])");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toBeAbsent();
  },
);

scenario(
  {
    name: "effect-routing: dome.daily raises backlog open loops into today's note",
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
      patch.auto: ["wiki/dailies/*.md"]
      graph.write: ["dome.daily.*"]
      question.ask: true
`,
        "wiki/dailies/2026-01-02.md": [
          "# 2026-01-02",
          "",
          "## Open Loops",
          "",
          "Human context stays outside Dome's generated block.",
          "",
          "## Notes",
          "",
        ].join("\n"),
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/projects/alpha.md": [
          "# Alpha",
          "",
          "TODO: Send budget update",
          "Follow up: Confirm Q3 plan with Eli",
          "",
        ].join("\n"),
        "wiki/projects/beta.md": [
          "# Beta",
          "",
          "TODO: Send budget update",
          "",
        ].join("\n"),
        "wiki/meetings/staff.md": [
          "# Staff",
          "",
          "- [ ] #task Review launch plan",
          "- [ ] Static meeting checklist should stay local",
          "- [x] Completed item should not surface",
          "",
        ].join("\n"),
      },
      message: "add source open loops",
    });
    const surfaced = await h.tick();
    expect(surfaced.adopted).toBe(true);

    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("Human context stays outside Dome's generated block.");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("<!-- dome.daily:open-loops:start -->");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("- [ ] Send budget update (from [[wiki/projects/alpha]])");
    const daily = await readFile(
      join(h.vaultPath, "wiki/dailies/2026-01-02.md"),
      "utf8",
    );
    expect(occurrences(daily, "Send budget update")).toBe(1);
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("- [ ] #followup Confirm Q3 plan with Eli (from [[wiki/projects/alpha]])");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("- [ ] Review launch plan (from [[wiki/meetings/staff]])");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toNotContain("Static meeting checklist should stay local");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toNotContain("Completed item should not surface");

    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: "wiki/dailies/2026-01-02.md",
      })
      .toHaveCount(0);

    const before = await readFile(
      join(h.vaultPath, "wiki/dailies/2026-01-02.md"),
      "utf8",
    );
    const second = await h.tick();
    expect(second.adopted).toBe(true);
    const after = await readFile(
      join(h.vaultPath, "wiki/dailies/2026-01-02.md"),
      "utf8",
    );
    expect(after).toBe(before);
  },
);

scenario(
  {
    name: "effect-routing: dome.daily signal carry-forward targets current daily note",
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
      patch.auto: ["wiki/dailies/*.md"]
      graph.write: ["dome.daily.*"]
      question.ask: true
`,
        "wiki/dailies/2025-12-15.md": [
          "# 2025-12-15",
          "",
          "## Notes",
          "",
          "Historical note.",
          "",
        ].join("\n"),
        "wiki/dailies/2026-01-02.md": [
          "# 2026-01-02",
          "",
          "## Open Loops",
          "",
          "## Notes",
          "",
        ].join("\n"),
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/dailies/2025-12-15.md": [
          "# 2025-12-15",
          "",
          "## Notes",
          "",
          "Historical note, edited much later.",
          "",
        ].join("\n"),
        "wiki/projects/alpha.md": [
          "# Alpha",
          "",
          "TODO: Send status update",
          "",
        ].join("\n"),
      },
      message: "edit historical daily and add current backlog",
    });

    const surfaced = await h.tick();
    expect(surfaced.adopted).toBe(true);

    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("- [ ] Send status update (from [[wiki/projects/alpha]])");
    await h
      .expectFile("wiki/dailies/2025-12-15.md")
      .toNotContain("<!-- dome.daily:open-loops:start -->");
    await h
      .expectFile("wiki/dailies/2025-12-15.md")
      .toNotContain("Send status update");
  },
);

scenario(
  {
    name: "effect-routing: dome.daily old daily maintenance touch does not refresh old loops",
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
      clock: new TestClock("2026-06-02T15:00:00.000Z"),
      bundles: ["dome.daily"],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  dome.daily:
    enabled: true
    config:
      daily_path: notes/{date}.md
    grant:
      read: ["notes/*.md"]
      patch.auto: ["notes/*.md"]
      graph.write: ["dome.daily.*"]
      question.ask: true
`,
        "notes/2026-06-02.md": [
          "# 2026-06-02",
          "",
          "## Open Loops",
          "",
          "## Notes",
          "",
        ].join("\n"),
        "notes/2026-06-01.md": [
          "# 2026-06-01",
          "",
          "## Notes",
          "",
          ...Array.from(
            { length: 12 },
            (_, index) => `TODO: Current loop ${String(index + 1).padStart(2, "0")}`,
          ),
          "",
        ].join("\n"),
        "notes/2026-05-28.md": [
          "# 2026-05-28",
          "",
          "## Notes",
          "",
          "TODO: Old maintenance loop should not jump the queue",
          "",
        ].join("\n"),
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h
      .expectFile("notes/2026-06-02.md")
      .toContain("Current loop 12");
    await h
      .expectFile("notes/2026-06-02.md")
      .toNotContain("Old maintenance loop should not jump the queue");

    await h.userCommit({
      files: {
        "notes/2026-05-28.md": [
          "# 2026-05-28",
          "",
          "## Notes",
          "",
          "TODO: Old maintenance loop should not jump the queue",
          "",
          "Historical prose edited during maintenance.",
          "",
        ].join("\n"),
      },
      message: "touch old daily note",
    });

    const afterTouch = await h.tick();
    expect(afterTouch.adopted).toBe(true);
    await h
      .expectFile("notes/2026-06-02.md")
      .toContain("Current loop 12");
    await h
      .expectFile("notes/2026-06-02.md")
      .toNotContain("Old maintenance loop should not jump the queue");
  },
);

scenario(
  {
    name: "effect-routing: dome.daily checked source-backed open loops stay resolved",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "patch" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "schedule" },
      { kind: "route", route: "garden-signal" },
      { kind: "route", route: "garden-schedule" },
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
      patch.auto: ["wiki/dailies/*.md"]
      graph.write: ["dome.daily.*"]
      question.ask: true
`,
        "wiki/dailies/2026-01-02.md": [
          "# 2026-01-02",
          "",
          "## Open Loops",
          "",
          "## Notes",
          "",
        ].join("\n"),
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/projects/alpha.md": [
          "# Alpha",
          "",
          "TODO: Send budget update",
          "",
        ].join("\n"),
        "wiki/projects/beta.md": [
          "# Beta",
          "",
          "TODO: Send budget update",
          "",
        ].join("\n"),
      },
      message: "add source open loop",
    });

    const surfaced = await h.tick();
    expect(surfaced.adopted).toBe(true);

    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("- [ ] Send budget update (from [[wiki/projects/alpha]])");

    const daily = await readFile(
      join(h.vaultPath, "wiki/dailies/2026-01-02.md"),
      "utf8",
    );
    await h.userCommit({
      files: {
        "wiki/dailies/2026-01-02.md": daily.replace(
          "- [ ] Send budget update (from [[wiki/projects/alpha]])",
          "- [x] Send budget update (from [[wiki/projects/alpha]])",
        ),
      },
      message: "complete surfaced daily open loop",
    });

    const resolved = await h.tick();
    expect(resolved.adopted).toBe(true);
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("### Resolved Today");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("- [x] Send budget update (from [[wiki/projects/alpha]])");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toNotContain("- [ ] Send budget update (from [[wiki/projects/alpha]])");

    const before = await readFile(
      join(h.vaultPath, "wiki/dailies/2026-01-02.md"),
      "utf8",
    );
    const settled = await h.tick();
    expect(settled.adopted).toBe(true);
    const after = await readFile(
      join(h.vaultPath, "wiki/dailies/2026-01-02.md"),
      "utf8",
    );
    expect(after).toBe(before);

    await h.advance(24 * 60 * 60 * 1000);
    const nextDay = await h.tick();
    expect(nextDay.adopted).toBe(true);
    await h
      .expectFile("wiki/dailies/2026-01-03.md")
      .toContain("type: daily");
    await h
      .expectFile("wiki/dailies/2026-01-03.md")
      .toNotContain("Send budget update");
  },
);

scenario(
  {
    name: "effect-routing: dome.daily dismissed source-backed open loops stay dismissed",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "patch" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "schedule" },
      { kind: "route", route: "garden-signal" },
      { kind: "route", route: "garden-schedule" },
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
      patch.auto: ["wiki/dailies/*.md"]
      graph.write: ["dome.daily.*"]
      question.ask: true
`,
        "wiki/dailies/2026-01-02.md": [
          "# 2026-01-02",
          "",
          "## Open Loops",
          "",
          "## Notes",
          "",
        ].join("\n"),
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/projects/alpha.md": [
          "# Alpha",
          "",
          "TODO: Archive the launch staffing thread",
          "",
        ].join("\n"),
      },
      message: "add dismissible source open loop",
    });

    const surfaced = await h.tick();
    expect(surfaced.adopted).toBe(true);
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain(
        "- [ ] Archive the launch staffing thread (from [[wiki/projects/alpha]])",
      );

    const daily = await readFile(
      join(h.vaultPath, "wiki/dailies/2026-01-02.md"),
      "utf8",
    );
    await h.userCommit({
      files: {
        "wiki/dailies/2026-01-02.md": daily.replace(
          "- [ ] Archive the launch staffing thread (from [[wiki/projects/alpha]])",
          "- [-] Archive the launch staffing thread (from [[wiki/projects/alpha]])",
        ),
      },
      message: "dismiss surfaced daily open loop",
    });

    const dismissed = await h.tick();
    expect(dismissed.adopted).toBe(true);
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain("### Dismissed Today");
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toContain(
        "- [-] Archive the launch staffing thread (from [[wiki/projects/alpha]])",
      );
    await h
      .expectFile("wiki/dailies/2026-01-02.md")
      .toNotContain(
        "- [ ] Archive the launch staffing thread (from [[wiki/projects/alpha]])",
      );

    const before = await readFile(
      join(h.vaultPath, "wiki/dailies/2026-01-02.md"),
      "utf8",
    );
    const settled = await h.tick();
    expect(settled.adopted).toBe(true);
    const after = await readFile(
      join(h.vaultPath, "wiki/dailies/2026-01-02.md"),
      "utf8",
    );
    expect(after).toBe(before);

    await h.advance(24 * 60 * 60 * 1000);
    const nextDay = await h.tick();
    expect(nextDay.adopted).toBe(true);
    await h
      .expectFile("wiki/dailies/2026-01-03.md")
      .toContain("type: daily");
    await h
      .expectFile("wiki/dailies/2026-01-03.md")
      .toNotContain("Archive the launch staffing thread");
  },
);

function occurrences(value: string, needle: string): number {
  if (needle.length === 0) return 0;
  return value.split(needle).length - 1;
}
