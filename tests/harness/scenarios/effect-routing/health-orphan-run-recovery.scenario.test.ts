// scenarios/effect-routing/health-orphan-run-recovery.scenario.test.ts
//
// Shipped dome.health processors should turn orphaned running ledger rows
// into normal questions, then fail the exact row generation through
// answer-triggered RunRecoveryEffect routing.

import { expect } from "bun:test";

import { commitOid } from "../../../../src/core/source-ref";
import type { RunId } from "../../../../src/engine/runner-contract";
import { capabilityUsesByRun } from "../../../../src/ledger/capability-uses";
import {
  getRun,
  insertQueued,
  markRunning,
  newRunId,
} from "../../../../src/ledger/runs";
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

    const startedAt = new Date("2026-05-27T00:00:00.000Z");
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

    await h.advance(60_000);
    const drained = await h.drainOperationalWork();
    expect(drained.scheduler.fired.map((fire) => fire.processorId)).toContain(
      "dome.health.orphan-run-recovery-questions",
    );
    await h
      .expectProjection()
      .questions()
      .toContainQuestion(`Run ${orphanId} for processor test.orphaned`);

    const questions = JSON.parse(
      (await h.runCli(["inspect", "questions", "--json"])).stdout,
    ) as ReadonlyArray<{
      readonly id: number;
      readonly idempotency_key: string;
    }>;
    const failQuestion = questions.find((q) =>
      q.idempotency_key.startsWith("dome.health.orphan-run-recovery:"),
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
  },
);
