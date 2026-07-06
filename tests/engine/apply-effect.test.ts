// Smoke tests for src/engine/core/apply-effect.ts: phase-compatibility rejections,
// successful routes, and capability-denial flow per
// docs/wiki/matrices/effect-router-targets.md.

import { describe, test, expect } from "bun:test";
import {
  EFFECT_PHASE_COMPATIBILITY,
  applyEffect,
  noopSinks,
  type ApplyEffectSinks,
} from "../../src/engine/core/apply-effect";
import {
  diagnosticEffect,
  externalActionEffect,
  factEffect,
  outboxRecoveryEffect,
  patchEffect,
  quarantineRecoveryEffect,
  questionEffect,
  runRecoveryEffect,
  searchDocumentEffect,
  viewEffect,
} from "../../src/core/effect";
import type { Capability } from "../../src/core/processor";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import type { RunId } from "../../src/engine/core/runner-contract";

const ref = sourceRef({ commit: commitOid("abc"), path: "wiki/x.md" });
const read: Capability = { kind: "read", paths: ["wiki/**"] };

const baseOpts = {
  processorId: "test.proc",
  runId: "run-1" as RunId,
  proposalId: "prop_1_aaaaaa",
  declared: [] as ReadonlyArray<Capability>,
  granted: [] as ReadonlyArray<Capability>,
  sinks: noopSinks(),
  candidate: commitOid(
    "0000000000000000000000000000000000000001",
  ),
};

test("phase compatibility table covers every effect kind and phase", () => {
  expect(Object.keys(EFFECT_PHASE_COMPATIBILITY).sort()).toEqual([
    "diagnostic",
    "external",
    "fact",
    "outbox-recovery",
    "patch",
    "quarantine-recovery",
    "question",
    "run-recovery",
    "search-document",
    "view",
  ]);
  for (const row of Object.values(EFFECT_PHASE_COMPATIBILITY)) {
    expect(Object.keys(row).sort()).toEqual(["adoption", "garden", "view"]);
  }
  expect(EFFECT_PHASE_COMPATIBILITY.patch).toEqual({
    adoption: true,
    garden: true,
    view: false,
  });
  expect(EFFECT_PHASE_COMPATIBILITY.view).toEqual({
    adoption: false,
    garden: false,
    view: true,
  });
});

describe("garden-phase PatchEffect routing", () => {
  // Migrated from the deleted garden-patch-router; garden patches now cross the
  // sole applier. An authorized auto patch is queued for sub-Proposal spawn by
  // the orchestrator (queued-for-spawn); denied/downgraded/propose patches are
  // surfaced and dropped without writing through the patch sink.
  const gardenRef = sourceRef({ commit: commitOid("abc"), path: "wiki/x.md" });
  const autoCap: Capability = { kind: "patch.auto", paths: ["wiki/**"] };
  const proposeCap: Capability = { kind: "patch.propose", paths: ["wiki/**"] };
  const autoPatch = patchEffect({
    mode: "auto",
    changes: [{ kind: "write", path: "wiki/x.md", content: "x\n" }],
    reason: "test auto patch",
    sourceRefs: [gardenRef],
  });
  const proposePatch = patchEffect({
    mode: "propose",
    changes: [{ kind: "write", path: "wiki/x.md", content: "x\n" }],
    reason: "test propose patch",
    sourceRefs: [gardenRef],
  });

  test("authorized auto patch is queued for sub-Proposal spawn", async () => {
    const r = await applyEffect({
      ...baseOpts,
      phase: "garden",
      declared: [autoCap, read],
      granted: [autoCap, read],
      effect: autoPatch,
    });
    expect(r.outcome).toBe("queued-for-spawn");
    expect(r.appliedEffect).toBe(autoPatch);
    expect(r.diagnostics).toEqual([]);
    expect(r.capabilityUse).toEqual({
      capability: "patch.auto",
      resource: "wiki/x.md",
      outcome: "allowed",
    });
  });

  test("denied patch is dropped and surfaced as a rejected diagnostic", async () => {
    const recorded: string[] = [];
    const r = await applyEffect({
      ...baseOpts,
      phase: "garden",
      declared: [],
      granted: [],
      effect: autoPatch,
      sinks: {
        ...noopSinks(),
        recordDiagnostic: async ({ effect }) => {
          recorded.push(effect.code);
        },
      },
    });
    expect(r.outcome).toBe("denied");
    expect(r.appliedEffect).toBeNull();
    expect(r.diagnostics[0]?.code).toBe("capability-deny-patch");
    expect(r.capabilityUse).toEqual({
      capability: "patch.auto",
      resource: "wiki/x.md",
      outcome: "denied",
    });
    expect(recorded).toEqual(["capability-deny-patch"]);
  });

  test("downgraded patch is dropped and surfaced as a diagnostic", async () => {
    const recorded: string[] = [];
    const r = await applyEffect({
      ...baseOpts,
      phase: "garden",
      declared: [proposeCap, read],
      granted: [proposeCap, read],
      effect: autoPatch,
      sinks: {
        ...noopSinks(),
        recordDiagnostic: async ({ effect }) => {
          recorded.push(effect.code);
        },
      },
    });
    expect(r.outcome).toBe("downgraded");
    expect(r.appliedEffect).toBeNull();
    expect(r.diagnostics[0]?.code).toBe("capability-downgrade-surprise");
    expect(r.capabilityUse).toEqual({
      capability: "patch.auto",
      resource: "wiki/x.md",
      outcome: "downgraded",
    });
    expect(recorded).toEqual(["capability-downgrade-surprise"]);
  });

  test("authorized propose patch is dropped until the review surface exists", async () => {
    const recorded: string[] = [];
    const r = await applyEffect({
      ...baseOpts,
      phase: "garden",
      declared: [proposeCap, read],
      granted: [proposeCap, read],
      effect: proposePatch,
      sinks: {
        ...noopSinks(),
        recordDiagnostic: async ({ effect }) => {
          recorded.push(effect.code);
        },
      },
    });
    expect(r.outcome).toBe("blocked-for-review");
    expect(r.appliedEffect).toBeNull();
    expect(r.diagnostics[0]?.code).toBe(
      "garden.patch-propose-review-unavailable",
    );
    expect(r.diagnostics[0]?.severity).toBe("info");
    expect(r.capabilityUse).toEqual({
      capability: "patch.propose",
      resource: "wiki/x.md",
      outcome: "allowed",
    });
    expect(recorded).toEqual(["garden.patch-propose-review-unavailable"]);
  });
});

