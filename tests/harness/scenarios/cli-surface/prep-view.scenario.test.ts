// scenarios/cli-surface/prep-view.scenario.test.ts
//
// `dome prep` is a source-backed planning packet over the daily task facts.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "cli-surface: dome prep renders source-backed planning context",
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
        "wiki/captures/launch.md": [
          "---",
          "type: source",
          "title: Launch",
          "---",
          "",
          "# Launch",
          "",
          "TODO: Draft launch staffing note",
          "Follow up: Ask Ben about hiring budget",
          "We should follow up with Cy about review timing",
          "",
        ].join("\n"),
      },
      message: "add prep context",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const text = await h.runCli([
      "prep",
      "--date",
      "2026-01-05",
      "--limit",
      "3",
    ]);
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toContain("# Dome Prep: 2026-01-05");
    expect(text.stdout).toContain("Daily note: wiki/dailies/2026-01-05.md");
    expect(text.stdout).toContain(
      "[followup] Ask Ben about hiring budget (wiki/captures/launch.md:9)",
    );
    expect(text.stdout).toContain("resolve: dome resolve ");
    expect(text.stdout).toContain("<track|ignore>");
    expect(text.stdout).toContain(
      "- ... 1 more open task (use --limit 4 to show all open tasks)",
    );
    expect(text.stdout).toContain("## SourceRefs");

    const json = await h.runCli([
      "prep",
      "--date",
      "2026-01-05",
      "--limit",
      "2",
      "--json",
    ]);
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");

    const payload = JSON.parse(json.stdout) as {
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
      readonly planningItems: ReadonlyArray<{
        readonly kind: string;
        readonly text: string;
        readonly path: string;
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
    expect(payload.planningItems.map((item) => item.kind)).toEqual([
      "followup",
      "followup",
    ]);
    expect(payload.planningItems.map((item) => item.text)).toEqual([
      "Send Ada launch notes",
      "Ask Ben about hiring budget",
    ]);
    expect(payload.planningItems[0]?.sourceRefs[0]?.path).toBe(
      payload.planningItems[0]?.path,
    );
    expect(payload.markdown).toContain("# Dome Prep: 2026-01-05");
    expect(payload.markdown).toContain("resolve: dome resolve ");
    expect(payload.markdown).toContain("<track|ignore>");
    expect(payload.markdown).toContain(
      "- ... 2 more open tasks (use --limit 4 to show all open tasks)",
    );
    expect(payload.markdown).toContain("wiki/captures/launch.md:9-9 @");
    expect(payload.markdown).toContain("wiki/captures/launch.md:10-10 @");
    expect(payload.markdown).toContain("wiki/dailies/2026-01-05.md @");
    expect(payload.markdown).toContain("wiki/dailies/2026-01-05.md:8-8 @");
    expect(payload.markdown).toContain("wiki/dailies/2026-01-05.md:9-9 @");
    expect(payload.markdown).not.toContain("wiki/captures/launch.md:8-8 @");
  },
);
