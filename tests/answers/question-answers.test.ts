// Smoke tests for src/answers/question-answers.ts: recordQuestionAnswer /
// getQuestionAnswer round-trip, including the answered_by audit column.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAnswersDb, type AnswersDb } from "../../src/answers/db";
import {
  getQuestionAnswer,
  recordQuestionAnswer,
  type RecordQuestionAnswerOpts,
} from "../../src/answers/question-answers";
import { commitOid, sourceRef } from "../../src/core/source-ref";

describe("recordQuestionAnswer / getQuestionAnswer", () => {
  let root: string;
  let db: AnswersDb;

  const baseOpts: RecordQuestionAnswerOpts = Object.freeze({
    idempotencyKey: "k1",
    answer: "yes",
    answeredAt: "2026-06-01T00:00:00.000Z",
    questionId: 1,
    question: "Ship it?",
    processorId: "dome.test",
    adoptedCommit: "abc123",
    answeredBy: "owner",
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "dome-question-answers-"));
    const opened = await openAnswersDb({
      path: join(root, ".dome", "state", "answers.db"),
    });
    if (!opened.ok) throw new Error("failed to open answers.db for test");
    db = opened.value.db;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("stores answered_by 'owner' and query round-trips it", () => {
    const rec = recordQuestionAnswer(db, baseOpts);
    expect(rec.record.answeredBy).toBe("owner");
    expect(getQuestionAnswer(db, baseOpts.idempotencyKey)?.answeredBy).toBe(
      "owner",
    );
  });

  it("stores answered_by 'auto' and query round-trips it", () => {
    const rec = recordQuestionAnswer(db, { ...baseOpts, answeredBy: "auto" });
    expect(rec.record.answeredBy).toBe("auto");
    expect(getQuestionAnswer(db, baseOpts.idempotencyKey)?.answeredBy).toBe(
      "auto",
    );
  });

  it("round-trips agent evidence and keeps the first concurrent answer", () => {
    const evidence = sourceRef({ path: "wiki/x.md", commit: commitOid("c1") });
    const first = recordQuestionAnswer(db, {
      ...baseOpts,
      answeredBy: "agent",
      answerContext: {
        kind: "agent",
        reason: "The source says yes.",
        evidence: [evidence],
      },
    });
    const second = recordQuestionAnswer(db, {
      ...baseOpts,
      answer: "no",
      answeredBy: "owner",
    });

    expect(first.kind).toBe("recorded");
    expect(second.kind).toBe("existing");
    expect(second.record.answer).toBe("yes");
    expect(second.record.answerContext).toEqual({
      kind: "agent",
      reason: "The source says yes.",
      evidence: [evidence],
    });
  });
});