describe("garden propose patches queue for review (enqueueProposal sink)", () => {
  // product-review-4 Task 3: when the engine wires an `enqueueProposal` sink,
  // garden-phase propose-mode patches (plain, or an auto->propose downgrade
  // rewrite) land in proposals.db instead of being surfaced and dropped.
  const gardenRef = sourceRef({ commit: commitOid("abc"), path: "wiki/x.md" });
  const proposeCap: Capability = { kind: "patch.propose", paths: ["wiki/**"] };
  const autoPatch = patchEffect({
    mode: "auto",
    changes: [{ kind: "write", path: "wiki/x.md", content: "x\n" }],
    reason: "test auto patch",
    sourceRefs: [gardenRef],
  });
  const proposePatch = patchEffect({
    mode: "propose",
    changes: [{ kind: "write", path: "wiki/x.md", content: "x\n" }],
    reason: "test propose patch",
    sourceRefs: [gardenRef],
  });

  test("(a) authorized propose patch with sink queues for review and calls the sink", async () => {
    const recorded: string[] = [];
    const enqueueCalls: Array<
      Parameters<NonNullable<ApplyEffectSinks["enqueueProposal"]>>[0]
    > = [];
    const r = await applyEffect({
      ...baseOpts,
      phase: "garden",
      extensionId: "dome.example",
      declared: [proposeCap, read],
      granted: [proposeCap, read],
      effect: proposePatch,
      sinks: {
        ...noopSinks(),
        recordDiagnostic: async ({ effect }) => {
          recorded.push(effect.code);
        },
        enqueueProposal: async (input) => {
          enqueueCalls.push(input);
          return { inserted: true, id: 7 };
        },
      },
    });
    expect(r.outcome).toBe("queued-for-review");
    expect(r.appliedEffect).toBe(proposePatch);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]?.code).toBe("garden.patch-proposed");
    expect(r.diagnostics[0]?.severity).toBe("info");
    expect(r.diagnostics[0]?.message).toContain("P7");
    expect(r.capabilityUse).toEqual({
      capability: "patch.propose",
      resource: "wiki/x.md",
      outcome: "allowed",
    });
    expect(recorded).toEqual(["garden.patch-proposed"]);
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]?.effect).toBe(proposePatch);
    expect(enqueueCalls[0]?.processorId).toBe("test.proc");
    expect(enqueueCalls[0]?.extensionId).toBe("dome.example");
    expect(enqueueCalls[0]?.runId).toBe(baseOpts.runId);
    expect(enqueueCalls[0]?.baseCommit).toBe(baseOpts.candidate);
  });

  test("(b) authorized propose patch without sink still drops (legacy behavior unchanged)", async () => {
    // Same case as the pre-Task-3 "authorized propose patch is dropped until
    // the review surface exists" test above — re-asserted here to pin that
    // omitting `enqueueProposal` (noopSinks()) preserves the legacy outcome.
    const r = await applyEffect({
      ...baseOpts,
      phase: "garden",
      declared: [proposeCap, read],
      granted: [proposeCap, read],
      effect: proposePatch,
      sinks: noopSinks(),
    });
    expect(r.outcome).toBe("blocked-for-review");
    expect(r.diagnostics[0]?.code).toBe(
      "garden.patch-propose-review-unavailable",
    );
  });

  test("(c) auto patch downgraded to propose, with sink, queues for review and preserves the downgrade warning", async () => {
    const recorded: string[] = [];
    const enqueueCalls: Array<
      Parameters<NonNullable<ApplyEffectSinks["enqueueProposal"]>>[0]
    > = [];
    const r = await applyEffect({
      ...baseOpts,
      phase: "garden",
      extensionId: "dome.example",
      declared: [proposeCap, read],
      granted: [proposeCap, read],
      effect: autoPatch,
      sinks: {
        ...noopSinks(),
        recordDiagnostic: async ({ effect }) => {
          recorded.push(effect.code);
        },
        enqueueProposal: async (input) => {
          enqueueCalls.push(input);
          return { inserted: true, id: 3 };
        },
      },
    });
    expect(r.outcome).toBe("queued-for-review");
    expect(r.appliedEffect).not.toBeNull();
    expect(r.appliedEffect?.kind).toBe("patch");
    if (r.appliedEffect?.kind === "patch") {
      expect(r.appliedEffect.mode).toBe("propose");
    }
    expect(r.diagnostics).toHaveLength(2);
    expect(r.diagnostics[0]?.code).toBe("capability-downgrade-surprise");
    expect(r.diagnostics[1]?.code).toBe("garden.patch-proposed");
    expect(r.diagnostics[1]?.message).toContain("P3");
    expect(r.capabilityUse).toEqual({
      capability: "patch.auto",
      resource: "wiki/x.md",
      outcome: "downgraded",
    });
    expect(recorded).toEqual([
      "capability-downgrade-surprise",
      "garden.patch-proposed",
    ]);
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]?.processorId).toBe("test.proc");
    expect(enqueueCalls[0]?.extensionId).toBe("dome.example");
    expect(enqueueCalls[0]?.baseCommit).toBe(baseOpts.candidate);
    // The auto-mode capability was authorized only after being rewritten to a
    // propose-mode shape — the enqueued effect must reflect that rewrite, not
    // the processor's original auto-mode emission.
    expect(enqueueCalls[0]?.effect.mode).toBe("propose");
  });

  test("(d) auto patch downgraded to propose, without sink, is unchanged (legacy behavior)", async () => {
    const recorded: string[] = [];
    const r = await applyEffect({
      ...baseOpts,
      phase: "garden",
      declared: [proposeCap, read],
      granted: [proposeCap, read],
      effect: autoPatch,
      sinks: {
        ...noopSinks(),
        recordDiagnostic: async ({ effect }) => {
          recorded.push(effect.code);
        },
      },
    });
    expect(r.outcome).toBe("downgraded");
    expect(r.appliedEffect).toBeNull();
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]?.code).toBe("capability-downgrade-surprise");
    expect(recorded).toEqual(["capability-downgrade-surprise"]);
  });
});

