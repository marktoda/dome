// scenarios/v1-acceptance/recovery-gauntlet.scenario.test.ts
//
// Top-level V1 recovery proof: operational trouble is visible through
// status/doctor/inspect, health processors raise normal questions, and
// answer handlers recover the substrate through effect routing.

import { expect } from "bun:test";
import { join } from "node:path";

import { externalActionEffect } from "../../../../src/core/effect";
import { commitOid, sourceRef } from "../../../../src/core/source-ref";
import type { RunId } from "../../../../src/engine/core/runner-contract";
import { capabilityUsesByRun } from "../../../../src/ledger/capability-uses";
import {
  getRun,
  insertQueued,
  markRunning,
  newRunId,
} from "../../../../src/ledger/runs";
import { insertPending, queryOutbox } from "../../../../src/outbox/dispatch";
import type { Harness } from "../../types";
import { scenario } from "../../index";

// A registered no-op processor id, standing in for "some active processor
// hit operational trouble" — the run/quarantine subject must resolve in the
// live ProcessorRegistry, or subject-liveness expiry
// (src/engine/operational/question-expiry.ts) releases the orphan-run and
// quarantine-recovery questions the instant they are raised, before this
// gauntlet gets to exercise their answer-routed recovery.
const GAUNTLET_PROCESSOR_ID = "test.orphaned-run.worker";
const GAUNTLET_FIXTURE_BUNDLE = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.orphaned-run",
);

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
      bundles: [
        "dome.health",
        { id: "test.orphaned-run", root: GAUNTLET_FIXTURE_BUNDLE },
      ],
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
      proposals.read: true
      patch.propose: [".dome/config.yaml"]
    processors:
      dome.health.report-card:
        grant:
          read:
            - "wiki/dailies/*.md"
            - "meta/report-card.md"
            - "meta/retrieval-misses.md"
            - ".dome/config.yaml"
          patch.auto: ["meta/report-card.md", "wiki/dailies/*.md"]
          run.read: true
          questions.read: true
          proposals.read: true
  test.orphaned-run:
    enabled: true
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

    // The recovery trio now fires on store-change signals (outbox.changed /
    // quarantine.changed) with the orphan detector demoted to an hourly cron —
    // the per-minute polls were dropped in the pruning pass. Two consequences
    // reshape this gauntlet:
    //   - the store-change flags are tick-scoped and a CLI reopen (runCli
    //     closes+reopens the harness runtime) would drop them, so the broken
    //     state is created LIVE and drained WITHOUT an intervening CLI; the
    //     "before" broken state is read in-process rather than through a
    //     pre-drain status/doctor snapshot;
    //   - the orphan cron needs an hour to become due, and a long-lived orphan
    //     row would trip the >10m NO_ORPHAN_RUNNING_LEDGER_ROWS invariant on
    //     that advance — so we cross the hour with no orphan present, then seed
    //     one aged into the (5m, 10m) window just before the drain.

    // Cross a top-of-hour with no orphan rows so the orphan cron is due.
    await h.advance(60 * 60_000);

    // Outbox: a pending row for a capability with no registered handler fails
    // terminally in the drain (firing outbox.changed). Enqueued on the harness
    // clock so the drain's enqueued_before cutoff includes it.
    insertPending(h.outbox, {
      effect: externalActionEffect({
        capability: "calendar.write",
        idempotencyKey: "gauntlet-outbox",
        payload: { title: "Recovery gauntlet" },
        sourceRefs: [ref],
      }),
      runId: "seed-gauntlet-outbox",
      now: h.clock.now(),
    });

    // Orphan run aged into the orphan window (5m detector floor < 8m < 10m
    // invariant ceiling); recovered by answer before it can age out.
    const startedAt = new Date(h.clock.now().getTime() - 8 * 60_000);
    const orphanId = newRunId(startedAt, () => "aaaaaa");
    insertQueued(h.ledger, {
      id: orphanId,
      proposalId: null,
      processorId: GAUNTLET_PROCESSOR_ID,
      processorVersion: "0.1.0",
      phase: "garden",
      inputCommit: adoptedCommit,
      triggerKind: "schedule",
      triggerPayload: null,
      startedAt,
    });
    markRunning(h.ledger, orphanId, startedAt);

    // Quarantine: trip through the LIVE runtime (default threshold 3) so the
    // store fires onQuarantineChanged on the runtime this drain uses.
    const quarantineKey = Object.freeze({
      phase: "garden" as const,
      processorId: GAUNTLET_PROCESSOR_ID,
      processorVersion: "0.1.0",
      triggerHash: "gauntlet-trigger",
    });
    h.executionState.recordRetryableTerminalFailure(quarantineKey, "first");
    h.executionState.recordRetryableTerminalFailure(quarantineKey, "second");
    h.executionState.recordRetryableTerminalFailure(quarantineKey, "third");

    // Before-recovery broken state, read in-process (no CLI reopen — that would
    // drop the tick-scoped signal flags before the drain).
    expect(queryOutbox(h.outbox).map((r) => r.status)).toEqual(["pending"]);
    expect(
      h.executionState.quarantines().map((q) => q.key.processorId),
    ).toEqual([GAUNTLET_PROCESSOR_ID]);

    // A one-minute advance makes the pending row's enqueued_before cutoff strict
    // and keeps the orphan under the 10m invariant ceiling.
    await h.advance(60_000);
    const drained = await h.drainOperationalWork();
    // Outbox + quarantine surface via the store-change epilogue dispatch (not
    // the scheduler); only the orphan detector runs on its (hourly) cron.
    expect(drained.scheduler.fired.map((fire) => fire.processorId)).toContain(
      "dome.health.orphan-run-recovery-questions",
    );
    expect(drained.outbox.map((r) => r.kind)).toEqual(["failed"]);

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
