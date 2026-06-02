// scenarios/cli-surface/answer-question.scenario.test.ts
//
// `dome resolve` is the public recovery channel for durable QuestionEffect
// rows. These scenarios keep it end-to-end: a real shipped processor asks a
// question, `inspect` exposes the stable row id, the CLI records the answer,
// and an answer-triggered garden processor emits a follow-up PatchEffect.
// The older `dome answer` command remains covered below as a compatibility
// alias for advanced scripts.

import { expect } from "bun:test";
import { join } from "node:path";

import { questionEffect } from "../../../../src/core/effect";
import { commitOid, sourceRef } from "../../../../src/core/source-ref";
import { insertQuestion } from "../../../../src/projections/questions";
import { scenario } from "../../index";

const ANSWER_HANDLER_BUNDLE_ROOT = join(
  __dirname,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.answer-handler",
);
const INVALID_ANSWER_HANDLER_BUNDLE_ROOT = join(
  __dirname,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.invalid-answer-handler",
);
const SLOW_ANSWER_HANDLER_BUNDLE_ROOT = join(
  __dirname,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.slow-answer-handler",
);

scenario(
  {
    name: "cli-surface: opt-in auto-resolution answers agent-safe questions through handlers",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "question" },
      { kind: "effect", effect: "patch" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "question.ask" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "capability", capability: "read" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "answer" },
    ],
    harness: {
      bundles: ["dome.daily"],
      initialFiles: {
        ".dome/config.yaml": `
engine:
  auto_resolve_questions:
    enabled: true
    policies:
      - agent-safe
    min_confidence: 0.6
    max_per_tick: 5
extensions:
  dome.daily:
    enabled: true
    grant:
      read:
        - "wiki/**/*.md"
        - "notes/*.md"
      patch.auto:
        - "wiki/**/*.md"
        - "notes/*.md"
      graph.write:
        - "dome.daily.*"
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
        "wiki/project.md":
          "# Project\n\nWe should follow up with Riley\n",
      },
      message: "add ambiguous followup",
    });

    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const rows = JSON.parse(
      (await h.runCli(["inspect", "questions", "--json"])).stdout,
    ) as ReadonlyArray<{
      readonly status: string;
      readonly answer: string;
      readonly metadata: { readonly automationPolicy?: string } | "-";
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("answered");
    expect(rows[0]?.answer).toBe("track");
    expect(rows[0]?.metadata).toEqual(
      expect.objectContaining({ automationPolicy: "agent-safe" }),
    );

    const durableAnswer = h.answers.raw
      .query<{
        answer: string;
        handler_status: string;
        handler_attempts: number;
      }, []>(
        "SELECT answer, handler_status, handler_attempts FROM question_answers",
      )
      .get();
    expect(durableAnswer?.answer).toBe("track");
    expect(durableAnswer?.handler_status).toBe("handled");
    expect(durableAnswer?.handler_attempts).toBe(1);

    const handlerRun = h.ledger.raw
      .query<{ trigger_kind: string }, []>(
        "SELECT trigger_kind FROM runs WHERE processor_id = 'dome.daily.ambiguous-followup-answer'",
      )
      .get();
    expect(handlerRun?.trigger_kind).toBe("answer");

    const adopted = await h.refs.adopted();
    expect(adopted).not.toBeNull();
    if (adopted === null) return;
    await h.expectFile("wiki/project.md", { atCommit: adopted })
      .toContain("- [ ] #followup Follow up with Riley");
  },
);

scenario(
  {
    name: "cli-surface: dome resolve records an answer and runs answer handlers",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "question" },
      { kind: "effect", effect: "patch" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "question.ask" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "capability", capability: "read" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "answer" },
    ],
    harness: {
      bundles: [
        "dome.markdown",
        { id: "test.answer-handler", root: ANSWER_HANDLER_BUNDLE_ROOT },
      ],
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const duplicateBody =
      "# Support rota\n\n" +
      "The support rota assigns incident triage ownership for weekday coverage.\n";

    await h.userCommit({
      files: {
        "wiki/support-rota.md": `---\ntype: note\n---\n${duplicateBody}`,
        "wiki/support-rota-copy.md": `---\ntype: note\n---\n${duplicateBody}`,
      },
      message: "add duplicate support rota pages",
    });

    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const inspect = await h.runCli(["inspect", "questions", "--json"]);
    expect(inspect.exitCode).toBe(0);
    const rows = JSON.parse(inspect.stdout) as ReadonlyArray<{
      readonly id: number;
      readonly status: string;
      readonly idempotency_key: string;
      readonly options: ReadonlyArray<string> | string;
    }>;
    expect(rows.length).toBe(1);
    const questionId = rows[0]?.id;
    expect(questionId).toBeGreaterThan(0);
    if (questionId === undefined) return;
    expect(rows[0]?.status).toBe("open");

    const answer = await h.runCli([
      "resolve",
      String(questionId),
      "keep separate",
      "--json",
    ]);
    expect(answer.exitCode).toBe(0);
    expect(answer.stderr).toBe("");
    const answered = JSON.parse(answer.stdout) as {
      readonly status: string;
      readonly question: {
        readonly id: number;
        readonly status: string;
        readonly answer: string;
        readonly answered_at: string | null;
      };
      readonly handlers: {
        readonly status: string;
        readonly runs: ReadonlyArray<{ readonly processor_id: string }>;
        readonly sub_proposals: number;
      };
    };
    expect(answered.status).toBe("answered");
    expect(answered.question.id).toBe(questionId);
    expect(answered.question.status).toBe("answered");
    expect(answered.question.answer).toBe("keep separate");
    expect(answered.question.answered_at).not.toBeNull();
    expect(answered.handlers.status).toBe("handled");
    expect(answered.handlers.runs.map((run) => run.processor_id)).toEqual([
      "dome.markdown.duplicate-detection-answer",
      "test.answer-handler.record-duplicate-answer",
    ]);
    expect(answered.handlers.sub_proposals).toBe(1);
    const ledgerRow = h.ledger.raw
      .query<{ trigger_kind: string }, []>(
        "SELECT trigger_kind FROM runs WHERE processor_id = 'test.answer-handler.record-duplicate-answer'",
      )
      .get();
    expect(ledgerRow?.trigger_kind).toBe("answer");
    const durableAnswer = h.answers.raw
      .query<{
        handler_status: string;
        handler_attempts: number;
      }, []>(
        "SELECT handler_status, handler_attempts FROM question_answers",
      )
      .get();
    expect(durableAnswer?.handler_status).toBe("handled");
    expect(durableAnswer?.handler_attempts).toBe(1);

    const adopted = await h.refs.adopted();
    expect(adopted).not.toBeNull();
    if (adopted === null) return;
    await h.expectFile("wiki/answer-handled.md", { atCommit: adopted })
      .toContain(`Question ${questionId}: keep separate`);

    const after = await h.runCli(["inspect", "questions", "--json"]);
    const afterRows = JSON.parse(after.stdout) as ReadonlyArray<{
      readonly id: number;
      readonly status: string;
      readonly answer: string;
    }>;
    expect(afterRows[0]?.id).toBe(questionId);
    expect(afterRows[0]?.status).toBe("answered");
    expect(afterRows[0]?.answer).toBe("keep separate");

    const rebuild = await h.runCli(["rebuild", "--json"]);
    expect(rebuild.exitCode).toBe(0);
    const rebuiltRows = JSON.parse(
      (await h.runCli(["inspect", "questions", "--json"])).stdout,
    ) as ReadonlyArray<{
      readonly status: string;
      readonly answer: string;
      readonly idempotency_key: string;
    }>;
    expect(rebuiltRows.length).toBe(1);
    expect(rebuiltRows[0]?.idempotency_key).toBe(rows[0]?.idempotency_key);
    expect(rebuiltRows[0]?.status).toBe("answered");
    expect(rebuiltRows[0]?.answer).toBe("keep separate");

    h.answers.raw.run(
      "UPDATE question_answers SET handler_status = 'skipped', handled_at = NULL",
    );
    const retry = await h.runCli([
      "resolve",
      String(questionId),
      "keep separate",
      "--json",
    ]);
    expect(retry.exitCode).toBe(0);
    const retried = JSON.parse(retry.stdout) as {
      readonly status: string;
      readonly handlers: { readonly status: string } | null;
    };
    expect(retried.status).toBe("already-answered");
    expect(retried.handlers?.status).toBe("handled");
    const answerHandlerRuns = h.ledger.raw
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM runs WHERE processor_id = 'test.answer-handler.record-duplicate-answer'",
      )
      .get();
    expect(answerHandlerRuns?.count).toBe(2);
  },
);

scenario(
  {
    name: "cli-surface: dome answer compatibility keeps failed handler dispatch retryable",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "question" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "outbox.recover" },
      { kind: "trigger", trigger: "answer" },
    ],
    harness: {
      bundles: [
        {
          id: "test.invalid-answer-handler",
          root: INVALID_ANSWER_HANDLER_BUNDLE_ROOT,
        },
      ],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  test.invalid-answer-handler:
    enabled: true
    grant:
      outbox.recover: ["retry"]
`,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);
    const adopted = await h.refs.adopted();
    expect(adopted).not.toBeNull();
    if (adopted === null) return;

    const ref = sourceRef({
      commit: commitOid(adopted),
      path: ".dome/config.yaml",
    });
    insertQuestion(h.projection, {
      effect: questionEffect({
        question: "Trigger invalid handler?",
        options: ["yes"],
        sourceRefs: [ref],
        idempotencyKey: "test.invalid-answer-handler:bad-output",
      }),
      processorId: "test.ask",
      adoptedCommit: commitOid(adopted),
    });

    const answer = await h.runCli(["answer", "1", "yes", "--json"]);
    expect(answer.exitCode).toBe(0);
    const body = JSON.parse(answer.stdout) as {
      readonly handlers: {
        readonly status: string;
        readonly runs: ReadonlyArray<{
          readonly processor_id: string;
          readonly execution_status: string;
        }>;
      };
    };
    expect(body.handlers.status).toBe("failed");
    expect(body.handlers.runs).toEqual([
      expect.objectContaining({
        processor_id: "test.invalid-answer-handler.invalid-output",
        execution_status: "failed",
      }),
    ]);

    const durableAnswer = h.answers.raw
      .query<{
        handler_status: string;
        handler_attempts: number;
        last_handler_error: string | null;
      }, []>(
        "SELECT handler_status, handler_attempts, last_handler_error FROM question_answers",
      )
      .get();
    expect(durableAnswer?.handler_status).toBe("failed");
    expect(durableAnswer?.handler_attempts).toBe(1);
    expect(durableAnswer?.last_handler_error).toContain(
      "Processor returned invalid output",
    );
  },
);

