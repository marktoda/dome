// tests/engine/question-expiry: subject-liveness expiry for OPEN questions
// whose emitting or subject processor is retired (no longer registered).
//
// Covers the four cases from docs/superpowers/plans/2026-07-06-product-review-4-tier1.md
// Task 9:
//   (a) retired emitting processor -> expired + durable answer row + diagnostic
//   (b) ACTIVE emitter, metadata.subjectProcessorId of a retired processor
//       (the work-vault zombie shape) -> expired
//   (c) both processors active -> untouched
//   (d) idempotent: a second pump run expires nothing further

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAnswersDb, type AnswersDb } from "../../src/answers/db";
import { getQuestionAnswer } from "../../src/answers/question-answers";
import { questionEffect, type DiagnosticEffect } from "../../src/core/effect";
import { defineProcessor } from "../../src/core/processor";
import { commitOid } from "../../src/core/source-ref";
import { expireOrphanSubjectQuestions } from "../../src/engine/operational/question-expiry";
import { openProjectionDb, type ProjectionDb } from "../../src/projections/db";
import {
  getQuestionRecord,
  insertQuestion,
} from "../../src/projections/questions";
import { buildRegistry, type ProcessorRegistry } from "../../src/processors/registry";

const tmpRoots: string[] = [];

afterEach(async () => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

function activeProcessor(id: string): ReturnType<typeof defineProcessor> {
  return defineProcessor({
    id,
    version: "0.0.1",
    phase: "garden",
    triggers: [{ kind: "schedule", cron: "* * * * *" }],
    capabilities: [],
    run: async () => [],
  });
}

function registryWith(ids: ReadonlyArray<string>): ProcessorRegistry {
  const built = buildRegistry(ids.map(activeProcessor));
  if (!built.ok) throw new Error(`registry build failed: ${built.error.kind}`);
  return built.value;
}

async function openTestProjection(root: string): Promise<ProjectionDb> {
  const opened = await openProjectionDb({
    path: join(root, "projection.db"),
    extensionSet: [],
    processorVersions: [],
    capabilityPolicyHash: "test-policy",
  });
  if (!opened.ok) throw new Error(`projection open failed: ${opened.error.kind}`);
  return opened.value.db;
}

async function openTestAnswers(root: string): Promise<AnswersDb> {
  const opened = await openAnswersDb({ path: join(root, "answers.db") });
  if (!opened.ok) throw new Error(`answers open failed: ${opened.error.kind}`);
  return opened.value.db;
}

describe("expireOrphanSubjectQuestions", () => {
  test("expires an open question whose emitting processor is retired", async () => {
    const root = mkdtempSync(join(tmpdir(), "question-expiry-"));
    tmpRoots.push(root);
    const projection = await openTestProjection(root);
    const answers = await openTestAnswers(root);
    try {
      insertQuestion(projection, {
        effect: questionEffect({
          question: "Fail stuck run for dome.warden.integrity?",
          options: ["fail", "ignore"],
          sourceRefs: [],
          idempotencyKey: "orphan-run:1",
        }),
        processorId: "dome.warden.integrity",
        runId: "run_1",
        adoptedCommit: commitOid("a".repeat(40)),
      });
      const inserted = getQuestionRecord(projection, 1);
      expect(inserted?.answeredAt).toBeNull();

      const recorded: DiagnosticEffect[] = [];
      const now = () => new Date("2026-07-06T00:00:00.000Z");
      const result = await expireOrphanSubjectQuestions({
        registry: registryWith(["dome.other.active"]),
        questions: projection,
        answers,
        recordDiagnostic: async (input) => {
          recorded.push(input.effect);
        },
        now,
      });

      expect(result.expired).toBe(1);

      const row = getQuestionRecord(projection, 1);
      expect(row?.answeredAt).toBe(now().toISOString());
      expect(row?.answer).toBe("expired");
      expect(row?.answeredBy).toBe("expired");

      const answerRow = getQuestionAnswer(answers, "orphan-run:1");
      expect(answerRow?.answer).toBe("expired");
      expect(answerRow?.answeredBy).toBe("expired");
      expect(answerRow?.handlerStatus).toBe("handled");
      expect(answerRow?.handledAt).toBe(now().toISOString());

      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.code).toBe("question.expired-subject-retired");
      expect(recorded[0]?.severity).toBe("info");
      expect(recorded[0]?.message).toContain("dome.warden.integrity");
    } finally {
      answers.close();
      projection.close();
    }
  });

  test("expires the work-vault zombie shape: active emitter, retired subjectProcessorId", async () => {
    const root = mkdtempSync(join(tmpdir(), "question-expiry-"));
    tmpRoots.push(root);
    const projection = await openTestProjection(root);
    const answers = await openTestAnswers(root);
    try {
      insertQuestion(projection, {
        effect: questionEffect({
          question:
            "Run 42 for processor dome.warden.integrity has been running. Mark it failed?",
          options: ["fail", "ignore"],
          sourceRefs: [],
          idempotencyKey: "orphan-run:zombie",
          metadata: {
            risk: "low",
            confidence: 1,
            recommendedAnswer: "fail",
            automationPolicy: "agent-safe",
            subjectProcessorId: "dome.warden.integrity",
          },
        }),
        processorId: "dome.health.orphan-run-recovery-questions",
        runId: "run_2",
        adoptedCommit: commitOid("b".repeat(40)),
      });

      const now = () => new Date("2026-07-06T00:00:00.000Z");
      const result = await expireOrphanSubjectQuestions({
        registry: registryWith(["dome.health.orphan-run-recovery-questions"]),
        questions: projection,
        answers,
        recordDiagnostic: async () => {},
        now,
      });

      expect(result.expired).toBe(1);
      const row = getQuestionRecord(projection, 1);
      expect(row?.answeredAt).not.toBeNull();
      expect(row?.answer).toBe("expired");

      const answerRow = getQuestionAnswer(answers, "orphan-run:zombie");
      expect(answerRow?.handlerStatus).toBe("handled");
    } finally {
      answers.close();
      projection.close();
    }
  });

  test("leaves a question untouched when both emitter and subject are active", async () => {
    const root = mkdtempSync(join(tmpdir(), "question-expiry-"));
    tmpRoots.push(root);
    const projection = await openTestProjection(root);
    const answers = await openTestAnswers(root);
    try {
      insertQuestion(projection, {
        effect: questionEffect({
          question: "Reset quarantine?",
          options: ["reset", "ignore"],
          sourceRefs: [],
          idempotencyKey: "quarantine:1",
          metadata: {
            risk: "medium",
            confidence: 1,
            recommendedAnswer: "reset",
            automationPolicy: "owner-needed",
            subjectProcessorId: "dome.active.subject",
          },
        }),
        processorId: "dome.health.quarantine-recovery-questions",
        runId: "run_3",
        adoptedCommit: commitOid("c".repeat(40)),
      });

      const recorded: DiagnosticEffect[] = [];
      const result = await expireOrphanSubjectQuestions({
        registry: registryWith([
          "dome.health.quarantine-recovery-questions",
          "dome.active.subject",
        ]),
        questions: projection,
        answers,
        recordDiagnostic: async (input) => {
          recorded.push(input.effect);
        },
        now: () => new Date("2026-07-06T00:00:00.000Z"),
      });

      expect(result.expired).toBe(0);
      expect(recorded).toHaveLength(0);
      const row = getQuestionRecord(projection, 1);
      expect(row?.answeredAt).toBeNull();
      expect(getQuestionAnswer(answers, "quarantine:1")).toBeNull();
    } finally {
      answers.close();
      projection.close();
    }
  });

  test("is idempotent: a second pump run expires nothing further", async () => {
    const root = mkdtempSync(join(tmpdir(), "question-expiry-"));
    tmpRoots.push(root);
    const projection = await openTestProjection(root);
    const answers = await openTestAnswers(root);
    try {
      insertQuestion(projection, {
        effect: questionEffect({
          question: "Fail stuck run?",
          options: ["fail", "ignore"],
          sourceRefs: [],
          idempotencyKey: "orphan-run:idempotent",
        }),
        processorId: "dome.warden.integrity",
        runId: "run_4",
        adoptedCommit: commitOid("d".repeat(40)),
      });

      const deps = {
        registry: registryWith(["dome.other.active"]),
        questions: projection,
        answers,
        recordDiagnostic: async (_input: {
          readonly effect: DiagnosticEffect;
          readonly processorId: string;
          readonly proposalId: string | null;
        }) => {},
        now: () => new Date("2026-07-06T00:00:00.000Z"),
      };

      const first = await expireOrphanSubjectQuestions(deps);
      expect(first.expired).toBe(1);

      const second = await expireOrphanSubjectQuestions(deps);
      expect(second.expired).toBe(0);

      // Idempotent write too: the answer row is unchanged by the no-op pass.
      const answerRow = getQuestionAnswer(answers, "orphan-run:idempotent");
      expect(answerRow?.handlerStatus).toBe("handled");
    } finally {
      answers.close();
      projection.close();
    }
  });
});