describe("adoption propose patches unaffected by the garden review sink", () => {
  // (d) from the Task 3 brief: adoption-phase propose patches still block —
  // an enqueueProposal sink has no effect outside the garden phase.
  test("adoption propose patch still blocks even when enqueueProposal is wired", async () => {
    const propose: Capability = { kind: "patch.propose", paths: ["wiki/**"] };
    const r = await applyEffect({
      ...baseOpts,
      phase: "adoption",
      declared: [propose, read],
      granted: [propose, read],
      effect: patchEffect({
        mode: "propose",
        changes: [{ kind: "write", path: "wiki/x.md", content: "x\n" }],
        reason: "adoption propose",
        sourceRefs: [ref],
      }),
      sinks: {
        ...noopSinks(),
        enqueueProposal: async () => ({ inserted: true, id: 1 }),
      },
    });
    expect(r.outcome).toBe("blocked-for-review");
    expect(r.diagnostics[0]?.code).toBe("patch.propose.requires-review");
  });
});

describe("phase-mismatch rejections", () => {
  test("ExternalActionEffect in adoption phase", async () => {
    const r = await applyEffect({
      ...baseOpts,
      phase: "adoption",
      effect: externalActionEffect({
        capability: "calendar.write",
        idempotencyKey: "e-1",
        payload: {},
        sourceRefs: [ref],
      }),
    });
    expect(r.outcome).toBe("rejected-by-phase");
  });

  test("OutboxRecoveryEffect in adoption phase", async () => {
    const r = await applyEffect({
      ...baseOpts,
      phase: "adoption",
      effect: outboxRecoveryEffect({
        action: "retry",
        idempotencyKey: "e-1",
        reason: "recover",
        sourceRefs: [ref],
      }),
    });
    expect(r.outcome).toBe("rejected-by-phase");
  });

  test("QuarantineRecoveryEffect in adoption phase", async () => {
    const r = await applyEffect({
      ...baseOpts,
      phase: "adoption",
      effect: quarantineRecoveryEffect({
        action: "reset",
        phase: "garden",
        processorId: "test.proc",
        processorVersion: "0.1.0",
        triggerHash: "trigger-1",
        quarantineId: "quarantine-1",
        quarantinedAt: "2026-05-29T00:00:00.000Z",
        consecutiveRetryableFailures: 3,
        reason: "recover",
        sourceRefs: [ref],
      }),
    });
    expect(r.outcome).toBe("rejected-by-phase");
  });

  test("RunRecoveryEffect in adoption phase", async () => {
    const r = await applyEffect({
      ...baseOpts,
      phase: "adoption",
      effect: runRecoveryEffect({
        action: "fail",
        runId: "run_1_orphan",
        startedAt: "2026-05-29T00:00:00.000Z",
        processorId: "test.proc",
        processorVersion: "0.1.0",
        phase: "garden",
        reason: "recover",
        sourceRefs: [ref],
      }),
    });
    expect(r.outcome).toBe("rejected-by-phase");
  });

  test("ViewEffect in adoption phase", async () => {
    const r = await applyEffect({
      ...baseOpts,
      phase: "adoption",
      effect: viewEffect({
        name: "v",
        content: { kind: "markdown", body: "ok" },
        scope: [ref],
      }),
    });
    expect(r.outcome).toBe("rejected-by-phase");
  });

  test("ViewEffect in garden phase", async () => {
    const r = await applyEffect({
      ...baseOpts,
      phase: "garden",
      effect: viewEffect({
        name: "v",
        content: { kind: "markdown", body: "ok" },
        scope: [ref],
      }),
    });
    expect(r.outcome).toBe("rejected-by-phase");
  });

  test("PatchEffect in view phase", async () => {
    const r = await applyEffect({
      ...baseOpts,
      phase: "view",
      effect: patchEffect({
        mode: "auto",
        changes: [{ kind: "write", path: "wiki/x.md", content: "x\n" }],
        reason: "x",
        sourceRefs: [ref],
      }),
    });
    expect(r.outcome).toBe("rejected-by-phase");
  });

  test("SearchDocumentEffect in view phase", async () => {
    const r = await applyEffect({
      ...baseOpts,
      phase: "view",
      effect: searchDocumentEffect({
        operation: "upsert",
        path: "wiki/x.md",
        category: "wiki",
        title: "x",
        body: "x",
        sourceRefs: [ref],
      }),
    });
    expect(r.outcome).toBe("rejected-by-phase");
  });

  test("phase-mismatch diagnostics are recorded through the diagnostic sink", async () => {
    const recorded: Array<{
      readonly code: string;
      readonly processorId: string;
      readonly runId: RunId | undefined;
      readonly proposalId: string | null;
    }> = [];
    const r = await applyEffect({
      ...baseOpts,
      sinks: {
        ...noopSinks(),
        recordDiagnostic: async ({
          effect,
          processorId,
          runId,
          proposalId,
        }) => {
          recorded.push({
            code: effect.code,
            processorId,
            runId,
            proposalId,
          });
        },
      },
      phase: "view",
      effect: patchEffect({
        mode: "auto",
        changes: [{ kind: "write", path: "wiki/x.md", content: "x\n" }],
        reason: "x",
        sourceRefs: [ref],
      }),
    });

    expect(r.outcome).toBe("rejected-by-phase");
    expect(recorded).toEqual([
      {
        code: "phase-mismatch",
        processorId: "test.proc",
        runId: "run-1" as RunId,
        proposalId: "prop_1_aaaaaa",
      },
    ]);
  });

  test("DiagnosticEffect (severity: block) in view phase", async () => {
    const r = await applyEffect({
      ...baseOpts,
      phase: "view",
      effect: diagnosticEffect({
        severity: "block",
        code: "x",
        message: "no view block",
        sourceRefs: [],
      }),
    });
    expect(r.outcome).toBe("rejected-by-phase");
  });
});

