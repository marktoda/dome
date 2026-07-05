// scenarios/cli-surface/agenda-view.scenario.test.ts
//
// `dome run agenda-with` renders source-backed person/topic prep by composing daily
// task facts with adopted-state search context.

import { expect } from "bun:test";

import { TestClock, scenario } from "../../index";

scenario(
  {
    name: "cli-surface: dome run agenda-with renders source-backed people and topic prep",
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
    harness: {
      clock: new TestClock("2026-01-05T15:00:00.000Z"),
      bundles: ["dome.daily", "dome.search"],
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
          "Follow up: Ask Ada about rollout risks 🔺",
          "We should follow up with Ada about review timing.",
          "Ada owns the launch staffing conversation.",
          "- [ ] Share Ada launch checklist",
          "",
        ].join("\n"),
      },
      message: "add agenda context",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const text = await h.runCli([
      "run",
      "agenda-with",
      "Ada",
      "--date",
      "2026-01-05",
      "--limit",
      "4",
    ]);
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toBe("");
    const textPayload = structuredData(text.stdout) as {
      readonly markdown: string;
    };
    expect(textPayload.markdown).toContain("# Dome Agenda: Ada");
    expect(textPayload.markdown).toContain(
      "[followup] Ask Ada about rollout risks (wiki/dailies/2026-01-05.md:23; source wiki/projects/launch.md:9)",
    );
    expect(textPayload.markdown).toContain(
      "[followup] Send Ada launch notes (wiki/dailies/2026-01-05.md:8)",
    );
    expect(textPayload.markdown).toContain(
      "- ... 1 more agenda item (use --limit 5 to show all agenda items)",
    );
    expect(textPayload.markdown).toContain("resolve: dome resolve ");
    expect(textPayload.markdown).toContain("<track|ignore>");
    expect(textPayload.markdown).toContain("## SourceRefs");

    const json = await h.runCli([
      "run",
      "agenda-with",
      "Ada",
      "--date",
      "2026-01-05",
      "--limit",
      "4",
      "--json",
    ]);
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");

    const payload = structuredData(json.stdout) as {
      readonly topic: string;
      readonly date: string;
      readonly counts: {
        readonly agendaItems: number;
        readonly context: number;
      };
      readonly shown: {
        readonly agendaItems: number;
        readonly context: number;
      };
      readonly omitted: {
        readonly agendaItems: number;
      };
      readonly agendaItems: ReadonlyArray<{
        readonly kind: string;
        readonly text: string;
        readonly questionId?: number;
        readonly resolveCommand?: string;
        readonly path: string;
        readonly dueDate: string | null;
        readonly priority: string | null;
        readonly evidenceLabel: string;
        readonly sourceRefs: ReadonlyArray<{ readonly path: string }>;
      }>;
      readonly context: ReadonlyArray<{ readonly path: string }>;
      readonly markdown: string;
    };

    expect(payload.topic).toBe("Ada");
    expect(payload.date).toBe("2026-01-05");
    expect(payload.counts.agendaItems).toBe(5);
    expect(payload.counts.context).toBeGreaterThan(0);
    expect(payload.shown.agendaItems).toBe(4);
    expect(payload.shown.context).toBe(payload.context.length);
    expect(payload.omitted.agendaItems).toBe(1);
    expect(payload.agendaItems.map((item) => item.text)).toEqual([
      "Send Ada launch notes",
      "Ask Ada about rollout risks",
      'Possible follow-up in wiki/projects/launch.md:10: "We should follow up with Ada about review timing.". Should Dome track this as a follow-up?',
      "Draft Ada staffing note",
    ]);
    expect(payload.agendaItems.map((item) => item.priority)).toEqual([
      null,
      "highest",
      null,
      null,
    ]);
    expect(payload.agendaItems[1]?.evidenceLabel).toBe(
      "wiki/dailies/2026-01-05.md:23; source wiki/projects/launch.md:9",
    );
    const questionItem = payload.agendaItems.find((item) =>
      item.kind === "question"
    );
    expect(questionItem?.questionId).toBeGreaterThan(0);
    expect(questionItem?.resolveCommand).toBe(
      `dome resolve ${questionItem?.questionId} <track|ignore>`,
    );
    expect(payload.agendaItems.map((item) => item.text).join("\n")).not
      .toContain("Ben");
    expect(payload.agendaItems[0]?.sourceRefs[0]?.path).toBe(
      payload.agendaItems[0]?.path,
    );
    expect(payload.agendaItems[1]?.sourceRefs.map((ref) => ref.path).sort())
      .toEqual(["wiki/dailies/2026-01-05.md", "wiki/projects/launch.md"]);
    expect(payload.context.map((entry) => entry.path)).toContain(
      "wiki/projects/launch.md",
    );
    expect(payload.markdown).toContain("# Dome Agenda: Ada");
    expect(payload.markdown).toContain("resolve: dome resolve ");
    expect(payload.markdown).toContain("<track|ignore>");
    expect(payload.markdown).toContain(
      "- ... 1 more agenda item (use --limit 5 to show all agenda items)",
    );

    const limitedContext = await h.runCli([
      "run",
      "agenda-with",
      "Ada",
      "--date",
      "2026-01-05",
      "--limit",
      "1",
      "--json",
    ]);
    expect(limitedContext.exitCode).toBe(0);
    expect(limitedContext.stderr).toBe("");
    const limitedPayload = structuredData(limitedContext.stdout) as {
      readonly shown: {
        readonly context: number;
      };
      readonly hasMore: {
        readonly context: boolean;
      };
      readonly context: ReadonlyArray<{ readonly path: string }>;
      readonly markdown: string;
    };
    expect(limitedPayload.shown.context).toBe(1);
    expect(limitedPayload.context.length).toBe(1);
    expect(limitedPayload.hasMore.context).toBe(true);
    expect(limitedPayload.markdown).toContain(
      "more context matches exist (increase --limit to show more context)",
    );
  },
);

