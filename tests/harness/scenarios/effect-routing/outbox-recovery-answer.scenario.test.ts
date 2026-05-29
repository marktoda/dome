// scenarios/effect-routing/outbox-recovery-answer.scenario.test.ts
//
// Failed external actions are recovered by the same question/answer processor
// path as every other human decision. This scenario seeds terminal outbox
// rows and questions, answers those questions through the public CLI, and
// asserts the answer handler can only move rows through an authorized
// OutboxRecoveryEffect.

import { expect } from "bun:test";
import { join } from "node:path";

import {
  externalActionEffect,
  questionEffect,
} from "../../../../src/core/effect";
import { commitOid, sourceRef } from "../../../../src/core/source-ref";
import type { RunId } from "../../../../src/engine/runner-contract";
import { capabilityUsesByRun } from "../../../../src/ledger/capability-uses";
import {
  insertPending,
  markFailed,
  queryOutbox,
} from "../../../../src/outbox/dispatch";
import { insertQuestion } from "../../../../src/projections/questions";
import { scenario } from "../../index";

const FIXTURE_BUNDLE = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.outbox-recovery",
);

scenario(
  {
    name: "effect-routing: question answers retry or abandon failed outbox rows",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "group", group: "external-actions" },
      { kind: "effect", effect: "question" },
      { kind: "effect", effect: "outbox-recovery" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "question.ask" },
      { kind: "capability", capability: "outbox.recover" },
      { kind: "trigger", trigger: "answer" },
      { kind: "route", route: "garden-answer" },
    ],
    harness: {
      bundles: [{ id: "test.outbox-recovery", root: FIXTURE_BUNDLE }],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  test.outbox-recovery:
    enabled: true
    grant:
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

    for (const key of ["recover-retry", "recover-abandon"] as const) {
      insertPending(h.outbox, {
        effect: externalActionEffect({
          capability: "calendar.write",
          idempotencyKey: key,
          payload: { title: key },
          sourceRefs: [ref],
        }),
        runId: `seed-${key}`,
      });
      markFailed(h.outbox, key, "terminal failure");
    }

    insertQuestion(h.projection, {
      effect: questionEffect({
        question: "Recover failed outbox row recover-retry?",
        options: ["retry", "abandon"],
        sourceRefs: [ref],
        idempotencyKey: "test.outbox-recovery:recover-retry",
      }),
      processorId: "test.health",
      adoptedCommit: commitOid(adopted),
    });
    insertQuestion(h.projection, {
      effect: questionEffect({
        question: "Recover failed outbox row recover-abandon?",
        options: ["retry", "abandon"],
        sourceRefs: [ref],
        idempotencyKey: "test.outbox-recovery:recover-abandon",
      }),
      processorId: "test.health",
      adoptedCommit: commitOid(adopted),
    });

    const inspect = await h.runCli(["inspect", "questions", "--json"]);
    expect(inspect.exitCode).toBe(0);
    const questions = JSON.parse(inspect.stdout) as ReadonlyArray<{
      readonly id: number;
      readonly idempotency_key: string;
    }>;
    const retryQuestion = questions.find(
      (q) => q.idempotency_key === "test.outbox-recovery:recover-retry",
    );
    const abandonQuestion = questions.find(
      (q) => q.idempotency_key === "test.outbox-recovery:recover-abandon",
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

    const rows = queryOutbox(h.outbox).map((row) => ({
      key: row.idempotencyKey,
      status: row.status,
      attempts: row.attempts,
      lastError: row.lastError,
    }));
    expect(rows).toEqual([
      {
        key: "recover-retry",
        status: "pending",
        attempts: 0,
        lastError: null,
      },
      {
        key: "recover-abandon",
        status: "abandoned",
        attempts: 0,
        lastError: "terminal failure",
      },
    ]);

    expect(
      capabilityUsesByRun(h.ledger, retryBody.handlers.runs[0]?.run_id as RunId),
    ).toEqual([
      expect.objectContaining({
        capability: "outbox.recover",
        resource: "retry:recover-retry",
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
        resource: "abandon:recover-abandon",
        outcome: "allowed",
      }),
    ]);
  },
);