describe("successful routes (noopSinks)", () => {
  test("PatchEffect in adoption phase with patch.auto granted → applied", async () => {
    const auto: Capability = { kind: "patch.auto", paths: ["wiki/**"] };
    const r = await applyEffect({
      ...baseOpts,
      declared: [read, auto],
      granted: [read, auto],
      phase: "adoption",
      effect: patchEffect({
        mode: "auto",
        changes: [{ kind: "write", path: "wiki/x.md", content: "x\n" }],
        reason: "x",
        sourceRefs: [ref],
      }),
    });
    expect(r.outcome).toBe("applied");
  });

  test("multi-path PatchEffect records every touched path in audit resource", async () => {
    const auto: Capability = { kind: "patch.auto", paths: ["wiki/**"] };
    const r = await applyEffect({
      ...baseOpts,
      declared: [read, auto],
      granted: [read, auto],
      phase: "adoption",
      effect: patchEffect({
        mode: "auto",
        changes: [
          { kind: "write", path: "wiki/a.md", content: "a\n" },
          { kind: "write", path: "wiki/b.md", content: "b\n" },
        ],
        reason: "two files",
        sourceRefs: [ref],
      }),
    });
    expect(r.outcome).toBe("applied");
    expect(r.capabilityUse?.resource).toBe("wiki/a.md,wiki/b.md");
  });

  test("DiagnosticEffect (info) in any phase → applied (no capability needed)", async () => {
    const e = diagnosticEffect({
      severity: "info",
      code: "x",
      message: "y",
      sourceRefs: [],
    });
    for (const phase of ["adoption", "garden", "view"] as const) {
      const r = await applyEffect({ ...baseOpts, phase, effect: e });
      expect(r.outcome).toBe("applied");
    }
  });

  test("ViewEffect in view phase → applied", async () => {
    const r = await applyEffect({
      ...baseOpts,
      declared: [read],
      granted: [read],
      phase: "view",
      effect: viewEffect({
        name: "v",
        content: { kind: "markdown", body: "ok" },
        scope: [ref],
      }),
    });
    expect(r.outcome).toBe("applied");
  });

  test("QuestionEffect in garden phase with question.ask granted → applied", async () => {
    const ask: Capability = { kind: "question.ask" };
    const r = await applyEffect({
      ...baseOpts,
      declared: [read, ask],
      granted: [read, ask],
      phase: "garden",
      effect: questionEffect({
        question: "Continue?",
        sourceRefs: [ref],
        idempotencyKey: "q-1",
      }),
    });
    expect(r.outcome).toBe("applied");
    expect(r.capabilityUse?.capability).toBe("question.ask");
  });

  test("SearchDocumentEffect in adoption phase with search.write granted → applied", async () => {
    const write: Capability = { kind: "search.write", paths: ["wiki/**"] };
    const r = await applyEffect({
      ...baseOpts,
      declared: [read, write],
      granted: [read, write],
      phase: "adoption",
      effect: searchDocumentEffect({
        operation: "upsert",
        path: "wiki/x.md",
        category: "wiki",
        title: "x",
        body: "x",
        sourceRefs: [ref],
      }),
    });
    expect(r.outcome).toBe("applied");
    expect(r.capabilityUse?.capability).toBe("search.write");
    expect(r.capabilityUse?.resource).toBe("wiki/x.md");
  });

  test("OutboxRecoveryEffect in garden phase with outbox.recover granted → applied", async () => {
    const recover: Capability = {
      kind: "outbox.recover",
      actions: ["retry", "abandon"],
    };
    const r = await applyEffect({
      ...baseOpts,
      declared: [recover],
      granted: [recover],
      phase: "garden",
      effect: outboxRecoveryEffect({
        action: "retry",
        idempotencyKey: "e-1",
        reason: "recover",
        sourceRefs: [ref],
      }),
    });
    expect(r.outcome).toBe("applied");
    expect(r.capabilityUse?.capability).toBe("outbox.recover");
    expect(r.capabilityUse?.resource).toBe("retry:e-1");
  });

  test("QuarantineRecoveryEffect in garden phase with quarantine.recover granted → applied", async () => {
    const recover: Capability = {
      kind: "quarantine.recover",
      actions: ["reset"],
    };
    const r = await applyEffect({
      ...baseOpts,
      declared: [recover],
      granted: [recover],
      phase: "garden",
      effect: quarantineRecoveryEffect({
        action: "reset",
        phase: "garden",
        processorId: "test.proc",
        processorVersion: "0.1.0",
        triggerHash: "trigger-1",
        quarantineId: "quarantine-1",
        quarantinedAt: "2026-05-29T00:00:00.000Z",
        consecutiveRetryableFailures: 3,
        reason: "recover",
        sourceRefs: [ref],
      }),
    });
    expect(r.outcome).toBe("applied");
    expect(r.capabilityUse?.capability).toBe("quarantine.recover");
    expect(r.capabilityUse?.resource).toBe(
      "reset:garden:test.proc:0.1.0:trigger-1:quarantine-1:2026-05-29T00:00:00.000Z:3",
    );
  });

  test("RunRecoveryEffect in garden phase with run.recover granted → applied", async () => {
    const recover: Capability = {
      kind: "run.recover",
      actions: ["fail"],
    };
    const r = await applyEffect({
      ...baseOpts,
      declared: [recover],
      granted: [recover],
      phase: "garden",
      effect: runRecoveryEffect({
        action: "fail",
        runId: "run_1_orphan",
        startedAt: "2026-05-29T00:00:00.000Z",
        processorId: "test.proc",
        processorVersion: "0.1.0",
        phase: "garden",
        reason: "recover",
        sourceRefs: [ref],
      }),
    });
    expect(r.outcome).toBe("applied");
    expect(r.capabilityUse?.capability).toBe("run.recover");
    expect(r.capabilityUse?.resource).toBe(
      "fail:run_1_orphan:2026-05-29T00:00:00.000Z:test.proc:0.1.0:garden",
    );
  });
});

