import { describe, expect, test } from "bun:test";

import { patchEffect } from "../../src/core/effect";
import type { Capability } from "../../src/core/processor";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { noopSinks } from "../../src/engine/apply-effect";
import { routeGardenPatchForSubProposal } from "../../src/engine/garden-patch-router";
import type { RunId } from "../../src/engine/runner-contract";

const ref = sourceRef({ commit: commitOid("abc"), path: "wiki/x.md" });
const runId = "run-1" as RunId;
const proposalId = "prop_1_router";

const autoPatch = patchEffect({
  mode: "auto",
  changes: [{ kind: "write", path: "wiki/x.md", content: "x\n" }],
  reason: "test auto patch",
  sourceRefs: [ref],
});

const proposePatch = patchEffect({
  mode: "propose",
  changes: [{ kind: "write", path: "wiki/x.md", content: "x\n" }],
  reason: "test propose patch",
  sourceRefs: [ref],
});

const autoCap: Capability = { kind: "patch.auto", paths: ["wiki/**"] };
const proposeCap: Capability = { kind: "patch.propose", paths: ["wiki/**"] };

describe("routeGardenPatchForSubProposal", () => {
  test("denied patches are dropped and surfaced as rejected diagnostics", async () => {
    const recorded: string[] = [];

    const routed = await routeGardenPatchForSubProposal({
      effect: autoPatch,
      processorId: "test.router",
      runId,
      proposalId,
      declared: [],
      granted: [],
      sinks: {
        ...noopSinks(),
        recordDiagnostic: async ({ effect }) => {
          recorded.push(effect.code);
        },
      },
    });

    expect(routed.kind).toBe("dropped");
    expect(routed.rejected).toBe(true);
    expect(routed.diagnostics[0]?.code).toBe("capability-deny-patch");
    expect(routed.capabilityUse).toEqual({
      capability: "patch.auto",
      resource: "wiki/x.md",
      outcome: "denied",
    });
    expect(recorded).toEqual(["capability-deny-patch"]);
  });

  test("downgraded patches are dropped and surfaced as diagnostics", async () => {
    const recorded: string[] = [];

    const routed = await routeGardenPatchForSubProposal({
      effect: autoPatch,
      processorId: "test.router",
      runId,
      proposalId,
      declared: [proposeCap],
      granted: [proposeCap],
      sinks: {
        ...noopSinks(),
        recordDiagnostic: async ({ effect }) => {
          recorded.push(effect.code);
        },
      },
    });

    expect(routed.kind).toBe("dropped");
    expect(routed.rejected).toBe(false);
    expect(routed.diagnostics[0]?.code).toBe("capability-downgrade-surprise");
    expect(routed.capabilityUse).toEqual({
      capability: "patch.auto",
      resource: "wiki/x.md",
      outcome: "downgraded",
    });
    expect(recorded).toEqual(["capability-downgrade-surprise"]);
  });

  test("authorized auto patches are eligible to spawn sub-Proposals", async () => {
    const routed = await routeGardenPatchForSubProposal({
      effect: autoPatch,
      processorId: "test.router",
      runId,
      proposalId,
      declared: [autoCap],
      granted: [autoCap],
      sinks: noopSinks(),
    });

    expect(routed.kind).toBe("spawn");
    if (routed.kind !== "spawn") return;
    expect(routed.patch).toBe(autoPatch);
    expect(routed.diagnostics).toEqual([]);
    expect(routed.capabilityUse).toEqual({
      capability: "patch.auto",
      resource: "wiki/x.md",
      outcome: "allowed",
    });
  });

  test("authorized propose patches are dropped until the review surface exists", async () => {
    const recorded: string[] = [];

    const routed = await routeGardenPatchForSubProposal({
      effect: proposePatch,
      processorId: "test.router",
      runId,
      proposalId,
      declared: [proposeCap],
      granted: [proposeCap],
      sinks: {
        ...noopSinks(),
        recordDiagnostic: async ({ effect }) => {
          recorded.push(effect.code);
        },
      },
    });

    expect(routed.kind).toBe("dropped");
    expect(routed.rejected).toBe(false);
    expect(routed.diagnostics[0]?.code).toBe(
      "garden.patch-propose-review-unavailable",
    );
    expect(routed.capabilityUse).toEqual({
      capability: "patch.propose",
      resource: "wiki/x.md",
      outcome: "allowed",
    });
    expect(recorded).toEqual(["garden.patch-propose-review-unavailable"]);
  });
});
