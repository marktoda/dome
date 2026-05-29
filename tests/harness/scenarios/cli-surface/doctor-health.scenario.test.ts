// scenarios/cli-surface/doctor-health.scenario.test.ts
//
// `dome doctor` is the read-only recovery dashboard for operational substrate
// failures. This scenario proves the CLI sees real persisted engine state
// rather than a mocked report: failed outbox rows, orphan running rows, and
// persisted processor quarantines.

import { expect } from "bun:test";
import { join } from "node:path";

import { externalActionEffect } from "../../../../src/core/effect";
import { sourceRef } from "../../../../src/core/source-ref";
import { openQuarantineStore } from "../../../../src/engine/quarantine-store";
import {
  insertQueued,
  markRunning,
  newRunId,
} from "../../../../src/ledger/runs";
import {
  insertPending,
  markFailed as markOutboxFailed,
} from "../../../../src/outbox/dispatch";
import { scenario } from "../../index";

scenario(
  {
    name: "cli-surface: dome doctor reports operational health findings",
    tags: [{ kind: "group", group: "cli-surface" }],
  },
  async (h) => {
    const head = await h.refs.head();
    const ref = sourceRef({
      commit: head,
      path: ".dome/.gitkeep",
    });

    insertPending(h.outbox, {
      effect: externalActionEffect({
        capability: "calendar.write",
        idempotencyKey: "doctor-scenario-failed",
        payload: { event: "failed" },
        sourceRefs: [ref],
      }),
      runId: "run-doctor-scenario-outbox",
      now: h.clock.now(),
    });
    markOutboxFailed(
      h.outbox,
      "doctor-scenario-failed",
      "terminal failure",
    );

    const runId = newRunId(h.clock.now(), () => "doctor");
    insertQueued(h.ledger, {
      id: runId,
      proposalId: null,
      processorId: "test.doctor",
      processorVersion: "0.0.1",
      phase: "garden",
      inputCommit: head,
      triggerKind: "schedule",
      triggerPayload: { test: true },
      startedAt: new Date(h.clock.now().getTime() - 1),
    });
    markRunning(h.ledger, runId, h.clock.now());

    const quarantine = openQuarantineStore({
      path: join(h.vaultPath, ".dome", "state", "quarantined.json"),
      quarantineThreshold: 2,
    });
    if (!quarantine.ok) {
      throw new Error(`quarantine open failed: ${quarantine.error.kind}`);
    }
    const key = Object.freeze({
      phase: "garden" as const,
      processorId: "test.doctor",
      processorVersion: "0.0.1",
      triggerHash: "doctor-scenario-trigger",
    });
    quarantine.value.recordRetryableTerminalFailure(key, "first");
    quarantine.value.recordRetryableTerminalFailure(key, "second");

    const doctor = await h.runCli([
      "doctor",
      "--json",
      "--orphan-threshold-ms",
      "0",
    ]);
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stderr).toBe("");
    const report = JSON.parse(doctor.stdout) as {
      readonly status: string;
      readonly summary: {
        readonly failedOutbox: number;
        readonly orphanRuns: number;
        readonly quarantinedProcessors: number;
      };
      readonly findings: ReadonlyArray<{ readonly code: string }>;
    };
    expect(report.status).toBe("unhealthy");
    expect(report.summary.failedOutbox).toBe(1);
    expect(report.summary.orphanRuns).toBe(1);
    expect(report.summary.quarantinedProcessors).toBe(1);
    expect(report.findings.map((finding) => finding.code)).toEqual([
      "outbox.failed",
      "run.orphan",
      "processor.quarantined",
    ]);
  },
);