describe("capability denial flows through", () => {
  test("PatchEffect (auto) in adoption with no patch grants → denied + broker diagnostic", async () => {
    const r = await applyEffect({
      ...baseOpts,
      phase: "adoption",
      effect: patchEffect({
        mode: "auto",
        changes: [{ kind: "write", path: "wiki/x.md", content: "x\n" }],
        reason: "x",
        sourceRefs: [ref],
      }),
    });
    expect(r.outcome).toBe("denied");
    expect(r.diagnostics[0]?.code).toBe("capability-deny-patch");
    expect(r.diagnostics[0]?.severity).toBe("block");
  });

  test("QuestionEffect with no question.ask grant is denied", async () => {
    const r = await applyEffect({
      ...baseOpts,
      phase: "garden",
      effect: questionEffect({
        question: "Continue?",
        sourceRefs: [ref],
        idempotencyKey: "q-1",
      }),
    });
    expect(r.outcome).toBe("denied");
    expect(r.diagnostics[0]?.code).toBe("capability-deny-question-ask");
    expect(r.capabilityUse?.capability).toBe("question.ask");
    expect(r.capabilityUse?.outcome).toBe("denied");
  });

  test("SearchDocumentEffect with no search.write grant is denied", async () => {
    const r = await applyEffect({
      ...baseOpts,
      phase: "adoption",
      effect: searchDocumentEffect({
        operation: "upsert",
        path: "wiki/x.md",
        category: "wiki",
        title: "x",
        body: "x",
        sourceRefs: [ref],
      }),
    });
    expect(r.outcome).toBe("denied");
    expect(r.diagnostics[0]?.code).toBe("capability-deny-search-write");
    expect(r.capabilityUse?.capability).toBe("search.write");
    expect(r.capabilityUse?.outcome).toBe("denied");
  });

  test("sourceRef read denial records read capability instead of primary capability", async () => {
    const write: Capability = {
      kind: "graph.write",
      namespaces: ["dome.test"],
    };
    const r = await applyEffect({
      ...baseOpts,
      declared: [write],
      granted: [write],
      phase: "adoption",
      effect: factEffect({
        subject: { kind: "page", path: "wiki/x.md" },
        predicate: "dome.test.value",
        object: { kind: "string", value: "x" },
        assertion: "explicit",
        sourceRefs: [ref],
      }),
    });
    expect(r.outcome).toBe("denied");
    expect(r.diagnostics[0]?.code).toBe("capability-deny-source-ref-read");
    expect(r.capabilityUse).toMatchObject({
      capability: "read",
      resource: "wiki/x.md",
      outcome: "denied",
    });
  });

  test("OutboxRecoveryEffect with no outbox.recover grant is denied", async () => {
    const r = await applyEffect({
      ...baseOpts,
      phase: "garden",
      effect: outboxRecoveryEffect({
        action: "abandon",
        idempotencyKey: "e-1",
        reason: "recover",
        sourceRefs: [ref],
      }),
    });
    expect(r.outcome).toBe("denied");
    expect(r.diagnostics[0]?.code).toBe("capability-deny-outbox-recover");
    expect(r.capabilityUse?.capability).toBe("outbox.recover");
    expect(r.capabilityUse?.resource).toBe("abandon:e-1");
  });

  test("QuarantineRecoveryEffect with no quarantine.recover grant is denied", async () => {
    const r = await applyEffect({
      ...baseOpts,
      phase: "garden",
      effect: quarantineRecoveryEffect({
        action: "reset",
        phase: "garden",
        processorId: "test.proc",
        processorVersion: "0.1.0",
        triggerHash: "trigger-1",
        quarantineId: "quarantine-1",
        quarantinedAt: "2026-05-29T00:00:00.000Z",
        consecutiveRetryableFailures: 3,
        reason: "recover",
        sourceRefs: [ref],
      }),
    });
    expect(r.outcome).toBe("denied");
    expect(r.diagnostics[0]?.code).toBe("capability-deny-quarantine-recover");
    expect(r.capabilityUse?.capability).toBe("quarantine.recover");
    expect(r.capabilityUse?.resource).toBe(
      "reset:garden:test.proc:0.1.0:trigger-1:quarantine-1:2026-05-29T00:00:00.000Z:3",
    );
  });

  test("RunRecoveryEffect with no run.recover grant is denied", async () => {
    const r = await applyEffect({
      ...baseOpts,
      phase: "garden",
      effect: runRecoveryEffect({
        action: "fail",
        runId: "run_1_orphan",
        startedAt: "2026-05-29T00:00:00.000Z",
        processorId: "test.proc",
        processorVersion: "0.1.0",
        phase: "garden",
        reason: "recover",
        sourceRefs: [ref],
      }),
    });
    expect(r.outcome).toBe("denied");
    expect(r.diagnostics[0]?.code).toBe("capability-deny-run-recover");
    expect(r.capabilityUse?.capability).toBe("run.recover");
    expect(r.capabilityUse?.resource).toBe(
      "fail:run_1_orphan:2026-05-29T00:00:00.000Z:test.proc:0.1.0:garden",
    );
  });
});

