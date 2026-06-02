// scenarios/cli-surface/today-task-view.scenario.test.ts
//
// `dome today` is the first daily workflow view with a dedicated CLI binding.
// It stays an extension-owned view processor: the CLI is only a thin wrapper
// around the command-triggered `dome.daily.today` processor.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "cli-surface: dome today renders source-backed task and followup data",
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
          "- [ ] Ship weekly update",
          "- [ ] #followup Send Ada launch notes",
          "",
        ].join("\n"),
        "wiki/captures/2026-01-05.md": [
          "---",
          "type: source",
          "title: Capture",
          "---",
          "",
          "# Capture",
          "",
          "TODO: Draft project staffing note 📅 2026-01-06",
          "Follow up: Ask Ben about hiring budget 🔺",
          "We should follow up with Cy about review timing",
          "",
        ].join("\n"),
      },
      message: "add today tasks",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const json = await h.runCli(["today", "--date", "2026-01-05", "--json"]);
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");

    const payload = JSON.parse(json.stdout) as {
      readonly date: string;
      readonly daily: {
        readonly path: string;
        readonly exists: boolean;
        readonly sourceRefs: ReadonlyArray<{ readonly path: string }>;
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
        readonly openTasks: number;
        readonly followups: number;
        readonly questions: number;
      };
      readonly omitted: {
        readonly openTasks: number;
        readonly followups: number;
        readonly questions: number;
      };
      readonly openTasks: ReadonlyArray<{
        readonly text: string;
        readonly path: string;
        readonly line: number | null;
        readonly source: "daily" | "backlog";
        readonly followup: boolean;
        readonly dueDate: string | null;
        readonly priority: "highest" | "high" | "medium" | "low" | "lowest" | null;
        readonly lastChangedAt: string | null;
        readonly sourceRefs: ReadonlyArray<{ readonly path: string }>;
      }>;
      readonly followups: ReadonlyArray<{
        readonly text: string;
        readonly source: "daily" | "backlog";
      }>;
      readonly questions: ReadonlyArray<{
        readonly id: number;
        readonly question: string;
        readonly options: ReadonlyArray<string>;
        readonly resolveCommand: string;
        readonly metadata?: {
          readonly automationPolicy?: string;
        };
        readonly automationPolicy?: string;
        readonly path: string;
        readonly source: "daily" | "backlog";
      }>;
    };

    expect(payload.date).toBe("2026-01-05");
    expect(payload.daily.path).toBe("wiki/dailies/2026-01-05.md");
    expect(payload.daily.exists).toBe(true);
    expect(payload.daily.sourceRefs[0]?.path).toBe(
      "wiki/dailies/2026-01-05.md",
    );
    expect(payload.counts.openTasks).toBe(4);
    expect(payload.counts.followups).toBe(2);
    expect(payload.counts.questions).toBe(1);
    expect(payload.sourceCounts.daily).toEqual({
      openTasks: 2,
      followups: 1,
      questions: 0,
    });
    expect(payload.sourceCounts.backlog).toEqual({
      openTasks: 2,
      followups: 1,
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
      openTasks: 4,
      followups: 2,
      questions: 1,
    });
    expect(payload.omitted).toEqual({
      openTasks: 0,
      followups: 0,
      questions: 0,
    });
    expect(payload.openTasks.map((task) => task.text)).toEqual([
      "Ship weekly update",
      "Send Ada launch notes",
      "Ask Ben about hiring budget",
      "Draft project staffing note",
    ]);
    expect(payload.openTasks.map((task) => task.dueDate)).toEqual([
      null,
      null,
      null,
      "2026-01-06",
    ]);
    expect(payload.openTasks.map((task) => task.priority)).toEqual([
      null,
      null,
      "highest",
      null,
    ]);
    expect(
      payload.openTasks.every((task) => typeof task.lastChangedAt === "string"),
    ).toBe(true);
    expect(payload.openTasks.map((task) => task.source)).toEqual([
      "daily",
      "daily",
      "backlog",
      "backlog",
    ]);
    expect(
      payload.openTasks.every((task) =>
        task.sourceRefs.some((ref) => ref.path === task.path)
      ),
    ).toBe(true);
    expect(payload.followups.map((task) => task.text)).toEqual([
      "Send Ada launch notes",
      "Ask Ben about hiring budget",
    ]);
    expect(payload.followups.map((task) => task.source)).toEqual([
      "daily",
      "backlog",
    ]);
    expect(payload.questions[0]?.question).toContain(
      "We should follow up with Cy about review timing",
    );
    expect(payload.questions[0]?.id).toBeGreaterThan(0);
    expect(payload.questions[0]?.options).toEqual(["track", "ignore"]);
    expect(payload.questions[0]?.resolveCommand).toBe(
      `dome resolve ${payload.questions[0]?.id} <track|ignore>`,
    );
    expect(payload.questions[0]?.metadata?.automationPolicy).toBe("agent-safe");
    expect(payload.questions[0]?.automationPolicy).toBe("agent-safe");
    expect(payload.questions[0]?.path).toBe("wiki/captures/2026-01-05.md");
    expect(payload.questions[0]?.source).toBe("backlog");

    h.projection.raw.run(
      "INSERT INTO facts (namespace, subject_kind, subject_id, predicate, "
        + "object_json, assertion, confidence, source_refs, processor_id, "
        + "adopted_commit, written_at) "
        + "SELECT namespace, subject_kind, subject_id, predicate, object_json, "
        + "assertion, confidence, source_refs, processor_id, adopted_commit, "
        + "written_at FROM facts WHERE predicate IN "
        + "('dome.daily.open_task', 'dome.daily.followup')",
    );

    const deduped = await h.runCli(["today", "--date", "2026-01-05", "--json"]);
    expect(deduped.exitCode).toBe(0);
    const dedupedPayload = JSON.parse(deduped.stdout) as {
      readonly counts: {
        readonly openTasks: number;
        readonly followups: number;
      };
      readonly openTasks: ReadonlyArray<{ readonly text: string }>;
      readonly followups: ReadonlyArray<{ readonly text: string }>;
    };
    expect(dedupedPayload.counts.openTasks).toBe(4);
    expect(dedupedPayload.counts.followups).toBe(2);
    expect(dedupedPayload.openTasks.map((task) => task.text)).toEqual(
      payload.openTasks.map((task) => task.text),
    );
    expect(dedupedPayload.followups.map((task) => task.text)).toEqual(
      payload.followups.map((task) => task.text),
    );

    const limited = await h.runCli([
      "today",
      "--date",
      "2026-01-05",
      "--limit",
      "2",
      "--json",
    ]);
    expect(limited.exitCode).toBe(0);
    const limitedPayload = JSON.parse(limited.stdout) as {
      readonly limit: number;
      readonly counts: {
        readonly openTasks: number;
        readonly followups: number;
        readonly questions: number;
      };
      readonly shown: {
        readonly openTasks: number;
        readonly followups: number;
        readonly questions: number;
      };
      readonly omitted: {
        readonly openTasks: number;
        readonly followups: number;
        readonly questions: number;
      };
      readonly openTasks: ReadonlyArray<{ readonly text: string }>;
      readonly followups: ReadonlyArray<{ readonly text: string }>;
      readonly questions: ReadonlyArray<{
        readonly id: number;
        readonly question: string;
        readonly resolveCommand: string;
      }>;
    };
    expect(limitedPayload.limit).toBe(2);
    expect(limitedPayload.counts.openTasks).toBe(4);
    expect(limitedPayload.counts.followups).toBe(2);
    expect(limitedPayload.counts.questions).toBe(1);
    expect(limitedPayload.shown).toEqual({
      openTasks: 2,
      followups: 2,
      questions: 1,
    });
    expect(limitedPayload.omitted).toEqual({
      openTasks: 2,
      followups: 0,
      questions: 0,
    });
    expect(limitedPayload.openTasks.map((task) => task.text)).toEqual(
      payload.openTasks.slice(0, 2).map((task) => task.text),
    );
    expect(limitedPayload.followups.map((task) => task.text)).toEqual(
      payload.followups.map((task) => task.text),
    );
    expect(limitedPayload.questions).toHaveLength(1);

    const text = await h.runCli(["today", "--date", "2026-01-05"]);
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toContain("DOME today 2026-01-05");
    expect(text.stdout).toContain(
      "daily    wiki/dailies/2026-01-05.md | exists | 2 open | 1 followups | 0 questions",
    );
    expect(text.stdout).toContain("backlog  2 open | 1 followups | 1 questions");
    expect(text.stdout).toContain("4 open | 2 followups | 1 questions");
    expect(text.stdout).toContain(
      "due      open 0 overdue | 0 today | 1 upcoming | 3 undated | followups 0 overdue | 0 today | 0 upcoming | 2 undated",
    );
    expect(text.stdout).toContain("Daily note");
    expect(text.stdout).toContain("Wider wiki backlog");
    expect(text.stdout).toContain(
      "Ask Ben about hiring budget (wiki/captures/2026-01-05.md:9)",
    );
    expect(text.stdout).toContain(
      `resolve: dome resolve ${payload.questions[0]?.id} <track|ignore>`,
    );

    const limitedText = await h.runCli([
      "today",
      "--date",
      "2026-01-05",
      "--limit",
      "2",
    ]);
    expect(limitedText.exitCode).toBe(0);
    expect(limitedText.stdout).toContain("  ... 2 more open tasks");
    expect(limitedText.stdout).toContain("Ship weekly update");
    expect(limitedText.stdout).toContain("Send Ada launch notes");
    expect(limitedText.stdout).not.toContain(
      "Draft project staffing note",
    );
  },
);

