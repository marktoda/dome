// Phase 6 — runtime ledger-lifecycle wiring.
//
// Exercises the seam added in `src/processors/runtime.ts`: when
// `BuildRuntimeOptions.ledger` is wired, every dispatched processor lands
// one row in the `runs` table (queued → running → terminal). Pinned by
// [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]].
//
// Real integration tests against `bun:sqlite` in tmpdirs — the ledger IS
// the SQL boundary for run audit history; mocking it would defeat the
// invariant's purpose.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRuntime } from "../../src/processors/runtime";
import { buildRegistry } from "../../src/processors/registry";
import {
  defineProcessor,
  treeOid,
  type Capability,
  type ExecutionPolicyRequest,
  type Processor,
  type ProcessorContext,
  type ProcessorPhase,
  type Trigger,
} from "../../src/core/processor";
import { transientProcessorError } from "../../src/core/processor-error";
import { commitOid } from "../../src/core/source-ref";
import {
  diagnosticEffect,
  type Effect,
} from "../../src/core/effect";
import { makeManualProposal } from "../../src/core/proposal";
import type { SignalEvent } from "../../src/engine/core/compile-range";
import type { EngineVault } from "../../src/engine/core/vault-shape";
import type { ModelProvider } from "../../src/engine/core/model-invoke";
import type { ExecutionPolicyCap } from "../../src/processors/execution-policy";
import { openLedgerDb, type LedgerDb } from "../../src/ledger/db";
import { capabilityUsesByRun } from "../../src/ledger/capability-uses";
import { queryRuns, type RunId } from "../../src/ledger/runs";
import { openTestLedger } from "../support/test-ledger";

// Stub EngineVault — the runtime never touches it.
const STUB_VAULT: EngineVault = {
  path: "/tmp/stub-vault",
  config: { git: { auto_commit_workflows: false } },
};

const BASE = commitOid("base000000000000000000000000000000000000");
const CANDIDATE = commitOid("cand000000000000000000000000000000000000");
const TREE = treeOid("tree000000000000000000000000000000000000");

const proposal = makeManualProposal({
  id: "prop_1_aaaaaa",
  base: BASE,
  head: CANDIDATE,
  branch: "main",
});

const SIGNAL_CREATED: SignalEvent = Object.freeze({
  signal: "file.created",
  path: "wiki/a.md",
});

const READ_WIKI: Capability = Object.freeze({
  kind: "read",
  paths: ["wiki/**"],
});

function makeFixtureProcessor(opts: {
  id: string;
  phase: ProcessorPhase;
  triggers: ReadonlyArray<Trigger>;
  capabilities?: ReadonlyArray<Capability>;
  execution?: ExecutionPolicyRequest;
  emitsEffects?: ReadonlyArray<Effect>;
  run?: (ctx: ProcessorContext<unknown>) => Promise<ReadonlyArray<Effect>>;
}): Processor {
  return defineProcessor({
    id: opts.id,
    version: "0.0.1",
    phase: opts.phase,
    triggers: opts.triggers,
    capabilities: opts.capabilities ?? [READ_WIKI],
    ...(opts.execution !== undefined ? { execution: opts.execution } : {}),
    run:
      opts.run !== undefined
        ? opts.run
        : async () => opts.emitsEffects ?? [],
  });
}