describe("stale-or-missing recovery sinks emit warning diagnostics", () => {
  test("quarantine-recovery against a stale/missing quarantine emits quarantine-recovery.stale-or-missing", async () => {
    const recover: Capability = {
      kind: "quarantine.recover",
      actions: ["reset"],
    };
    const r = await applyEffect({
      ...baseOpts,
      declared: [recover],
      granted: [recover],
      phase: "garden",
      effect: quarantineRecoveryEffect({
        action: "reset",
        phase: "garden",
        processorId: "test.proc",
        processorVersion: "0.1.0",
        triggerHash: "trigger-1",
        quarantineId: "quarantine-1",
        quarantinedAt: "2026-05-29T00:00:00.000Z",
        consecutiveRetryableFailures: 3,
        reason: "recover",
        sourceRefs: [ref],
      }),
      sinks: {
        ...noopSinks(),
        recoverQuarantine: async () => false,
      },
    });
    expect(r.outcome).toBe("applied");
    expect(r.diagnostics.length).toBe(1);
    expect(r.diagnostics[0]?.code).toBe("quarantine-recovery.stale-or-missing");
    expect(r.diagnostics[0]?.severity).toBe("warning");
    expect(r.diagnostics[0]?.message).toContain("quarantine-1");
  });

  test("outbox-recovery against a stale/missing outbox entry emits outbox-recovery.stale-or-missing", async () => {
    const recover: Capability = {
      kind: "outbox.recover",
      actions: ["retry", "abandon"],
    };
    const r = await applyEffect({
      ...baseOpts,
      declared: [recover],
      granted: [recover],
      phase: "garden",
      effect: outboxRecoveryEffect({
        action: "retry",
        idempotencyKey: "e-stale-1",
        reason: "recover",
        sourceRefs: [ref],
      }),
      sinks: {
        ...noopSinks(),
        recoverOutbox: async () => false,
      },
    });
    expect(r.outcome).toBe("applied");
    expect(r.diagnostics.length).toBe(1);
    expect(r.diagnostics[0]?.code).toBe("outbox-recovery.stale-or-missing");
    expect(r.diagnostics[0]?.severity).toBe("warning");
    expect(r.diagnostics[0]?.message).toContain("e-stale-1");
  });

  test("run-recovery against a stale/missing run emits run-recovery.stale-or-missing", async () => {
    const recover: Capability = {
      kind: "run.recover",
      actions: ["fail"],
    };
    const r = await applyEffect({
      ...baseOpts,
      declared: [recover],
      granted: [recover],
      phase: "garden",
      effect: runRecoveryEffect({
        action: "fail",
        runId: "run_stale_1",
        startedAt: "2026-05-29T00:00:00.000Z",
        processorId: "test.proc",
        processorVersion: "0.1.0",
        phase: "garden",
        reason: "recover",
        sourceRefs: [ref],
      }),
      sinks: {
        ...noopSinks(),
        recoverRun: async () => false,
      },
    });
    expect(r.outcome).toBe("applied");
    expect(r.diagnostics.length).toBe(1);
    expect(r.diagnostics[0]?.code).toBe("run-recovery.stale-or-missing");
    expect(r.diagnostics[0]?.severity).toBe("warning");
    expect(r.diagnostics[0]?.message).toContain("run_stale_1");
  });
});

