// Smoke tests for src/core/proposal.ts: id shape + entropy, per-source
// constructors, optional `sessionId` cleanliness, ProposalSchema round-trip /
// rejection, and the metadata helper freeze + optional-key cleanliness.

import { describe, test, expect } from "bun:test";
import {
  ProposalSchema,
  agentProposal,
  clientProposal,
  gardenProposal,
  importProposal,
  makeProposalId,
  manualProposal,
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

describe("per-source constructors stamp the right source.kind", () => {
  test("clientProposal", () => {
    const p = clientProposal({
      id: "prop_1_aaaaaa",
      base,
      head,
      clientId: "mobile",
    });
    expect(p.source.kind).toBe("client");
  });

  test("agentProposal", () => {
    const p = agentProposal({
      id: "prop_1_aaaaaa",
      base,
      head,
      harness: "claude-code",
    });
    expect(p.source.kind).toBe("agent");
  });

  test("gardenProposal", () => {
    const p = gardenProposal({
      id: "prop_1_aaaaaa",
      base,
      head,
      processorId: "dome.markdown",
      runId: "run-1",
    });
    expect(p.source.kind).toBe("garden");
  });

  test("manualProposal", () => {
    const p = manualProposal({
      id: "prop_1_aaaaaa",
      base,
      head,
      branch: "main",
    });
    expect(p.source.kind).toBe("manual");
  });

  test("importProposal", () => {
    const p = importProposal({
      id: "prop_1_aaaaaa",
      base,
      head,
      importerId: "obsidian-import",
    });
    expect(p.source.kind).toBe("import");
  });
});

describe("agentProposal sessionId optional handling", () => {
  test("absent sessionId produces a valid Proposal without leaking the key", () => {
    const p = agentProposal({
      id: "prop_1_aaaaaa",
      base,
      head,
      harness: "claude-code",
    });
    if (p.source.kind !== "agent") throw new Error("expected agent source");
    expect("sessionId" in p.source).toBe(false);
  });

  test("present sessionId is set on the source", () => {
    const p = agentProposal({
      id: "prop_1_aaaaaa",
      base,
      head,
      harness: "claude-code",
      sessionId: "sess-42",
    });
    if (p.source.kind !== "agent") throw new Error("expected agent source");
    expect(p.source.sessionId).toBe("sess-42");
  });
});

describe("ProposalSchema round-trip and rejection", () => {
  test("parses a constructed proposal", () => {
    const p = clientProposal({
      id: "prop_1_aaaaaa",
      base,
      head,
      clientId: "mobile",
    });
    const parsed = ProposalSchema.parse(p);
    expect(parsed.id).toBe("prop_1_aaaaaa");
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
