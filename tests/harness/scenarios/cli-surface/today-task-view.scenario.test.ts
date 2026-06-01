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
          "TODO: Draft project staffing note",
          "Follow up: Ask Ben about hiring budget",
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
      readonly openTasks: ReadonlyArray<{
        readonly text: string;
        readonly path: string;
        readonly line: number | null;
        readonly followup: boolean;
        readonly sourceRefs: ReadonlyArray<{ readonly path: string }>;
      }>;
      readonly followups: ReadonlyArray<{ readonly text: string }>;
      readonly questions: ReadonlyArray<{
        readonly id: number;
        readonly question: string;
        readonly options: ReadonlyArray<string>;
        readonly resolveCommand: string;
        readonly path: string;
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
    expect(payload.openTasks.map((task) => task.text)).toEqual([
      "Draft project staffing note",
      "Ask Ben about hiring budget",
      "Ship weekly update",
      "Send Ada launch notes",
    ]);
    expect(
      payload.openTasks.every((task) =>
        task.sourceRefs.some((ref) => ref.path === task.path)
      ),
    ).toBe(true);
    expect(payload.followups.map((task) => task.text)).toEqual([
      "Ask Ben about hiring budget",
      "Send Ada launch notes",
    ]);
    expect(payload.questions[0]?.question).toContain(
      "We should follow up with Cy about review timing",
    );
    expect(payload.questions[0]?.id).toBeGreaterThan(0);
    expect(payload.questions[0]?.options).toEqual(["track", "ignore"]);
    expect(payload.questions[0]?.resolveCommand).toBe(
      `dome resolve ${payload.questions[0]?.id} <track|ignore>`,
    );
    expect(payload.questions[0]?.path).toBe("wiki/captures/2026-01-05.md");

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
    expect(text.stdout).toContain("4 open | 2 followups | 1 questions");
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
    expect(limitedText.stdout).not.toContain("Ship weekly update");
  },
);