describe("adoption propose patches block for review", () => {
  test("PatchEffect mode propose in adoption returns blocked-for-review", async () => {
    const propose: Capability = { kind: "patch.propose", paths: ["wiki/**"] };
    const r = await applyEffect({
      ...baseOpts,
      declared: [read, propose],
      granted: [read, propose],
      phase: "adoption",
      effect: patchEffect({
        mode: "propose",
        changes: [{ kind: "write", path: "wiki/x.md", content: "x\n" }],
        reason: "needs review",
        sourceRefs: [ref],
      }),
    });

    expect(r.outcome).toBe("blocked-for-review");
    expect(r.appliedEffect).toBeNull();
    expect(r.diagnostics[0]?.severity).toBe("block");
    expect(r.diagnostics[0]?.code).toBe("patch.propose.requires-review");
    expect(r.capabilityUse?.capability).toBe("patch.propose");
    expect(r.capabilityUse?.outcome).toBe("allowed");
  });

  test("auto downgraded to propose blocks for review", async () => {
    const propose: Capability = { kind: "patch.propose", paths: ["wiki/**"] };
    const r = await applyEffect({
      ...baseOpts,
      declared: [read, propose],
      granted: [read, propose],
      phase: "adoption",
      effect: patchEffect({
        mode: "auto",
        changes: [{ kind: "write", path: "wiki/x.md", content: "x\n" }],
        reason: "needs auto",
        sourceRefs: [ref],
      }),
    });

    expect(r.outcome).toBe("blocked-for-review");
    expect(r.appliedEffect).toBeNull();
    expect(r.diagnostics.map((d) => d.code)).toEqual([
      "capability-downgrade-surprise",
      "patch.propose.requires-review",
    ]);
    expect(r.capabilityUse?.capability).toBe("patch.auto");
    expect(r.capabilityUse?.outcome).toBe("downgraded");
  });
});

