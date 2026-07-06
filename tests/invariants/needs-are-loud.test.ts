// NEEDS_ARE_LOUD — the run-time complement of the doctor grant-starvation
// probe. A processor whose manifest-declared capability has an empty effective
// grant intersection (or whose declared operational read-view context field is
// absent at invocation) still RUNS, but the runtime emits a warning
// `processor.need-unmet` diagnostic naming the processor + the unmet need.
// Silent degradation on a declared need is a defect.
//
// Behavioral enforcement lives here (the runtime path is exercised directly via
// buildRuntime); this file is also the AC3 lockstep anchor for
// docs/wiki/invariants/NEEDS_ARE_LOUD.md.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { buildRuntime } from "../../src/processors/runtime";
import { buildRegistry } from "../../src/processors/registry";
import {
  defineProcessor,
  treeOid,
  type Capability,
  type Processor,
  type ProcessorPhase,
  type Trigger,
} from "../../src/core/processor";
import { commitOid, type CommitOid } from "../../src/core/source-ref";
import {
  diagnosticEffect,
  type Effect,
} from "../../src/core/effect";
import { makeManualProposal } from "../../src/core/proposal";
import type { EngineVault } from "../../src/engine/core/vault-shape";
import type { SignalEvent } from "../../src/engine/core/compile-range";
import type { LedgerDb } from "../../src/ledger/db";
import { openTestLedger } from "../support/test-ledger";

let ledger: LedgerDb;
beforeAll(async () => {
  ledger = await openTestLedger();
});
afterAll(() => {
  ledger.close();
});

const STUB_VAULT: EngineVault = {
  path: "/tmp/needs-are-loud-vault",
  config: { git: { auto_commit_workflows: false } },
};

const CANDIDATE = commitOid("cand000000000000000000000000000000000000");
const TREE = treeOid("tree000000000000000000000000000000000000");
const READ_WIKI: Capability = { kind: "read", paths: ["wiki/**"] };
const GRAPH_WRITE: Capability = {
  kind: "graph.write",
  namespaces: ["dome.test"],
};
const QUESTIONS_READ: Capability = { kind: "questions.read" };
const PROPOSALS_READ: Capability = { kind: "proposals.read" };

const SIGNAL: SignalEvent = Object.freeze({
  signal: "file.created",
  path: "wiki/a.md",
});

const proposal = makeManualProposal({
  id: "prop_1_aaaaaa",
  base: commitOid("base000000000000000000000000000000000000"),
  head: CANDIDATE,
  branch: "main",
});

function makeGardenProcessor(opts: {
  id: string;
  capabilities: ReadonlyArray<Capability>;
  onRun?: () => void;
}): Processor {
  return defineProcessor({
    id: opts.id,
    version: "0.0.1",
    phase: "garden" satisfies ProcessorPhase,
    triggers: [{ kind: "signal", name: "file.created" } satisfies Trigger],
    capabilities: opts.capabilities,
    run: async () => {
      opts.onRun?.();
      return [] as ReadonlyArray<Effect>;
    },
  });
}

function buildRuntimeFor(
  processors: ReadonlyArray<Processor>,
  resolveGrants: (processorId: string) => ReadonlyArray<Capability>,
) {
  const reg = buildRegistry(processors);
  if (!reg.ok) throw new Error(`registry build failed: ${reg.error.kind}`);
  return buildRuntime({
    registry: reg.value,
    resolveGrants,
    extensionIdFor: (id) => id,
    resolveTree: async (_commit: CommitOid) => TREE,
    ledger,
  });
}

async function runGardenOnce(rt: ReturnType<typeof buildRuntimeFor>) {
  return rt.gardenRunner({
    vault: STUB_VAULT,
    adopted: CANDIDATE,
    changedPaths: ["wiki/a.md"],
    signals: [SIGNAL],
    proposal,
  });
}

function needUnmetDiagnostics(effects: ReadonlyArray<Effect>) {
  return effects.filter(
    (e) => e.kind === "diagnostic" && e.code === "processor.need-unmet",
  );
}

