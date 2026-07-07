// scenarios/cli-surface/prep-view.scenario.test.ts
//
// `dome run prep` is a source-backed planning packet over the daily task facts.

import { expect } from "bun:test";

import { TestClock, scenario } from "../../index";

scenario(
  {
    name: "cli-surface: dome run prep samples daily and backlog detail rows within the limit",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "fact" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "view" },
      { kind: "capability", capability: "graph.write" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "command" },
    ],
    harness: { bundles: ["dome.daily"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/dailies/2026-01-05.md": [
          "---",
          "type: daily",
          "recurrence: 2026-01-05",
          "---",
          "",
          "# 2026-01-05",
          "",
          "- [ ] Daily one",
          "- [ ] Daily two",
          "- [ ] Daily three",
          "",
        ].join("\n"),
        "wiki/projects/backlog.md": [
          "# Backlog",
          "",
          "- [ ] Backlog one",
          "- [ ] Backlog two",
          "- [ ] Backlog three",
          "",
        ].join("\n"),
      },
      message: "add prep daily and backlog tasks",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const json = await h.runCli([
      "run",
      "prep",
      "--date",
      "2026-01-05",
      "--limit",
      "2",
      "--json",
    ]);
    expect(json.exitCode).toBe(0);
    const payload = structuredData(json.stdout) as {
      readonly limit: number;
      readonly counts: { readonly openTasks: number };
      readonly sourceCounts: {
        readonly daily: { readonly openTasks: number };
        readonly backlog: { readonly openTasks: number };
      };
      readonly shown: {
        readonly planningItems: number;
        readonly followups: number;
        readonly openTasks: number;
        readonly questions: number;
      };
      readonly omitted: {
        readonly planningItems: number;
        readonly followups: number;
        readonly openTasks: number;
        readonly questions: number;
      };
      readonly planningItems: ReadonlyArray<{
        readonly text: string;
        readonly path: string;
      }>;
      readonly openTasks: ReadonlyArray<{
        readonly text: string;
        readonly source: "daily" | "backlog";
      }>;
      readonly markdown: string;
    };
    expect(payload.limit).toBe(2);
    expect(payload.counts.openTasks).toBe(6);
    expect(payload.sourceCounts.daily.openTasks).toBe(3);
    expect(payload.sourceCounts.backlog.openTasks).toBe(3);
    expect(payload.shown).toEqual({
      planningItems: 2,
      followups: 0,
      openTasks: 4,
      questions: 0,
    });
    expect(payload.omitted).toEqual({
      planningItems: 4,
      followups: 0,
      openTasks: 2,
      questions: 0,
    });
    expect(payload.planningItems.map((item) => item.text)).toEqual([
      "Daily one",
      "Daily two",
    ]);
    expect(payload.openTasks.map((task) => task.text)).toEqual([
      "Daily one",
      "Daily two",
      "Backlog one",
      "Backlog two",
    ]);
    expect(payload.openTasks.map((task) => task.source)).toEqual([
      "daily",
      "daily",
      "backlog",
      "backlog",
    ]);
    expect(payload.markdown).toContain(
      "- 2 open tasks already listed in Start Here",
    );
    expect(payload.markdown).toContain("- Wider wiki backlog");
    expect(payload.markdown).toContain("Backlog one");
    expect(payload.markdown).toContain("Backlog two");
    expect(payload.markdown).not.toContain("Backlog three");

    const text = await h.runCli([
      "run",
      "prep",
      "--date",
      "2026-01-05",
      "--limit",
      "2",
    ]);
    expect(text.exitCode).toBe(0);
    const textPayload = structuredData(text.stdout) as {
      readonly markdown: string;
    };
    expect(textPayload.markdown).toContain("## Start Here");
    expect(textPayload.markdown).toContain("[task] Daily one");
    expect(textPayload.markdown).toContain("[task] Daily two");
    expect(textPayload.markdown).toContain(
      "- 2 open tasks already listed in Start Here",
    );
    expect(textPayload.markdown).toContain("- Wider wiki backlog");
    expect(textPayload.markdown).toContain("Backlog one");
    expect(textPayload.markdown).toContain("Backlog two");
    expect(textPayload.markdown).not.toContain("Daily three");
    expect(textPayload.markdown).not.toContain("Backlog three");
  },
);