// Per docs/wiki/specs/effects.md §DiagnosticEffect: "In the garden phase,
// `block` is treated as `error` — garden processors cannot block adoption
// because they run after it." The demotion must happen at the applier
// chokepoint so the persisted projection row matches the matrix; a raw
// `block` row from a garden run would surface as an adoption blocker that
// no sync can ever clear.
describe("garden-phase block-severity demotion", () => {
  const blockDiagnostic = () =>
    diagnosticEffect({
      severity: "block",
      code: "test.garden-blocker",
      message: "garden processor emitted block",
      sourceRefs: [ref],
    });

  test("garden block diagnostic routes as error", async () => {
    const recorded: Array<{ severity: string; code: string }> = [];
    const sinks = {
      ...noopSinks(),
      recordDiagnostic: async (input: {
        effect: { severity: string; code: string };
      }) => {
        recorded.push({
          severity: input.effect.severity,
          code: input.effect.code,
        });
      },
    };

    const r = await applyEffect({
      ...baseOpts,
      sinks,
      declared: [read],
      granted: [read],
      phase: "garden",
      effect: blockDiagnostic(),
    });

    expect(r.outcome).toBe("applied");
    expect(
      r.appliedEffect?.kind === "diagnostic"
        ? r.appliedEffect.severity
        : null,
    ).toBe("error");
    // Code, message, and evidence survive the rewrite.
    expect(
      r.appliedEffect?.kind === "diagnostic" ? r.appliedEffect.code : null,
    ).toBe("test.garden-blocker");
    expect(
      r.appliedEffect?.kind === "diagnostic"
        ? r.appliedEffect.sourceRefs
        : [],
    ).toHaveLength(1);
    // The persisted row (what the sink saw) is the demoted severity.
    expect(recorded).toEqual([
      { severity: "error", code: "test.garden-blocker" },
    ]);
  });

  test("adoption block diagnostic keeps block severity", async () => {
    const r = await applyEffect({
      ...baseOpts,
      declared: [read],
      granted: [read],
      phase: "adoption",
      effect: blockDiagnostic(),
    });

    expect(r.outcome).toBe("applied");
    expect(
      r.appliedEffect?.kind === "diagnostic"
        ? r.appliedEffect.severity
        : null,
    ).toBe("block");
  });

  test("garden error/warning diagnostics pass through unchanged", async () => {
    const r = await applyEffect({
      ...baseOpts,
      phase: "garden",
      effect: diagnosticEffect({
        severity: "warning",
        code: "test.warn",
        message: "w",
        sourceRefs: [],
      }),
    });
    expect(
      r.appliedEffect?.kind === "diagnostic"
        ? r.appliedEffect.severity
        : null,
    ).toBe("warning");
  });
});
