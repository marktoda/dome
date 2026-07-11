import { describe, expect, test } from "bun:test";

import {
  compileAgentWork,
  validateAgentWorkCompletion,
  type AgentWorkQuestionInput,
} from "../../src/agent-work/agent-work";
import { commitOid, sourceRef } from "../../src/core/source-ref";

const ref = (path: string) => sourceRef({ path, commit: commitOid("c1") });

function question(
  id: number,
  overrides: Partial<AgentWorkQuestionInput> = {},
): AgentWorkQuestionInput {
  return {
    id,
    question: `Question ${id}?`,
    options: ["yes", "no"],
    sourceRefs: [ref(`wiki/${id}.md`)],
    metadata: {
      resolutionMode: "dispatch",
      automationPolicy: "agent-safe",
      risk: "low",
      confidence: 0.8,
    },
    processorId: "dome.test.question",
    runId: `run-${id}`,
    adoptedCommit: "adopted-1",
    askedAt: `2026-07-0${id}T00:00:00.000Z`,
    ...overrides,
  };
}

describe("compileAgentWork", () => {
  test("derives only agent work and normalizes model-safe compatibility rows", () => {
    const snapshot = compileAgentWork({
      questions: [
        question(1),
        question(2, {
          metadata: {
            resolutionMode: "dispatch",
            automationPolicy: "model-safe",
            risk: "medium",
          },
        }),
        question(3, {
          metadata: {
            resolutionMode: "dispatch",
            automationPolicy: "owner-needed",
          },
        }),
      ],
      now: new Date("2026-07-09T12:00:00.000Z"),
    });

    expect(snapshot.schema).toBe("dome.agent-work/v1");
    expect(snapshot.items.map((item) => item.questionId)).toEqual([1, 2]);
    expect(snapshot.items[1]?.policy).toBe("agent-safe");
    expect(snapshot.items[1]?.sourcePolicy).toBe("model-safe");
    expect(snapshot.counts.ready).toBe(2);
  });

  test("keeps unsafe-to-attempt rows visible with explicit reasons", () => {
    const snapshot = compileAgentWork({
      questions: [
        question(1, {
          metadata: {
            resolutionMode: "acknowledge",
            automationPolicy: "agent-safe",
          },
        }),
        question(2, { sourceRefs: [] }),
        question(3, {
          metadata: { automationPolicy: "agent-safe" },
        }),
      ],
      now: new Date("2026-07-09T12:00:00.000Z"),
    });

    expect(snapshot.items.map((item) => item.readiness)).toEqual([
      "needs-action",
      "needs-evidence",
      "needs-contract",
    ]);
    expect(snapshot.counts).toMatchObject({
      total: 3,
      ready: 0,
      needsAction: 1,
      needsEvidence: 1,
      needsContract: 1,
    });
  });
});

describe("validateAgentWorkCompletion", () => {
  test("requires the current revision, an allowed answer, reason, and every source", () => {
    const item = compileAgentWork({
      questions: [question(1, { sourceRefs: [ref("wiki/a.md"), ref("wiki/b.md")] })],
      now: new Date("2026-07-09T12:00:00.000Z"),
    }).items[0]!;

    expect(validateAgentWorkCompletion(item, {
      questionId: 1,
      expectedRevision: "stale",
      answer: "yes",
      reason: "supported",
      evidence: item.sourceRefs,
    })).toMatchObject({ ok: false, problem: "stale-revision" });

    expect(validateAgentWorkCompletion(item, {
      questionId: 1,
      expectedRevision: item.revision,
      answer: "yes",
      reason: "supported",
      evidence: [ref("wiki/a.md")],
    })).toMatchObject({ ok: false, problem: "missing-evidence" });

    expect(validateAgentWorkCompletion(item, {
      questionId: 1,
      expectedRevision: item.revision,
      answer: "yes",
      reason: "Both sources support yes.",
      evidence: item.sourceRefs,
    })).toMatchObject({ ok: true, answer: "yes" });
  });
});
