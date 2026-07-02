// operational-query-view: buildOperationalQueryView adapts the durable
// outbox/ledger/execution-state/projection stores into the read-only
// `ctx.operational` surface. This file covers the `questions` accessor added
// alongside `questions.read` (docs/wiki/specs/capabilities.md
// §"questions.read") — the other three accessors (outbox/quarantines/
// orphanRuns) are already covered indirectly via tests/engine/operational-work.test.ts
// and tests/processors/runtime.test.ts.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { questionEffect } from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { buildOperationalQueryView } from "../../src/engine/operational/operational-query-view";
import { buildProcessorExecutionState } from "../../src/processors/execution-state";
import { openOutboxDb, type OutboxDb } from "../../src/outbox/db";
import { openProjectionDb, type ProjectionDb } from "../../src/projections/db";
import { insertQuestion, queryQuestionRecords } from "../../src/projections/questions";
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

      expect(view.questions({ resolved: true })).toEqual([]);
    } finally {
      fixtures.close();
    }
  });
});
