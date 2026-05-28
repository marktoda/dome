import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { diagnosticEffect, jobEffect } from "../../src/core/effect";
import {
  defineProcessor,
  treeOid,
  type Capability,
  type Processor,
} from "../../src/core/processor";
import { commitOid } from "../../src/core/source-ref";
import { noopSinks } from "../../src/engine/apply-effect";
import { runQueuedJobs } from "../../src/engine/jobs";
import type { EngineVault } from "../../src/engine/vault-shape";
import { enqueueJob } from "../../src/projections/jobs";
import { openProjectionDb, type ProjectionDb } from "../../src/projections/db";
import { buildRegistry } from "../../src/processors/registry";

const ADOPTED = commitOid("adopted0000000000000000000000000000000000");
const TREE = treeOid("tree000000000000000000000000000000000000");
const NOW = new Date("2026-05-28T12:00:00.000Z");

type Fixture = {
  readonly root: string;
  readonly projection: ProjectionDb;
  readonly vault: EngineVault;
};

const fixtures: Fixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    try {
      fixture.projection.close();
    } catch {
      // already closed
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe("runQueuedJobs", () => {
  test("runs due jobs as garden-phase target processor invocations", async () => {
    const seenInputs: unknown[] = [];
    const processor = defineProcessor({
      id: "test.jobs.worker",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "signal", name: "document.changed" }],
      capabilities: [],
      run: async (ctx) => {
        seenInputs.push(ctx.input);
        return [];
      },
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);
    enqueue(fixture, "job-1", processor.id, { x: 1 });

    const result = await runWithProcessors(fixture, [processor]);

    expect(result.drained.length).toBe(1);
    expect(result.drained[0]?.status).toBe("succeeded");
    expect(seenInputs).toEqual([{ x: 1 }]);
    expect(jobRow(fixture.projection, "job-1")).toMatchObject({
      status: "succeeded",
      attempts: 1,
    });
  });

  test("reschedules retryable failed jobs until maxAttempts is exhausted", async () => {
    const processor = defineProcessor({
      id: "test.jobs.thrower",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "signal", name: "document.changed" }],
      capabilities: [],
      run: async () => {
        throw Object.assign(new Error("temporary job boom"), {
          retryable: true,
        });
      },
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);
    enqueue(fixture, "job-1", processor.id, null, 2);
    let now = NOW;

    const first = await runWithProcessors(fixture, [processor], () => now);
    const afterFirst = jobRow(fixture.projection, "job-1");
    now = new Date(afterFirst.run_after);

    const second = await runWithProcessors(fixture, [processor], () => now);

    expect(first.drained[0]?.status).toBe("rescheduled");
    expect(second.drained[0]?.status).toBe("failed");
    expect(jobRow(fixture.projection, "job-1")).toMatchObject({
      status: "failed",
      attempts: 2,
    });
  });

  test("non-retryable job failures fail without burning remaining attempts", async () => {
    const processor = defineProcessor({
      id: "test.jobs.deterministic-failure",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "signal", name: "document.changed" }],
      capabilities: [],
      run: async () => {
        throw new Error("deterministic job boom");
      },
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);
    enqueue(fixture, "job-1", processor.id, null, 3);

    const result = await runWithProcessors(fixture, [processor]);

    expect(result.drained[0]?.status).toBe("failed");
    expect(jobRow(fixture.projection, "job-1")).toMatchObject({
      status: "failed",
      attempts: 1,
    });
  });

  test("missing target processors fail the job and emit a diagnostic", async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture);
    enqueue(fixture, "job-1", "test.jobs.missing", null);
    const recorded: Array<{
      readonly code: string;
      readonly processorId: string;
      readonly proposalId: string | null;
    }> = [];

    const result = await runWithProcessors(fixture, [], () => NOW, {
      recordDiagnostic: async ({ effect, processorId, proposalId }) => {
        recorded.push({ code: effect.code, processorId, proposalId });
      },
    });

    expect(result.drained[0]?.status).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe("job.target-unavailable");
    expect(recorded).toEqual([
      {
        code: "job.target-unavailable",
        processorId: "engine.jobs",
        proposalId: null,
      },
    ]);
    expect(jobRow(fixture.projection, "job-1")).toMatchObject({
      status: "failed",
      attempts: 1,
    });
  });

  test("dispatch crashes after claim reschedule or fail without leaving running rows", async () => {
    const processor = defineProcessor({
      id: "test.jobs.dispatch-crash",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "signal", name: "document.changed" }],
      capabilities: [],
      run: async () => [],
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);
    enqueue(fixture, "job-1", processor.id, null, 2);
    let now = NOW;
    const crashingResolveTree = async () => {
      throw new Error("tree unavailable");
    };
    const recorded: string[] = [];

    const first = await runWithProcessors(
      fixture,
      [processor],
      () => now,
      {
        recordDiagnostic: async ({ effect }) => {
          recorded.push(effect.code);
        },
      },
      { resolveTree: crashingResolveTree },
    );
    const afterFirst = jobRow(fixture.projection, "job-1");
    now = new Date(afterFirst.run_after);
    const second = await runWithProcessors(
      fixture,
      [processor],
      () => now,
      {
        recordDiagnostic: async ({ effect }) => {
          recorded.push(effect.code);
        },
      },
      { resolveTree: crashingResolveTree },
    );

    expect(first.drained[0]?.status).toBe("rescheduled");
    expect(first.diagnostics[0]?.code).toBe("job.dispatch-crashed");
    expect(second.drained[0]?.status).toBe("failed");
    expect(recorded).toEqual([
      "job.dispatch-crashed",
      "job.dispatch-crashed",
    ]);
    expect(jobRow(fixture.projection, "job-1")).toMatchObject({
      status: "failed",
      attempts: 2,
    });
  });

  test("job diagnostics route through normal garden sinks", async () => {
    const processor = defineProcessor({
      id: "test.jobs.diagnostic",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "signal", name: "document.changed" }],
      capabilities: [],
      run: async () => [
        diagnosticEffect({
          severity: "info",
          code: "test.job.info",
          message: "job emitted diagnostic",
          sourceRefs: [],
        }),
      ],
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);
    enqueue(fixture, "job-1", processor.id, null);
    const recorded: string[] = [];

    await runWithProcessors(fixture, [processor], undefined, {
      recordDiagnostic: async ({ effect }) => {
        recorded.push(effect.code);
      },
    });

    expect(recorded).toEqual(["test.job.info"]);
  });
});

