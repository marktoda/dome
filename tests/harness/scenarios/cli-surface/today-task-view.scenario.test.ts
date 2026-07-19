// scenarios/cli-surface/today-task-view.scenario.test.ts
//
// `dome run today` exercises the extension-owned `dome.daily.today` view
// processor without keeping a dedicated top-level daily CLI command.

import { expect } from "bun:test";

import { TestClock, scenario } from "../../index";

scenario(
  {
    name: "cli-surface: dome run today renders source-backed task and followup data",
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

    const json = await h.runCli(["run", "today", "--date", "2026-01-05", "--json"]);
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");

    const payload = structuredData(json.stdout) as {
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
        readonly reviews: number;
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
        readonly reviews: number;
      };
      readonly omitted: {
        readonly openTasks: number;
        readonly followups: number;
        readonly questions: number;
        readonly reviews: number;
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
        readonly evidenceLabel: string;
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
    expect(payload.counts.questions).toBe(0);
    expect(payload.sourceCounts.daily).toEqual({
      openTasks: 4,
      followups: 2,
      questions: 0,
    });
    expect(payload.sourceCounts.backlog).toEqual({
      openTasks: 0,
      followups: 0,
      questions: 0,
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
      questions: 0,
      reviews: 0,
    });
    expect(payload.omitted).toEqual({
      openTasks: 0,
      followups: 0,
      questions: 0,
      reviews: 0,
    });
    expect(payload.openTasks.map((task) => task.text)).toEqual([
      "Ship weekly update",
      "Send Ada launch notes",
      "Draft project staffing note",
      "Ask Ben about hiring budget",
    ]);
    expect(payload.openTasks.map((task) => task.dueDate)).toEqual([
      null,
      null,
      "2026-01-06",
      null,
    ]);
    expect(payload.openTasks.map((task) => task.priority)).toEqual([
      null,
      null,
      null,
      "highest",
    ]);
    expect(
      payload.openTasks.every((task) => typeof task.lastChangedAt === "string"),
    ).toBe(true);
    expect(payload.openTasks.map((task) => task.source)).toEqual([
      "daily",
      "daily",
      "daily",
      "daily",
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
      "daily",
    ]);
    // The ambiguous follow-up question is agent-safe, so it stays in the
    // agent-work lane and never spends the owner's Today budget.
    expect(payload.questions).toEqual([]);

    h.projection.raw.run(
      "INSERT INTO facts (namespace, subject_kind, subject_id, predicate, "
        + "object_json, assertion, confidence, source_refs, processor_id, "
        + "run_id, adopted_commit, written_at) "
        + "SELECT namespace, subject_kind, subject_id, predicate, object_json, "
        + "assertion, confidence, source_refs, processor_id, run_id, adopted_commit, "
        + "written_at FROM facts WHERE predicate IN "
        + "('dome.daily.open_task', 'dome.daily.followup')",
    );

    const deduped = await h.runCli(["run", "today", "--date", "2026-01-05", "--json"]);
    expect(deduped.exitCode).toBe(0);
    const dedupedPayload = structuredData(deduped.stdout) as {
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
      "run",
      "today",
      "--date",
      "2026-01-05",
      "--limit",
      "2",
      "--json",
    ]);
    expect(limited.exitCode).toBe(0);
    const limitedPayload = structuredData(limited.stdout) as {
      readonly limit: number;
      readonly counts: {
        readonly openTasks: number;
        readonly followups: number;
        readonly questions: number;
        readonly reviews: number;
      };
      readonly shown: {
        readonly openTasks: number;
        readonly followups: number;
        readonly questions: number;
        readonly reviews: number;
      };
      readonly omitted: {
        readonly openTasks: number;
        readonly followups: number;
        readonly questions: number;
        readonly reviews: number;
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
    expect(limitedPayload.counts.questions).toBe(0);
    expect(limitedPayload.shown).toEqual({
      openTasks: 2,
      followups: 2,
      questions: 0,
      reviews: 0,
    });
    expect(limitedPayload.omitted).toEqual({
      openTasks: 2,
      followups: 0,
      questions: 0,
      reviews: 0,
    });
    expect(limitedPayload.openTasks.map((task) => task.text)).toEqual(
      payload.openTasks.slice(0, 2).map((task) => task.text),
    );
    expect(limitedPayload.followups.map((task) => task.text)).toEqual(
      payload.followups.map((task) => task.text),
    );
    expect(limitedPayload.questions).toHaveLength(0);
  },
);

scenario(
  {
    name: "cli-surface: dome run today treats generated open loops as daily surface",
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
          "## Open Loops",
          "",
          "<!-- dome.daily:open-loops:start -->",
          "### Source-backed Open Loops",
          "- [ ] Ship alpha note 📅 2026-01-05 (from [[wiki/projects/alpha]])",
          "- [ ] #followup Ask Ada about beta 🔺 (from [[wiki/projects/beta]])",
          "- [x] Done generated task (from [[wiki/projects/done]])",
          "- [-] Dismissed generated task (from [[wiki/projects/dismissed]])",
          "<!-- dome.daily:open-loops:end -->",
          "",
        ].join("\n"),
        "wiki/projects/alpha.md": [
          "# Alpha",
          "",
          "TODO: Ship alpha note 📅 2026-01-05",
          "",
        ].join("\n"),
        "wiki/projects/beta.md": [
          "# Beta",
          "",
          "TODO: #followup Ask Ada about beta 🔺",
          "",
        ].join("\n"),
        "wiki/projects/other.md": [
          "# Other",
          "",
          "TODO: Backlog only task",
          "",
        ].join("\n"),
      },
      message: "add generated daily open-loop surface",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const json = await h.runCli(["run", "today", "--date", "2026-01-05", "--json"]);
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");

    const payload = structuredData(json.stdout) as {
      readonly counts: {
        readonly openTasks: number;
        readonly followups: number;
        readonly questions: number;
        readonly reviews: number;
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
      readonly openTasks: ReadonlyArray<{
        readonly text: string;
        readonly path: string;
        readonly line: number | null;
        readonly source: "daily" | "backlog";
        readonly followup: boolean;
        readonly dueDate: string | null;
        readonly priority: string | null;
        readonly evidenceLabel: string;
        readonly sourceRefs: ReadonlyArray<{ readonly path: string }>;
      }>;
      readonly followups: ReadonlyArray<{
        readonly text: string;
        readonly source: "daily" | "backlog";
      }>;
    };

    expect(payload.counts).toEqual({
      openTasks: 3,
      followups: 1,
      questions: 0,
      reviews: 0,
    });
    expect(payload.sourceCounts.daily).toEqual({
      openTasks: 3,
      followups: 1,
      questions: 0,
    });
    expect(payload.sourceCounts.backlog).toEqual({
      openTasks: 0,
      followups: 0,
      questions: 0,
    });
    expect(payload.dueCounts.openTasks).toEqual({
      overdue: 0,
      today: 1,
      upcoming: 0,
      undated: 2,
    });
    expect(payload.dueCounts.followups).toEqual({
      overdue: 0,
      today: 0,
      upcoming: 0,
      undated: 1,
    });
    expect(payload.openTasks.map((task) => task.text)).toEqual([
      "Ship alpha note",
      "Ask Ada about beta",
      "Backlog only task",
    ]);
    expect(payload.openTasks.map((task) => task.source)).toEqual([
      "daily",
      "daily",
      "daily",
    ]);
    expect(payload.openTasks.map((task) => task.path)).toEqual([
      "wiki/dailies/2026-01-05.md",
      "wiki/dailies/2026-01-05.md",
      "wiki/dailies/2026-01-05.md",
    ]);
    expect(payload.openTasks.map((task) => task.line)).toEqual([19, 20, 21]);
    expect(payload.openTasks.map((task) => task.dueDate)).toEqual([
      "2026-01-05",
      null,
      null,
    ]);
    expect(payload.openTasks.map((task) => task.priority)).toEqual([
      null,
      "highest",
      null,
    ]);
    expect(payload.openTasks[0]?.sourceRefs.map((ref) => ref.path).sort())
      .toEqual(["wiki/dailies/2026-01-05.md", "wiki/projects/alpha.md"]);
    expect(payload.openTasks[1]?.sourceRefs.map((ref) => ref.path).sort())
      .toEqual(["wiki/dailies/2026-01-05.md", "wiki/projects/beta.md"]);
    expect(payload.openTasks[2]?.sourceRefs.map((ref) => ref.path).sort())
      .toEqual(["wiki/dailies/2026-01-05.md", "wiki/projects/other.md"]);
    expect(payload.openTasks.map((task) => task.evidenceLabel)).toEqual([
      "wiki/dailies/2026-01-05.md:19; source wiki/projects/alpha.md:3",
      "wiki/dailies/2026-01-05.md:20; source wiki/projects/beta.md:3",
      "wiki/dailies/2026-01-05.md:21; source wiki/projects/other.md:3",
    ]);
    expect(payload.followups.map((task) => ({
      text: task.text,
      source: task.source,
    }))).toEqual([{ text: "Ask Ada about beta", source: "daily" }]);

    const prep = await h.runCli([
      "run",
      "prep",
      "--date",
      "2026-01-05",
      "--limit",
      "5",
      "--json",
    ]);
    expect(prep.exitCode).toBe(0);
    expect(prep.stderr).toBe("");
    const prepPayload = structuredData(prep.stdout) as {
      readonly counts: {
        readonly openTasks: number;
        readonly followups: number;
        readonly questions: number;
        readonly reviews: number;
      };
      readonly sourceCounts: typeof payload.sourceCounts;
    };
    expect(prepPayload.counts).toEqual(payload.counts);
    expect(prepPayload.sourceCounts).toEqual(payload.sourceCounts);
  },
);

scenario(
  {
    name: "cli-surface: dome run today samples daily and backlog rows within the limit",
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
          "- [ ] #task Backlog one",
          "- [ ] #task Backlog two",
          "- [ ] #task Backlog three",
          "",
        ].join("\n"),
      },
      message: "add daily and backlog tasks",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const json = await h.runCli([
      "run",
      "today",
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
      readonly shown: { readonly openTasks: number };
      readonly omitted: { readonly openTasks: number };
      readonly openTasks: ReadonlyArray<{
        readonly text: string;
        readonly source: "daily" | "backlog";
      }>;
    };
    expect(payload.limit).toBe(2);
    expect(payload.counts.openTasks).toBe(6);
    expect(payload.sourceCounts.daily.openTasks).toBe(3);
    expect(payload.sourceCounts.backlog.openTasks).toBe(3);
    expect(payload.shown.openTasks).toBe(4);
    expect(payload.omitted.openTasks).toBe(2);
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
  },
);

