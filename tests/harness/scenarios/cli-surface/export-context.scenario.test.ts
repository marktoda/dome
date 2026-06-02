// scenarios/cli-surface/export-context.scenario.test.ts
//
// `dome export-context` packages adopted search matches and related facts into
// a portable markdown packet for cross-session handoff.

import { expect } from "bun:test";
import { join } from "node:path";

import { scenario } from "../../index";

const CONTEXT_SIGNAL_BUNDLE_ROOT = join(
  __dirname,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.context-signal",
);

function localDateString(date: Date = new Date()): string {
  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

scenario(
  {
    name: "cli-surface: dome export-context returns source-backed markdown packet",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "search-document" },
      { kind: "effect", effect: "fact" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "view" },
      { kind: "capability", capability: "graph.write" },
      { kind: "capability", capability: "search.write" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "command" },
    ],
    harness: {
      bundles: ["dome.markdown", "dome.graph", "dome.search", "dome.daily"],
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/project-alpha.md":
          "---\n" +
          "type: concept\n" +
          "tags:\n" +
          "  - strategy\n" +
          "  - launch\n" +
          "  - alpha\n" +
          "  - ownership\n" +
          "  - runtime\n" +
          "  - platform\n" +
          "  - staffing\n" +
          "  - handoff\n" +
          "  - planning\n" +
          "---\n" +
          "# Project Alpha\n\n" +
          "The alpha launch ownership model assigns platform runtime to Danny.\n" +
          "- [ ] Book hotel for beta retreat\n" +
          "- [ ] Ask Danny about alpha launch handoff 🔺 📅 2026-01-07\n" +
          "\n" +
          "See [[missing-alpha-owner]].\n",
        "wiki/project-alpha-copy.md":
          "---\n" +
          "type: concept\n" +
          "---\n" +
          "# Project Alpha\n\n" +
          "The alpha launch ownership model assigns platform runtime to Danny.\n" +
          "- [ ] Book hotel for beta retreat\n" +
          "- [ ] Ask Danny about alpha launch handoff 🔺 📅 2026-01-07\n" +
          "\n" +
          "See [[missing-alpha-owner]].\n",
        "wiki/project-beta.md":
          "---\n" +
          "type: concept\n" +
          "---\n" +
          "# Project Beta\n\n" +
          "The beta launch has a different staffing plan.\n",
      },
      message: "add exportable context",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const text = await h.runCli(["export-context", "alpha launch"]);
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toContain("# Dome Context: alpha launch");
    expect(text.stdout).toContain("## Read First");
    expect(text.stdout).toContain("## Open Loops");
    expect(text.stdout).toContain("## Unresolved Questions");
    expect(text.stdout).toContain("## Active Diagnostics");
    expect(text.stdout).toContain("wiki/project-alpha.md");
    expect(text.stdout).toContain("- Ranking:");
    expect(text.stdout).toContain("alpha launch ownership model");
    expect(text.stdout).toContain("SourceRefs:");
    expect(text.stdout).toContain("Summary:");
    expect(text.stdout).toContain("`open-loop`: Ask Danny about alpha launch handoff");
    expect(text.stdout).toContain("dome.graph.tagged");
    expect(text.stdout).toContain(
      "Ask Danny about alpha launch handoff [due: 2026-01-07, priority: highest]",
    );
    expect(text.stdout).not.toContain(
      "Ask Danny about alpha launch handoff 🔺 📅 2026-01-07",
    );
    expect(text.stdout).toContain("more facts");
    expect(text.stdout).toContain("Diagnostics:");
    expect(text.stdout).toContain("dome.markdown.broken-wikilink");
    expect(text.stdout).toContain("Questions:");
    expect(text.stdout).toContain("resolve: dome resolve ");

    const json = await h.runCli([
      "export-context",
      "alpha launch",
      "--json",
      "--limit",
      "3",
    ]);
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");

    const payload = JSON.parse(json.stdout) as {
      readonly topic: string;
      readonly limit: number;
      readonly shown: { readonly entries: number };
      readonly hasMore: { readonly entries: boolean };
      readonly overview: {
        readonly readFirst: ReadonlyArray<{
          readonly path: string;
          readonly reason: string;
          readonly ranking: {
            readonly score: number;
            readonly ftsRank: number;
            readonly reasons: ReadonlyArray<string>;
          };
        }>;
        readonly openLoops: ReadonlyArray<{
          readonly path: string;
          readonly text: string;
        }>;
        readonly unresolvedQuestions: ReadonlyArray<{
          readonly id: number;
          readonly resolveCommand: string;
          readonly metadata?: {
            readonly automationPolicy?: string;
          };
          readonly automationPolicy?: string;
        }>;
        readonly diagnostics: ReadonlyArray<{
          readonly path: string;
          readonly code: string;
        }>;
      };
      readonly markdown: string;
      readonly entries: ReadonlyArray<{
        readonly path: string;
        readonly title: string;
        readonly ranking: {
          readonly score: number;
          readonly ftsRank: number;
          readonly reasons: ReadonlyArray<string>;
        };
        readonly sourceRefs: ReadonlyArray<{ readonly path: string }>;
        readonly summary: ReadonlyArray<{
          readonly kind: string;
          readonly text: string;
          readonly sourceRefs: ReadonlyArray<{ readonly path: string }>;
        }>;
        readonly facts: ReadonlyArray<{
          readonly predicate: string;
          readonly object: string;
        }>;
        readonly diagnostics: ReadonlyArray<{ readonly code: string }>;
        readonly questions: ReadonlyArray<{
          readonly id: number;
          readonly question: string;
          readonly resolveCommand: string;
          readonly metadata?: {
            readonly automationPolicy?: string;
          };
          readonly automationPolicy?: string;
        }>;
      }>;
    };

    expect(payload.topic).toBe("alpha launch");
    expect(payload.limit).toBe(3);
    expect(payload.shown.entries).toBe(payload.entries.length);
    expect(payload.hasMore.entries).toBe(false);
    expect(payload.markdown).toContain("# Dome Context: alpha launch");
    expect(payload.overview.readFirst.map((item) => item.path)).toContain(
      "wiki/project-alpha.md",
    );
    expect(payload.overview.readFirst.some((item) =>
      item.reason.includes("open loop")
    )).toBe(true);
    expect(payload.overview.readFirst.some((item) =>
      item.ranking.reasons.includes("concept page")
    )).toBe(true);
    expect(payload.overview.openLoops.some((item) =>
      item.text ===
        "Ask Danny about alpha launch handoff [due: 2026-01-07, priority: highest]"
    )).toBe(true);
    expect(payload.overview.openLoops.some((item) =>
      item.text === "Book hotel for beta retreat"
    )).toBe(false);
    expect(payload.overview.unresolvedQuestions.some((item) =>
      item.resolveCommand.includes("dome resolve")
    )).toBe(true);
    expect(payload.overview.diagnostics.some((diagnostic) =>
      diagnostic.code === "dome.markdown.broken-wikilink"
    )).toBe(true);
    const alpha = payload.entries.find(
      (entry) => entry.path === "wiki/project-alpha.md",
    );
    expect(alpha?.title).toBe("Project Alpha");
    expect(alpha?.ranking.score).toBeGreaterThan(0);
    expect(alpha?.ranking.reasons.some((reason) => reason.includes("open loop")))
      .toBe(true);
    expect(alpha?.sourceRefs[0]?.path).toBe("wiki/project-alpha.md");
    expect(alpha?.summary).toContainEqual(
      expect.objectContaining({
        kind: "open-loop",
        text:
          "Ask Danny about alpha launch handoff [due: 2026-01-07, priority: highest]",
        sourceRefs: expect.arrayContaining([
          expect.objectContaining({ path: "wiki/project-alpha.md" }),
        ]),
      }),
    );
    expect(alpha?.summary.some((item) =>
      item.kind === "open-loop" && item.text === "Book hotel for beta retreat"
    )).toBe(false);
    expect(alpha?.summary.every((item) => item.sourceRefs.length > 0)).toBe(true);
    expect(alpha?.facts.some((fact) => fact.predicate === "dome.graph.tagged"))
      .toBe(true);
    expect(alpha?.facts).toContainEqual(
      expect.objectContaining({
        predicate: "dome.daily.open_task",
        object:
          "Ask Danny about alpha launch handoff [due: 2026-01-07, priority: highest]",
      }),
    );
    expect((alpha?.facts.length ?? 0)).toBeLessThanOrEqual(8);
    expect(payload.markdown).toContain("more facts");
    expect(alpha?.diagnostics.some(
      (diagnostic) => diagnostic.code === "dome.markdown.broken-wikilink",
    )).toBe(true);
    const question = alpha?.questions.find((question) =>
      question.question.includes("Possible duplicate pages")
    );
    expect(question?.id).toBeGreaterThan(0);
    expect(question?.resolveCommand).toBe(
      `dome resolve ${question?.id} <merge|keep separate>`,
    );
    expect(question?.metadata?.automationPolicy).toBe("owner-needed");
    expect(question?.automationPolicy).toBe("owner-needed");

    const limitedText = await h.runCli([
      "export-context",
      "alpha launch",
      "--limit",
      "1",
    ]);
    expect(limitedText.exitCode).toBe(0);
    expect(limitedText.stderr).toBe("");
    expect(limitedText.stdout).toContain(
      "more adopted-state matches exist (increase --limit to include more entries)",
    );

    const limitedJson = await h.runCli([
      "export-context",
      "alpha launch",
      "--limit",
      "1",
      "--json",
    ]);
    expect(limitedJson.exitCode).toBe(0);
    expect(limitedJson.stderr).toBe("");
    const limitedPayload = JSON.parse(limitedJson.stdout) as {
      readonly limit: number;
      readonly shown: { readonly entries: number };
      readonly hasMore: { readonly entries: boolean };
      readonly markdown: string;
      readonly entries: ReadonlyArray<{ readonly path: string }>;
    };
    expect(limitedPayload.limit).toBe(1);
    expect(limitedPayload.shown.entries).toBe(1);
    expect(limitedPayload.hasMore.entries).toBe(true);
    expect(limitedPayload.entries).toHaveLength(1);
    expect(limitedPayload.markdown).toContain(
      "more adopted-state matches exist (increase --limit to include more entries)",
    );
  },
);