scenario(
  {
    name: "cli-surface: dome today ranks backlog by due proximity and recency",
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

    const oldTimestamp =
      Date.parse("2026-01-01T09:00:00.000Z") / 1000;
    const newTimestamp =
      Date.parse("2026-01-05T09:00:00.000Z") / 1000;

    await h.userCommit({
      files: {
        "wiki/projects/old.md": [
          "# Old Project",
          "",
          "TODO: Ancient overdue task 📅 2025-10-20",
          "TODO: Priority stale task 🔺",
          "TODO: Old plain backlog",
          "",
        ].join("\n"),
      },
      message: "add old backlog",
      author: {
        name: "dome-test",
        email: "test@local",
        timestamp: oldTimestamp,
      },
    });
    const oldSync = await h.tick();
    expect(oldSync.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/projects/new.md": [
          "# New Project",
          "",
          "TODO: Recent overdue task 📅 2026-01-04",
          "TODO: Fresh plain backlog",
          "",
        ].join("\n"),
      },
      message: "add fresh backlog",
      author: {
        name: "dome-test",
        email: "test@local",
        timestamp: newTimestamp,
      },
    });
    const newSync = await h.tick();
    expect(newSync.adopted).toBe(true);

    const json = await h.runCli(["today", "--date", "2026-01-05", "--json"]);
    expect(json.exitCode).toBe(0);
    const payload = JSON.parse(json.stdout) as {
      readonly openTasks: ReadonlyArray<{
        readonly text: string;
        readonly lastChangedAt: string | null;
      }>;
    };

    expect(payload.openTasks.map((task) => task.text)).toEqual([
      "Recent overdue task",
      "Ancient overdue task",
      "Priority stale task",
      "Fresh plain backlog",
      "Old plain backlog",
    ]);
    expect(payload.openTasks.map((task) => task.lastChangedAt)).toEqual([
      "2026-01-05T09:00:00.000Z",
      "2026-01-01T09:00:00.000Z",
      "2026-01-01T09:00:00.000Z",
      "2026-01-05T09:00:00.000Z",
      "2026-01-01T09:00:00.000Z",
    ]);

    const limited = await h.runCli([
      "today",
      "--date",
      "2026-01-05",
      "--limit",
      "4",
    ]);
    expect(limited.exitCode).toBe(0);
    expect(limited.stdout).toContain("Recent overdue task");
    expect(limited.stdout).toContain("Ancient overdue task");
    expect(limited.stdout).toContain("Priority stale task");
    expect(limited.stdout).toContain("Fresh plain backlog");
    expect(limited.stdout).not.toContain("Old plain backlog");
  },
);