scenario(
  {
    name: "cli-surface: dome run today ranks backlog by due proximity and recency",
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
    // Keep both timestamped owner commits pending, then compile the whole
    // range once. Today ranking needs each path's Git-derived human-change
    // time; it does not need one complete compiler cycle per commit.
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const json = await h.runCli(["run", "today", "--date", "2026-01-05", "--json"]);
    expect(json.exitCode).toBe(0);
    const payload = structuredData(json.stdout) as {
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
      "run",
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
    name: "cli-surface: dome run today folds exact and near-duplicate open loops",
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
          "TODO: Hayden conversation — pull up prep card 30 min before; walk-in order mandate then comp 📅 2026-01-04 🔺",
          "TODO: Book hotel for Seattle",
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
          "",
        ].join("\n"),
        "wiki/dailies/2026-01-05.md": [
          "# 2026-01-05",
          "",
          "## Notes",
          "",
          "TODO: Hayden conversation — pull up prep card 30 min before; walk-in order is mandate first, then compensation 📅 2026-01-05 🔺",
          "TODO: Draft launch staffing note",
          "",
        ].join("\n"),
      },
      message: "add current exact and near-duplicate tasks",
      author: {
        name: "dome-test",
        email: "test@local",
        timestamp: Date.parse("2026-01-05T09:00:00.000Z") / 1000,
      },
    });
    const newSync = await h.tick();
    expect(newSync.adopted).toBe(true);

    const json = await h.runCli(["run", "today", "--date", "2026-01-05", "--json"]);
    expect(json.exitCode).toBe(0);
    const payload = structuredData(json.stdout) as {
      readonly counts: { readonly openTasks: number };
      readonly sourceCounts: {
        readonly daily: { readonly openTasks: number };
        readonly backlog: { readonly openTasks: number };
      };
      readonly openTasks: ReadonlyArray<{
        readonly text: string;
        readonly path: string;
        readonly source: "daily" | "backlog";
        readonly sourceRefs: ReadonlyArray<{ readonly path: string }>;
      }>;
    };

    expect(payload.counts.openTasks).toBe(4);
    expect(payload.sourceCounts.daily.openTasks).toBe(2);
    expect(payload.sourceCounts.backlog.openTasks).toBe(2);
    expect(payload.openTasks.map((task) => task.text)).toEqual([
      "Hayden conversation — pull up prep card 30 min before; walk-in order is mandate first, then compensation",
      "Draft launch staffing note",
      "Ship Conv 1 written follow-up",
      "Book hotel for Seattle",
    ]);
    const repeated = payload.openTasks.find((task) =>
      task.text === "Ship Conv 1 written follow-up"
    );
    expect(repeated?.path).toBe("wiki/projects/new.md");
    expect(repeated?.sourceRefs.map((ref) => ref.path).sort())
      .toEqual(["wiki/projects/new.md", "wiki/projects/old.md"]);
    const hayden = payload.openTasks.find((task) =>
      task.text.startsWith("Hayden conversation")
    );
    expect(hayden?.path).toBe("wiki/dailies/2026-01-05.md");
    expect(hayden?.source).toBe("daily");
    expect(hayden?.sourceRefs.map((ref) => ref.path).sort()).toEqual([
      "wiki/dailies/2026-01-05.md",
      "wiki/projects/old.md",
    ]);
  },
);