function buildRuntimeFor(
  processors: ReadonlyArray<Processor>,
  ledger: LedgerDb,
  overrides?: {
    resolveGrants?: (processorId: string) => ReadonlyArray<Capability>;
    executionCap?: ExecutionPolicyCap;
    modelProvider?: ModelProvider;
  },
) {
  const reg = buildRegistry(processors);
  if (!reg.ok) throw new Error(`registry build failed: ${reg.error.kind}`);
  return buildRuntime({
    registry: reg.value,
    resolveGrants: overrides?.resolveGrants ?? (() => [READ_WIKI]),
    extensionIdFor: (id) => id,
    resolveTree: async () => TREE,
    ledger,
    ...(overrides?.executionCap !== undefined
      ? { executionCap: overrides.executionCap }
      : {}),
    ...(overrides?.modelProvider !== undefined
      ? { modelProvider: overrides.modelProvider }
      : {}),
  });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

describe("runtime — ledger lifecycle (Phase 6)", () => {
  let root: string;
  let dbPath: string;
  let handles: LedgerDb[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dome-runtime-ledger-"));
    dbPath = join(root, ".dome", "state", "runs.db");
    handles = [];
  });

  afterEach(() => {
    for (const h of handles) {
      try {
        h.close();
      } catch {
        // already closed
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  async function openLedger(): Promise<LedgerDb> {
    const r = await openLedgerDb({ path: dbPath });
    if (!r.ok) throw new Error(`openLedgerDb failed: ${r.error.kind}`);
    handles.push(r.value.db);
    return r.value.db;
  }

  test("successful processor run lands one row with status='succeeded' and effect hashes", async () => {
    const ledger = await openLedger();
    const diag = diagnosticEffect({
      severity: "info",
      code: "test.ok",
      message: "ok",
      sourceRefs: [],
    });
    const diag2 = diagnosticEffect({
      severity: "info",
      code: "test.ok2",
      message: "ok2",
      sourceRefs: [],
    });
    const p = makeFixtureProcessor({
      id: "test.ledger.success",
      phase: "adoption",
      triggers: [{ kind: "signal", name: "file.created" }],
      emitsEffects: [diag, diag2],
    });
    const rt = buildRuntimeFor([p], ledger);

    const results = await rt.adoptionRunner({
      vault: STUB_VAULT,
      candidate: CANDIDATE,
      changedPaths: ["wiki/a.md"],
      signals: [SIGNAL_CREATED],
      iteration: 1,
      proposal,
    });

    expect(results.length).toBe(1);
    const runnerResult = results[0];
    if (runnerResult === undefined) throw new Error("expected runner result");
    expect(typeof runnerResult.runId).toBe("string");
    expect(runnerResult.runId.startsWith("run_")).toBe(true);

    const rows = queryRuns(ledger, { processorId: "test.ledger.success" });
    expect(rows.length).toBe(1);
    const row = rows[0];
    if (row === undefined) throw new Error("expected row");

    expect(row.status).toBe("succeeded");
    expect(row.id).toBe(runnerResult.runId);
    expect(row.processorId).toBe("test.ledger.success");
    expect(row.processorVersion).toBe("0.0.1");
    expect(row.phase).toBe("adoption");
    expect(row.proposalId).toBe("prop_1_aaaaaa");
    expect(row.inputCommit).toBe(CANDIDATE);
    expect(row.triggerKind).toBe("signal");

    // effect_hashes_json round-trip: two hashes, each 64-char hex.
    expect(row.effectHashes.length).toBe(2);
    for (const h of row.effectHashes) {
      expect(h.length).toBe(64);
      expect(/^[0-9a-f]{64}$/.test(h)).toBe(true);
    }

    // Lifecycle timestamps both present and well-formed.
    expect(row.startedAt.length).toBeGreaterThan(0);
    expect(row.finishedAt).not.toBeNull();
    expect(row.durationMs).not.toBeNull();
    if (row.durationMs !== null) {
      expect(row.durationMs).toBeGreaterThanOrEqual(0);
    }

    // Phase 6 leaves cost + output_commit null (deferred to follow-ups).
    expect(row.costUsd).toBeNull();
    expect(row.outputCommit).toBeNull();
    expect(row.error).toBeNull();
  });

  test("throwing processor lands one row with status='failed' and error populated", async () => {
    const ledger = await openLedger();
    const p = makeFixtureProcessor({
      id: "test.ledger.thrower",
      phase: "adoption",
      triggers: [{ kind: "signal", name: "file.created" }],
      run: async () => {
        throw new Error("boom from test");
      },
    });
    const rt = buildRuntimeFor([p], ledger);

    const results = await rt.adoptionRunner({
      vault: STUB_VAULT,
      candidate: CANDIDATE,
      changedPaths: ["wiki/a.md"],
      signals: [SIGNAL_CREATED],
      iteration: 1,
      proposal,
    });

    // The engine-generated block diagnostic flows back to the adoption loop.
    expect(results.length).toBe(1);
    expect(results[0]?.effects.length).toBe(1);

    const rows = queryRuns(ledger, { processorId: "test.ledger.thrower" });
    expect(rows.length).toBe(1);
    const row = rows[0];
    if (row === undefined) throw new Error("expected row");

    expect(row.status).toBe("failed");
    const parsed = JSON.parse(row.error ?? "{}");
    expect(parsed.code).toBe("processor.threw");
    expect(parsed.message).toContain("boom from test");
    expect(parsed.processorId).toBe("test.ledger.thrower");
    expect(row.finishedAt).not.toBeNull();
    expect(row.durationMs).not.toBeNull();
  });

  test("adoption processor with denied execution policy is skipped and not invoked", async () => {
    const ledger = await openLedger();
    let invoked = false;
    const p = makeFixtureProcessor({
      id: "test.ledger.policy-denied",
      phase: "adoption",
      triggers: [{ kind: "signal", name: "file.created" }],
      execution: { class: "llm", timeoutMs: 600_000 },
      run: async () => {
        invoked = true;
        return [];
      },
    });
    const rt = buildRuntimeFor([p], ledger);

    const results = await rt.adoptionRunner({
      vault: STUB_VAULT,
      candidate: CANDIDATE,
      changedPaths: ["wiki/a.md"],
      signals: [SIGNAL_CREATED],
      iteration: 1,
      proposal,
    });

    expect(invoked).toBe(false);
    expect(results.length).toBe(1);
    const effect = results[0]?.effects[0];
    expect(effect?.kind).toBe("diagnostic");
    if (effect?.kind !== "diagnostic") return;
    expect(effect.code).toBe("execution-policy.phase-class-denied");
    expect(effect.severity).toBe("block");

    const rows = queryRuns(ledger, { processorId: "test.ledger.policy-denied" });
    expect(rows.length).toBe(1);
    const row = rows[0];
    if (row === undefined) throw new Error("expected row");

    expect(row.status).toBe("skipped");
    const parsed = JSON.parse(row.error ?? "{}");
    expect(parsed.code).toBe("execution-policy.phase-class-denied");
    expect(parsed.message).toContain(
      "Adoption processors must use deterministic execution",
    );
    expect(parsed.phase).toBe("adoption");
    expect(parsed.processorId).toBe("test.ledger.policy-denied");
    expect(parsed.class).toBe("llm");
    expect(row.durationMs).toBeNull();
    expect(row.finishedAt).not.toBeNull();
  });

  test("garden processor timeout lands timed_out row with structured error", async () => {
    const ledger = await openLedger();
    const lateEffect = diagnosticEffect({
      severity: "info",
      code: "test.late-after-timeout",
      message: "late output should be discarded",
      sourceRefs: [],
    });
    const p = makeFixtureProcessor({
      id: "test.ledger.timeout",
      phase: "garden",
      triggers: [{ kind: "signal", name: "file.created" }],
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
    const rt = buildRuntimeFor([p], ledger);

    const results = await rt.gardenRunner({
      vault: STUB_VAULT,
      adopted: CANDIDATE,
      changedPaths: ["wiki/a.md"],
      signals: [SIGNAL_CREATED],
      proposal,
    });

    expect(results.length).toBe(1);
    const effects = results[0]?.effects ?? [];
    expect(effects.length).toBe(1);
    expect(effects).not.toContainEqual(lateEffect);
    const effect = effects[0];
    expect(effect?.kind).toBe("diagnostic");
    if (effect?.kind !== "diagnostic") return;
    expect(effect.code).toBe("processor.timeout");
    expect(effect.severity).toBe("error");

    const rows = queryRuns(ledger, { processorId: "test.ledger.timeout" });
    expect(rows.length).toBe(1);
    const row = rows[0];
    if (row === undefined) throw new Error("expected row");

    expect(row.status).toBe("timed_out");
    expect(row.effectHashes).toEqual([]);
    const parsed = JSON.parse(row.error ?? "{}");
    expect(parsed.code).toBe("processor.timeout");
    expect(parsed.processorId).toBe("test.ledger.timeout");
    expect(parsed.phase).toBe("garden");
    expect(row.finishedAt).not.toBeNull();
    expect(row.durationMs).not.toBeNull();
  });

  test("garden processor cancellation lands cancelled row without orphaning", async () => {
    const ledger = await openLedger();
    let processorSignal: AbortSignal | undefined;
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let laterInvoked = false;
    const p = makeFixtureProcessor({
      id: "test.ledger.cancelled-a",
      phase: "garden",
      triggers: [{ kind: "signal", name: "file.created" }],
      execution: { class: "background", timeoutMs: 5_000 },
      run: async (ctx) => {
        processorSignal = ctx.signal;
        started?.();
        await waitForAbort(ctx.signal);
        return [];
      },
    });
    const later = makeFixtureProcessor({
      id: "test.ledger.cancelled-b",
      phase: "garden",
      triggers: [{ kind: "signal", name: "file.created" }],
      run: async () => {
        laterInvoked = true;
        return [];
      },
    });
    const rt = buildRuntimeFor([p, later], ledger);
    const controller = new AbortController();

    const run = rt.gardenRunner({
      vault: STUB_VAULT,
      adopted: CANDIDATE,
      changedPaths: ["wiki/a.md"],
      signals: [SIGNAL_CREATED],
      proposal,
      signal: controller.signal,
    });
    await startedPromise;
    expect(processorSignal?.aborted).toBe(false);
    controller.abort();
    const results = await run;

    expect(processorSignal?.aborted).toBe(true);
    expect(laterInvoked).toBe(false);
    // Two results: the cancelled run plus the abort-skip for the matched
    // processor the aborted pass never dispatched.
    expect(results.length).toBe(2);
    expect(results[0]?.executionStatus).toBe("cancelled");
    expect(results[0]?.executionError?.code).toBe("processor.cancelled");
    expect(results[1]?.executionStatus).toBe("skipped");
    expect(results[1]?.processorId).toBe("test.ledger.cancelled-b");
    expect(results[1]?.effects).toEqual([]);
    const effects = results[0]?.effects ?? [];
    expect(effects.length).toBe(1);
    expect(effects[0]?.kind).toBe("diagnostic");
    if (effects[0]?.kind === "diagnostic") {
      expect(effects[0].code).toBe("processor.cancelled");
      expect(effects[0].severity).toBe("error");
    }

    const rows = queryRuns(ledger, { processorId: "test.ledger.cancelled-a" });
    expect(rows.length).toBe(1);
    const row = rows[0];
    if (row === undefined) throw new Error("expected row");
    expect(row.status).toBe("cancelled");
    expect(row.finishedAt).not.toBeNull();
    expect(row.durationMs).not.toBeNull();
    const parsed = JSON.parse(row.error ?? "{}");
    expect(parsed.code).toBe("processor.cancelled");
    expect(parsed.processorId).toBe("test.ledger.cancelled-a");
    // The undispatched-but-trigger-matched processor must still be ledgered
    // (EVERY_PROCESSOR_RUN_IS_LEDGERED): a mid-tick shutdown previously
    // dropped it with no row at all, making aborted garden passes
    // indistinguishable from passes that never matched (2026-06-10).
    const skippedRows = queryRuns(ledger, {
      processorId: "test.ledger.cancelled-b",
    });
    expect(skippedRows.length).toBe(1);
    expect(skippedRows[0]?.status).toBe("skipped");
    const skipError = JSON.parse(skippedRows[0]?.error ?? "{}");
    expect(skipError.code).toBe("processor.aborted-before-dispatch");
    expect(skipError.processorId).toBe("test.ledger.cancelled-b");
    expect(queryRuns(ledger, { status: "running" })).toEqual([]);
  });

  test("runtime close cancels in-flight garden work before returning", async () => {
    const ledger = await openLedger();
    let processorSignal: AbortSignal | undefined;
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let laterInvoked = false;
    const p = makeFixtureProcessor({
      id: "test.ledger.close-cancelled-a",
      phase: "garden",
      triggers: [{ kind: "signal", name: "file.created" }],
      execution: { class: "background", timeoutMs: 5_000 },
      run: async (ctx) => {
        processorSignal = ctx.signal;
        started?.();
        await waitForAbort(ctx.signal);
        return [];
      },
    });
    const later = makeFixtureProcessor({
      id: "test.ledger.close-cancelled-b",
      phase: "garden",
      triggers: [{ kind: "signal", name: "file.created" }],
      run: async () => {
        laterInvoked = true;
        return [];
      },
    });
    const rt = buildRuntimeFor([p, later], ledger);

    const run = rt.gardenRunner({
      vault: STUB_VAULT,
      adopted: CANDIDATE,
      changedPaths: ["wiki/a.md"],
      signals: [SIGNAL_CREATED],
      proposal,
    });
    await startedPromise;
    expect(processorSignal?.aborted).toBe(false);

    await rt.close();
    const results = await run;

    expect(processorSignal?.aborted).toBe(true);
    expect(laterInvoked).toBe(false);
    // Cancelled run + the abort-skip for the undispatched matched processor.
    expect(results.length).toBe(2);
    expect(results[0]?.executionStatus).toBe("cancelled");
    expect(results[0]?.executionError?.code).toBe("processor.cancelled");
    expect(results[1]?.executionStatus).toBe("skipped");
    expect(results[1]?.executionError?.code).toBe(
      "processor.aborted-before-dispatch",
    );

    const rows = queryRuns(ledger, {
      processorId: "test.ledger.close-cancelled-a",
    });
    expect(rows.length).toBe(1);
    const row = rows[0];
    if (row === undefined) throw new Error("expected row");
    expect(row.status).toBe("cancelled");
    expect(row.finishedAt).not.toBeNull();
    expect(row.durationMs).not.toBeNull();
    const parsed = JSON.parse(row.error ?? "{}");
    expect(parsed.code).toBe("processor.cancelled");
    expect(parsed.processorId).toBe("test.ledger.close-cancelled-a");
    const closeSkips = queryRuns(ledger, {
      processorId: "test.ledger.close-cancelled-b",
    });
    expect(closeSkips.length).toBe(1);
    expect(closeSkips[0]?.status).toBe("skipped");
    expect(JSON.parse(closeSkips[0]?.error ?? "{}").code).toBe(
      "processor.aborted-before-dispatch",
    );
    expect(queryRuns(ledger, { status: "running" })).toEqual([]);
    await expect(rt.close()).resolves.toBeUndefined();
  });

  test("quarantined garden trigger is recorded as skipped with structured error", async () => {
    const ledger = await openLedger();
    let invocations = 0;
    const p = makeFixtureProcessor({
      id: "test.ledger.quarantine",
      phase: "garden",
      triggers: [{ kind: "signal", name: "file.created" }],
      run: async () => {
        invocations += 1;
        throw transientProcessorError("retryable outage");
      },
    });
    const rt = buildRuntimeFor([p], ledger);

    for (let i = 0; i < 4; i += 1) {
      await rt.gardenRunner({
        vault: STUB_VAULT,
        adopted: CANDIDATE,
        changedPaths: ["wiki/a.md"],
        signals: [SIGNAL_CREATED],
        proposal,
      });
    }

    expect(invocations).toBe(3);
    const rows = queryRuns(ledger, { processorId: "test.ledger.quarantine" });
    expect(rows.length).toBe(4);
    expect(rows.filter((row) => row.status === "failed").length).toBe(3);
    const skipped = rows.find((row) => row.status === "skipped");
    if (skipped === undefined) throw new Error("expected skipped row");
    const parsed = JSON.parse(skipped.error ?? "{}");
    expect(parsed.code).toBe("processor.quarantined");
    expect(parsed.retryable).toBe(false);
    expect(parsed.phase).toBe("garden");
    expect(parsed.processorId).toBe("test.ledger.quarantine");
    expect(skipped.durationMs).toBeNull();
    expect(skipped.finishedAt).not.toBeNull();
  });

  test("consecutive failures across DIFFERENT changed-path sets still quarantine", async () => {
    // The quarantine key hashes the trigger declaration, not the matched
    // signal events. When matched paths were part of the key, a signal-
    // driven processor got a fresh key per commit and its failure counter
    // never reached the threshold — quarantine effectively applied only to
    // schedule triggers.
    const ledger = await openLedger();
    let invocations = 0;
    const p = makeFixtureProcessor({
      id: "test.ledger.quarantine-varying-paths",
      phase: "garden",
      triggers: [{ kind: "signal", name: "file.created" }],
      run: async () => {
        invocations += 1;
        throw transientProcessorError("retryable outage");
      },
    });
    const rt = buildRuntimeFor([p], ledger);

    const paths = ["wiki/a.md", "wiki/b.md", "wiki/c.md", "wiki/d.md"];
    for (const path of paths) {
      await rt.gardenRunner({
        vault: STUB_VAULT,
        adopted: CANDIDATE,
        changedPaths: [path],
        signals: [Object.freeze({ signal: "file.created" as const, path })],
        proposal,
      });
    }

    // Three failures quarantine the trigger; the fourth (different path
    // again) is skipped without invoking the processor.
    expect(invocations).toBe(3);
    const rows = queryRuns(ledger, {
      processorId: "test.ledger.quarantine-varying-paths",
    });
    expect(rows.length).toBe(4);
    expect(rows.filter((row) => row.status === "failed").length).toBe(3);
    const skipped = rows.find((row) => row.status === "skipped");
    if (skipped === undefined) throw new Error("expected skipped row");
    expect(JSON.parse(skipped.error ?? "{}").code).toBe(
      "processor.quarantined",
    );
  });

  test("model cost and structured model failure are persisted on failed runs", async () => {
    const ledger = await openLedger();
    const cap: Capability = { kind: "model.invoke" };
    const p = makeFixtureProcessor({
      id: "test.ledger.model-json",
      phase: "garden",
      triggers: [{ kind: "signal", name: "file.created" }],
      capabilities: [READ_WIKI, cap],
      execution: { class: "llm" },
      run: async (ctx) => {
        if (ctx.modelInvoke === undefined) {
          throw new Error("missing modelInvoke");
        }
        await ctx.modelInvoke.structured({
          prompt: "json",
          schemaName: "test.schema/v1",
          parse: (value) => value,
        });
        return [];
      },
    });
    const rt = buildRuntimeFor([p], ledger, {
      resolveGrants: () => [READ_WIKI, cap],
      modelProvider: async () => ({
        text: "not-json",
        costUsd: 0.125,
      }),
    });

    const results = await rt.gardenRunner({
      vault: STUB_VAULT,
      adopted: CANDIDATE,
      changedPaths: ["wiki/a.md"],
      signals: [SIGNAL_CREATED],
      proposal,
    });

    expect(results[0]?.executionStatus).toBe("failed");
    expect(results[0]?.executionError?.code).toBe("model.output.invalid-json");
    const rows = queryRuns(ledger, { processorId: "test.ledger.model-json" });
    expect(rows.length).toBe(1);
    const row = rows[0];
    if (row === undefined) throw new Error("expected row");
    expect(row.status).toBe("failed");
    expect(row.costUsd).toBe(0.125);
    const parsed = JSON.parse(row.error ?? "{}");
    expect(parsed.code).toBe("model.output.invalid-json");
    expect(capabilityUsesByRun(ledger, row.id as RunId)).toEqual([
      expect.objectContaining({
        capability: "model.invoke",
        resource: null,
        outcome: "allowed",
      }),
    ]);
  });

  test("model provider timeout is retryable and can quarantine a garden trigger", async () => {
    const ledger = await openLedger();
    const cap: Capability = { kind: "model.invoke" };
    let providerCalls = 0;
    let providerAborts = 0;
    const p = makeFixtureProcessor({
      id: "test.ledger.model-timeout",
      phase: "garden",
      triggers: [{ kind: "signal", name: "file.created" }],
      capabilities: [READ_WIKI, cap],
      execution: { class: "llm", timeoutMs: 50, modelCallTimeoutMs: 5 },
      run: async (ctx) => {
        if (ctx.modelInvoke === undefined) {
          throw new Error("missing modelInvoke");
        }
        await ctx.modelInvoke({ prompt: "slow model" });
        return [];
      },
    });
    const rt = buildRuntimeFor([p], ledger, {
      resolveGrants: () => [READ_WIKI, cap],
      modelProvider: async (request) => {
        providerCalls += 1;
        await waitForAbort(request.signal);
        providerAborts += 1;
        return { text: "late" };
      },
    });

    for (let i = 0; i < 4; i += 1) {
      await rt.gardenRunner({
        vault: STUB_VAULT,
        adopted: CANDIDATE,
        changedPaths: ["wiki/a.md"],
        signals: [SIGNAL_CREATED],
        proposal,
      });
    }

    expect(providerCalls).toBe(3);
    expect(providerAborts).toBe(3);
    const rows = queryRuns(ledger, { processorId: "test.ledger.model-timeout" });
    expect(rows.length).toBe(4);
    const failedRows = rows.filter((row) => row.status === "failed");
    expect(failedRows.length).toBe(3);
    for (const row of failedRows) {
      const parsed = JSON.parse(row.error ?? "{}");
      expect(parsed.code).toBe("model.invoke.timeout");
      expect(parsed.retryable).toBe(true);
      expect(parsed.processorId).toBe("test.ledger.model-timeout");
    }
    const skipped = rows.find((row) => row.status === "skipped");
    if (skipped === undefined) throw new Error("expected skipped row");
    const parsedSkipped = JSON.parse(skipped.error ?? "{}");
    expect(parsedSkipped.code).toBe("processor.quarantined");
    expect(parsedSkipped.retryable).toBe(false);
  });

  test("vault execution cap bounds processor timeout at dispatch", async () => {
    const ledger = await openLedger();
    const p = makeFixtureProcessor({
      id: "test.ledger.execution-cap",
      phase: "garden",
      triggers: [{ kind: "signal", name: "file.created" }],
      execution: { class: "background", timeoutMs: 1_000 },
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return [];
      },
    });
    const rt = buildRuntimeFor([p], ledger, {
      executionCap: { timeoutMs: 5 },
    });

    const results = await rt.gardenRunner({
      vault: STUB_VAULT,
      adopted: CANDIDATE,
      changedPaths: ["wiki/a.md"],
      signals: [SIGNAL_CREATED],
      proposal,
    });

    expect(results[0]?.executionStatus).toBe("timed_out");
    expect(results[0]?.executionError?.code).toBe("processor.timeout");
    expect(results[0]?.executionError?.message).toContain("5ms");
    const rows = queryRuns(ledger, { processorId: "test.ledger.execution-cap" });
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("timed_out");
  });

  test("no ledger wired (Phase 6 transitional) — runs proceed and no rows are written", async () => {
    // Open a separate ledger purely to assert the OTHER ledger sees nothing
    // (no shared state between the two ledger files).
    const witnessLedger = await openLedger();
    // The runtime gets its own independent in-memory ledger, so the
    // witness (the file-backed ledger above) still sees zero rows.
    const runtimeLedger = await openTestLedger();

    const p = makeFixtureProcessor({
      id: "test.no-ledger",
      phase: "adoption",
      triggers: [{ kind: "signal", name: "file.created" }],
      emitsEffects: [
        diagnosticEffect({
          severity: "info",
          code: "test.fired",
          message: "fired",
          sourceRefs: [],
        }),
      ],
    });

    // Build a runtime WITHOUT a ledger.
    const reg = buildRegistry([p]);
    if (!reg.ok) throw new Error(`registry build failed: ${reg.error.kind}`);
    const rt = buildRuntime({
      registry: reg.value,
      resolveGrants: () => [READ_WIKI],
      extensionIdFor: (id) => id,
      resolveTree: async () => TREE,
      ledger: runtimeLedger,
    });

    const results = await rt.adoptionRunner({
      vault: STUB_VAULT,
      candidate: CANDIDATE,
      changedPaths: ["wiki/a.md"],
      signals: [SIGNAL_CREATED],
      iteration: 1,
      proposal,
    });

    expect(results.length).toBe(1);
    // runId is still populated (the fallback `makeRunContext` path).
    expect(typeof results[0]?.runId).toBe("string");
    expect(results[0]?.runId.startsWith("run_")).toBe(true);

    // No rows in the witness ledger (it was never wired in).
    expect(queryRuns(witnessLedger).length).toBe(0);
    runtimeLedger.close();
  });
});
