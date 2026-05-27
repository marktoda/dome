// Smoke tests for src/processors/runtime.ts: buildRuntime + adoptionRunner
// — empty registry, single-processor dispatch, non-matching skip, phase
// filtering, processor-exception synthesis, resolveTree invocation, and
// ProcessorContext round-trip.

import { describe, test, expect } from "bun:test";
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
import { commitOid, type CommitOid } from "../../src/core/source-ref";
import {
  diagnosticEffect,
  type DiagnosticEffect,
  type Effect,
} from "../../src/core/effect";
import { manualProposal } from "../../src/core/proposal";
import type { SignalEvent } from "../../src/engine/compile-range";
import type { Vault } from "../../src/vault";

// Stub Vault — the runtime never touches it (only passed through the
// AdoptionPhaseRunner input contract).
const STUB_VAULT = { path: "/tmp/stub-vault" } as unknown as Vault;

const BASE = commitOid("base000000000000000000000000000000000000");
const CANDIDATE = commitOid("cand000000000000000000000000000000000000");
const TREE = treeOid("tree000000000000000000000000000000000000");

const proposal = manualProposal({
  id: "prop_1_aaaaaa",
  base: BASE,
  head: CANDIDATE,
  branch: "main",
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
  overrides?: {
    resolveGrants?: (processorId: string) => ReadonlyArray<Capability>;
    extensionIdFor?: (processorId: string) => string;
    resolveTree?: (commit: CommitOid) => Promise<typeof TREE>;
  },
) {
  const reg = buildRegistry(processors);
  if (!reg.ok) throw new Error(`registry build failed: ${reg.error.kind}`);
  return buildRuntime({
    registry: reg.value,
    resolveGrants: overrides?.resolveGrants ?? (() => []),
    extensionIdFor: overrides?.extensionIdFor ?? ((id) => id),
    resolveTree: overrides?.resolveTree ?? (async () => TREE),
  });
}

const SIGNAL_CREATED: SignalEvent = Object.freeze({
  signal: "file.created",
  path: "wiki/a.md",
});

describe("buildRuntime — shape", () => {
  test("returns a runtime exposing a callable adoptionRunner", () => {
    const rt = buildRuntimeFor([]);
    expect(typeof rt.adoptionRunner).toBe("function");
  });

  test("empty registry → adoptionRunner returns empty RunnerResult[]", async () => {
    const rt = buildRuntimeFor([]);
    const results = await rt.adoptionRunner({
      vault: STUB_VAULT,
      candidate: CANDIDATE,
      changedPaths: ["wiki/a.md"],
      signals: [SIGNAL_CREATED],
      iteration: 1,
      proposal,
    });
    expect(results).toEqual([]);
  });
});

describe("adoptionRunner — dispatch + match filtering", () => {
  test("single adoption processor matched by signal → one RunnerResult with declared+granted+effects", async () => {
    const cap: Capability = { kind: "read", paths: ["wiki/**"] };
    const diag: DiagnosticEffect = diagnosticEffect({
      severity: "info",
      code: "test.fired",
      message: "fired",
      sourceRefs: [],
    });
    const p = makeFixtureProcessor({
      id: "test.match",
      phase: "adoption",
      triggers: [{ kind: "signal", name: "file.created" }],
      capabilities: [cap],
      emitsEffects: [diag],
    });
    const rt = buildRuntimeFor([p], { resolveGrants: () => [cap] });

    const results = await rt.adoptionRunner({
      vault: STUB_VAULT,
      candidate: CANDIDATE,
      changedPaths: ["wiki/a.md"],
      signals: [SIGNAL_CREATED],
      iteration: 1,
      proposal,
    });

    expect(results.length).toBe(1);
    expect(results[0]?.processorId).toBe("test.match");
    expect(results[0]?.declared).toEqual([cap]);
    expect(results[0]?.granted).toEqual([cap]);
    expect(results[0]?.effects).toEqual([diag]);
  });

  test("non-matching processor (signal doesn't match its triggers) → not included", async () => {
    const p = makeFixtureProcessor({
      id: "test.no-match",
      phase: "adoption",
      triggers: [{ kind: "signal", name: "link.added" }],
    });
    const rt = buildRuntimeFor([p]);

    const results = await rt.adoptionRunner({
      vault: STUB_VAULT,
      candidate: CANDIDATE,
      changedPaths: ["wiki/a.md"],
      signals: [SIGNAL_CREATED],
      iteration: 1,
      proposal,
    });

    expect(results).toEqual([]);
  });

  test("garden + view phase processors are NOT invoked by adoptionRunner", async () => {
    const gardenP = makeFixtureProcessor({
      id: "test.garden",
      phase: "garden",
      triggers: [{ kind: "signal", name: "file.created" }],
      emitsEffects: [
        diagnosticEffect({
          severity: "info",
          code: "garden.fired",
          message: "garden",
          sourceRefs: [],
        }),
      ],
    });
    const viewP = makeFixtureProcessor({
      id: "test.view",
      phase: "view",
      triggers: [{ kind: "signal", name: "file.created" }],
      emitsEffects: [
        diagnosticEffect({
          severity: "info",
          code: "view.fired",
          message: "view",
          sourceRefs: [],
        }),
      ],
    });
    const rt = buildRuntimeFor([gardenP, viewP]);

    const results = await rt.adoptionRunner({
      vault: STUB_VAULT,
      candidate: CANDIDATE,
      changedPaths: ["wiki/a.md"],
      signals: [SIGNAL_CREATED],
      iteration: 1,
      proposal,
    });

    expect(results).toEqual([]);
  });
});

describe("adoptionRunner — processor exception synthesis", () => {
  test("processor that throws → synthesized DiagnosticEffect with code 'processor-threw', severity 'error'; loop does not crash", async () => {
    const p = makeFixtureProcessor({
      id: "test.thrower",
      phase: "adoption",
      triggers: [{ kind: "signal", name: "file.created" }],
      run: async () => {
        throw new Error("boom");
      },
    });
    const rt = buildRuntimeFor([p]);

    const results = await rt.adoptionRunner({
      vault: STUB_VAULT,
      candidate: CANDIDATE,
      changedPaths: ["wiki/a.md"],
      signals: [SIGNAL_CREATED],
      iteration: 1,
      proposal,
    });

    expect(results.length).toBe(1);
    const effects = results[0]?.effects ?? [];
    expect(effects.length).toBe(1);
    const synthesized = effects[0];
    expect(synthesized?.kind).toBe("diagnostic");
    if (synthesized?.kind !== "diagnostic") return;
    expect(synthesized.code).toBe("processor-threw");
    expect(synthesized.severity).toBe("error");
    expect(synthesized.message).toContain("test.thrower");
    expect(synthesized.message).toContain("boom");
  });
});

describe("adoptionRunner — context wiring", () => {
  test("resolveTree is invoked once per adoptionRunner call to build the snapshot", async () => {
    let resolveTreeCalls = 0;
    const p = makeFixtureProcessor({
      id: "test.a",
      phase: "adoption",
      triggers: [{ kind: "signal", name: "file.created" }],
    });
    const p2 = makeFixtureProcessor({
      id: "test.b",
      phase: "adoption",
      triggers: [{ kind: "signal", name: "file.created" }],
    });
    const rt = buildRuntimeFor([p, p2], {
      resolveTree: async () => {
        resolveTreeCalls += 1;
        return TREE;
      },
    });

    await rt.adoptionRunner({
      vault: STUB_VAULT,
      candidate: CANDIDATE,
      changedPaths: ["wiki/a.md"],
      signals: [SIGNAL_CREATED],
      iteration: 1,
      proposal,
    });

    expect(resolveTreeCalls).toBe(1);
  });

  test("processor sees ProcessorContext whose proposal === input.proposal and changedPaths === input.changedPaths", async () => {
    const observed: { proposal: unknown; changedPaths: ReadonlyArray<string> | null } = {
      proposal: undefined,
      changedPaths: null,
    };
    const changedPaths = ["wiki/a.md", "wiki/b.md"];
    const p = makeFixtureProcessor({
      id: "test.observer",
      phase: "adoption",
      triggers: [{ kind: "signal", name: "file.created" }],
      run: async (ctx) => {
        observed.proposal = ctx.proposal;
        observed.changedPaths = ctx.changedPaths;
        return [];
      },
    });
    const rt = buildRuntimeFor([p]);

    await rt.adoptionRunner({
      vault: STUB_VAULT,
      candidate: CANDIDATE,
      changedPaths,
      signals: [SIGNAL_CREATED],
      iteration: 1,
      proposal,
    });

    expect(observed.proposal).toBe(proposal);
    expect(observed.changedPaths).toBe(changedPaths);
  });

  test("processor sees its input envelope as { kind: 'adoption', matchedTriggers }", async () => {
    let observedInput: AdoptionRunInput | undefined;
    const p = makeFixtureProcessor({
      id: "test.envelope",
      phase: "adoption",
      triggers: [{ kind: "signal", name: "file.created" }],
      run: async (ctx) => {
        observedInput = ctx.input;
        return [];
      },
    });
    const rt = buildRuntimeFor([p]);

    await rt.adoptionRunner({
      vault: STUB_VAULT,
      candidate: CANDIDATE,
      changedPaths: ["wiki/a.md"],
      signals: [SIGNAL_CREATED],
      iteration: 1,
      proposal,
    });

    expect(observedInput?.kind).toBe("adoption");
    expect(observedInput?.matchedTriggers.length).toBe(1);
    expect(observedInput?.matchedTriggers[0]?.trigger.kind).toBe("signal");
  });
});
