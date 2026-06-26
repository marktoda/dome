import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  diagnosticEffect,
  jobEffect,
  patchEffect,
} from "../../src/core/effect";
import type { AdoptionResult, Proposal } from "../../src/core/proposal";
import {
  defineProcessor,
  treeOid,
  type Capability,
  type Processor,
} from "../../src/core/processor";
import { transientProcessorError } from "../../src/core/processor-error";
import { commitOid, type CommitOid } from "../../src/core/source-ref";
import { noopSinks } from "../../src/engine/core/apply-effect";
import type { ApplyPatchInput } from "../../src/engine/core/apply-patch";
import { runQueuedJobs } from "../../src/engine/operational/jobs";
import type { EngineVault } from "../../src/engine/core/vault-shape";
import { claimNextEligibleJob, enqueueJob } from "../../src/projections/jobs";
import { openProjectionDb, type ProjectionDb } from "../../src/projections/db";
import { buildRegistry } from "../../src/processors/registry";
import type { LedgerDb } from "../../src/ledger/db";
import { openTestLedger } from "../support/test-ledger";

const ADOPTED = commitOid("adopted0000000000000000000000000000000000");
const TREE = treeOid("tree000000000000000000000000000000000000");
const NOW = new Date("2026-05-28T12:00:00.000Z");

type Fixture = {
  readonly root: string;
  readonly projection: ProjectionDb;
  readonly vault: EngineVault;
  readonly ledger: LedgerDb;
};

const fixtures: Fixture[] = [];

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    try {
      fixture.projection.close();
    } catch {
      // already closed
    }
    try {
      fixture.ledger.close();
    } catch {
      // already closed
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe("runQueuedJobs", () => {
  test("cancelled job dispatch returns the claimed row to pending without consuming attempts", async () => {
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const controller = new AbortController();
    const processor = defineProcessor({
      id: "test.jobs.cancelled",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "signal", name: "document.changed" }],
      capabilities: [],
      run: async (ctx) => {
        started?.();
        await waitForAbort(ctx.signal);
        return [];
      },
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);
    enqueue(fixture, "job-cancel", processor.id, { x: 1 });

    const run = runWithProcessors(
      fixture,
      [processor],
      () => NOW,
      {},
      { signal: controller.signal },
    );
    await startedPromise;
    controller.abort();

    const result = await run;

    expect(result.drained).toEqual([
      expect.objectContaining({
        processorId: processor.id,
        status: "rescheduled",
      }),
    ]);
    expect(jobRow(fixture.projection, "job-cancel")).toMatchObject({
      status: "pending",
      attempts: 0,
      run_after: NOW.toISOString(),
    });
  });

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
        throw transientProcessorError("temporary job boom");
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

  test("expired running claims are recovered before draining due jobs", async () => {
    let calls = 0;
    const processor = defineProcessor({
      id: "test.jobs.expired-claim",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "signal", name: "document.changed" }],
      capabilities: [],
      run: async () => {
        calls += 1;
        return [];
      },
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);
    enqueue(fixture, "job-expired", processor.id, null, 2);

    const claimed = claimNextEligibleJob(fixture.projection, NOW, 1000);
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);

    const result = await runWithProcessors(
      fixture,
      [processor],
      () => new Date(NOW.getTime() + 2000),
    );

    expect(result.drained[0]?.status).toBe("succeeded");
    expect(calls).toBe(1);
    expect(jobRow(fixture.projection, "job-expired")).toMatchObject({
      status: "succeeded",
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

  test("authorized job garden patch is surfaced when sub-Proposal adoption is not wired", async () => {
    const patchCap = { kind: "patch.auto" as const, paths: ["wiki/**"] };
    const processor = defineProcessor({
      id: "test.jobs.patch-no-adopter",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "signal", name: "document.changed" }],
      capabilities: [patchCap],
      run: async () => [
        patchEffect({
          mode: "auto",
          changes: [
            { kind: "write", path: "wiki/job.md", content: "job patch\n" },
          ],
          reason: "job patch",
          sourceRefs: [],
        }),
      ],
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);
    enqueue(fixture, "job-1", processor.id, null);
    const recordedDiagnostics: string[] = [];
    let applyPatchCalls = 0;

    const result = await runWithProcessors(
      fixture,
      [processor],
      undefined,
      {
        recordDiagnostic: async ({ effect }) => {
          recordedDiagnostics.push(effect.code);
        },
      },
      {
        applyGardenPatchToCandidate: async () => {
          applyPatchCalls += 1;
          return commitOid("should-not-be-called");
        },
      },
    );

    expect(result.drained[0]?.status).toBe("succeeded");
    expect(result.diagnostics.some((d) =>
      d.code === "jobs.garden-sub-proposal-spawn-disabled"
    )).toBe(true);
    expect(recordedDiagnostics).toContain(
      "jobs.garden-sub-proposal-spawn-disabled",
    );
    expect(applyPatchCalls).toBe(0);
  });

  test("authorized job garden patch becomes a garden sub-Proposal when wired", async () => {
    const patchCap = { kind: "patch.auto" as const, paths: ["wiki/**"] };
    const newHead = commitOid("jobgardenpatchhead0000000000000000000000");
    const processor = defineProcessor({
      id: "test.jobs.patch-adopter",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "signal", name: "document.changed" }],
      capabilities: [patchCap],
      run: async () => [
        patchEffect({
          mode: "auto",
          changes: [
            { kind: "write", path: "wiki/job.md", content: "job patch\n" },
          ],
          reason: "job patch",
          sourceRefs: [],
        }),
      ],
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);
    enqueue(fixture, "job-1", processor.id, null);
    const adoptedProposals: Proposal[] = [];
    const depths: number[] = [];

    const result = await runWithProcessors(
      fixture,
      [processor],
      undefined,
      {},
      {
        applyGardenPatchToCandidate: async ({ candidate, patch }) => {
          expect(candidate).toBe(ADOPTED);
          expect(patch.changes[0]?.path as string | undefined).toBe(
            "wiki/job.md",
          );
          return newHead;
        },
        adoptSubProposal: async (proposal, cascadeDepth) => {
          adoptedProposals.push(proposal);
          depths.push(cascadeDepth);
          return {
            proposalId: proposal.id,
            adopted: true,
            adoptedRef: proposal.head,
            diagnostics: [],
            closureCommitOid: null,
            iterations: 1,
          };
        },
      },
    );

    expect(result.drained[0]?.status).toBe("succeeded");
    expect(adoptedProposals.length).toBe(1);
    expect(adoptedProposals[0]?.base).toBe(ADOPTED);
    expect(adoptedProposals[0]?.head).toBe(newHead);
    expect(adoptedProposals[0]?.source.kind).toBe("garden");
    expect(adoptedProposals[0]?.metadata?.reason).toBe("job patch");
    expect(depths).toEqual([1]);
  });
});

