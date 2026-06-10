// Projection-maintenance hooks on the shared non-signal garden routing path
// (src/engine/garden/garden-run-routing.ts).
//
// Schedule fires, queued jobs, and answer handlers all route through
// `routeGardenRunEffects`. Before this contract was pinned, the shared path
// never called the resolveFacts / resolveDiagnostics / resolveQuestions
// sinks that the signal-triggered garden path (garden.ts) calls — so a
// scheduled processor that stopped re-emitting a finding left its stale
// projection rows behind forever. These tests pin the hook contract:
// resolveFacts before fact routing, resolveDiagnostics/resolveQuestions
// after routing with the run's emitted effects, all gated on a succeeded
// execution.

import { describe, expect, test } from "bun:test";

import { routeGardenRunEffects } from "../../src/engine/garden/garden-run-routing";
import { noopSinks, type ApplyEffectSinks } from "../../src/engine/core/apply-effect";
import {
  diagnosticEffect,
  factEffect,
  questionEffect,
} from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import type { RunnerResult, RunId } from "../../src/engine/core/runner-contract";
import type { EngineVault } from "../../src/engine/core/vault-shape";
import type { Effect } from "../../src/core/effect";

const ADOPTED = commitOid("a".repeat(40));
const VAULT: EngineVault = {
  path: "/tmp/unused-garden-run-routing",
  config: { git: { auto_commit_workflows: true } },
};

const REF = sourceRef({ commit: ADOPTED, path: "wiki/page.md" });

function makeResult(opts: {
  effects: ReadonlyArray<Effect>;
  executionStatus?: RunnerResult["executionStatus"];
}): RunnerResult {
  return {
    runId: "run_routing_test" as RunId,
    processorId: "test.scheduled",
    executionStatus: opts.executionStatus ?? "succeeded",
    declared: [
      { kind: "read" as const, paths: ["**/*.md"] },
      { kind: "question.ask" as const },
      { kind: "graph.write" as const, namespaces: ["test.facts"] },
    ],
    granted: [
      { kind: "read" as const, paths: ["**/*.md"] },
      { kind: "question.ask" as const },
      { kind: "graph.write" as const, namespaces: ["test.facts"] },
    ],
    inspectedPaths: ["wiki/page.md"],
    effects: [...opts.effects],
  };
}

async function route(opts: {
  result: RunnerResult;
  sinks: ApplyEffectSinks;
  diagnostics?: ReturnType<typeof diagnosticEffect>[];
}): Promise<void> {
  await routeGardenRunEffects({
    result: opts.result,
    vault: VAULT,
    adopted: ADOPTED,
    proposalId: null,
    sinks: opts.sinks,
    diagnostics: opts.diagnostics ?? [],
    applyGardenPatch: async () => null,
    extensionIdFor: () => "test",
    disabledDiagnostic: {
      code: "test.disabled",
      message: "garden patch dispatch disabled in this test",
    },
  });
}

