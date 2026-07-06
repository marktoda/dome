// operational-query-view: buildOperationalQueryView adapts the durable
// outbox/ledger/execution-state/projection stores into the read-only
// `ctx.operational` surface. This file covers the `questions` accessor added
// alongside `questions.read` (docs/wiki/specs/capabilities.md
// §"questions.read"), the `runs` accessor added alongside `run.read`
// (docs/wiki/specs/capabilities.md §"run.read"), and the `proposals`
// accessor added alongside `proposals.read` (docs/wiki/specs/capabilities.md
// §"proposals.read") — the other two accessors (outbox/quarantines) and
// `orphanRuns` are already covered indirectly via
// tests/engine/operational-work.test.ts and tests/processors/runtime.test.ts.
// Capability gating (declared ∩ granted → `ctx.operational.proposals`
// present/absent) is exercised in tests/processors/runtime.test.ts and
// tests/invariants/needs-are-loud.test.ts — this file tests the builder's
// raw adapter behavior only.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileChange, questionEffect } from "../../src/core/effect";
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
import { openProposalsDb, type ProposalsDb } from "../../src/proposals/db";
import {
  enqueuePendingProposal,
  listProposals,
} from "../../src/proposals/pending-proposals";
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
  readonly proposals: ProposalsDb;
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
  const proposalsResult = await openProposalsDb({
    path: join(root, "proposals.db"),
  });
  if (!proposalsResult.ok) {
    outboxResult.value.db.close();
    projectionResult.value.db.close();
    throw new Error(`proposals open failed: ${proposalsResult.error.kind}`);
  }
  const ledger = await openTestLedger();

  return {
    projection: projectionResult.value.db,
    outbox: outboxResult.value.db,
    ledger,
    proposals: proposalsResult.value.db,
    close: () => {
      ledger.close();
      proposalsResult.value.db.close();
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
        queryProposals: (filter) =>
          listProposals(fixtures.proposals, filter),
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
        queryProposals: (filter) =>
          listProposals(fixtures.proposals, filter),
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
        effectHashes: ["sha-effect-1", "sha-effect-2"],
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
        queryProposals: (filter) =>
          listProposals(fixtures.proposals, filter),
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
      // A run that never reached succeeded has no effect hashes → count 0.
      expect(sinceRows[0]?.effectCount).toBe(0);

      const oldRow = all.find((row) => row.id === oldId);
      expect(oldRow?.status).toBe("succeeded");
      expect(oldRow?.costUsd).toBe(0.01);
      expect(oldRow?.durationMs).toBe(100);
      // effectCount is the derived length of the ledger's effect hashes —
      // the no-op discriminator (0 on a succeeded run = genuine no-op).
      expect(oldRow?.effectCount).toBe(2);
    } finally {
      fixtures.close();
    }
  });
});

describe("buildOperationalQueryView — proposals", () => {
  test("proposals(filter) returns seeded rows adapted from the pending-proposals store", async () => {
    const fixtures = await openFixtures();
    try {
      enqueuePendingProposal(fixtures.proposals, {
        processorId: "test.garden",
        extensionId: "test",
        runId: "run_1",
        reason: "tidy up the notes",
        changes: [
          fileChange({ kind: "write", path: "notes/a.md", content: "hello" }),
          fileChange({ kind: "delete", path: "notes/b.md" }),
        ],
        sourceRefs: [
          sourceRef({ commit: commitOid("a".repeat(40)), path: "notes/a.md" }),
        ],
        baseCommit: "b".repeat(40),
        baseContents: { "notes/a.md": null, "notes/b.md": "old" },
        createdAt: "2026-07-06T00:00:00.000Z",
      });

      const view = buildOperationalQueryView({
        outbox: fixtures.outbox,
        ledger: fixtures.ledger,
        executionState: buildProcessorExecutionState(),
        queryQuestions: (filter) =>
          queryQuestionRecords(fixtures.projection, filter),
        queryProposals: (filter) =>
          listProposals(fixtures.proposals, filter),
      });

      // `buildOperationalQueryView` always populates `proposals` (capability
      // gating happens one layer up, in src/processors/runtime.ts); the `?`
      // in the type is for the gated `ctx.operational.proposals` surface.
      const pending = view.proposals?.({ status: "pending" }) ?? [];
      expect(pending).toHaveLength(1);
      expect(pending[0]?.processorId).toBe("test.garden");
      expect(pending[0]?.reason).toBe("tidy up the notes");
      // `paths` is derived from `changes.map(c => c.path)` — the raw
      // FileChange payload (content/kind) stays internal to proposals.db.
      expect(pending[0]?.paths).toEqual(["notes/a.md", "notes/b.md"]);
      expect(pending[0]?.status).toBe("pending");
      expect(typeof pending[0]?.id).toBe("number");
      expect(pending[0]?.createdAt).toBe("2026-07-06T00:00:00.000Z");
      // Producer bundle id + decision instant surface on the view row (the
      // trust ladder buckets accept rates by decidedAt, per-processor grants
      // resolve by extensionId).
      expect(pending[0]?.extensionId).toBe("test");
      expect(pending[0]?.decidedAt).toBeNull();

      expect(view.proposals?.({ status: "applied" })).toEqual([]);
    } finally {
      fixtures.close();
    }
  });
});