scenario(
  {
    name: "cli-surface: dome today folds repeated source-backed open loops",
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
        "wiki/projects/old.md": [
          "# Old Project",
          "",
          "TODO: Ship Conv 1 written follow-up 📅 2026-01-04 🔺",
          "",
        ].join("\n"),
      },
      message: "add old duplicate task",
      author: {
        name: "dome-test",
        email: "test@local",
        timestamp: Date.parse("2026-01-01T09:00:00.000Z") / 1000,
      },
    });
    const oldSync = await h.tick();
    expect(oldSync.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/projects/new.md": [
          "# New Project",
          "",
          "TODO: Ship Conv 1 written follow-up 📅 2026-01-04 🔺",
          "TODO: Draft launch staffing note",
          "",
        ].join("\n"),
      },
      message: "add fresh duplicate task",
      author: {
        name: "dome-test",
        email: "test@local",
        timestamp: Date.parse("2026-01-05T09:00:00.000Z") / 1000,
      },
    });
    const newSync = await h.tick();
    expect(newSync.adopted).toBe(true);

    const json = await h.runCli(["today", "--date", "2026-01-05", "--json"]);
    expect(json.exitCode).toBe(0);
    const payload = JSON.parse(json.stdout) as {
      readonly counts: { readonly openTasks: number };
      readonly sourceCounts: {
        readonly backlog: { readonly openTasks: number };
      };
      readonly openTasks: ReadonlyArray<{
        readonly text: string;
        readonly path: string;
        readonly sourceRefs: ReadonlyArray<{ readonly path: string }>;
      }>;
    };

    expect(payload.counts.openTasks).toBe(2);
    expect(payload.sourceCounts.backlog.openTasks).toBe(2);
    expect(payload.openTasks.map((task) => task.text)).toEqual([
      "Ship Conv 1 written follow-up",
      "Draft launch staffing note",
    ]);
    expect(payload.openTasks[0]?.path).toBe("wiki/projects/new.md");
    expect(payload.openTasks[0]?.sourceRefs.map((ref) => ref.path).sort())
      .toEqual(["wiki/projects/new.md", "wiki/projects/old.md"]);

    const text = await h.runCli(["today", "--date", "2026-01-05"]);
    expect(text.exitCode).toBe(0);
    expect(occurrences(text.stdout, "Ship Conv 1 written follow-up")).toBe(1);
  },
);

