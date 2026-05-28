// Smoke tests for src/engine/apply-effect.ts: phase-compatibility rejections,
// successful routes, and capability-denial flow per
// docs/wiki/matrices/effect-router-targets.md.

import { describe, test, expect } from "bun:test";
import { applyEffect, noopSinks } from "../../src/engine/apply-effect";
import {
  diagnosticEffect,
  externalActionEffect,
  jobEffect,
  patchEffect,
  viewEffect,
} from "../../src/core/effect";
import type { Capability } from "../../src/core/processor";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import type { RunId } from "../../src/engine/runner-contract";

const ref = sourceRef({ commit: commitOid("abc"), path: "wiki/x.md" });

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

describe("phase-mismatch rejections", () => {
  test("JobEffect in adoption phase", async () => {
    const r = await applyEffect({
      ...baseOpts,
      phase: "adoption",
      effect: jobEffect({
        processorId: "p",
        input: null,
        idempotencyKey: "j-1",
      }),
    });
    expect(r.outcome).toBe("rejected-by-phase");
    expect(r.diagnostics[0]?.code).toBe("phase-mismatch");
  });

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
      declared: [auto],
      granted: [auto],
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
      phase: "view",
      effect: viewEffect({
        name: "v",
        content: { kind: "markdown", body: "ok" },
        scope: [ref],
      }),
    });
    expect(r.outcome).toBe("applied");
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
  });
});
