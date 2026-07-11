import { describe, expect, test } from "bun:test";

import {
  compileAttention,
  type AttentionProposalInput,
  type AttentionQuestionInput,
} from "../../src/attention/attention";
import { commitOid, sourceRef } from "../../src/core/source-ref";

const ref = sourceRef({
  commit: commitOid("a".repeat(40)),
  path: "wiki/example.md",
});

function question(
  id: number,
  overrides: Partial<AttentionQuestionInput> = {},
): AttentionQuestionInput {
  return {
    id,
    question: `Question ${id}?`,
    options: ["yes", "no"],
    sourceRefs: [ref],
    processorId: "example.questions",
    askedAt: "2026-07-08T12:00:00.000Z",
    metadata: { automationPolicy: "owner-needed" },
    ...overrides,
  };
}

function proposal(
  id: number,
  overrides: Partial<AttentionProposalInput> = {},
): AttentionProposalInput {
  return {
    id,
    processorId: "example.proposals",
    reason: `Proposal ${id}`,
    paths: ["wiki/example.md"],
    sourceRefs: [ref],
    createdAt: "2026-07-08T10:00:00.000Z",
    ...overrides,
  };
}

describe("compileAttention", () => {
  test("ranks owner decisions and reviews in one bounded queue", () => {
    const snapshot = compileAttention({
      now: new Date("2026-07-09T12:00:00.000Z"),
      questions: [
        question(1),
        question(2, {
          metadata: {
            automationPolicy: "owner-needed",
            confidence: 0.9,
            attention: {
              consequence: "high",
              urgency: "now",
              reason: "blocks an external commitment",
            },
          },
        }),
      ],
      proposals: [proposal(3)],
      primaryLimit: 2,
    });

    expect(snapshot.primary.map((item) => item.id)).toEqual([
      "decision:2",
      "proposal:3",
    ]);
    expect(snapshot.backlog.map((item) => item.id)).toEqual(["decision:1"]);
    expect(snapshot.counts).toEqual({
      owner: 3,
      decisions: 2,
      reviews: 1,
      primary: 2,
      backlog: 1,
    });
  });

  test("keeps agent work out of the owner budget", () => {
    const snapshot = compileAttention({
      now: new Date("2026-07-09T12:00:00.000Z"),
      questions: [
        question(1, { metadata: { automationPolicy: "agent-safe" } }),
        question(2, { metadata: { automationPolicy: "model-safe" } }),
      ],
      proposals: [],
    });

    expect(snapshot.primary).toEqual([]);
    expect(snapshot.backlog).toEqual([]);
    expect(snapshot.agentWorkCount).toBe(2);
  });

  test("moves aging ordinary requests and stale proposals out of primary", () => {
    const snapshot = compileAttention({
      now: new Date("2026-07-09T12:00:00.000Z"),
      questions: [
        question(1, { askedAt: "2026-06-01T00:00:00.000Z" }),
        question(2, {
          askedAt: "2026-06-01T00:00:00.000Z",
          metadata: {
            automationPolicy: "owner-needed",
            attention: { consequence: "high", urgency: "none" },
          },
        }),
      ],
      proposals: [proposal(3, { stale: true })],
    });

    expect(snapshot.primary.map((item) => item.id)).toEqual(["decision:2"]);
    expect(snapshot.backlog.map((item) => item.id).sort()).toEqual([
      "decision:1",
      "proposal:3",
    ]);
  });
});
