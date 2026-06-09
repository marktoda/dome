import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { diagnosticEffect, patchEffect } from "../../src/core/effect";
import type { AdoptionResult, Proposal } from "../../src/core/proposal";
import {
  defineProcessor,
  treeOid,
  type Capability,
  type Processor,
} from "../../src/core/processor";
import { commitOid, type CommitOid } from "../../src/core/source-ref";
import { noopSinks } from "../../src/engine/apply-effect";
import type { ApplyPatchInput } from "../../src/engine/apply-patch";
import type { ModelStepProvider } from "../../src/engine/model-invoke";
import { runScheduler } from "../../src/engine/scheduler";
import type { EngineVault } from "../../src/engine/vault-shape";
import { openProjectionDb, type ProjectionDb } from "../../src/projections/db";
import {
  getCursor,
  upsertCursor,
} from "../../src/projections/schedule-cursors";
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
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe("runScheduler — executor-result telemetry", () => {
  test("cancelled scheduled work does not advance the schedule cursor", async () => {
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const controller = new AbortController();
    const processor = defineProcessor({
      id: "test.scheduler.cancelled",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "schedule", cron: "* * * * *" }],
      capabilities: [],
      run: async (ctx) => {
        started?.();
        await waitForAbort(ctx.signal);
        return [];
      },
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);

    const run = runWithProcessor(fixture, processor, {}, {
      signal: controller.signal,
    });
    await startedPromise;
    controller.abort();

    const result = await run;

    expect(result.fired).toEqual([]);
    expect(result.skipped).toContainEqual({
      processorId: "test.scheduler.cancelled",
      reason: "cancelled",
    });
    expect(getCursor(fixture.projection, processor.id)).toBeNull();
  });

  test("processor execution failure diagnostic marks scheduled fire unsuccessful", async () => {
    const processor = defineProcessor({
      id: "test.scheduler.thrower",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "schedule", cron: "* * * * *" }],
      capabilities: [],
      run: async () => {
        throw new Error("scheduled boom");
      },
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);

    const result = await runWithProcessor(fixture, processor);

    expect(result.fired.length).toBe(1);
    expect(result.fired[0]?.processorId).toBe("test.scheduler.thrower");
    expect(result.fired[0]?.success).toBe(false);
  });

  test("processor timeout diagnostic marks scheduled fire unsuccessful and discards late output", async () => {
    const lateEffect = diagnosticEffect({
      severity: "info",
      code: "test.scheduler.late",
      message: "late output should not make the fire successful",
      sourceRefs: [],
    });
    const processor = defineProcessor({
      id: "test.scheduler.timeout",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "schedule", cron: "* * * * *" }],
      capabilities: [],
      execution: { class: "background", timeoutMs: 5 },
      run: async (ctx) => {
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) {
            resolve();
            return;
          }
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return [lateEffect];
      },
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);
    const recordedDiagnostics: string[] = [];

    const result = await runWithProcessor(fixture, processor, {
      recordDiagnostic: async ({ effect }) => {
        recordedDiagnostics.push(effect.code);
      },
    });

    expect(result.fired.length).toBe(1);
    expect(result.fired[0]?.processorId).toBe("test.scheduler.timeout");
    expect(result.fired[0]?.success).toBe(false);
    expect(recordedDiagnostics).toContain("processor.timeout");
    expect(recordedDiagnostics).not.toContain("test.scheduler.late");
  });

  test("processor-emitted executor-like diagnostic code does not mark scheduled fire unsuccessful", async () => {
    const processor = defineProcessor({
      id: "test.scheduler.user-diagnostic",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "schedule", cron: "* * * * *" }],
      capabilities: [],
      run: async () => [
        diagnosticEffect({
          severity: "error",
          code: "processor.timeout",
          message: "user-space diagnostic with executor-like code",
          sourceRefs: [],
        }),
      ],
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);
    const recordedDiagnostics: string[] = [];

    const result = await runWithProcessor(fixture, processor, {
      recordDiagnostic: async ({ effect }) => {
        recordedDiagnostics.push(effect.code);
      },
    });

    expect(result.fired.length).toBe(1);
    expect(result.fired[0]?.processorId).toBe("test.scheduler.user-diagnostic");
    expect(result.fired[0]?.success).toBe(true);
    expect(recordedDiagnostics).toContain("processor.timeout");
  });

  test("invalid cron diagnostics are recorded through the diagnostic sink", async () => {
    const processor = defineProcessor({
      id: "test.scheduler.bad-cron",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "schedule", cron: "not a cron" }],
      capabilities: [],
      run: async () => [],
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);
    const recorded: Array<{
      readonly code: string;
      readonly processorId: string;
      readonly proposalId: string | null;
    }> = [];

    const result = await runWithProcessor(fixture, processor, {
      recordDiagnostic: async ({ effect, processorId, proposalId }) => {
        recorded.push({ code: effect.code, processorId, proposalId });
      },
    });

    expect(result.fired.length).toBe(0);
    expect(result.skipped[0]).toEqual({
      processorId: "test.scheduler.bad-cron",
      reason: "cron-parse-failed",
    });
    expect(recorded).toEqual([
      {
        code: "scheduler.cron-parse-failed",
        processorId: "engine.scheduler",
        proposalId: null,
      },
    ]);
  });

  test("cron changes preserve last fire and do not fire immediately", async () => {
    const processor = defineProcessor({
      id: "test.scheduler.cron-changed",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "schedule", cron: "* * * * *" }],
      capabilities: [],
      run: async () => [
        diagnosticEffect({
          severity: "info",
          code: "test.scheduler.should-not-fire",
          message: "cron changes should not fire immediately",
          sourceRefs: [],
        }),
      ],
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);
    upsertCursor(fixture.projection, {
      processorId: "test.scheduler.cron-changed",
      cron: "0 * * * *",
      lastFire: "2026-05-28T11:59:00.000Z",
      nextFire: "2026-05-28T12:00:00.000Z",
    });

    const result = await runWithProcessor(fixture, processor);
    const cursor = getCursor(fixture.projection, "test.scheduler.cron-changed");

    expect(result.fired).toEqual([]);
    expect(result.skipped).toEqual([
      { processorId: "test.scheduler.cron-changed", reason: "cron-changed" },
    ]);
    expect(cursor?.cron).toBe("* * * * *");
    expect(cursor?.lastFire).toBe("2026-05-28T11:59:00.000Z");
    expect(cursor?.nextFire).toBe("2026-05-28T12:01:00.000Z");
  });

  test("broker diagnostics do not mark scheduled fire unsuccessful", async () => {
    const processor = defineProcessor({
      id: "test.scheduler.capability-denied",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "schedule", cron: "* * * * *" }],
      capabilities: [],
      run: async () => [
        patchEffect({
          mode: "auto",
          changes: [
            { kind: "write", path: "wiki/scheduled.md", content: "scheduled\n" },
          ],
          reason: "missing grant",
          sourceRefs: [],
        }),
      ],
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);
    const recordedProposalIds: Array<string | null> = [];

    const result = await runWithProcessor(fixture, processor, {
      recordDiagnostic: async ({ proposalId }) => {
        recordedProposalIds.push(proposalId);
      },
    });

    expect(result.fired.length).toBe(1);
    expect(result.fired[0]?.processorId).toBe("test.scheduler.capability-denied");
    expect(result.fired[0]?.success).toBe(true);
    expect(result.diagnostics.some((d) => d.code === "capability-deny-patch"))
      .toBe(true);
    expect(recordedProposalIds).toEqual([null]);
  });

  test("authorized scheduled garden patch is dropped when sub-Proposal adoption is not wired", async () => {
    const patchCap = { kind: "patch.auto" as const, paths: ["wiki/**"] };
    const processor = defineProcessor({
      id: "test.scheduler.patch-no-adopter",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "schedule", cron: "* * * * *" }],
      capabilities: [patchCap],
      run: async () => [
        patchEffect({
          mode: "auto",
          changes: [
            { kind: "write", path: "wiki/scheduled.md", content: "scheduled\n" },
          ],
          reason: "scheduled patch",
          sourceRefs: [],
        }),
      ],
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);
    const recordedDiagnostics: string[] = [];
    const recordedProposalIds: Array<string | null> = [];
    let applyPatchCalls = 0;

    const result = await runWithProcessor(
      fixture,
      processor,
      {
        recordDiagnostic: async ({ effect, proposalId }) => {
          recordedDiagnostics.push(effect.code);
          recordedProposalIds.push(proposalId);
        },
        applyPatch: async () => {
          applyPatchCalls += 1;
          return commitOid("should-not-be-called");
        },
      },
      {
        resolveGrants: () => [patchCap],
      },
    );

    expect(result.fired[0]?.success).toBe(true);
    expect(recordedDiagnostics).toContain(
      "scheduler.garden-sub-proposal-spawn-disabled",
    );
    expect(recordedProposalIds).toEqual([null]);
    expect(applyPatchCalls).toBe(0);
  });

  test("authorized scheduled garden patch becomes a garden sub-Proposal when wired", async () => {
    const patchCap = { kind: "patch.auto" as const, paths: ["wiki/**"] };
    const newHead = commitOid("scheduledgardenpatchhead00000000000000000");
    const processor = defineProcessor({
      id: "test.scheduler.patch-adopter",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "schedule", cron: "* * * * *" }],
      capabilities: [patchCap],
      run: async () => [
        patchEffect({
          mode: "auto",
          changes: [
            { kind: "write", path: "wiki/scheduled.md", content: "scheduled\n" },
          ],
          reason: "scheduled patch",
          sourceRefs: [],
        }),
      ],
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);
    const adoptedProposals: Proposal[] = [];
    const depths: number[] = [];

    const result = await runWithProcessor(
      fixture,
      processor,
      {},
      {
        resolveGrants: () => [patchCap],
        applyGardenPatchToCandidate: async ({ candidate, patch }) => {
          expect(candidate).toBe(ADOPTED);
          expect(patch.changes[0]?.path as string | undefined).toBe(
            "wiki/scheduled.md",
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

    expect(result.fired[0]?.success).toBe(true);
    expect(adoptedProposals.length).toBe(1);
    expect(adoptedProposals[0]?.base).toBe(ADOPTED);
    expect(adoptedProposals[0]?.head).toBe(newHead);
    expect(adoptedProposals[0]?.source.kind).toBe("garden");
    expect(depths).toEqual([1]);
  });

  test("scheduled garden propose-mode patch is diagnosed but not spawned", async () => {
    const patchCap = { kind: "patch.propose" as const, paths: ["wiki/**"] };
    const processor = defineProcessor({
      id: "test.scheduler.patch-propose",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "schedule", cron: "* * * * *" }],
      capabilities: [patchCap],
      run: async () => [
        patchEffect({
          mode: "propose",
          changes: [
            { kind: "write", path: "wiki/scheduled.md", content: "scheduled\n" },
          ],
          reason: "scheduled propose patch",
          sourceRefs: [],
        }),
      ],
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);
    let applyPatchCalls = 0;
    let adoptionCalls = 0;

    const recordedDiagnostics: string[] = [];

    const result = await runWithProcessor(
      fixture,
      processor,
      {
        recordDiagnostic: async ({ effect }) => {
          recordedDiagnostics.push(effect.code);
        },
      },
      {
        resolveGrants: () => [patchCap],
        applyGardenPatchToCandidate: async () => {
          applyPatchCalls += 1;
          return commitOid("should-not-be-called");
        },
        adoptSubProposal: async (proposal) => {
          adoptionCalls += 1;
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

    expect(result.fired[0]?.success).toBe(true);
    expect(result.diagnostics.map((d) => d.code)).toContain(
      "garden.patch-propose-review-unavailable",
    );
    expect(recordedDiagnostics).toContain(
      "garden.patch-propose-review-unavailable",
    );
    expect(applyPatchCalls).toBe(0);
    expect(adoptionCalls).toBe(0);
  });

  test("scheduled llm processor receives a defined, callable ctx.modelInvoke.step", async () => {
    const modelCap: Capability = { kind: "model.invoke", maxDailyCostUsd: 5 };
    let stepCalled = 0;
    const modelStepProvider: ModelStepProvider = async (request) => {
      stepCalled += 1;
      // Echo back a deterministic tool call so the processor can assert it
      // received the injected provider's result.
      expect(request.messages[0]?.content).toBe("go");
      return { toolCalls: [{ id: "c1", name: "echo", input: {} }] };
    };

    let stepWasDefined = false;
    let resultName: string | undefined;
    const processor = defineProcessor({
      id: "test.scheduler.llm-step",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "schedule", cron: "* * * * *" }],
      capabilities: [modelCap],
      run: async (ctx) => {
        stepWasDefined = ctx.modelInvoke?.step !== undefined;
        if (ctx.modelInvoke?.step !== undefined) {
          const out = await ctx.modelInvoke.step({
            messages: [{ role: "user", content: "go" }],
            tools: [{ name: "echo", description: "", inputSchema: {} }],
          });
          resultName = out.toolCalls?.[0]?.name;
        }
        return [];
      },
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);

    const result = await runWithProcessor(
      fixture,
      processor,
      {},
      {
        resolveGrants: () => [modelCap],
        modelStepProvider,
      },
    );

    expect(result.fired.length).toBe(1);
    expect(result.fired[0]?.success).toBe(true);
    expect(stepWasDefined).toBe(true);
    expect(stepCalled).toBe(1);
    expect(resultName).toBe("echo");
  });
});

async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "dome-scheduler-"));
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
  return {
    root,
    projection: projectionResult.value.db,
    vault: {
      path: root,
      config: { git: { auto_commit_workflows: false } },
    },
  };
}

