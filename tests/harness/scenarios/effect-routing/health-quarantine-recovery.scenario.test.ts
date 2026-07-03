// scenarios/effect-routing/health-quarantine-recovery.scenario.test.ts
//
// Shipped dome.health processors should turn quarantined processor triggers
// into normal questions, then reset the quarantine through answer-triggered
// QuarantineRecoveryEffect routing.
//
// The quarantine-recovery-questions processor subscribes to the
// `quarantine.changed` store-change signal (the per-minute cron was dropped in
// the pruning pass). So the trip must happen through the LIVE runtime's
// execution state (`h.executionState`) — that fires the store's
// `onQuarantineChanged`, sets the runtime's tick-scoped `quarantine.changed`
// flag, and the next operational drain's epilogue dispatches the subscriber
// once. No CLI / reopen may run between the trip and the drain, or a fresh
// runtime would lose the flag.

import { expect } from "bun:test";

import type { RunId } from "../../../../src/engine/core/runner-contract";
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
  # The synthetic 'test' bundle the seeded quarantine belongs to: configured
  # (so the registry-orphan GC treats test.quarantined as a known — if absent
  # from config, the GC would prune its counter as a retired-bundle orphan).
  test:
    enabled: false
    grant: {}
`,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    // Trip the quarantine through the LIVE runtime (default threshold 3) so the
    // store fires `onQuarantineChanged` on the runtime the next drain uses.
    const key = Object.freeze({
      phase: "garden" as const,
      processorId: "test.quarantined",
      processorVersion: "0.1.0",
      triggerHash: "health-quarantine-trigger",
    });
    h.executionState.recordRetryableTerminalFailure(key, "first");
    h.executionState.recordRetryableTerminalFailure(key, "second");
    const tripped = h.executionState.recordRetryableTerminalFailure(
      key,
      "third",
    );
    expect(tripped).not.toBeNull();

    // No CLI / reopen between the trip and the drain: the epilogue reads the
    // runtime's tick-scoped `quarantine.changed` flag the trip just set.
    const drained = await h.drainOperationalWork();
    expect(drained.scheduler.fired.map((fire) => fire.processorId)).not.toContain(
      "dome.health.quarantine-recovery-questions",
    );
    await h
      .expectProjection()
      .questions()
      .toContainQuestion("Processor test.quarantined is quarantined");

    const inspectBefore = await h.runCli(["inspect", "quarantine", "--json"]);
    expect(inspectBefore.exitCode).toBe(0);
    expect(inspectBefore.stderr).toBe("");
    expect(JSON.parse(inspectBefore.stdout)).toEqual([
      expect.objectContaining({
        phase: "garden",
        processor: "test.quarantined",
        version: "0.1.0",
        trigger_hash: "health-quarantine-trigger",
        failures: 3,
      }),
    ]);

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
	        resource: expect.stringContaining(
	          "reset:garden:test.quarantined:0.1.0:health-quarantine-trigger:",
	        ),
	        outcome: "allowed",
	      }),
	    ]);

    const inspectAfter = await h.runCli(["inspect", "quarantine", "--json"]);
    expect(inspectAfter.exitCode).toBe(0);
    expect(JSON.parse(inspectAfter.stdout)).toEqual([]);
  },
);
