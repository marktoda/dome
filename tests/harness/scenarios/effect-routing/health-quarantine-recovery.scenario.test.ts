// scenarios/effect-routing/health-quarantine-recovery.scenario.test.ts
//
// Shipped dome.health processors should turn quarantined processor triggers
// into normal questions, then reset the quarantine through answer-triggered
// QuarantineRecoveryEffect routing.

import { expect } from "bun:test";
import { join } from "node:path";

import { openQuarantineStore } from "../../../../src/engine/quarantine-store";
import type { RunId } from "../../../../src/engine/runner-contract";
import { capabilityUsesByRun } from "../../../../src/ledger/capability-uses";
import { scenario } from "../../index";

scenario(
  {
    name: "effect-routing: dome.health questions reset quarantined processors",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "question" },
      { kind: "effect", effect: "quarantine-recovery" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "quarantine.read" },
      { kind: "capability", capability: "question.ask" },
      { kind: "capability", capability: "quarantine.recover" },
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
      quarantine.read: true
      question.ask: true
      quarantine.recover: ["reset"]
`,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const quarantine = openQuarantineStore({
      path: join(h.vaultPath, ".dome", "state", "quarantined.json"),
      quarantineThreshold: 2,
    });
    if (!quarantine.ok) {
      throw new Error(`quarantine open failed: ${quarantine.error.kind}`);
    }
    const key = Object.freeze({
      phase: "garden" as const,
      processorId: "test.quarantined",
      processorVersion: "0.1.0",
      triggerHash: "health-quarantine-trigger",
    });
    quarantine.value.recordRetryableTerminalFailure(key, "first");
    quarantine.value.recordRetryableTerminalFailure(key, "second");
    await h.reopenRuntime();

    const inspectBefore = await h.runCli(["inspect", "quarantine", "--json"]);
    expect(inspectBefore.exitCode).toBe(0);
    expect(inspectBefore.stderr).toBe("");
    expect(JSON.parse(inspectBefore.stdout)).toEqual([
      expect.objectContaining({
        phase: "garden",
        processor: "test.quarantined",
        version: "0.1.0",
        trigger_hash: "health-quarantine-trigger",
        failures: 2,
      }),
    ]);

    await h.advance(60_000);
    const drained = await h.drainOperationalWork();
    expect(drained.scheduler.fired.map((fire) => fire.processorId)).toContain(
      "dome.health.quarantine-recovery-questions",
    );
    await h
      .expectProjection()
      .questions()
      .toContainQuestion("Processor test.quarantined is quarantined");

    const questions = JSON.parse(
      (await h.runCli(["inspect", "questions", "--json"])).stdout,
    ) as ReadonlyArray<{
      readonly id: number;
      readonly idempotency_key: string;
    }>;
    const resetQuestion = questions.find((q) =>
      q.idempotency_key.startsWith("dome.health.quarantine-recovery:"),
    );
    expect(resetQuestion).toBeDefined();
    if (resetQuestion === undefined) return;

    const reset = await h.runCli([
      "answer",
      String(resetQuestion.id),
      "reset",
      "--json",
    ]);
    expect(reset.exitCode).toBe(0);
    const body = JSON.parse(reset.stdout) as {
      readonly handlers: {
        readonly status: string;
        readonly runs: ReadonlyArray<{ readonly run_id: RunId }>;
      };
    };
    expect(body.handlers.status).toBe("handled");
    expect(body.handlers.runs).toEqual([
      expect.objectContaining({
        processor_id: "dome.health.quarantine-recovery-answer",
        effect_count: 1,
      }),
    ]);

    expect(
      capabilityUsesByRun(h.ledger, body.handlers.runs[0]?.run_id as RunId),
    ).toEqual([
      expect.objectContaining({
        capability: "quarantine.recover",
        resource:
          "reset:garden:test.quarantined:0.1.0:health-quarantine-trigger",
        outcome: "allowed",
      }),
    ]);

    const inspectAfter = await h.runCli(["inspect", "quarantine", "--json"]);
    expect(inspectAfter.exitCode).toBe(0);
    expect(JSON.parse(inspectAfter.stdout)).toEqual([]);
  },
);
