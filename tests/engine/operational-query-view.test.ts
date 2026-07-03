// operational-query-view: buildOperationalQueryView adapts the durable
// outbox/ledger/execution-state/projection stores into the read-only
// `ctx.operational` surface. This file covers the `questions` accessor added
// alongside `questions.read` (docs/wiki/specs/capabilities.md
// §"questions.read") and the `runs` accessor added alongside `run.read`
// (docs/wiki/specs/capabilities.md §"run.read") — the other two accessors
// (outbox/quarantines) and `orphanRuns` are already covered indirectly via
// tests/engine/operational-work.test.ts and tests/processors/runtime.test.ts.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { questionEffect } from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { buildOperationalQueryView } from "../../src/engine/operational/operational-query-view";
import { buildProcessorExecutionState } from "../../src/processors/execution-state";
import {
  insertQueued,
  markRunning,
  markSucceeded,
  markFailed,
  newRunId,
} from "../../src/ledger/runs";
import { openOutboxDb, type OutboxDb } from "../../src/outbox/db";
import { openProjectionDb, type ProjectionDb } from "../../src/projections/db";
import {
  answerQuestion,
  insertQuestion,
  queryQuestionRecords,
} from "../../src/projections/questions";
import { openTestLedger } from "../support/test-ledger";
import type { LedgerDb } from "../../src/ledger/db";

const tmpRoots: string[] = [];

