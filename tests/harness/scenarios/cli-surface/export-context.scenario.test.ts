// scenarios/cli-surface/export-context.scenario.test.ts
//
// `dome export-context` packages adopted search matches and related facts into
// a portable markdown packet for cross-session handoff.

import { expect } from "bun:test";

import { scenario } from "../../index";

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
          "- [ ] Ask Danny about alpha launch handoff 🔺 📅 2026-01-07\n" +
          "\n" +
          "See [[missing-alpha-owner]].\n",
        "wiki/project-alpha-copy.md":
          "---\n" +
          "type: concept\n" +
          "---\n" +
          "# Project Alpha\n\n" +
          "The alpha launch ownership model assigns platform runtime to Danny.\n" +
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
    expect(alpha?.ranking.reasons).toContain("open loop");
    expect(alpha?.sourceRefs[0]?.path).toBe("wiki/project-alpha.md");
    expect(alpha?.facts.some((fact) => fact.predicate === "dome.graph.tagged"))
      .toBe(true);
    expect(alpha?.facts).toContainEqual(
      expect.objectContaining({
        predicate: "dome.daily.open_task",
        object:
          "Ask Danny about alpha launch handoff [due: 2026-01-07, priority: highest]",
      }),
    );
    expect((alpha?.facts.length ?? 0)).toBeGreaterThan(8);
    expect(payload.markdown).toContain(
      `... ${(alpha?.facts.length ?? 8) - 8} more facts`,
    );
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
  },
);