scenario(
  {
    name: "cli-surface: dome today respects configured daily note path",
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
    harness: {
      bundles: ["dome.daily"],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  dome.daily:
    enabled: true
    config:
      daily_path: notes/{date}.md
    grant:
      read: ["wiki/**/*.md", "notes/*.md"]
      patch.auto: ["notes/*.md"]
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
        "notes/2026-01-05.md": [
          "# 2026-01-05",
          "",
          "- [ ] Ship configured daily surface",
          "",
        ].join("\n"),
        "wiki/captures/work.md": [
          "# Work",
          "",
          "TODO: Prepare supporting context",
          "",
        ].join("\n"),
      },
      message: "add configured daily note",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const json = await h.runCli(["today", "--date", "2026-01-05", "--json"]);
    expect(json.exitCode).toBe(0);
    const payload = JSON.parse(json.stdout) as {
      readonly daily: { readonly path: string; readonly exists: boolean };
      readonly sourceCounts: {
        readonly daily: { readonly openTasks: number };
        readonly backlog: { readonly openTasks: number };
      };
    };

    expect(payload.daily.path).toBe("notes/2026-01-05.md");
    expect(payload.daily.exists).toBe(true);
    expect(payload.sourceCounts.daily.openTasks).toBe(1);
    expect(payload.sourceCounts.backlog.openTasks).toBe(1);
  },
);

function occurrences(value: string, needle: string): number {
  if (needle.length === 0) return 0;
  return value.split(needle).length - 1;
}