async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "dome-jobs-"));
  const projectionResult = await openProjectionDb({
    path: join(root, ".dome", "state", "projection.db"),
    extensionSet: [],
    processorVersions: [],
    capabilityPolicyHash: "test-policy",
  });
  if (!projectionResult.ok) {
    throw new Error(
      `openProjectionDb failed: ${JSON.stringify(projectionResult.error)}`,
    );
  }
  const ledger = await openTestLedger();
  return {
    root,
    projection: projectionResult.value.db,
    vault: {
      path: root,
      config: { git: { auto_commit_workflows: false } },
    },
    ledger,
  };
}

function enqueue(
  fixture: Fixture,
  idempotencyKey: string,
  processorId: string,
  input: import("../../src/core/effect").JsonValue,
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
    readonly signal?: AbortSignal;
    readonly resolveTree?: () => Promise<typeof TREE>;
    readonly adoptSubProposal?: (
      proposal: Proposal,
      cascadeDepth: number,
    ) => Promise<AdoptionResult>;
    readonly applyGardenPatchToCandidate?: (
      opts: ApplyPatchInput,
    ) => Promise<CommitOid | null>;
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
    ledger: fixture.ledger,
    ...(runnerOverrides.signal !== undefined
      ? { signal: runnerOverrides.signal }
      : {}),
    ...(runnerOverrides.adoptSubProposal !== undefined
      ? { adoptSubProposal: runnerOverrides.adoptSubProposal }
      : {}),
    ...(runnerOverrides.applyGardenPatchToCandidate !== undefined
      ? {
          applyGardenPatchToCandidate:
            runnerOverrides.applyGardenPatchToCandidate,
        }
      : {}),
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
