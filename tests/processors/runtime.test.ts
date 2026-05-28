// Smoke tests for src/processors/runtime.ts: buildRuntime + adoptionRunner
// — empty registry, single-processor dispatch, non-matching skip, phase
// filtering, processor-exception synthesis, resolveTree invocation, and
// ProcessorContext round-trip.

import { describe, test, expect } from "bun:test";
import {
  buildRuntime,
  dispatchOneProcessor,
  type AdoptionRunInput,
} from "../../src/processors/runtime";
import { buildRegistry } from "../../src/processors/registry";
import {
  defineProcessor,
  treeOid,
  type Capability,
  type ExecutionPolicyRequest,
  type Processor,
  type ProcessorContext,
  type ProcessorPhase,
  type Snapshot,
  type Trigger,
} from "../../src/core/processor";
import { transientProcessorError } from "../../src/core/processor-error";
import { commitOid, type CommitOid } from "../../src/core/source-ref";
import {
  diagnosticEffect,
  type DiagnosticEffect,
  type Effect,
} from "../../src/core/effect";
import { makeManualProposal } from "../../src/core/proposal";
import type { SignalEvent } from "../../src/engine/compile-range";
import type { EngineVault } from "../../src/engine/vault-shape";
import type { ModelProvider } from "../../src/engine/model-invoke";

// Stub EngineVault — the runtime never touches it (only passed through the
// AdoptionPhaseRunner input contract).
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
    capabilities: opts.capabilities ?? [],
    ...(opts.execution !== undefined ? { execution: opts.execution } : {}),
    run:
      opts.run !== undefined
        ? opts.run
        : async () => opts.emitsEffects ?? [],
  });
}