async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "dome-jobs-"));
  const projectionResult = await openProjectionDb({
    path: join(root, ".dome", "state", "projection.db"),
    extensionSet: [],
    processorVersions: [],
  });
  if (!projectionResult.ok) {
    throw new Error(
      `openProjectionDb failed: ${JSON.stringify(projectionResult.error)}`,
    );
  }
  return {
    root,
    projection: projectionResult.value.db,
    vault: {
      path: root,
      config: { git: { auto_commit_workflows: false } },
    },
  };
}

function enqueue(
  fixture: Fixture,
  idempotencyKey: string,
  processorId: string,
  input: unknown,
  maxAttempts?: number,
): void {
  enqueueJob(fixture.projection, {
    processorId: "test.jobs.enqueuer",
    effect: jobEffect({
      processorId,
      input,
      runAfter: NOW.toISOString(),
      idempotencyKey,
      ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    }),
  });
}

async function runWithProcessors(
  fixture: Fixture,
  processors: ReadonlyArray<Processor>,
  now: () => Date = () => NOW,
  sinkOverrides: Partial<ReturnType<typeof noopSinks>> = {},
  runnerOverrides: {
    readonly resolveTree?: () => Promise<typeof TREE>;
  } = {},
) {
  const registryResult = buildRegistry(processors);
  if (!registryResult.ok) {
    throw new Error(`registry build failed: ${registryResult.error.kind}`);
  }
  return runQueuedJobs({
    vault: fixture.vault,
    adopted: ADOPTED,
    registry: registryResult.value,
    projection: fixture.projection,
    sinks: { ...noopSinks(), ...sinkOverrides },
    resolveTree: runnerOverrides.resolveTree ?? (async () => TREE),
    now,
    resolveGrants: (processorId: string): ReadonlyArray<Capability> =>
      registryResult.value.get(processorId)?.capabilities ?? [],
    extensionIdFor: (id: string) => id,
  });
}

function jobRow(
  db: ProjectionDb,
  idempotencyKey: string,
): { readonly status: string; readonly attempts: number; readonly run_after: string } {
  const row = db.raw
    .query<
      { readonly status: string; readonly attempts: number; readonly run_after: string },
      [string]
    >(
      "SELECT status, attempts, run_after FROM scheduled_jobs WHERE idempotency_key = ?",
    )
    .get(idempotencyKey);
  if (row === null) {
    throw new Error(`missing job row ${idempotencyKey}`);
  }
  return row;
}