scenario(
  {
    name: "cli-surface: dome run prep renders source-backed planning context",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "fact" },
      { kind: "effect", effect: "question" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "view" },
      { kind: "capability", capability: "graph.write" },
      { kind: "capability", capability: "question.ask" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "command" },
    ],
    harness: {
      clock: new TestClock("2026-01-05T15:00:00.000Z"),
      bundles: ["dome.daily"],
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/dailies/2026-01-05.md": [
          "---",
          "type: daily",
          "recurrence: 2026-01-05",
          "---",
          "",
          "# 2026-01-05",
          "",
          "- [ ] Ship weekly update",
          "- [ ] #followup Send Ada launch notes",
          "",
        ].join("\n"),
        "wiki/captures/launch.md": [
          "---",
          "type: source",
          "title: Launch",
          "---",
          "",
          "# Launch",
          "",
          "TODO: Draft launch staffing note 📅 2026-01-06",
          "Follow up: Ask Ben about hiring budget 🔺",
          "We should follow up with Cy about review timing",
          "",
        ].join("\n"),
      },
      message: "add prep context",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const text = await h.runCli([
      "run",
      "prep",
      "--date",
      "2026-01-05",
      "--limit",
      "3",
    ]);
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toBe("");
    const textPayload = structuredData(text.stdout) as {
      readonly markdown: string;
    };
    expect(textPayload.markdown).toContain("# Dome Prep: 2026-01-05");
    expect(textPayload.markdown).toContain(
      "Daily note: wiki/dailies/2026-01-05.md",
    );
    expect(textPayload.markdown).toContain(
      "Daily note scope: 4 open tasks, 2 followups, 0 questions",
    );
    expect(textPayload.markdown).toContain(
      "Backlog scope: 0 open tasks, 0 followups, 1 questions",
    );
    expect(textPayload.markdown).toContain(
      "Due: open tasks 0 overdue, 0 today, 1 upcoming, 3 undated; followups 0 overdue, 0 today, 0 upcoming, 2 undated",
    );
    expect(textPayload.markdown).toContain(
      "[followup] Ask Ben about hiring budget (wiki/dailies/2026-01-05.md:23; source wiki/captures/launch.md:9)",
    );
    expect(textPayload.markdown).toContain(
      "- 2 followups already listed in Start Here",
    );
    expect(textPayload.markdown).toContain(
      "- 1 open task already listed in Start Here",
    );
    expect(textPayload.markdown).toContain(
      "- 1 question already listed in Start Here",
    );
    expect(textPayload.markdown).toContain("resolve: dome resolve ");
    expect(textPayload.markdown).toContain(
      "policy: agent-safe; risk low; confidence 0.65",
    );
    expect(textPayload.markdown).toContain("<track|ignore>");
    expect(textPayload.markdown).toContain(
      "- ... 1 more open task (use --limit 4 to show all open tasks)",
    );
    expect(occurrences(textPayload.markdown, "Ask Ben about hiring budget")).toBe(
      1,
    );
    expect(textPayload.markdown).toContain("## SourceRefs");

    const json = await h.runCli([
      "run",
      "prep",
      "--date",
      "2026-01-05",
      "--limit",
      "2",
      "--json",
    ]);
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");

    const payload = structuredData(json.stdout) as {
      readonly date: string;
      readonly limit: number;
      readonly daily: {
        readonly path: string;
        readonly exists: boolean;
      };
      readonly counts: {
        readonly openTasks: number;
        readonly followups: number;
        readonly questions: number;
      };
      readonly sourceCounts: {
        readonly daily: {
          readonly openTasks: number;
          readonly followups: number;
          readonly questions: number;
        };
        readonly backlog: {
          readonly openTasks: number;
          readonly followups: number;
          readonly questions: number;
        };
      };
      readonly dueCounts: {
        readonly openTasks: {
          readonly overdue: number;
          readonly today: number;
          readonly upcoming: number;
          readonly undated: number;
        };
        readonly followups: {
          readonly overdue: number;
          readonly today: number;
          readonly upcoming: number;
          readonly undated: number;
        };
      };
      readonly shown: {
        readonly planningItems: number;
        readonly followups: number;
        readonly openTasks: number;
        readonly questions: number;
      };
      readonly omitted: {
        readonly planningItems: number;
        readonly followups: number;
        readonly openTasks: number;
        readonly questions: number;
      };
      readonly planningItems: ReadonlyArray<{
        readonly kind: string;
        readonly text: string;
        readonly path: string;
        readonly dueDate: string | null;
        readonly priority: string | null;
        readonly lastChangedAt: string | null;
        readonly evidenceLabel: string;
        readonly sourceRefs: ReadonlyArray<{ readonly path: string }>;
      }>;
      readonly markdown: string;
    };

    expect(payload.date).toBe("2026-01-05");
    expect(payload.limit).toBe(2);
    expect(payload.daily.path).toBe("wiki/dailies/2026-01-05.md");
    expect(payload.daily.exists).toBe(true);
    expect(payload.counts.openTasks).toBe(4);
    expect(payload.counts.followups).toBe(2);
    expect(payload.counts.questions).toBe(1);
    expect(payload.sourceCounts.daily).toEqual({
      openTasks: 4,
      followups: 2,
      questions: 0,
    });
    expect(payload.sourceCounts.backlog).toEqual({
      openTasks: 0,
      followups: 0,
      questions: 1,
    });
    expect(payload.dueCounts.openTasks).toEqual({
      overdue: 0,
      today: 0,
      upcoming: 1,
      undated: 3,
    });
    expect(payload.dueCounts.followups).toEqual({
      overdue: 0,
      today: 0,
      upcoming: 0,
      undated: 2,
    });
    expect(payload.shown).toEqual({
      planningItems: 2,
      followups: 2,
      openTasks: 2,
      questions: 1,
    });
    expect(payload.omitted).toEqual({
      planningItems: 3,
      followups: 0,
      openTasks: 2,
      questions: 0,
    });
    expect(payload.planningItems.map((item) => item.kind)).toEqual([
      "followup",
      "followup",
    ]);
    expect(payload.planningItems.map((item) => item.text)).toEqual([
      "Send Ada launch notes",
      "Ask Ben about hiring budget",
    ]);
    expect(payload.planningItems.map((item) => item.dueDate)).toEqual([
      null,
      null,
    ]);
    expect(payload.planningItems.map((item) => item.priority)).toEqual([
      null,
      "highest",
    ]);
    expect(payload.planningItems.map((item) => item.evidenceLabel)).toEqual([
      "wiki/dailies/2026-01-05.md:9",
      "wiki/dailies/2026-01-05.md:23; source wiki/captures/launch.md:9",
    ]);
    expect(
      payload.planningItems.every((item) =>
        typeof item.lastChangedAt === "string"
      ),
    ).toBe(true);
    expect(payload.planningItems[0]?.sourceRefs[0]?.path).toBe(
      payload.planningItems[0]?.path,
    );
    expect(payload.markdown).toContain("# Dome Prep: 2026-01-05");
    expect(payload.markdown).toContain(
      "Daily note scope: 4 open tasks, 2 followups, 0 questions",
    );
    expect(payload.markdown).toContain(
      "Backlog scope: 0 open tasks, 0 followups, 1 questions",
    );
    expect(payload.markdown).toContain(
      "Due: open tasks 0 overdue, 0 today, 1 upcoming, 3 undated; followups 0 overdue, 0 today, 0 upcoming, 2 undated",
    );
    expect(payload.markdown).toContain("resolve: dome resolve ");
    expect(payload.markdown).toContain(
      "policy: agent-safe; risk low; confidence 0.65",
    );
    expect(payload.markdown).toContain("<track|ignore>");
    expect(payload.markdown).toContain(
      "- 2 followups already listed in Start Here",
    );
    expect(payload.markdown).toContain(
      "- 1 open task already listed in Start Here",
    );
    expect(payload.markdown).toContain(
      "- ... 2 more open tasks (use --limit 4 to show all open tasks)",
    );
    expect(payload.markdown).toContain("wiki/captures/launch.md:9-9 @");
    expect(payload.markdown).toContain("wiki/captures/launch.md:10-10 @");
    expect(payload.markdown).toContain("wiki/dailies/2026-01-05.md @");
    expect(payload.markdown).toContain("wiki/dailies/2026-01-05.md:8-8 @");
    expect(payload.markdown).toContain("wiki/dailies/2026-01-05.md:9-9 @");
    expect(payload.markdown).toContain("wiki/dailies/2026-01-05.md:23-23 @");
  },
);

