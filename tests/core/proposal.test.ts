// Smoke tests for src/core/proposal.ts: id shape + entropy, the
// `makeManualProposal` daemon helper, ProposalSchema round-trip /
// rejection, and the metadata helper freeze + optional-key cleanliness.
//
// Phase 11a collapsed the 5-way `ProposalSource` (client/agent/garden/
// manual/import) to the 2-way internal union (manual + garden). The five
// public source-constructors are gone — Proposals are internal types
// constructed by the daemon. The remaining surface this file exercises:
// the `makeManualProposal` helper + the Zod schemas + the metadata helper.

import { describe, test, expect } from "bun:test";
import {
  ProposalSchema,
  makeManualProposal,
  makeProposalId,
  proposalMetadata,
} from "../../src/core/proposal";
import { commitOid } from "../../src/core/source-ref";

const base = commitOid("base123");
const head = commitOid("head456");

describe("makeProposalId", () => {
  test("returns the prop_<unix-ms>_<6-hex> shape", () => {
    const id = makeProposalId();
    expect(id).toMatch(/^prop_\d+_[0-9a-f]{6}$/);
  });

  test("returns distinct ids on consecutive calls (random suffix entropy)", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i += 1) ids.add(makeProposalId());
    // 6 hex chars of entropy makes collisions in 20 draws astronomically
    // unlikely; assert all distinct.
    expect(ids.size).toBe(20);
  });
});

describe("makeManualProposal", () => {
  test("stamps source.kind = 'manual' with the supplied branch", () => {
    const p = makeManualProposal({
      id: "prop_1_aaaaaa",
      base,
      head,
      branch: "main",
    });
    expect(p.source.kind).toBe("manual");
    if (p.source.kind !== "manual") throw new Error("expected manual source");
    expect(p.source.branch).toBe("main");
  });

  test("freezes the returned proposal (mutation throws in strict mode)", () => {
    const p = makeManualProposal({
      id: "prop_1_aaaaaa",
      base,
      head,
      branch: "main",
    });
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.source)).toBe(true);
  });

  test("defaults id to a fresh makeProposalId() when omitted", () => {
    const p = makeManualProposal({ base, head, branch: "main" });
    expect(p.id).toMatch(/^prop_\d+_[0-9a-f]{6}$/);
  });

  test("only sets metadata when defined (no `metadata: undefined` key)", () => {
    const p = makeManualProposal({
      id: "prop_1_aaaaaa",
      base,
      head,
      branch: "main",
    });
    expect("metadata" in p).toBe(false);

    const pWithMeta = makeManualProposal({
      id: "prop_1_aaaaaa",
      base,
      head,
      branch: "main",
      metadata: proposalMetadata({ title: "x" }),
    });
    expect(pWithMeta.metadata?.title).toBe("x");
  });
});

describe("ProposalSchema round-trip and rejection", () => {
  test("parses a constructed manual proposal", () => {
    const p = makeManualProposal({
      id: "prop_1_aaaaaa",
      base,
      head,
      branch: "main",
    });
    const parsed = ProposalSchema.parse(p);
    expect(parsed.id).toBe("prop_1_aaaaaa");
  });

  test("parses a garden-source proposal shape", () => {
    const parsed = ProposalSchema.parse({
      id: "prop_1_aaaaaa",
      base: "base",
      head: "head",
      source: { kind: "garden", processorId: "dome.markdown", runId: "run-1" },
    });
    expect(parsed.source.kind).toBe("garden");
  });

  test("rejects the retired `client` source kind", () => {
    expect(() =>
      ProposalSchema.parse({
        id: "prop_1_aaaaaa",
        base: "base",
        head: "head",
        source: { kind: "client", clientId: "mobile" },
      }),
    ).toThrow();
  });

  test("rejects empty `base`", () => {
    expect(() =>
      ProposalSchema.parse({
        id: "prop_1_aaaaaa",
        base: "",
        head: "head",
        source: { kind: "manual", branch: "main" },
      }),
    ).toThrow();
  });

  test("rejects empty `head`", () => {
    expect(() =>
      ProposalSchema.parse({
        id: "prop_1_aaaaaa",
        base: "base",
        head: "",
        source: { kind: "manual", branch: "main" },
      }),
    ).toThrow();
  });
});

describe("proposalMetadata", () => {
  test("returns a frozen object", () => {
    const m = proposalMetadata({ title: "x" });
    expect(Object.isFrozen(m)).toBe(true);
  });

  test("only sets defined optional fields (no `key: undefined`)", () => {
    const m = proposalMetadata({ title: "x" });
    expect("title" in m).toBe(true);
    expect("authoredAt" in m).toBe(false);
    expect("reason" in m).toBe(false);
  });
});
