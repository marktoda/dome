import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAnswersDb } from "../../src/answers/db";
import { externalActionEffect, questionEffect } from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { defineProcessor, treeOid } from "../../src/core/processor";
import { runOperationalWork } from "../../src/engine/operational/operational-work";
import { openOutboxDb } from "../../src/outbox/db";
import { insertPending, queryOutbox } from "../../src/outbox/dispatch";
import { openProjectionDb } from "../../src/projections/db";
import { insertQuestion } from "../../src/projections/questions";
import { getCursor } from "../../src/projections/schedule-cursors";
import { buildRegistry } from "../../src/processors/registry";
import { openTestLedger } from "../support/test-ledger";

const tmpRoots: string[] = [];

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

afterEach(async () => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

describe("runOperationalWork", () => {
  test("threads cancellation into scheduled processor dispatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "operational-work-"));
    tmpRoots.push(root);

    const projection = await openProjectionDb({
      path: join(root, "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    if (!projection.ok) {
      throw new Error(`projection open failed: ${projection.error.kind}`);
    }

    const outbox = await openOutboxDb({ path: join(root, "outbox.db") });
    if (!outbox.ok) {
      projection.value.db.close();
      throw new Error(`outbox open failed: ${outbox.error.kind}`);
    }

    const ledger = await openTestLedger();
    try {
      let started: (() => void) | undefined;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      const controller = new AbortController();
      const processor = defineProcessor({
        id: "test.operational.cancelled-schedule",
        version: "0.0.1",
        phase: "garden",
        triggers: [{ kind: "schedule", cron: "* * * * *" }],
        capabilities: [],
        run: async (ctx) => {
          started?.();
          await waitForAbort(ctx.signal);
          return [];
        },
      });
      const registry = buildRegistry([processor]);
      if (!registry.ok) {
        throw new Error(`registry build failed: ${registry.error.kind}`);
      }

      const logicalNow = new Date("2026-01-01T00:00:00.000Z");
      const run = runOperationalWork({
        vault: {
          path: root,
          config: { git: { auto_commit_workflows: true } },
        },
        adopted: commitOid("b".repeat(40)),
        registry: registry.value,
        projection: projection.value.db,
        outbox: outbox.value.db,
        sinks: {
          applyPatch: async () => null,
          captureView: async () => {},
          recordDiagnostic: async () => {},
          recordFact: async () => {},
          recordSearchDocument: async () => {},
          recordQuestion: async () => {},
          dispatchExternal: async () => {},
          recoverOutbox: async () => true,
          recoverQuarantine: async () => true,
          recoverRun: async () => true,
        },
        resolveTree: async () => treeOid("c".repeat(40)),
        now: () => logicalNow,
        resolveGrants: () => [],
        extensionIdFor: (processorId) => processorId,
        externalHandlers: {},
        signal: controller.signal,
        ledger,
      });

      await startedPromise;
      controller.abort();
      const result = await run;

      expect(result.scheduler.fired).toEqual([]);
      expect(result.scheduler.skipped).toContainEqual({
        processorId: processor.id,
        reason: "cancelled",
      });
      expect(getCursor(projection.value.db, processor.id)).toBeNull();
    } finally {
      ledger.close();
      outbox.value.db.close();
      projection.value.db.close();
    }
  });

  test("uses the injected clock for the outbox drain cutoff", async () => {
    const root = mkdtempSync(join(tmpdir(), "operational-work-"));
    tmpRoots.push(root);

    const projection = await openProjectionDb({
      path: join(root, "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    if (!projection.ok) {
      throw new Error(`projection open failed: ${projection.error.kind}`);
    }

    const outbox = await openOutboxDb({ path: join(root, "outbox.db") });
    if (!outbox.ok) {
      projection.value.db.close();
      throw new Error(`outbox open failed: ${outbox.error.kind}`);
    }

    const ledger = await openTestLedger();
    try {
      const logicalNow = new Date("2026-01-01T00:00:00.000Z");
      const idempotencyKey = "future-enqueued";
      insertPending(outbox.value.db, {
        runId: "run_test",
        now: new Date(logicalNow.getTime() - 1),
        effect: externalActionEffect({
          capability: "calendar.write",
          idempotencyKey,
          payload: { title: "future" },
          sourceRefs: [
            sourceRef({
              commit: commitOid("a".repeat(40)),
              path: "wiki/page.md",
            }),
          ],
        }),
      });
      outbox.value.db.raw
        .query("UPDATE outbox SET enqueued_at = ? WHERE idempotency_key = ?")
        .run(
          new Date(logicalNow.getTime() + 1000).toISOString(),
          idempotencyKey,
        );

      const registry = buildRegistry([]);
      if (!registry.ok) {
        throw new Error(`registry build failed: ${registry.error.kind}`);
      }

      let handlerCalls = 0;
      const result = await runOperationalWork({
        vault: {
          path: root,
          config: { git: { auto_commit_workflows: true } },
        },
        adopted: commitOid("b".repeat(40)),
        registry: registry.value,
        projection: projection.value.db,
        outbox: outbox.value.db,
        sinks: {
          applyPatch: async () => null,
          captureView: async () => {},
          recordDiagnostic: async () => {},
          recordFact: async () => {},
          recordSearchDocument: async () => {},
          recordQuestion: async () => {},
          dispatchExternal: async () => {},
          recoverOutbox: async () => true,
          recoverQuarantine: async () => true,
          recoverRun: async () => true,
        },
        resolveTree: async () => treeOid("c".repeat(40)),
        now: () => logicalNow,
        resolveGrants: () => [],
        extensionIdFor: (processorId) => processorId,
        externalHandlers: {
          "calendar.write": async () => {
            handlerCalls++;
            return { externalId: "external_test" };
          },
        },
        ledger,
      });

      expect(result.outbox).toEqual([]);
      expect(handlerCalls).toBe(0);
    } finally {
      ledger.close();
      outbox.value.db.close();
      projection.value.db.close();
    }
  });

  test("cancels in-flight outbox dispatch without consuming retry budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "operational-work-"));
    tmpRoots.push(root);

    const projection = await openProjectionDb({
      path: join(root, "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    if (!projection.ok) {
      throw new Error(`projection open failed: ${projection.error.kind}`);
    }

    const outbox = await openOutboxDb({ path: join(root, "outbox.db") });
    if (!outbox.ok) {
      projection.value.db.close();
      throw new Error(`outbox open failed: ${outbox.error.kind}`);
    }

    const ledger = await openTestLedger();
    try {
      const logicalNow = new Date("2026-01-01T00:00:00.000Z");
      insertPending(outbox.value.db, {
        runId: "run_test",
        now: new Date(logicalNow.getTime() - 1),
        effect: externalActionEffect({
          capability: "calendar.write",
          idempotencyKey: "cancel-during-drain",
          payload: { title: "cancel" },
          sourceRefs: [
            sourceRef({
              commit: commitOid("a".repeat(40)),
              path: "wiki/page.md",
            }),
          ],
        }),
      });

      const registry = buildRegistry([]);
      if (!registry.ok) {
        throw new Error(`registry build failed: ${registry.error.kind}`);
      }

      const controller = new AbortController();
      let started: (() => void) | undefined;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      let handlerSignal: AbortSignal | undefined;

      const run = runOperationalWork({
        vault: {
          path: root,
          config: { git: { auto_commit_workflows: true } },
        },
        adopted: commitOid("b".repeat(40)),
        registry: registry.value,
        projection: projection.value.db,
        outbox: outbox.value.db,
        sinks: {
          applyPatch: async () => null,
          captureView: async () => {},
          recordDiagnostic: async () => {},
          recordFact: async () => {},
          recordSearchDocument: async () => {},
          recordQuestion: async () => {},
          dispatchExternal: async () => {},
          recoverOutbox: async () => true,
          recoverQuarantine: async () => true,
          recoverRun: async () => true,
        },
        resolveTree: async () => treeOid("c".repeat(40)),
        now: () => logicalNow,
        resolveGrants: () => [],
        extensionIdFor: (processorId) => processorId,
        externalHandlers: {
          "calendar.write": async ({ signal }) => {
            handlerSignal = signal;
            started?.();
            await waitForAbort(signal);
            return { externalId: "should-not-send" };
          },
        },
        signal: controller.signal,
        ledger,
      });

      await startedPromise;
      expect(handlerSignal?.aborted).toBe(false);
      controller.abort();

      const result = await run;
      expect(result.outbox).toHaveLength(1);
      expect(result.outbox[0]?.kind).toBe("cancelled");
      expect(handlerSignal?.aborted).toBe(true);

      const row = queryOutbox(outbox.value.db)[0];
      expect(row?.status).toBe("pending");
      expect(row?.attempts).toBe(0);
      expect(row?.lastError).toBeNull();
    } finally {
      ledger.close();
      outbox.value.db.close();
      projection.value.db.close();
    }
  });

  test("question expiry fires onQuestionsChanged, surfaces diagnostics, and exempts disabled bundles", async () => {
    const root = mkdtempSync(join(tmpdir(), "operational-work-"));
    tmpRoots.push(root);

    const projection = await openProjectionDb({
      path: join(root, "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    if (!projection.ok) {
      throw new Error(`projection open failed: ${projection.error.kind}`);
    }

    const outbox = await openOutboxDb({ path: join(root, "outbox.db") });
    if (!outbox.ok) {
      projection.value.db.close();
      throw new Error(`outbox open failed: ${outbox.error.kind}`);
    }

    const answers = await openAnswersDb({ path: join(root, "answers.db") });
    if (!answers.ok) {
      outbox.value.db.close();
      projection.value.db.close();
      throw new Error(`answers open failed: ${answers.error.kind}`);
    }

    const ledger = await openTestLedger();
    try {
      const adopted = commitOid("b".repeat(40));
      // Two open questions from unregistered emitters: one under a
      // configured-but-DISABLED bundle (exempt), one genuinely retired.
      insertQuestion(projection.value.db, {
        effect: questionEffect({
          question: "Reset the paused warden?",
          sourceRefs: [],
          idempotencyKey: "disabled-bundle-question",
        }),
        processorId: "dome.paused.checker",
        runId: "run_disabled",
        adoptedCommit: adopted,
      });
      insertQuestion(projection.value.db, {
        effect: questionEffect({
          question: "Fail the retired warden's stuck run?",
          sourceRefs: [],
          idempotencyKey: "retired-question",
        }),
        processorId: "dome.warden.integrity",
        runId: "run_retired",
        adoptedCommit: adopted,
      });

      const registry = buildRegistry([]);
      if (!registry.ok) {
        throw new Error(`registry build failed: ${registry.error.kind}`);
      }

      let questionsChangedFires = 0;
      const result = await runOperationalWork({
        vault: {
          path: root,
          config: { git: { auto_commit_workflows: true } },
        },
        adopted,
        registry: registry.value,
        projection: projection.value.db,
        answers: answers.value.db,
        outbox: outbox.value.db,
        disabledExtensionIds: ["dome.paused"],
        onQuestionsChanged: () => {
          questionsChangedFires += 1;
        },
        sinks: {
          applyPatch: async () => null,
          captureView: async () => {},
          recordDiagnostic: async () => {},
          recordFact: async () => {},
          recordSearchDocument: async () => {},
          recordQuestion: async () => {},
          dispatchExternal: async () => {},
          recoverOutbox: async () => true,
          recoverQuarantine: async () => true,
          recoverRun: async () => true,
        },
        resolveTree: async () => treeOid("c".repeat(40)),
        now: () => new Date("2026-07-06T00:00:00.000Z"),
        resolveGrants: () => [],
        extensionIdFor: (processorId) => processorId,
        externalHandlers: {},
        ledger,
      });

      // Only the retired emitter's question expired; the disabled bundle's
      // question is exempt (quarantine-GC posture).
      expect(result.questionExpiry.expired).toBe(1);
      // Expiry changes the open-question set outside the recordQuestion sink,
      // so the tick-scoped questions.changed flag must be raised — same
      // contract as auto-resolution's durable answers.
      expect(questionsChangedFires).toBe(1);
      // Dual diagnostics pattern (scheduler.ts): the expiry diagnostic is on
      // the result, folded into the aggregate diagnostics array.
      expect(
        result.questionExpiry.diagnostics.map((d) => d.code),
      ).toEqual(["question.expired-subject-retired"]);
      expect(result.diagnostics.map((d) => d.code)).toContain(
        "question.expired-subject-retired",
      );

      // A second pump run expires nothing and does NOT re-fire the flag.
      questionsChangedFires = 0;
      const second = await runOperationalWork({
        vault: {
          path: root,
          config: { git: { auto_commit_workflows: true } },
        },
        adopted,
        registry: registry.value,
        projection: projection.value.db,
        answers: answers.value.db,
        outbox: outbox.value.db,
        disabledExtensionIds: ["dome.paused"],
        onQuestionsChanged: () => {
          questionsChangedFires += 1;
        },
        sinks: {
          applyPatch: async () => null,
          captureView: async () => {},
          recordDiagnostic: async () => {},
          recordFact: async () => {},
          recordSearchDocument: async () => {},
          recordQuestion: async () => {},
          dispatchExternal: async () => {},
          recoverOutbox: async () => true,
          recoverQuarantine: async () => true,
          recoverRun: async () => true,
        },
        resolveTree: async () => treeOid("c".repeat(40)),
        now: () => new Date("2026-07-06T00:00:00.000Z"),
        resolveGrants: () => [],
        extensionIdFor: (processorId) => processorId,
        externalHandlers: {},
        ledger,
      });
      expect(second.questionExpiry.expired).toBe(0);
      expect(questionsChangedFires).toBe(0);
    } finally {
      ledger.close();
      answers.value.db.close();
      outbox.value.db.close();
      projection.value.db.close();
    }
  });
});