scenario(
  {
    name: "cli-surface: dome answer compatibility applies vault processor timeout cap to handlers",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "question" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "answer" },
    ],
    harness: {
      bundles: [
        {
          id: "test.slow-answer-handler",
          root: SLOW_ANSWER_HANDLER_BUNDLE_ROOT,
        },
      ],
      initialFiles: {
        ".dome/config.yaml": `
engine:
  processor_timeout_ms: 5
extensions:
  test.slow-answer-handler:
    enabled: true
`,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);
    const adopted = await h.refs.adopted();
    expect(adopted).not.toBeNull();
    if (adopted === null) return;

    const ref = sourceRef({
      commit: commitOid(adopted),
      path: ".dome/config.yaml",
    });
    insertQuestion(h.projection, {
      effect: questionEffect({
        question: "Trigger slow handler?",
        options: ["yes"],
        sourceRefs: [ref],
        idempotencyKey: "test.slow-answer-handler:timeout",
      }),
      processorId: "test.ask",
      adoptedCommit: commitOid(adopted),
    });

    const answer = await h.runCli(["answer", "1", "yes", "--json"]);
    expect(answer.exitCode).toBe(0);
    const body = JSON.parse(answer.stdout) as {
      readonly handlers: {
        readonly status: string;
        readonly runs: ReadonlyArray<{
          readonly processor_id: string;
          readonly execution_status: string;
          readonly execution_error?: {
            readonly code: string;
            readonly message: string;
          };
        }>;
      };
    };
    expect(body.handlers.status).toBe("failed");
    expect(body.handlers.runs).toEqual([
      expect.objectContaining({
        processor_id: "test.slow-answer-handler.wait-for-abort",
        execution_status: "timed_out",
        execution_error: expect.objectContaining({
          code: "processor.timeout",
          message: expect.stringContaining("5ms"),
        }),
      }),
    ]);

    const row = await h
      .expectLedger({
        processorId: "test.slow-answer-handler.wait-for-abort",
        status: "timed_out",
      })
      .toHaveExactlyOne();
    expect(JSON.parse(row.error ?? "{}").message).toContain("5ms");
  },
);
