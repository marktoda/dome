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
      { kind: "effect", effect: "patch" },
      { kind: "effect", effect: "question" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "capability", capability: "question.ask" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "answer" },
      { kind: "route", route: "garden-answer" },
    ],
    harness: { bundles: ["dome.markdown"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/page.md":
          "# Page\n\nWorking with [[wiki/entities/grae-danco#Notes|Grace]].\n",
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
      readonly id: number;
      readonly status: string;
      readonly question: string;
      readonly options: ReadonlyArray<string>;
      readonly metadata: {
        readonly automationPolicy?: string;
        readonly risk?: string;
      };
      readonly idempotency_key: string;
    }>;
    const row = rows[0];
    expect(row?.status).toBe("open");
    expect(row?.question).toContain("[[wiki/entities/grae-danco#Notes]]");
    expect(row?.options).toEqual([
      "wiki/entities/grace-danco#Notes",
      "wiki/entities/grade-danco#Notes",
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
    expect(row?.id).toBeDefined();
    if (row === undefined) return;

    const resolve = await h.runCli([
      "resolve",
      String(row.id),
      "wiki/entities/grace-danco#Notes",
      "--json",
    ]);
    expect(resolve.exitCode).toBe(0);
    const resolved = JSON.parse(resolve.stdout) as {
      readonly status: string;
      readonly question: {
        readonly status: string;
        readonly answer: string;
      };
      readonly handlers: {
        readonly status: string;
        readonly sub_proposals: number;
        readonly runs: ReadonlyArray<{
          readonly processor_id: string;
          readonly execution_status: string;
          readonly authorized_patch_count: number;
        }>;
      };
    };
    expect(resolved.status).toBe("answered");
    expect(resolved.question).toEqual(
      expect.objectContaining({
        status: "answered",
        answer: "wiki/entities/grace-danco#Notes",
      }),
    );
    expect(resolved.handlers.status).toBe("handled");
    expect(resolved.handlers.sub_proposals).toBe(1);
    expect(resolved.handlers.runs).toContainEqual(
      expect.objectContaining({
        processor_id: "dome.markdown.ambiguous-wikilink-answer",
        execution_status: "succeeded",
        authorized_patch_count: 1,
      }),
    );

    await h
      .expectFile("wiki/page.md")
      .toContain("[[wiki/entities/grace-danco#Notes|Grace]]");
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(0);

    await h.expectProjection().questions().toHaveCount(0);

    const settled = await h.tick();
    expect(settled.adopted).toBe(true);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(0);
  },
);
