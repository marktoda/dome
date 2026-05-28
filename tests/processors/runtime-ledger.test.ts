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

import {
  buildRuntime,
  type AdoptionRunInput,
} from "../../src/processors/runtime";
import { buildRegistry } from "../../src/processors/registry";
import {
  defineProcessor,
  treeOid,
  type Capability,
  type Processor,
  type ProcessorContext,
  type ProcessorPhase,
  type Trigger,
} from "../../src/core/processor";
import { commitOid } from "../../src/core/source-ref";
import {
  diagnosticEffect,
  type Effect,
} from "../../src/core/effect";
import { makeManualProposal } from "../../src/core/proposal";
import type { SignalEvent } from "../../src/engine/compile-range";
import type { EngineVault } from "../../src/engine/vault-shape";
import { openLedgerDb, type LedgerDb } from "../../src/ledger/db";
import { queryRuns } from "../../src/ledger/runs";

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

function makeFixtureProcessor(opts: {
  id: string;
  phase: ProcessorPhase;
  triggers: ReadonlyArray<Trigger>;
  capabilities?: ReadonlyArray<Capability>;
  emitsEffects?: ReadonlyArray<Effect>;
  run?: (ctx: ProcessorContext<AdoptionRunInput>) => Promise<ReadonlyArray<Effect>>;
}): Processor {
  return defineProcessor({
    id: opts.id,
    version: "0.0.1",
    phase: opts.phase,
    triggers: opts.triggers,
    capabilities: opts.capabilities ?? [],
    run:
      opts.run !== undefined
        ? (opts.run as (ctx: ProcessorContext<unknown>) => Promise<ReadonlyArray<Effect>>)
        : async () => opts.emitsEffects ?? [],
  });
}

function buildRuntimeFor(
  processors: ReadonlyArray<Processor>,
  ledger: LedgerDb,
) {
  const reg = buildRegistry(processors);
  if (!reg.ok) throw new Error(`registry build failed: ${reg.error.kind}`);
  return buildRuntime({
    registry: reg.value,
    resolveGrants: () => [],
    extensionIdFor: (id) => id,
    resolveTree: async () => TREE,
    ledger,
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

    // The synthesized `processor-threw` diagnostic still flows back to the
    // adoption loop — the existing non-blocking behavior is preserved.
    expect(results.length).toBe(1);
    expect(results[0]?.effects.length).toBe(1);

    const rows = queryRuns(ledger, { processorId: "test.ledger.thrower" });
    expect(rows.length).toBe(1);
    const row = rows[0];
    if (row === undefined) throw new Error("expected row");

    expect(row.status).toBe("failed");
    expect(row.error).toContain("boom from test");
    expect(row.finishedAt).not.toBeNull();
    expect(row.durationMs).not.toBeNull();
  });

  test("no ledger wired (Phase 6 transitional) — runs proceed and no rows are written", async () => {
    // Open a separate ledger purely to assert the OTHER ledger sees nothing
    // (no shared state between the two ledger files).
    const witnessLedger = await openLedger();

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
      resolveGrants: () => [],
      extensionIdFor: (id) => id,
      resolveTree: async () => TREE,
      // ledger intentionally absent
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
  });
});