scenario(
  {
    name: "cli-surface: dome export-context recalls current daily surface for daily-intent packets",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "search-document" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "view" },
      { kind: "capability", capability: "search.write" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "command" },
    ],
    harness: { bundles: ["dome.markdown", "dome.search"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const today = localDateString();
    const dailyPath = `notes/${today}.md`;
    const oldDailyPath = "notes/2026-01-01.md";
    await h.userCommit({
      files: {
        [dailyPath]:
          `# ${today}\n\n` +
          "## Open Loops\n\n" +
          "<!-- dome.daily:open-loops:start -->\n" +
          "### Source-backed Open Loops\n" +
          "- [ ] #followup Handle source-backed launch review 🔺 " +
          `📅 ${today} (from [[wiki/source-project]])\n` +
          "<!-- dome.daily:open-loops:end -->\n\n" +
          "## Notes\n\n" +
          "- [ ] Handle the current launch review.\n",
        [oldDailyPath]:
          "---\n" +
          "type: daily\n" +
          "recurrence: 2026-01-01\n" +
          "---\n\n" +
          "# 2026-01-01\n\n" +
          "What should I work on today?\n\n" +
          "- [ ] Historical daily task should not be read-first today.\n",
        "wiki/source-project.md":
          "# Source Project\n\n" +
          "- [ ] #followup Handle source-backed launch review 🔺 " +
          `📅 ${today}\n`,
      },
      message: "add current daily note",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const cli = await h.runCli([
      "export-context",
      "what should I work on today",
      "--json",
      "--limit",
      "4",
    ]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stderr).toBe("");

    const payload = JSON.parse(cli.stdout) as {
      readonly overview: {
        readonly readFirst: ReadonlyArray<{
          readonly path: string;
          readonly reason: string;
          readonly ranking: {
            readonly reasons: ReadonlyArray<string>;
          };
        }>;
        readonly recallSignals: ReadonlyArray<{
          readonly path: string;
          readonly kind: string;
          readonly label: string;
          readonly sourceRefs: ReadonlyArray<{ readonly path: string }>;
        }>;
        readonly openLoops: ReadonlyArray<{
          readonly path: string;
          readonly predicate: string;
          readonly text: string;
          readonly sourceRefs: ReadonlyArray<{ readonly path: string }>;
        }>;
      };
      readonly markdown: string;
      readonly entries: ReadonlyArray<{
        readonly path: string;
        readonly ranking: { readonly reasons: ReadonlyArray<string> };
        readonly sourceRefs: ReadonlyArray<{ readonly path: string }>;
      }>;
    };

    expect(payload.entries[0]?.path).toBe(dailyPath);
    expect(payload.entries.map((entry) => entry.path)).not.toContain(
      oldDailyPath,
    );
    expect(payload.entries[0]?.ranking.reasons).toContain(
      "current daily surface",
    );
    expect(payload.entries[0]?.sourceRefs).toContainEqual(
      expect.objectContaining({ path: dailyPath }),
    );
    expect(payload.overview.readFirst[0]?.path).toBe(dailyPath);
    expect(payload.overview.readFirst.map((item) => item.path)).not.toContain(
      oldDailyPath,
    );
    expect(payload.overview.readFirst[0]?.reason).toContain(
      "current daily surface",
    );
    expect(payload.overview.recallSignals).toContainEqual(
      expect.objectContaining({
        path: dailyPath,
        kind: "daily",
        label: "current daily surface",
        sourceRefs: expect.arrayContaining([
          expect.objectContaining({ path: dailyPath }),
        ]),
      }),
    );
    expect(payload.overview.openLoops[0]).toEqual(
      expect.objectContaining({
        path: dailyPath,
        predicate: "dome.daily.followup",
        text:
          `Handle source-backed launch review [due: ${today}, priority: highest]`,
        sourceRefs: expect.arrayContaining([
          expect.objectContaining({ path: dailyPath }),
          expect.objectContaining({ path: "wiki/source-project.md" }),
        ]),
      }),
    );
    expect(payload.overview.openLoops).toContainEqual(
      expect.objectContaining({
        path: dailyPath,
        predicate: "dome.daily.open_task",
        text: "Handle the current launch review.",
        sourceRefs: expect.arrayContaining([
          expect.objectContaining({ path: dailyPath }),
        ]),
      }),
    );
    expect(payload.markdown).toContain("## Open Loops");
    expect(payload.markdown).toContain("Handle source-backed launch review");
    expect(payload.markdown).toContain("wiki/source-project.md");
  },
);

scenario(
  {
    name: "cli-surface: dome export-context recalls pages through projection signals",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "search-document" },
      { kind: "effect", effect: "fact" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "view" },
      { kind: "capability", capability: "graph.write" },
      { kind: "capability", capability: "search.write" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "command" },
    ],
    harness: {
      bundles: [
        "dome.markdown",
        "dome.search",
        { id: "test.context-signal", root: CONTEXT_SIGNAL_BUNDLE_ROOT },
      ],
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/signal-only.md":
          "---\n" +
          "type: concept\n" +
          "---\n" +
          "# Operations Notebook\n\n" +
          "This page intentionally avoids the packet topic in searchable prose.\n",
      },
      message: "add signal-only context page",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const query = await h.runCli(["query", "alpha launch", "--json"]);
    expect(query.exitCode).toBe(0);
    const queryPayload = JSON.parse(query.stdout) as {
      readonly shown: { readonly matches: number };
      readonly matches: ReadonlyArray<{
        readonly path: string;
        readonly ranking: {
          readonly signals: ReadonlyArray<{ readonly kind: string }>;
        };
      }>;
    };
    expect(queryPayload.shown.matches).toBe(1);
    expect(queryPayload.matches).toContainEqual(
      expect.objectContaining({
        path: "wiki/signal-only.md",
        ranking: expect.objectContaining({
          signals: expect.arrayContaining([
            expect.objectContaining({ kind: "recall" }),
          ]),
        }),
      }),
    );

    const exported = await h.runCli([
      "export-context",
      "alpha launch",
      "--json",
      "--limit",
      "3",
    ]);
    expect(exported.exitCode).toBe(0);
    expect(exported.stderr).toBe("");
    const payload = JSON.parse(exported.stdout) as {
      readonly overview: {
        readonly readFirst: ReadonlyArray<{
          readonly path: string;
          readonly reason: string;
          readonly ranking: {
            readonly reasons: ReadonlyArray<string>;
          };
        }>;
        readonly openLoops: ReadonlyArray<{
          readonly path: string;
          readonly text: string;
        }>;
        readonly recallSignals: ReadonlyArray<{
          readonly path: string;
          readonly kind: string;
          readonly label: string;
          readonly text: string;
          readonly sourceRefs: ReadonlyArray<{ readonly path: string }>;
        }>;
      };
      readonly markdown: string;
      readonly entries: ReadonlyArray<{
        readonly path: string;
        readonly snippet: string;
        readonly ranking: {
          readonly reasons: ReadonlyArray<string>;
          readonly signals: ReadonlyArray<{ readonly kind: string }>;
        };
      }>;
    };

    expect(payload.entries.map((entry) => entry.path)).toContain(
      "wiki/signal-only.md",
    );
    const entry = payload.entries.find((item) =>
      item.path === "wiki/signal-only.md"
    );
    expect(entry?.snippet).toContain("intentionally avoids the packet topic");
    expect(entry?.ranking.reasons).toContain("open-loop topic match");
    expect(entry?.ranking.signals.some((signal) => signal.kind === "recall"))
      .toBe(true);
    expect(payload.overview.readFirst).toContainEqual(
      expect.objectContaining({
        path: "wiki/signal-only.md",
      }),
    );
    expect(payload.overview.readFirst.find((item) =>
      item.path === "wiki/signal-only.md"
    )?.reason).toContain("open-loop topic match");
    expect(payload.overview.openLoops).toContainEqual(
      expect.objectContaining({
        path: "wiki/signal-only.md",
        text: "Call Riley about alpha launch readiness",
      }),
    );
    expect(payload.overview.recallSignals).toContainEqual(
      expect.objectContaining({
        path: "wiki/signal-only.md",
        kind: "open-loop",
        label: "open-loop topic match",
        text: "Call Riley about alpha launch readiness",
      }),
    );
    expect(payload.overview.recallSignals[0]?.sourceRefs[0]?.path).toBe(
      "wiki/signal-only.md",
    );
    expect(payload.markdown).toContain("## Recall Signals");
    expect(payload.markdown).toContain("open-loop topic match");
    expect(payload.markdown).toContain("Call Riley about alpha launch readiness");
  },
);