// Task 9 (PWA checkbox settles for real): the today payload's `blockId` field
// — a compatible widening of dome.daily.today/v1. A task line that already
// carries a stamped ^block-anchor surfaces it as `blockId` (the identity
// `performSettle` looks up); a task with no anchor omits the field entirely
// — never a synthesized id.
//
// `dome.daily.stamp-block-id` auto-stamps every unanchored task line within
// the SAME tick (garden cascade resolves inline in this harness), so a
// genuinely-unanchored probe needs a path outside its `patch.auto` grant —
// here, `wiki/projects/**` is read-only (stamping silently skipped per
// stamp-block-id.ts's "narrow grant simply skips the stamp" design), while
// `wiki/dailies/*.md` keeps the default patch.auto grant.
scenario(
  {
    name: "cli-surface: dome run today carries blockId for anchored tasks, omits it otherwise",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "fact" },
      { kind: "effect", effect: "patch" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "garden" },
      { kind: "phase", phase: "view" },
      { kind: "capability", capability: "graph.write" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "command" },
    ],
    harness: {
      clock: new TestClock("2026-01-05T15:00:00.000Z"),
      bundles: ["dome.daily"],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  dome.daily:
    enabled: true
    grant:
      read: ["wiki/**/*.md", "notes/*.md"]
      patch.auto: ["wiki/dailies/*.md"]
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
        "wiki/dailies/2026-01-05.md": [
          "---",
          "type: daily",
          "recurrence: 2026-01-05",
          "---",
          "",
          "# 2026-01-05",
          "",
          "- [ ] Ship the anchored task ^t1a2b3c4",
          "",
        ].join("\n"),
        "wiki/projects/backlog.md": [
          "# Backlog",
          "",
          "TODO: Backlog anchored task ^tdeadbeef",
          "TODO: Backlog unanchored task",
          "",
        ].join("\n"),
      },
      message: "add anchored and unanchored tasks",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const json = await h.runCli(["run", "today", "--date", "2026-01-05", "--json"]);
    expect(json.exitCode).toBe(0);
    const payload = structuredData(json.stdout) as {
      readonly openTasks: ReadonlyArray<{
        readonly text: string;
        readonly source: "daily" | "backlog";
        readonly blockId?: string;
      }>;
    };

    const anchoredDaily = payload.openTasks.find((t) => t.text === "Ship the anchored task");
    const anchoredBacklog = payload.openTasks.find((t) => t.text === "Backlog anchored task");
    const unanchoredBacklog = payload.openTasks.find((t) => t.text === "Backlog unanchored task");

    expect(anchoredDaily?.blockId).toBe("t1a2b3c4");
    expect(anchoredBacklog?.blockId).toBe("tdeadbeef");
    expect(unanchoredBacklog?.blockId).toBeUndefined();
  },
);

scenario(
  {
    name: "cli-surface: dome run today respects configured daily note path",
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
      clock: new TestClock("2026-01-05T15:00:00.000Z"),
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

    const json = await h.runCli(["run", "today", "--date", "2026-01-05", "--json"]);
    expect(json.exitCode).toBe(0);
    const payload = structuredData(json.stdout) as {
      readonly daily: { readonly path: string; readonly exists: boolean };
      readonly sourceCounts: {
        readonly daily: { readonly openTasks: number };
        readonly backlog: { readonly openTasks: number };
      };
    };

    expect(payload.daily.path).toBe("notes/2026-01-05.md");
    expect(payload.daily.exists).toBe(true);
    expect(payload.sourceCounts.daily.openTasks).toBe(2);
    expect(payload.sourceCounts.backlog.openTasks).toBe(0);
  },
);

function structuredData(stdout: string): unknown {
  const envelope = JSON.parse(stdout) as { readonly data?: unknown };
  return envelope.data;
}
