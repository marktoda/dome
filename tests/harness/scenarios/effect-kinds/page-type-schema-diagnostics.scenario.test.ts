// scenarios/effect-kinds/page-type-schema-diagnostics.scenario.test.ts
//
// Page-type schemas are vault substrate: the markdown linter reads
// `.dome/page-types.yaml` through ctx.snapshot and validates changed pages
// against the declared type extras without leaving processor purity.

import { expect } from "bun:test";
import { join } from "node:path";

import { queryQuestionRecords } from "../../../../src/projections/questions";
import { scenario } from "../../index";

const PAGE_TYPE_JOB_BUNDLE = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.page-type-job-flow",
);

scenario(
  {
    name: "effect-kinds: dome.markdown.lint-frontmatter validates vault page-type schemas",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: { bundles: ["dome.markdown"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        ".dome/page-types.yaml":
          "extensions:\n" +
          "  - name: recipe\n" +
          "    frontmatter_extras:\n" +
          "      cuisine: required\n" +
          "      servings: optional\n",
        "wiki/recipes/soup.md":
          "---\n" +
          "type: recipe\n" +
          "created: 2026-05-28\n" +
          "updated: 2026-05-28\n" +
          "unexpected: yes\n" +
          "---\n" +
          "# Soup\n",
      },
      message: "add recipe page type",
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.missing-required-field" })
      .toHaveCount(1);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.unknown-frontmatter-field" })
      .toHaveCount(1);
    await h
      .expectLedger({ processorId: "dome.markdown.lint-frontmatter" })
      .toAllHaveStatus("succeeded");

    await h.userCommit({
      files: {
        ".dome/page-types.yaml":
          "extensions:\n" +
          "  - name: recipe\n" +
          "    frontmatter_extras:\n" +
          "      cuisine: optional\n" +
          "      servings: optional\n" +
          "      unexpected: optional\n",
      },
      message: "relax recipe page type",
    });

    const relaxed = await h.tick();
    expect(relaxed.adopted).toBe(true);

    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.missing-required-field" })
      .toHaveCount(0);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.unknown-frontmatter-field" })
      .toHaveCount(0);
  },
);

scenario(
  {
    name: "effect-kinds: answer-handler page-type patches rebuild schema diagnostics",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "question" },
      { kind: "effect", effect: "patch" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "question.ask" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "trigger", trigger: "answer" },
      { kind: "route", route: "garden-answer" },
    ],
    harness: {
      bundles: [
        "dome.markdown",
        { id: "test.page-type-job-flow", root: PAGE_TYPE_JOB_BUNDLE },
      ],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  dome.markdown:
    enabled: true
    grant:
      read: ["**/*.md", ".dome/page-types.yaml"]
      patch.auto: ["**/*.md"]
      question.ask: true
  test.page-type-job-flow:
    enabled: true
    grant:
      patch.auto: [".dome/page-types.yaml"]
`,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        ".dome/page-types.yaml":
          "extensions:\n" +
          "  - name: recipe\n" +
          "    frontmatter_extras:\n" +
          "      cuisine: required\n",
        "wiki/recipes/soup.md":
          "---\n" +
          "type: recipe\n" +
          "created: 2026-05-28\n" +
          "updated: 2026-05-28\n" +
          "unexpected: yes\n" +
          "---\n" +
          "# Soup\n",
        // An ambiguous wikilink fires dome.markdown.ambiguous-wikilink's
        // question — the answer-flow vehicle for this test (the question
        // emitter is incidental; the subject is answer-driven schema cleanup).
        "wiki/page.md":
          "# Page\n\nWorking with [[wiki/entities/grae-danco#Notes|Grace]].\n",
        "wiki/entities/grace-danco.md": "# Grace Danco\n",
        "wiki/entities/grade-danco.md": "# Grade Danco\n",
      },
      message: "add answer-driven schema cleanup fixture",
    });

    const defective = await h.tick();
    expect(defective.adopted).toBe(true);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.missing-required-field" })
      .toHaveCount(1);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.unknown-frontmatter-field" })
      .toHaveCount(1);

    // Question inspection is not this scenario's subject. Read the harness's
    // live projection directly so the only CLI/runtime lifecycle exercised
    // below is the answer-driven patch path under test.
    const rows = queryQuestionRecords(h.projection, { resolved: false });
    expect(rows.length).toBe(1);
    const questionId = rows[0]?.id;
    expect(questionId).toBeGreaterThan(0);
    if (questionId === undefined) return;

    const answered = await h.runCli([
      "answer",
      String(questionId),
      // The ambiguous-link question is only the answer-flow vehicle. Keep its
      // own handler neutral so this scenario produces exactly the one page-
      // type sub-Proposal whose projection rebuild it claims to prove.
      "keep unresolved",
      "--json",
    ]);
    expect(answered.exitCode).toBe(0);
    const body = JSON.parse(answered.stdout) as {
      readonly handlers: {
        readonly status: string;
        readonly runs: ReadonlyArray<{ readonly processor_id: string }>;
        readonly sub_proposals: number;
      } | null;
    };
    expect(body.handlers?.status).toBe("handled");
    expect(body.handlers?.runs.map((run) => run.processor_id)).toContain(
      "test.page-type-job-flow.answer-worker",
    );
    expect(body.handlers?.sub_proposals).toBe(1);

    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.missing-required-field" })
      .toHaveCount(0);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.unknown-frontmatter-field" })
      .toHaveCount(0);
  },
);
