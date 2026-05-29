// scenarios/cli-surface/agenda-view.scenario.test.ts
//
// `dome agenda` renders source-backed person/topic prep by composing daily
// task facts with adopted-state search context.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "cli-surface: dome agenda renders source-backed people and topic prep",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "fact" },
      { kind: "effect", effect: "question" },
      { kind: "effect", effect: "search-document" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "view" },
      { kind: "capability", capability: "graph.write" },
      { kind: "capability", capability: "question.ask" },
      { kind: "capability", capability: "search.write" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "command" },
    ],
    harness: { bundles: ["dome.daily", "dome.search"] },
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
          "- [ ] #followup Send Ada launch notes",
          "- [ ] Ask Ben about hiring budget",
          "",
        ].join("\n"),
        "wiki/projects/launch.md": [
          "---",
          "type: project",
          "title: Launch Plan",
          "---",
          "",
          "# Launch Plan",
          "",
          "TODO: Draft Ada staffing note",
          "Follow up: Ask Ada about rollout risks",
          "We should follow up with Ada about review timing.",
          "Ada owns the launch staffing conversation.",
          "",
        ].join("\n"),
      },
      message: "add agenda context",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const text = await h.runCli([
      "agenda",
      "Ada",
      "--date",
      "2026-01-05",
      "--limit",
      "4",
    ]);
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toContain("# Dome Agenda: Ada");
    expect(text.stdout).toContain(
      "[followup] Ask Ada about rollout risks (wiki/projects/launch.md:9)",
    );
    expect(text.stdout).toContain(
      "[followup] #followup Send Ada launch notes (wiki/dailies/2026-01-05.md:8)",
    );
    expect(text.stdout).toContain("## SourceRefs");

    const json = await h.runCli([
      "agenda",
      "Ada",
      "--date",
      "2026-01-05",
      "--limit",
      "4",
      "--json",
    ]);
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");

    const payload = JSON.parse(json.stdout) as {
      readonly topic: string;
      readonly date: string;
      readonly counts: {
        readonly agendaItems: number;
        readonly context: number;
      };
      readonly agendaItems: ReadonlyArray<{
        readonly kind: string;
        readonly text: string;
        readonly path: string;
        readonly sourceRefs: ReadonlyArray<{ readonly path: string }>;
      }>;
      readonly context: ReadonlyArray<{ readonly path: string }>;
      readonly markdown: string;
    };

    expect(payload.topic).toBe("Ada");
    expect(payload.date).toBe("2026-01-05");
    expect(payload.counts.agendaItems).toBe(4);
    expect(payload.counts.context).toBeGreaterThan(0);
    expect(payload.agendaItems.map((item) => item.text)).toEqual([
      "#followup Send Ada launch notes",
      "Ask Ada about rollout risks",
      'Possible follow-up in wiki/projects/launch.md:10: "We should follow up with Ada about review timing.". Should Dome track this as a follow-up?',
      "Draft Ada staffing note",
    ]);
    expect(payload.agendaItems.map((item) => item.text).join("\n")).not
      .toContain("Ben");
    expect(payload.agendaItems[0]?.sourceRefs[0]?.path).toBe(
      payload.agendaItems[0]?.path,
    );
    expect(payload.context.map((entry) => entry.path)).toContain(
      "wiki/projects/launch.md",
    );
    expect(payload.markdown).toContain("# Dome Agenda: Ada");
  },
);