async function runWithProcessor(
  fixture: Fixture,
  processor: Processor,
  sinkOverrides: Partial<ReturnType<typeof noopSinks>> = {},
  schedulerOverrides: {
    readonly resolveGrants?: () => ReadonlyArray<Capability>;
    readonly signal?: AbortSignal;
    readonly adoptSubProposal?: (
      proposal: Proposal,
      cascadeDepth: number,
    ) => Promise<AdoptionResult>;
    readonly applyGardenPatchToCandidate?: (
      opts: ApplyPatchInput,
    ) => Promise<CommitOid | null>;
    readonly modelStepProvider?: ModelStepProvider;
  } = {},
) {
  const registryResult = buildRegistry([processor]);
  if (!registryResult.ok) {
    throw new Error(`registry build failed: ${registryResult.error.kind}`);
  }
  const opts = {
    vault: fixture.vault,
    adopted: ADOPTED,
    registry: registryResult.value,
    projection: fixture.projection,
    sinks: { ...noopSinks(), ...sinkOverrides },
    resolveTree: async () => TREE,
    now: () => NOW,
    resolveGrants: schedulerOverrides.resolveGrants ?? (() => []),
    extensionIdFor: (id: string) => id,
    ...(schedulerOverrides.modelStepProvider !== undefined
      ? { modelStepProvider: schedulerOverrides.modelStepProvider }
      : {}),
    ...(schedulerOverrides.signal !== undefined
      ? { signal: schedulerOverrides.signal }
      : {}),
    ...(schedulerOverrides.adoptSubProposal !== undefined
      ? { adoptSubProposal: schedulerOverrides.adoptSubProposal }
      : {}),
    ...(schedulerOverrides.applyGardenPatchToCandidate !== undefined
      ? {
          applyGardenPatchToCandidate:
            schedulerOverrides.applyGardenPatchToCandidate,
        }
      : {}),
  };
  return runScheduler(opts);
}