// `dome today --prep` is the dedicated binding over the same
// `dome.daily.prep` view processor (a top-level `dome prep` verb until the
// 2026-07-06 cohesion review folded it into `today`). Unlike
// `dome run <name>` (which always wraps output in a `{name, kind, schema,
// data}` envelope), the dedicated binding renders human markdown by default
// and the bare structured payload under `--json`, matching its `dome query`
// / `dome export-context` siblings.
scenario(
  {
    name: "cli-surface: dome today --prep dispatches to dome.daily.prep",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "fact" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "view" },
      { kind: "capability", capability: "graph.write" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "command" },
    ],
    harness: { bundles: ["dome.daily"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/dailies/2026-01-05.md": [
          "---",
          "type: daily",
          "recurrence: 2026-01-05",
          "---",
          "",
          "# 2026-01-05",
          "",
          "- [ ] Dedicated verb task",
          "",
        ].join("\n"),
      },
      message: "add dedicated-verb prep task",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    // The retired top-level spelling fails loudly with the replacement.
    const retired = await h.runCli(["prep", "--date", "2026-01-05"]);
    expect(retired.exitCode).toBe(64);
    expect(retired.stderr).toContain(
      "dome prep: retired. Use `dome today --prep` instead.",
    );

    // Default text output is the rendered markdown packet, not a JSON blob.
    const text = await h.runCli(["today", "--prep", "--date", "2026-01-05"]);
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toContain("# Dome Prep: 2026-01-05");
    expect(text.stdout).toContain("Dedicated verb task");
    expect(text.stdout).not.toMatch(/^\s*[{[]/); // not a JSON envelope

    // `--json` emits the bare `dome.daily.prep/v1` payload — no
    // {name,kind,schema,data} wrapper (that's `dome run`'s shape, not this
    // dedicated binding's).
    const json = await h.runCli([
      "today",
      "--prep",
      "--date",
      "2026-01-05",
      "--json",
    ]);
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");
    const payload = JSON.parse(json.stdout) as {
      readonly schema: string;
      readonly date: string;
      readonly markdown: string;
    };
    expect(payload.schema).toBe("dome.daily.prep/v1");
    expect(payload.date).toBe("2026-01-05");
    expect(payload.markdown).toContain("Dedicated verb task");
  },
);

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function structuredData(stdout: string): unknown {
  const envelope = JSON.parse(stdout) as { readonly data?: unknown };
  return envelope.data;
}