describe("routeGardenRunEffects projection-maintenance hooks", () => {
  test("a succeeded run calls all three resolve hooks with the run's scope and emissions", async () => {
    const calls: string[] = [];
    let resolveFactsInput: unknown = null;
    let resolveDiagnosticsInput: {
      emittedDiagnostics: ReadonlyArray<{ code: string }>;
      inspectedPaths: ReadonlyArray<string>;
    } | null = null;
    let resolveQuestionsInput: {
      emittedQuestions: ReadonlyArray<{ idempotencyKey: string }>;
    } | null = null;

    const diag = diagnosticEffect({
      severity: "warning",
      code: "test.finding",
      message: "still true",
      sourceRefs: [REF],
    });
    const question = questionEffect({
      question: "still open?",
      idempotencyKey: "test:q1",
      sourceRefs: [REF],
    });
    const fact = factEffect({
      subject: { kind: "page", path: "wiki/page.md" },
      predicate: "test.facts.flag",
      object: { kind: "string", value: "on" },
      assertion: "extracted",
      sourceRefs: [REF],
    });

    const sinks: ApplyEffectSinks = {
      ...noopSinks(),
      resolveFacts: async (input) => {
        calls.push("resolveFacts");
        resolveFactsInput = input;
      },
      recordFact: async () => {
        calls.push("recordFact");
      },
      resolveDiagnostics: async (input) => {
        calls.push("resolveDiagnostics");
        resolveDiagnosticsInput = input;
      },
      resolveQuestions: async (input) => {
        calls.push("resolveQuestions");
        resolveQuestionsInput = input;
      },
    };

    await route({
      result: makeResult({ effects: [diag, question, fact] }),
      sinks,
    });

    // resolveFacts runs BEFORE any fact routes (stale-then-replace order).
    expect(calls.indexOf("resolveFacts")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("resolveFacts")).toBeLessThan(
      calls.indexOf("recordFact"),
    );
    // The post-routing hooks run after routing, once each.
    expect(calls.filter((c) => c === "resolveDiagnostics")).toHaveLength(1);
    expect(calls.filter((c) => c === "resolveQuestions")).toHaveLength(1);

    expect(resolveFactsInput).toMatchObject({
      processorId: "test.scheduled",
      inspectedPaths: ["wiki/page.md"],
    });
    expect(resolveDiagnosticsInput).not.toBeNull();
    expect(
      resolveDiagnosticsInput!.emittedDiagnostics.map((d) => d.code),
    ).toContain("test.finding");
    expect(resolveDiagnosticsInput!.inspectedPaths).toEqual(["wiki/page.md"]);
    expect(resolveQuestionsInput).not.toBeNull();
    expect(
      resolveQuestionsInput!.emittedQuestions.map((q) => q.idempotencyKey),
    ).toEqual(["test:q1"]);
  });

  test("a run that emits nothing still resolves: stale rows for inspected paths can clear", async () => {
    let resolveDiagnosticsCalled = false;
    let emitted: ReadonlyArray<unknown> | null = null;
    const sinks: ApplyEffectSinks = {
      ...noopSinks(),
      resolveDiagnostics: async (input) => {
        resolveDiagnosticsCalled = true;
        emitted = input.emittedDiagnostics;
      },
    };

    await route({ result: makeResult({ effects: [] }), sinks });

    expect(resolveDiagnosticsCalled).toBe(true);
    expect(emitted).not.toBeNull();
    expect(emitted!).toHaveLength(0);
  });

  test("a non-succeeded run calls no resolve hooks (a failed run must not clear prior findings)", async () => {
    const calls: string[] = [];
    const sinks: ApplyEffectSinks = {
      ...noopSinks(),
      resolveFacts: async () => {
        calls.push("resolveFacts");
      },
      resolveDiagnostics: async () => {
        calls.push("resolveDiagnostics");
      },
      resolveQuestions: async () => {
        calls.push("resolveQuestions");
      },
    };

    await route({
      result: makeResult({ effects: [], executionStatus: "failed" }),
      sinks,
    });

    expect(calls).toEqual([]);
  });

  test("routing-produced diagnostics (e.g. a capability denial) reach resolveDiagnostics", async () => {
    // Emit a question WITHOUT question.ask in the grant set: the broker
    // denies it and the denial diagnostic must be part of the resolution
    // set, mirroring garden.ts.
    let emittedCodes: ReadonlyArray<string> | null = null;
    const sinks: ApplyEffectSinks = {
      ...noopSinks(),
      resolveDiagnostics: async (input) => {
        emittedCodes = input.emittedDiagnostics.map((d) => d.code);
      },
    };
    const question = questionEffect({
      question: "may I?",
      idempotencyKey: "test:denied",
      sourceRefs: [REF],
    });
    const result: RunnerResult = {
      ...makeResult({ effects: [question] }),
      declared: [],
      granted: [],
    };

    const diagnostics: ReturnType<typeof diagnosticEffect>[] = [];
    await route({ result, sinks, diagnostics });

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(emittedCodes).not.toBeNull();
    expect(emittedCodes!).toEqual(diagnostics.map((d) => d.code));
  });
});
