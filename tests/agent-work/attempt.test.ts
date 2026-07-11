import { describe, expect, test } from "bun:test";

import { attemptAgentWork, drainAgentWork, type AgentWorkPort } from "../../src/agent-work/attempt";
import { compileAgentWork, type CompleteAgentWorkInput } from "../../src/agent-work/agent-work";
import { commitOid, sourceRef } from "../../src/core/source-ref";

function fixturePort(): { port: AgentWorkPort; completions: CompleteAgentWorkInput[] } {
  const completions: CompleteAgentWorkInput[] = [];
  let open = true;
  const source = sourceRef({ path: "wiki/evidence.md", commit: commitOid("c1") });
  const compile = (questionId?: number) => compileAgentWork({
    questions: open
      ? [{
          id: 7,
          question: "Track this follow-up?",
          options: ["track", "ignore"],
          sourceRefs: [source],
          metadata: {
            resolutionMode: "dispatch",
            automationPolicy: "agent-safe",
            risk: "low",
          },
          processorId: "dome.test",
          runId: "run-7",
          adoptedCommit: "adopted-1",
          askedAt: "2026-07-09T00:00:00.000Z",
        }]
      : [],
    now: new Date("2026-07-09T12:00:00.000Z"),
    ...(questionId !== undefined ? { questionId } : {}),
  });
  return {
    completions,
    port: {
      agentWork: async (opts) => compile(opts?.questionId),
      completeAgentWork: async (input) => {
        completions.push(input);
        open = false;
        return { kind: "completed" };
      },
    },
  };
}

describe("agent-work attempt loop", () => {
  test("passes one immutable packet to an agent and completes through the port", async () => {
    const { port, completions } = fixturePort();
    const result = await attemptAgentWork(port, 7, async (item) => ({
      kind: "answer",
      answer: "track",
      reason: "The source is phrased as an explicit commitment.",
      evidence: item.sourceRefs,
    }));

    expect(result.kind).toBe("completed");
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ questionId: 7, answer: "track" });
  });

  test("a bounded drain leaves no separate job state", async () => {
    const { port } = fixturePort();
    const result = await drainAgentWork(port, async (item) => ({
      kind: "answer",
      answer: "track",
      reason: "Grounded.",
      evidence: item.sourceRefs,
    }));
    expect(result.attempted).toBe(1);
    expect(result.remaining.counts.total).toBe(0);
  });
});
