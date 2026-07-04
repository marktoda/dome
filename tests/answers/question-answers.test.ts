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
    expect(rec.answeredBy).toBe("owner");
    expect(getQuestionAnswer(db, baseOpts.idempotencyKey)?.answeredBy).toBe(
      "owner",
    );
  });

  it("stores answered_by 'auto' and query round-trips it", () => {
    const rec = recordQuestionAnswer(db, { ...baseOpts, answeredBy: "auto" });
    expect(rec.answeredBy).toBe("auto");
    expect(getQuestionAnswer(db, baseOpts.idempotencyKey)?.answeredBy).toBe(
      "auto",
    );
  });
});