afterEach(async () => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function openFixtures(): Promise<{
  readonly projection: ProjectionDb;
  readonly outbox: OutboxDb;
  readonly ledger: LedgerDb;
  readonly close: () => void;
}> {
  const root = mkdtempSync(join(tmpdir(), "operational-query-view-"));
  tmpRoots.push(root);

  const projectionResult = await openProjectionDb({
    path: join(root, "projection.db"),
    extensionSet: [],
    processorVersions: [],
    capabilityPolicyHash: "test-policy",
  });
  if (!projectionResult.ok) {
    throw new Error(`projection open failed: ${projectionResult.error.kind}`);
  }
  const outboxResult = await openOutboxDb({ path: join(root, "outbox.db") });
  if (!outboxResult.ok) {
    projectionResult.value.db.close();
    throw new Error(`outbox open failed: ${outboxResult.error.kind}`);
  }
  const ledger = await openTestLedger();

  return {
    projection: projectionResult.value.db,
    outbox: outboxResult.value.db,
    ledger,
    close: () => {
      ledger.close();
      outboxResult.value.db.close();
      projectionResult.value.db.close();
    },
  };
}

describe("buildOperationalQueryView — questions", () => {
  test("questions(filter) returns seeded rows adapted from the projection question store", async () => {
    const fixtures = await openFixtures();
    try {
      const adoptedCommit = commitOid("a".repeat(40));
      insertQuestion(fixtures.projection, {
        effect: questionEffect({
          question: "Open question?",
          idempotencyKey: "open-1",
          sourceRefs: [
            sourceRef({ commit: adoptedCommit, path: "wiki/a.md" }),
          ],
        }),
        processorId: "test.processor",
        runId: "run_1",
        adoptedCommit,
      });

      const view = buildOperationalQueryView({
        outbox: fixtures.outbox,
        ledger: fixtures.ledger,
        executionState: buildProcessorExecutionState(),
        queryQuestions: (filter) =>
          queryQuestionRecords(fixtures.projection, filter),
      });

      const open = view.questions({ resolved: false });
      expect(open).toHaveLength(1);
      expect(open[0]?.question).toBe("Open question?");
      expect(open[0]?.processorId).toBe("test.processor");
      expect(open[0]?.answeredAt).toBeNull();
      // Additive `state` discriminant — default open-only behavior for
      // existing callers (e.g. dome.daily.compose-blocks) is unchanged; the
      // row just now also carries `state`.
      expect(open[0]?.state).toBe("open");

      expect(view.questions({ resolved: true })).toEqual([]);
    } finally {
      fixtures.close();
    }
  });

  test("questions({ resolvedSince }) returns the open backlog plus only in-window resolved rows, discriminated by state", async () => {
    const fixtures = await openFixtures();
    try {
      const adoptedCommit = commitOid("a".repeat(40));

      insertQuestion(fixtures.projection, {
        effect: questionEffect({
          question: "Still open?",
          idempotencyKey: "open-1",
          sourceRefs: [sourceRef({ commit: adoptedCommit, path: "wiki/a.md" })],
        }),
        processorId: "test.processor",
        runId: "run_1",
        adoptedCommit,
      });

      insertQuestion(fixtures.projection, {
        effect: questionEffect({
          question: "Resolved before the window?",
          idempotencyKey: "resolved-early",
          sourceRefs: [sourceRef({ commit: adoptedCommit, path: "wiki/a.md" })],
        }),
        processorId: "test.processor",
        runId: "run_2",
        adoptedCommit,
      });
      answerQuestion(fixtures.projection, {
        idempotencyKey: "resolved-early",
        answer: "yes",
        answeredAt: "2026-06-01T00:00:00.000Z",
      });

      insertQuestion(fixtures.projection, {
        effect: questionEffect({
          question: "Resolved inside the window?",
          idempotencyKey: "resolved-in-window",
          sourceRefs: [sourceRef({ commit: adoptedCommit, path: "wiki/a.md" })],
        }),
        processorId: "test.processor",
        runId: "run_3",
        adoptedCommit,
      });
      answerQuestion(fixtures.projection, {
        idempotencyKey: "resolved-in-window",
        answer: "no",
        answeredAt: "2026-06-10T00:00:00.000Z",
      });

      const view = buildOperationalQueryView({
        outbox: fixtures.outbox,
        ledger: fixtures.ledger,
        executionState: buildProcessorExecutionState(),
        queryQuestions: (filter) =>
          queryQuestionRecords(fixtures.projection, filter),
      });

      const rows = view.questions({ resolvedSince: "2026-06-05T00:00:00.000Z" });
      expect(rows).toHaveLength(2);

      const byKey = new Map(rows.map((row) => [row.idempotencyKey, row]));
      expect(byKey.get("open-1")?.state).toBe("open");
      expect(byKey.get("open-1")?.answeredAt).toBeNull();
      expect(byKey.get("resolved-in-window")?.state).toBe("resolved");
      expect(byKey.get("resolved-in-window")?.answeredAt).toBe(
        "2026-06-10T00:00:00.000Z",
      );
      expect(byKey.get("resolved-in-window")?.answer).toBe("no");
      expect(byKey.has("resolved-early")).toBe(false);
    } finally {
      fixtures.close();
    }
  });
});

describe("buildOperationalQueryView — runs", () => {
  test("runs(filter) with startedSince returns only runs started at-or-after the bound, with cost/outcome fields", async () => {
    const fixtures = await openFixtures();
    try {
      const oldId = newRunId(new Date("2026-06-01T00:00:00.000Z"));
      insertQueued(fixtures.ledger, {
        id: oldId,
        proposalId: null,
        processorId: "test.old-processor",
        processorVersion: "1.0.0",
        phase: "garden",
        inputCommit: commitOid("a".repeat(40)),
        triggerKind: "signal",
        triggerPayload: null,
        startedAt: new Date("2026-06-01T00:00:00.000Z"),
      });
      markRunning(fixtures.ledger, oldId, new Date("2026-06-01T00:00:00.000Z"));
      markSucceeded(fixtures.ledger, {
        id: oldId,
        effectHashes: [],
        costUsd: 0.01,
        durationMs: 100,
        outputCommit: null,
        finishedAt: new Date("2026-06-01T00:00:01.000Z"),
      });

      const newId = newRunId(new Date("2026-06-10T00:00:00.000Z"));
      insertQueued(fixtures.ledger, {
        id: newId,
        proposalId: null,
        processorId: "test.new-processor",
        processorVersion: "1.0.0",
        phase: "garden",
        inputCommit: commitOid("b".repeat(40)),
        triggerKind: "signal",
        triggerPayload: null,
        startedAt: new Date("2026-06-10T00:00:00.000Z"),
      });
      markRunning(fixtures.ledger, newId, new Date("2026-06-10T00:00:00.000Z"));
      markFailed(fixtures.ledger, {
        id: newId,
        error: "boom",
        durationMs: 250,
        finishedAt: new Date("2026-06-10T00:00:00.250Z"),
      });

      const view = buildOperationalQueryView({
        outbox: fixtures.outbox,
        ledger: fixtures.ledger,
        executionState: buildProcessorExecutionState(),
        queryQuestions: (filter) =>
          queryQuestionRecords(fixtures.projection, filter),
      });

      const all = view.runs();
      expect(all).toHaveLength(2);

      const sinceRows = view.runs({ startedSince: "2026-06-05T00:00:00.000Z" });
      expect(sinceRows).toHaveLength(1);
      expect(sinceRows[0]?.id).toBe(newId);
      expect(sinceRows[0]?.processorId).toBe("test.new-processor");
      expect(sinceRows[0]?.status).toBe("failed");
      expect(sinceRows[0]?.durationMs).toBe(250);
      expect(sinceRows[0]?.costUsd).toBeNull();

      const oldRow = all.find((row) => row.id === oldId);
      expect(oldRow?.status).toBe("succeeded");
      expect(oldRow?.costUsd).toBe(0.01);
      expect(oldRow?.durationMs).toBe(100);
    } finally {
      fixtures.close();
    }
  });
});
