// scenarios/effect-routing/health-outbox-recovery.scenario.test.ts
//
// Shipped dome.health processors should turn failed outbox rows into normal
// questions, then recover the rows through answer-triggered
// OutboxRecoveryEffect routing.

import { expect } from "bun:test";

import { externalActionEffect } from "../../../../src/core/effect";
import { commitOid, sourceRef } from "../../../../src/core/source-ref";
import type { RunId } from "../../../../src/engine/core/runner-contract";
import { capabilityUsesByRun } from "../../../../src/ledger/capability-uses";
import {
  insertPending,
  markAbandoned,
  queryOutbox,
} from "../../../../src/outbox/dispatch";
import { scenario } from "../../index";

scenario(
  {
    name: "effect-routing: dome.health questions recover failed outbox rows",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "group", group: "external-actions" },
      { kind: "effect", effect: "question" },
      { kind: "effect", effect: "outbox-recovery" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "outbox.read" },
      { kind: "capability", capability: "question.ask" },
      { kind: "capability", capability: "outbox.recover" },
      { kind: "trigger", trigger: "schedule" },
      { kind: "trigger", trigger: "answer" },
    ],
    harness: {
      bundles: ["dome.health"],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  dome.health:
    enabled: true
    grant:
      read: ["**"]
      outbox.read: ["failed"]
      question.ask: true
      outbox.recover: ["retry", "abandon"]
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

    // The outbox-recovery-questions processor subscribes to the `outbox.changed`
    // store-change signal (the per-minute cron was dropped in the pruning pass).
    // So we drive REAL terminal failures through the operational drain: seed
    // PENDING rows for a capability with no registered handler, then drain — the
    // dispatcher's missing-handler terminal branch fires `outbox.changed`, whose
    // tick epilogue dispatches the subscriber once. Rows are enqueued on the
    // harness clock so the drain's `enqueued_before` cutoff includes them.
    const MISSING_HANDLER_ERROR =
      "No external handler registered for capability 'calendar.write'.";
    for (const key of ["health-retry", "health-abandon"] as const) {
      insertPending(h.outbox, {
        effect: externalActionEffect({
          capability: "calendar.write",
          idempotencyKey: key,
          payload: { title: key },
          sourceRefs: [ref],
        }),
        runId: `seed-${key}`,
        now: h.clock.now(),
      });
    }

    await h.advance(60_000);
    const drained = await h.drainOperationalWork();
    // The rows fail terminally in the drain (missing handler); the recovery
    // processor runs on the `outbox.changed` epilogue dispatch, not the
    // scheduler.
    expect(
      drained.outbox.map((r) => r.kind),
    ).toEqual(["failed", "failed"]);
    expect(drained.scheduler.fired.map((fire) => fire.processorId)).not.toContain(
      "dome.health.outbox-recovery-questions",
    );
    await h
      .expectProjection()
      .questions()
      .toContainQuestion("Outbox action health-retry");
    await h.expectProjection().questions().toHaveCount(2);

    const inspect = await h.runCli(["inspect", "questions", "--json"]);
    expect(inspect.exitCode).toBe(0);
    const questions = JSON.parse(inspect.stdout) as ReadonlyArray<{
      readonly id: number;
      readonly idempotency_key: string;
    }>;
    const retryQuestion = questions.find(
      (q) =>
        q.idempotency_key.startsWith(
          "dome.health.outbox-recovery:health-retry|failure:",
        ),
    );
    const abandonQuestion = questions.find(
      (q) =>
        q.idempotency_key.startsWith(
          "dome.health.outbox-recovery:health-abandon|failure:",
        ),
    );
    expect(retryQuestion).toBeDefined();
    expect(abandonQuestion).toBeDefined();
    if (retryQuestion === undefined || abandonQuestion === undefined) return;

    const retry = await h.runCli([
      "answer",
      String(retryQuestion.id),
      "retry",
      "--json",
    ]);
    expect(retry.exitCode).toBe(0);
    const retryBody = JSON.parse(retry.stdout) as {
      readonly handlers: {
        readonly status: string;
        readonly runs: ReadonlyArray<{ readonly run_id: RunId }>;
      };
    };
    expect(retryBody.handlers.status).toBe("handled");
    expect(retryBody.handlers.runs).toEqual([
      expect.objectContaining({
        processor_id: "dome.health.outbox-recovery-answer",
        effect_count: 1,
      }),
    ]);
    expect(retryBody.handlers).toEqual(
      expect.objectContaining({ diagnostics: [] }),
    );

    const abandon = await h.runCli([
      "answer",
      String(abandonQuestion.id),
      "abandon",
      "--json",
    ]);
    expect(abandon.exitCode).toBe(0);
    const abandonBody = JSON.parse(abandon.stdout) as {
      readonly handlers: {
        readonly status: string;
        readonly runs: ReadonlyArray<{ readonly run_id: RunId }>;
      };
    };
    expect(abandonBody.handlers.status).toBe("handled");
    expect(abandonBody.handlers.runs).toEqual([
      expect.objectContaining({
        processor_id: "dome.health.outbox-recovery-answer",
        effect_count: 1,
      }),
    ]);
    expect(abandonBody.handlers).toEqual(
      expect.objectContaining({ diagnostics: [] }),
    );

    expect(
      capabilityUsesByRun(h.ledger, retryBody.handlers.runs[0]?.run_id as RunId),
    ).toEqual([
      expect.objectContaining({
        capability: "outbox.recover",
        resource: "retry:health-retry",
        outcome: "allowed",
      }),
    ]);
    expect(
      capabilityUsesByRun(
        h.ledger,
        abandonBody.handlers.runs[0]?.run_id as RunId,
      ),
    ).toEqual([
      expect.objectContaining({
        capability: "outbox.recover",
        resource: "abandon:health-abandon",
        outcome: "allowed",
      }),
    ]);

    const rows = queryOutbox(h.outbox).map((row) => ({
      key: row.idempotencyKey,
      status: row.status,
      attempts: row.attempts,
      lastError: row.lastError,
    }));
    expect(rows).toEqual([
      {
        key: "health-retry",
        status: "pending",
        attempts: 0,
        lastError: null,
      },
      {
        // Abandoned after its terminal drain failure — attempts/lastError are
        // whatever the missing-handler terminal branch recorded.
        key: "health-abandon",
        status: "abandoned",
        attempts: 1,
        lastError: MISSING_HANDLER_ERROR,
      },
    ]);

    // Re-notification: health-retry (replayed to pending) fails terminally
    // again, firing `outbox.changed` a second time so a fresh recovery question
    // opens. The CLI replay stamped `next_attempt_at` on wall-clock time; realign
    // it to the harness clock so the operational drain re-attempts (and, with no
    // handler, re-fails) it.
    h.outbox.raw
      .query(
        "UPDATE outbox SET next_attempt_at = ? WHERE idempotency_key = 'health-retry'",
      )
      .run(h.clock.now().toISOString());
    await h.advance(60_000);
    await h.drainOperationalWork();
    const afterRetryFailure = JSON.parse(
      (await h.runCli(["inspect", "questions", "--json"])).stdout,
    ) as ReadonlyArray<{
      readonly status: string;
      readonly idempotency_key: string;
    }>;
    expect(
      afterRetryFailure.filter((q) =>
        q.idempotency_key.startsWith(
          "dome.health.outbox-recovery:health-retry|failure:",
        ),
      ).map((q) => q.status),
    ).toEqual(["answered", "open"]);
    markAbandoned(h.outbox, "health-retry");
  },
);