describe("NEEDS_ARE_LOUD (runtime invariant)", () => {
  test("ungranted declared capability → processor RUNS and a processor.need-unmet warning lands", async () => {
    let ran = false;
    const p = makeGardenProcessor({
      id: "test.need.graph-write",
      capabilities: [READ_WIKI, GRAPH_WRITE],
      onRun: () => {
        ran = true;
      },
    });
    // graph.write declared but NOT granted (read only) → empty intersection.
    const rt = buildRuntimeFor([p], () => [READ_WIKI]);

    const results = await runGardenOnce(rt);

    expect(results.length).toBe(1);
    // Degradation stays graceful: the processor still runs.
    expect(ran).toBe(true);
    expect(results[0]?.executionStatus).toBe("succeeded");

    const warnings = needUnmetDiagnostics(results[0]?.effects ?? []);
    expect(warnings.length).toBe(1);
    const warning = warnings[0]!;
    if (warning.kind !== "diagnostic") throw new Error("expected diagnostic");
    expect(warning.severity).toBe("warning");
    // Code/detail carries the processor id + the unmet need.
    expect(warning.message).toContain("test.need.graph-write");
    expect(warning.message).toContain("graph.write");
  });

  test("absent declared operational read-view context field → processor.need-unmet warning", async () => {
    const p = makeGardenProcessor({
      id: "test.need.questions-read",
      capabilities: [READ_WIKI, QUESTIONS_READ],
    });
    // questions.read declared but not granted → ctx.operational questions
    // accessor absent at run time.
    const rt = buildRuntimeFor([p], () => [READ_WIKI]);

    const results = await runGardenOnce(rt);

    const warnings = needUnmetDiagnostics(results[0]?.effects ?? []);
    expect(warnings.length).toBe(1);
    const warning = warnings[0]!;
    if (warning.kind !== "diagnostic") throw new Error("expected diagnostic");
    expect(warning.severity).toBe("warning");
    expect(warning.message).toContain("questions.read");
  });

  test("absent declared proposals.read context field → processor.need-unmet warning", async () => {
    const p = makeGardenProcessor({
      id: "test.need.proposals-read",
      capabilities: [READ_WIKI, PROPOSALS_READ],
    });
    // proposals.read declared but not granted → ctx.operational.proposals
    // accessor absent at run time.
    const rt = buildRuntimeFor([p], () => [READ_WIKI]);

    const results = await runGardenOnce(rt);

    const warnings = needUnmetDiagnostics(results[0]?.effects ?? []);
    expect(warnings.length).toBe(1);
    const warning = warnings[0]!;
    if (warning.kind !== "diagnostic") throw new Error("expected diagnostic");
    expect(warning.severity).toBe("warning");
    expect(warning.message).toContain("proposals.read");
  });

  test("fully granted processor emits no processor.need-unmet diagnostic", async () => {
    const p = makeGardenProcessor({
      id: "test.need.satisfied",
      capabilities: [READ_WIKI, GRAPH_WRITE, QUESTIONS_READ],
    });
    const rt = buildRuntimeFor([p], () => [
      READ_WIKI,
      GRAPH_WRITE,
      QUESTIONS_READ,
    ]);

    const results = await runGardenOnce(rt);

    expect(results[0]?.executionStatus).toBe("succeeded");
    expect(needUnmetDiagnostics(results[0]?.effects ?? [])).toEqual([]);
  });

  test("deduped once per (processor, need) per host session", async () => {
    const p = makeGardenProcessor({
      id: "test.need.dedup",
      capabilities: [READ_WIKI, GRAPH_WRITE],
    });
    const rt = buildRuntimeFor([p], () => [READ_WIKI]);

    const first = await runGardenOnce(rt);
    const second = await runGardenOnce(rt);

    expect(needUnmetDiagnostics(first[0]?.effects ?? []).length).toBe(1);
    // Same runtime (host session): the second firing is silent.
    expect(needUnmetDiagnostics(second[0]?.effects ?? []).length).toBe(0);

    // A fresh runtime (a restart) re-emits — that's desirable, not a bug.
    const rt2 = buildRuntimeFor([p], () => [READ_WIKI]);
    const afterRestart = await runGardenOnce(rt2);
    expect(needUnmetDiagnostics(afterRestart[0]?.effects ?? []).length).toBe(1);
  });

  test("smoke: diagnosticEffect helper produces the warning shape we assert on", () => {
    const d = diagnosticEffect({
      severity: "warning",
      code: "processor.need-unmet",
      message: "x: y",
      sourceRefs: [],
    });
    expect(d.kind).toBe("diagnostic");
  });
});
