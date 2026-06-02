// scenarios/effect-kinds/wikilink-ambiguity-questions.scenario.test.ts
//
// Ambiguous wikilink repairs should preserve uncertainty as a durable,
// source-backed question instead of auto-patching the wrong target or creating
// duplicate stub pages.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "effect-kinds: dome.markdown.validate-wikilinks asks about ambiguous repair candidates",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "effect", effect: "question" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "question.ask" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: { bundles: ["dome.markdown"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/page.md": "# Page\n\nWorking with [[wiki/entities/grae-danco]].\n",
        "wiki/entities/grace-danco.md": "# Grace Danco\n",
        "wiki/entities/grade-danco.md": "# Grade Danco\n",
      },
      message: "add ambiguous wikilink",
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(1);
    await h.expectProjection().questions().toHaveCount(1);

    const inspect = await h.runCli(["inspect", "questions", "--json"]);
    expect(inspect.exitCode).toBe(0);
    const rows = JSON.parse(inspect.stdout) as ReadonlyArray<{
      readonly question: string;
      readonly options: ReadonlyArray<string>;
      readonly metadata: {
        readonly automationPolicy?: string;
        readonly risk?: string;
      };
      readonly idempotency_key: string;
    }>;
    const row = rows[0];
    expect(row?.question).toContain("[[wiki/entities/grae-danco]]");
    expect(row?.options).toEqual([
      "wiki/entities/grace-danco",
      "wiki/entities/grade-danco",
      "keep unresolved",
    ]);
    expect(row?.metadata).toEqual(
      expect.objectContaining({
        automationPolicy: "agent-safe",
        risk: "medium",
      }),
    );
    expect(row?.idempotency_key).toMatch(
      /^dome\.markdown\.ambiguous-wikilink:/,
    );
  },
);