function buildRuntimeFor(
  processors: ReadonlyArray<Processor>,
  overrides?: {
    resolveGrants?: (processorId: string) => ReadonlyArray<Capability>;
    extensionIdFor?: (processorId: string) => string;
    resolveTree?: (commit: CommitOid) => Promise<typeof TREE>;
    modelProvider?: ModelProvider;
  },
) {
  const reg = buildRegistry(processors);
  if (!reg.ok) throw new Error(`registry build failed: ${reg.error.kind}`);
  return buildRuntime({
    registry: reg.value,
    resolveGrants: overrides?.resolveGrants ?? (() => []),
    extensionIdFor: overrides?.extensionIdFor ?? ((id) => id),
    resolveTree: overrides?.resolveTree ?? (async () => TREE),
    ...(overrides?.modelProvider !== undefined
      ? { modelProvider: overrides.modelProvider }
      : {}),
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
  test("processor that throws → processor.threw block diagnostic; loop does not crash", async () => {
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
    expect(synthesized.code).toBe("processor.threw");
    expect(synthesized.severity).toBe("block");
    expect(synthesized.message).toContain("test.thrower");
    expect(synthesized.message).toContain("boom");
  });

  test("processor returning malformed effect → processor.invalid-output block diagnostic", async () => {
    const p = makeFixtureProcessor({
      id: "test.invalid-output",
      phase: "adoption",
      triggers: [{ kind: "signal", name: "file.created" }],
      run: async () => [
        {
          kind: "patch",
          mode: "auto",
          changes: [],
          reason: "bad",
          sourceRefs: [],
        } as never,
      ],
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
    const effect = results[0]?.effects[0];
    expect(effect?.kind).toBe("diagnostic");
    if (effect?.kind !== "diagnostic") return;
    expect(effect.code).toBe("processor.invalid-output");
    expect(effect.severity).toBe("block");
  });
});

describe("gardenRunner — executor diagnostics", () => {
  test("garden processor that throws → processor.threw error diagnostic", async () => {
    const p = makeFixtureProcessor({
      id: "test.garden.thrower",
      phase: "garden",
      triggers: [{ kind: "signal", name: "file.created" }],
      run: async () => {
        throw new Error("garden boom");
      },
    });
    const rt = buildRuntimeFor([p]);

    const results = await rt.gardenRunner({
      vault: STUB_VAULT,
      adopted: CANDIDATE,
      changedPaths: ["wiki/a.md"],
      signals: [SIGNAL_CREATED],
      proposal,
    });

    expect(results.length).toBe(1);
    const effect = results[0]?.effects[0];
    expect(effect?.kind).toBe("diagnostic");
    if (effect?.kind !== "diagnostic") return;
    expect(effect.code).toBe("processor.threw");
    expect(effect.severity).toBe("error");
    expect(effect.message).toContain("test.garden.thrower");
    expect(effect.message).toContain("garden boom");
  });

  test("three retryable garden failures quarantine the matching trigger", async () => {
    let invocations = 0;
    const p = makeFixtureProcessor({
      id: "test.garden.quarantine",
      phase: "garden",
      triggers: [{ kind: "signal", name: "file.created" }],
      run: async () => {
        invocations += 1;
        throw transientProcessorError("temporary downstream failure");
      },
    });
    const rt = buildRuntimeFor([p]);

    for (let i = 0; i < 3; i += 1) {
      const results = await rt.gardenRunner({
        vault: STUB_VAULT,
        adopted: CANDIDATE,
        changedPaths: ["wiki/a.md"],
        signals: [SIGNAL_CREATED],
        proposal,
      });
      expect(results[0]?.executionStatus).toBe("failed");
      expect(results[0]?.executionError?.code).toBe("processor.threw");
      expect(results[0]?.executionError?.retryable).toBe(true);
    }

    const quarantined = await rt.gardenRunner({
      vault: STUB_VAULT,
      adopted: CANDIDATE,
      changedPaths: ["wiki/a.md"],
      signals: [SIGNAL_CREATED],
      proposal,
    });

    expect(invocations).toBe(3);
    expect(quarantined.length).toBe(1);
    expect(quarantined[0]?.executionStatus).toBe("skipped");
    expect(quarantined[0]?.executionError?.code).toBe("processor.quarantined");
    const effect = quarantined[0]?.effects[0];
    expect(effect?.kind).toBe("diagnostic");
    if (effect?.kind !== "diagnostic") return;
    expect(effect.code).toBe("processor.quarantined");
    expect(effect.severity).toBe("error");
  });

  test("non-retryable garden failures do not quarantine", async () => {
    let invocations = 0;
    const p = makeFixtureProcessor({
      id: "test.garden.nonretryable",
      phase: "garden",
      triggers: [{ kind: "signal", name: "file.created" }],
      run: async () => {
        invocations += 1;
        throw new Error("permanent bug");
      },
    });
    const rt = buildRuntimeFor([p]);

    for (let i = 0; i < 4; i += 1) {
      const results = await rt.gardenRunner({
        vault: STUB_VAULT,
        adopted: CANDIDATE,
        changedPaths: ["wiki/a.md"],
        signals: [SIGNAL_CREATED],
        proposal,
      });
      expect(results[0]?.executionStatus).toBe("failed");
      expect(results[0]?.executionError?.code).toBe("processor.threw");
      expect(results[0]?.executionError?.retryable).toBe(false);
    }

    expect(invocations).toBe(4);
  });

  test("garden processor with effective model.invoke grant receives ctx.modelInvoke", async () => {
    const cap: Capability = {
      kind: "model.invoke",
      modelAllowlist: ["test-model"],
    };
    let providerPrompt = "";
    const p = makeFixtureProcessor({
      id: "test.garden.model",
      phase: "garden",
      triggers: [{ kind: "signal", name: "file.created" }],
      capabilities: [cap],
      execution: { class: "llm", modelCallTimeoutMs: 500 },
      run: async (ctx) => {
        if (ctx.modelInvoke === undefined) {
          throw new Error("missing modelInvoke");
        }
        const text = await ctx.modelInvoke({
          prompt: "summarize",
          model: "test-model",
        });
        return [
          diagnosticEffect({
            severity: "info",
            code: "model.ok",
            message: text,
            sourceRefs: [],
          }),
        ];
      },
    });
    const rt = buildRuntimeFor([p], {
      resolveGrants: () => [cap],
      modelProvider: async (request) => {
        providerPrompt = request.prompt;
        return { text: "model result" };
      },
    });

    const results = await rt.gardenRunner({
      vault: STUB_VAULT,
      adopted: CANDIDATE,
      changedPaths: ["wiki/a.md"],
      signals: [SIGNAL_CREATED],
      proposal,
    });

    expect(providerPrompt).toBe("summarize");
    expect(results[0]?.executionStatus).toBe("succeeded");
    const effect = results[0]?.effects[0];
    expect(effect?.kind).toBe("diagnostic");
    if (effect?.kind !== "diagnostic") return;
    expect(effect.message).toBe("model result");
  });

  test("model output parse errors preserve model-specific execution codes", async () => {
    const cap: Capability = { kind: "model.invoke" };
    const p = makeFixtureProcessor({
      id: "test.garden.model-json",
      phase: "garden",
      triggers: [{ kind: "signal", name: "file.created" }],
      capabilities: [cap],
      execution: { class: "llm" },
      run: async (ctx) => {
        await ctx.modelInvoke?.structured({
          prompt: "json",
          schemaName: "test.schema/v1",
          parse: (value) => value,
        });
        return [];
      },
    });
    const rt = buildRuntimeFor([p], {
      resolveGrants: () => [cap],
      modelProvider: async () => ({ text: "not-json" }),
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
    const effect = results[0]?.effects[0];
    expect(effect?.kind).toBe("diagnostic");
    if (effect?.kind !== "diagnostic") return;
    expect(effect.code).toBe("model.output.invalid-json");
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
        observedInput = ctx.input as AdoptionRunInput;
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

describe("dispatchOneProcessor — scoped snapshot reads", () => {
  test("readFile returns null and listMarkdownFiles filters outside effective read grants", async () => {
    const readCap: Capability = { kind: "read", paths: ["wiki/**"] };
    const observed: {
      allowed: string | null;
      denied: string | null;
      invalid: string | null;
      listed: ReadonlyArray<string>;
    } = {
      allowed: null,
      denied: null,
      invalid: null,
      listed: [],
    };
    const snapshot: Snapshot = Object.freeze({
      commit: CANDIDATE,
      tree: TREE,
      readFile: async (path: string): Promise<string | null> => {
        if (path === "wiki/allowed.md") return "allowed";
        if (path === "secret/denied.md") return "denied";
        return null;
      },
      listMarkdownFiles: async (): Promise<ReadonlyArray<string>> =>
        Object.freeze(["wiki/allowed.md", "secret/denied.md"]),
    });
    const p = makeFixtureProcessor({
      id: "test.scoped-snapshot",
      phase: "adoption",
      triggers: [{ kind: "signal", name: "file.created" }],
      capabilities: [readCap],
      run: async (ctx) => {
        observed.allowed = await ctx.snapshot.readFile("wiki/allowed.md");
        observed.denied = await ctx.snapshot.readFile("secret/denied.md");
        observed.invalid = await ctx.snapshot.readFile("../secret.md");
        observed.listed = await ctx.snapshot.listMarkdownFiles();
        return [];
      },
    });

    const result = await dispatchOneProcessor({
      processor: p,
      phase: "adoption",
      envelope: { kind: "adoption", matchedTriggers: [] },
      snapshot,
      changedPaths: [],
      proposal,
      inputCommit: CANDIDATE,
      matches: [],
      resolveGrants: () => [readCap],
      extensionIdFor: (id) => id,
      ledger: undefined,
    });

    expect(result.executionStatus).toBe("succeeded");
    expect(observed.allowed).toBe("allowed");
    expect(observed.denied).toBeNull();
    expect(observed.invalid).toBeNull();
    expect(observed.listed).toEqual(["wiki/allowed.md"]);
  });
});
