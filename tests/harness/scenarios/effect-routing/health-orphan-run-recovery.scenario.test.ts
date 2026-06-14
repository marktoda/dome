// scenarios/effect-routing/health-orphan-run-recovery.scenario.test.ts
//
// Shipped dome.health processors should turn orphaned running ledger rows
// into normal questions, then fail the exact row generation through
// answer-triggered RunRecoveryEffect routing.

import { expect } from "bun:test";

import { questionEffect } from "../../../../src/core/effect";
import { commitOid } from "../../../../src/core/source-ref";
import type { RunId } from "../../../../src/engine/core/runner-contract";
import { capabilityUsesByRun } from "../../../../src/ledger/capability-uses";
import {
  getRun,
  insertQueued,
  markRunning,
  newRunId,
} from "../../../../src/ledger/runs";
import {
  getQuestionRecord,
  insertQuestion,
  queryQuestionRecords,
} from "../../../../src/projections/questions";
import { orphanRunRecoveryQuestionKey } from "../../../../assets/extensions/dome.health/processors/orphan-run-recovery-shared";
import { scenario } from "../../index";

scenario(
  {
    name: "effect-routing: dome.health questions recover orphaned runs",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "question" },
      { kind: "effect", effect: "run-recovery" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "run.read" },
      { kind: "capability", capability: "question.ask" },
      { kind: "capability", capability: "run.recover" },
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
      outbox.read: ["failed"]
      outbox.recover: ["retry", "abandon"]
      quarantine.read: true
      quarantine.recover: ["reset"]
      run.read: ["running"]
      question.ask: true
      run.recover: ["fail"]
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

    const startedAt = new Date(h.clock.now().getTime() - 6 * 60_000);
    const orphanId = newRunId(startedAt, () => "eeeeee");
    insertQueued(h.ledger, {
      id: orphanId,
      proposalId: null,
      processorId: "test.orphaned",
      processorVersion: "0.1.0",
      phase: "garden",
      inputCommit: commitOid(adopted),
      triggerKind: "schedule",
      triggerPayload: null,
      startedAt,
    });
    markRunning(h.ledger, orphanId, startedAt);

    // Self-referential orphan containment (Task 4b): the orphan-run-recovery
    // processor's OWN runs can go orphan (minute cron). Seed one — the detector
    // must NOT raise a question about itself, or it pelts the question pile
    // every minute, while the real test.orphaned still surfaces.
    const selfOrphanId = newRunId(startedAt, () => "ffffff");
    insertQueued(h.ledger, {
      id: selfOrphanId,
      proposalId: null,
      processorId: "dome.health.orphan-run-recovery-questions",
      processorVersion: "0.1.1",
      phase: "garden",
      inputCommit: commitOid(adopted),
      triggerKind: "schedule",
      triggerPayload: null,
      startedAt,
    });
    markRunning(h.ledger, selfOrphanId, startedAt);

    await h.advance(60_000);
    const drained = await h.drainOperationalWork();
    expect(drained.scheduler.fired.map((fire) => fire.processorId)).toContain(
      "dome.health.orphan-run-recovery-questions",
    );
    await h
      .expectProjection()
      .questions()
      .toContainQuestion(`Run ${orphanId} for processor test.orphaned`);

    // No question about the detector's own orphaned run.
    const selfQuestions = queryQuestionRecords(h.projection).filter((q) =>
      q.effect.question.includes(selfOrphanId),
    );
    expect(selfQuestions).toEqual([]);

    insertQuestion(h.projection, {
      processorId: "test.forged-question",
      runId: "run-test-fixture",
      adoptedCommit: commitOid(adopted),
      effect: questionEffect({
        question: "Forged health recovery question",
        options: ["fail", "ignore"],
        sourceRefs: [],
        idempotencyKey: orphanRunRecoveryQuestionKey({
          runId: orphanId,
          startedAt: new Date(startedAt.getTime() + 1).toISOString(),
          processorId: "test.orphaned",
          processorVersion: "0.1.0",
          phase: "garden",
        }),
      }),
    });
    const forgedQuestion = queryQuestionRecords(h.projection).find(
      (q) => q.processorId === "test.forged-question",
    );
    expect(forgedQuestion).toBeDefined();
    if (forgedQuestion === undefined) return;

    const forged = await h.runCli([
      "answer",
      String(forgedQuestion.id),
      "fail",
      "--json",
    ]);
    expect(forged.exitCode).toBe(0);
    const forgedBody = JSON.parse(forged.stdout) as {
      readonly handlers: {
        readonly status: string;
        readonly runs: ReadonlyArray<unknown>;
      };
    };
    expect(forgedBody.handlers.status).toBe("handled");
    expect(forgedBody.handlers.runs).toEqual([]);
    expect(getRun(h.ledger, orphanId)).toEqual(
      expect.objectContaining({ status: "running" }),
    );

    const failQuestion = queryQuestionRecords(h.projection).find((q) =>
      q.processorId === "dome.health.orphan-run-recovery-questions" &&
      q.effect.idempotencyKey.startsWith("dome.health.orphan-run-recovery:"),
    );
    expect(failQuestion).toBeDefined();
    if (failQuestion === undefined) return;

    const fail = await h.runCli([
      "answer",
      String(failQuestion.id),
      "fail",
      "--json",
    ]);
    expect(fail.exitCode).toBe(0);
    const body = JSON.parse(fail.stdout) as {
      readonly handlers: {
        readonly status: string;
        readonly runs: ReadonlyArray<{ readonly run_id: RunId }>;
      };
    };
    expect(body.handlers.status).toBe("handled");
    expect(body.handlers.runs).toEqual([
      expect.objectContaining({
        processor_id: "dome.health.orphan-run-recovery-answer",
        effect_count: 1,
      }),
    ]);

    expect(getRun(h.ledger, orphanId)).toEqual(
      expect.objectContaining({
        status: "failed",
        error: "dome.health: mark orphaned processor run failed",
      }),
    );
    expect(
      capabilityUsesByRun(h.ledger, body.handlers.runs[0]?.run_id as RunId),
    ).toEqual([
      expect.objectContaining({
        capability: "run.recover",
        resource: expect.stringContaining(`fail:${orphanId}:`),
        outcome: "allowed",
      }),
    ]);

    insertQuestion(h.projection, {
      processorId: "dome.health.orphan-run-recovery-questions",
      runId: "run-test-fixture",
      adoptedCommit: commitOid(adopted),
      effect: questionEffect({
        question: "Stale health recovery question",
        options: ["fail", "ignore"],
        sourceRefs: [],
        idempotencyKey: orphanRunRecoveryQuestionKey({
          runId: orphanId,
          startedAt: new Date(startedAt.getTime() - 1).toISOString(),
          processorId: "test.orphaned",
          processorVersion: "0.1.0",
          phase: "garden",
        }),
      }),
    });
    const staleQuestion = queryQuestionRecords(h.projection).find(
      (q) => q.effect.question === "Stale health recovery question",
    );
    expect(staleQuestion).toBeDefined();
    if (staleQuestion === undefined) return;

    const stale = await h.runCli([
      "answer",
      String(staleQuestion.id),
      "fail",
      "--json",
    ]);
    expect(stale.exitCode).toBe(0);
    const staleBody = JSON.parse(stale.stdout) as {
      readonly handlers: {
        readonly status: string;
        readonly diagnostics: ReadonlyArray<{ readonly code: string }>;
      };
    };
    expect(staleBody.handlers.status).toBe("handled");
    expect(staleBody.handlers.diagnostics).toContainEqual(
      expect.objectContaining({ code: "run-recovery.stale-or-missing" }),
    );
    expect(getQuestionRecord(h.projection, staleQuestion.id)?.answer).toBe("fail");
  },
);