scenario(
  {
    name: "cli-surface: dome export-context surfaces source-backed decisions",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "search-document" },
      { kind: "effect", effect: "fact" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "view" },
      { kind: "capability", capability: "graph.write" },
      { kind: "capability", capability: "search.write" },
      { kind: "capability", capability: "model.invoke" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "command" },
    ],
    harness: {
      bundles: ["dome.intake", "dome.search"],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  dome.intake:
    enabled: true
    grant:
      read:
        - "wiki/generated/intake/*.md"
        - "wiki/syntheses/intake-*.md"
      patch.auto:
        - "wiki/syntheses/intake-*.md"
        - "wiki/syntheses/intake-rollup.md"
      graph.write:
        - "dome.intake.*"
      model.invoke:
        modelAllowlist: ["test-model"]
        maxDailyCostUsd: 1
      question.ask: true
  dome.search:
    enabled: true
    grant:
      read: ["**/*.md"]
      search.write: ["**/*.md"]
`,
      },
      modelProvider: async (request) => {
        expect(request.model).toBe("test-model");
        if (
          request.prompt.startsWith(
            "Synthesize recent Dome generated intake captures",
          )
        ) {
          return {
            text: JSON.stringify({
              title: "Alpha capture rollup",
              thesis: "Alpha launch captures include ownership decisions.",
              themes: ["Alpha launch ownership"],
              risks: [],
              nextSteps: [],
            }),
            costUsd: 0.01,
          };
        }
        return {
          text: JSON.stringify({
            title: "Alpha decision synthesis",
            thesis: "Alpha launch ownership was decided in the capture.",
            highlights: ["Danny owns platform runtime for alpha launch"],
            risks: [],
            nextSteps: [],
          }),
          costUsd: 0.01,
        };
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/generated/intake/alpha-decision.md": [
          "---",
          "type: capture",
          "intake_items:",
          "  - kind: decision",
          "    text: Danny owns platform runtime for alpha launch",
          "    confidence: 0.94",
          "---",
          "",
          "# Alpha Decision Capture",
          "",
          "Decision: Danny owns platform runtime for the alpha launch ownership model.",
          "",
        ].join("\n"),
      },
      message: "add generated decision capture",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const json = await h.runCli([
      "export-context",
      "alpha launch ownership",
      "--json",
      "--limit",
      "3",
    ]);
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");

    const payload = JSON.parse(json.stdout) as {
      readonly overview: {
        readonly readFirst: ReadonlyArray<{
          readonly path: string;
          readonly reason: string;
          readonly ranking: {
            readonly reasons: ReadonlyArray<string>;
          };
        }>;
        readonly decisions: ReadonlyArray<{
          readonly path: string;
          readonly predicate: string;
          readonly text: string;
          readonly sourceRefs: ReadonlyArray<{ readonly path: string }>;
        }>;
      };
      readonly markdown: string;
      readonly entries: ReadonlyArray<{
        readonly path: string;
        readonly summary: ReadonlyArray<{
          readonly kind: string;
          readonly text: string;
          readonly sourceRefs: ReadonlyArray<{ readonly path: string }>;
        }>;
      }>;
    };

    expect(payload.markdown).toContain("## Decisions");
    expect(payload.markdown).toContain("dome.intake.decision");
    expect(payload.markdown).toContain(
      "Danny owns platform runtime for alpha launch",
    );
    expect(payload.overview.readFirst.some((item) =>
      item.path === "wiki/generated/intake/alpha-decision.md" &&
      item.reason.includes("decision") &&
      item.ranking.reasons.includes("decision")
    )).toBe(true);
    expect(payload.overview.decisions).toContainEqual(
      expect.objectContaining({
        path: "wiki/generated/intake/alpha-decision.md",
        predicate: "dome.intake.decision",
        text: "Danny owns platform runtime for alpha launch",
      }),
    );
    const decision = payload.overview.decisions.find(
      (item) => item.predicate === "dome.intake.decision",
    );
    expect(decision?.sourceRefs[0]?.path).toBe(
      "wiki/generated/intake/alpha-decision.md",
    );
    const entry = payload.entries.find(
      (item) => item.path === "wiki/generated/intake/alpha-decision.md",
    );
    expect(entry?.summary).toContainEqual(
      expect.objectContaining({
        kind: "decision",
        text: "Danny owns platform runtime for alpha launch",
        sourceRefs: expect.arrayContaining([
          expect.objectContaining({
            path: "wiki/generated/intake/alpha-decision.md",
          }),
        ]),
      }),
    );
    expect(payload.markdown).toContain(
      "`decision`: Danny owns platform runtime for alpha launch",
    );
  },
);
