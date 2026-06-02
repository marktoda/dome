// scenarios/v1-acceptance/recovery-gauntlet.scenario.test.ts
//
// Top-level V1 recovery proof: operational trouble is visible through
// status/doctor/inspect, health processors raise normal questions, and
// answer handlers recover the substrate through effect routing.

import { expect } from "bun:test";
import { join } from "node:path";

import { externalActionEffect } from "../../../../src/core/effect";
import { commitOid, sourceRef } from "../../../../src/core/source-ref";
import { openQuarantineStore } from "../../../../src/engine/quarantine-store";
import type { RunId } from "../../../../src/engine/runner-contract";
import { capabilityUsesByRun } from "../../../../src/ledger/capability-uses";
import {
  getRun,
  insertQueued,
  markRunning,
  newRunId,
} from "../../../../src/ledger/runs";
import {
  insertPending,
  markFailed,
  queryOutbox,
} from "../../../../src/outbox/dispatch";
import type { Harness } from "../../types";
import { scenario } from "../../index";

scenario(
  {
    name: "v1-acceptance: recovery loop surfaces and resolves stuck operational state",
    tags: [
      { kind: "group", group: "v1-acceptance" },
      { kind: "effect", effect: "question" },
      { kind: "effect", effect: "outbox-recovery" },
      { kind: "effect", effect: "quarantine-recovery" },
      { kind: "effect", effect: "run-recovery" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "schedule" },
      { kind: "trigger", trigger: "answer" },
      { kind: "route", route: "garden-schedule" },
      { kind: "route", route: "garden-answer" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "outbox.read" },
      { kind: "capability", capability: "outbox.recover" },
      { kind: "capability", capability: "quarantine.read" },
      { kind: "capability", capability: "quarantine.recover" },
      { kind: "capability", capability: "run.read" },
      { kind: "capability", capability: "run.recover" },
      { kind: "capability", capability: "question.ask" },
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
      outbox.recover: ["retry", "abandon"]
      quarantine.read: true
      quarantine.recover: ["reset"]
      run.read: ["running"]
      run.recover: ["fail"]
      question.ask: true
`,
        "AGENTS.md": [
          "# This is a Dome vault.",
          "",
          "Use Dome status, doctor, inspect, and resolve for operational recovery.",
          "",
          "<!-- BEGIN user-prose -->",
          "<!-- END user-prose -->",
          "",
        ].join("\n"),
        "CLAUDE.md": "@AGENTS.md\n",
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const adopted = await h.refs.adopted();
    expect(adopted).not.toBeNull();
    if (adopted === null) return;
    const adoptedCommit = commitOid(adopted);

    const ref = sourceRef({
      commit: adoptedCommit,
      path: ".dome/config.yaml",
    });
    insertPending(h.outbox, {
      effect: externalActionEffect({
        capability: "calendar.write",
        idempotencyKey: "gauntlet-outbox",
        payload: { title: "Recovery gauntlet" },
        sourceRefs: [ref],
      }),
      runId: "seed-gauntlet-outbox",
    });
    markFailed(h.outbox, "gauntlet-outbox", "terminal failure");

    const startedAt = new Date(h.clock.now().getTime() - 6 * 60_000);
    const orphanId = newRunId(startedAt, () => "aaaaaa");
    insertQueued(h.ledger, {
      id: orphanId,
      proposalId: null,
      processorId: "test.gauntlet-orphaned",
      processorVersion: "0.1.0",
      phase: "garden",
      inputCommit: adoptedCommit,
      triggerKind: "schedule",
      triggerPayload: null,
      startedAt,
    });
    markRunning(h.ledger, orphanId, startedAt);

    const quarantine = openQuarantineStore({
      path: join(h.vaultPath, ".dome", "state", "quarantined.json"),
      quarantineThreshold: 2,
    });
    if (!quarantine.ok) {
      throw new Error(`quarantine open failed: ${quarantine.error.kind}`);
    }
    quarantine.value.recordRetryableTerminalFailure(
      {
        phase: "garden",
        processorId: "test.gauntlet-quarantined",
        processorVersion: "0.1.0",
        triggerHash: "gauntlet-trigger",
      },
      "first",
    );
    quarantine.value.recordRetryableTerminalFailure(
      {
        phase: "garden",
        processorId: "test.gauntlet-quarantined",
        processorVersion: "0.1.0",
        triggerHash: "gauntlet-trigger",
      },
      "second",
    );
    await h.reopenRuntime();

    const statusBefore = JSON.parse(
      (await successfulCli(h, ["status", "--json"])).stdout,
    ) as {
      readonly questions: number;
      readonly outbox_failed: number;
      readonly quarantined: number;
      readonly failed_runs: number;
    };
    expect(statusBefore).toEqual(
      expect.objectContaining({
        questions: 0,
        outbox_failed: 1,
        quarantined: 1,
        failed_runs: 0,
      }),
    );

    const doctorBefore = JSON.parse(
      (await successfulCli(h, ["doctor", "--json"])).stdout,
    ) as {
      readonly status: string;
      readonly summary: {
        readonly failedOutbox: number;
        readonly orphanRuns: number;
        readonly quarantinedProcessors: number;
      };
    };
    expect(doctorBefore.status).toBe("unhealthy");
    expect(doctorBefore.summary).toEqual(
      expect.objectContaining({
        failedOutbox: 1,
        orphanRuns: 1,
        quarantinedProcessors: 1,
      }),
    );

    const outboxRows = JSON.parse(
      (await successfulCli(h, ["inspect", "outbox", "--json"])).stdout,
    ) as ReadonlyArray<{ readonly id: number; readonly status: string }>;
    expect(outboxRows).toEqual([
      expect.objectContaining({ id: 1, status: "failed" }),
    ]);

    const runRows = JSON.parse(
      (await successfulCli(h, ["inspect", "runs", "--json"])).stdout,
    ) as ReadonlyArray<{
      readonly id: string;
      readonly processor: string;
      readonly status: string;
    }>;
    expect(runRows).toContainEqual(
      expect.objectContaining({
        id: orphanId,
        processor: "test.gauntlet-orphaned",
        status: "running",
      }),
    );

    const quarantineRows = JSON.parse(
      (await successfulCli(h, ["inspect", "quarantine", "--json"])).stdout,
    ) as ReadonlyArray<{
      readonly processor: string;
      readonly failures: number;
    }>;
    expect(quarantineRows).toEqual([
      expect.objectContaining({
        processor: "test.gauntlet-quarantined",
        failures: 2,
      }),
    ]);

    await h.advance(60_000);
    const drained = await h.drainOperationalWork();
    expect(drained.scheduler.fired.map((fire) => fire.processorId)).toEqual(
      expect.arrayContaining([
        "dome.health.outbox-recovery-questions",
        "dome.health.quarantine-recovery-questions",
        "dome.health.orphan-run-recovery-questions",
      ]),
    );

    const statusWithQuestions = JSON.parse(
      (await successfulCli(h, ["status", "--json"])).stdout,
    ) as { readonly questions: number };
    expect(statusWithQuestions.questions).toBe(3);

    const questions = JSON.parse(
      (await successfulCli(h, ["inspect", "questions", "--json"])).stdout,
    ) as ReadonlyArray<{
      readonly id: number;
      readonly status: string;
      readonly idempotency_key: string;
    }>;
    expect(questions).toHaveLength(3);
    expect(questions.every((q) => q.status === "open")).toBe(true);

    const outboxQuestion = questionWithKey(
      questions,
      "dome.health.outbox-recovery:gauntlet-outbox|failure:",
    );
    const quarantineQuestion = questionWithKey(
      questions,
      "dome.health.quarantine-recovery:",
    );
    const orphanQuestion = questionWithKey(
      questions,
      "dome.health.orphan-run-recovery:",
    );

    const outboxAnswer = await answerQuestion(h, outboxQuestion.id, "abandon");
    expect(outboxAnswer.handlers.runs).toEqual([
      expect.objectContaining({
        processor_id: "dome.health.outbox-recovery-answer",
        effect_count: 1,
      }),
    ]);
    expect(
      capabilityUsesByRun(
        h.ledger,
        outboxAnswer.handlers.runs[0]?.run_id as RunId,
      ),
    ).toEqual([
      expect.objectContaining({
        capability: "outbox.recover",
        resource: "abandon:gauntlet-outbox",
        outcome: "allowed",
      }),
    ]);

    const quarantineAnswer = await answerQuestion(
      h,
      quarantineQuestion.id,
      "reset",
    );
    expect(quarantineAnswer.handlers.runs).toEqual([
      expect.objectContaining({
        processor_id: "dome.health.quarantine-recovery-answer",
        effect_count: 1,
      }),
    ]);
    expect(
      capabilityUsesByRun(
        h.ledger,
        quarantineAnswer.handlers.runs[0]?.run_id as RunId,
      )[0],
    ).toEqual(
      expect.objectContaining({
        capability: "quarantine.recover",
        outcome: "allowed",
      }),
    );

    const orphanAnswer = await answerQuestion(h, orphanQuestion.id, "fail");
    expect(orphanAnswer.handlers.runs).toEqual([
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

    const finalStatus = JSON.parse(
      (await successfulCli(h, ["status", "--json"])).stdout,
    ) as {
      readonly questions: number;
      readonly outbox_pending: number;
      readonly outbox_failed: number;
      readonly quarantined: number;
      readonly failed_runs: number;
    };
    expect(finalStatus).toEqual(
      expect.objectContaining({
        questions: 0,
        outbox_pending: 0,
        outbox_failed: 0,
        quarantined: 0,
        failed_runs: 0,
      }),
    );

    const doctorAfter = JSON.parse(
      (await successfulCli(h, ["doctor", "--json"])).stdout,
    ) as {
      readonly status: string;
      readonly summary: { readonly findingCount: number };
    };
    expect(doctorAfter.status).toBe("ok");
    expect(doctorAfter.summary.findingCount).toBe(0);

    expect(
      queryOutbox(h.outbox).map((row) => ({
        key: row.idempotencyKey,
        status: row.status,
      })),
    ).toEqual([{ key: "gauntlet-outbox", status: "abandoned" }]);
    expect(
      JSON.parse(
        (await successfulCli(h, ["inspect", "quarantine", "--json"])).stdout,
      ),
    ).toEqual([]);
  },
);

async function successfulCli(
  h: Harness,
  args: ReadonlyArray<string>,
): Promise<{ readonly stdout: string }> {
  const result = await h.runCli(args);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  return result;
}

function questionWithKey(
  questions: ReadonlyArray<{
    readonly id: number;
    readonly idempotency_key: string;
  }>,
  prefix: string,
): { readonly id: number; readonly idempotency_key: string } {
  const question = questions.find((q) => q.idempotency_key.startsWith(prefix));
  expect(question).toBeDefined();
  if (question === undefined) {
    throw new Error(`expected question with key prefix ${prefix}`);
  }
  return question;
}

async function answerQuestion(
  h: Harness,
  id: number,
  value: string,
): Promise<{
  readonly handlers: {
    readonly status: string;
    readonly runs: ReadonlyArray<{ readonly run_id: RunId }>;
  };
}> {
  const answer = await successfulCli(h, [
    "resolve",
    String(id),
    value,
    "--json",
  ]);
  const payload = JSON.parse(answer.stdout) as {
    readonly handlers: {
      readonly status: string;
      readonly runs: ReadonlyArray<{ readonly run_id: RunId }>;
    };
  };
  expect(payload.handlers.status).toBe("handled");
  return payload;
}