// `dome agenda-with` (Task 14) is the dedicated top-level verb over the same
// `dome.daily.agenda-with` view processor — previously reachable only via
// the hidden `dome run agenda-with` dispatcher. `--json` emits the bare
// structured payload (no `{name,kind,schema,data}` envelope), matching its
// `dome query` / `dome export-context` siblings.
scenario(
  {
    name: "cli-surface: dome agenda-with (dedicated verb) dispatches to dome.daily.agenda-with",
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
          "- [ ] Ask Cy about the launch",
          "",
        ].join("\n"),
      },
      message: "add dedicated-verb agenda task",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    // Missing person/topic is a usage error (64) before the vault opens.
    const missing = await h.runCli(["agenda-with", "--date", "2026-01-05"]);
    expect(missing.exitCode).toBe(64);

    // Default text output is the rendered markdown packet.
    const text = await h.runCli([
      "agenda-with",
      "Cy",
      "--date",
      "2026-01-05",
    ]);
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toContain("# Dome Agenda: Cy");
    expect(text.stdout).toContain("Ask Cy about the launch");
    expect(text.stdout).not.toMatch(/^\s*[{[]/); // not a JSON envelope

    // `--json` emits the bare `dome.daily.agenda-with/v1` payload.
    const json = await h.runCli([
      "agenda-with",
      "Cy",
      "--date",
      "2026-01-05",
      "--json",
    ]);
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");
    const payload = JSON.parse(json.stdout) as {
      readonly schema: string;
      readonly topic: string;
      readonly markdown: string;
    };
    expect(payload.schema).toBe("dome.daily.agenda-with/v1");
    expect(payload.topic).toBe("Cy");
    expect(payload.markdown).toContain("Ask Cy about the launch");
  },
);

function structuredData(stdout: string): unknown {
  const envelope = JSON.parse(stdout) as { readonly data?: unknown };
  return envelope.data;
}
