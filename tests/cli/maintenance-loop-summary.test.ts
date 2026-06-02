import { describe, expect, test } from "bun:test";

import { collectMaintenanceLoopSummaries } from "../../src/cli/maintenance-loop-summary";
import { diagnosticEffect, questionEffect } from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import type { MaintenanceLoop } from "../../src/extensions/maintenance-loops";
import type { QuestionRecord } from "../../src/projections/questions";

const REF = sourceRef({
  commit: commitOid("abc123"),
  path: "wiki/test.md",
  range: { startLine: 1, endLine: 1 },
});

const LOOP: MaintenanceLoop = {
  id: "test.loop",
  goal: "Keep test work visible.",
  evidence: [{ kind: "operational", name: "diagnostics" }],
  processors: ["test.disabled-processor"],
  surfaces: [{ kind: "status", name: "status" }],
  settlement: {
    key: "test key",
    noOpWhen: "test work is represented",
  },
  risks: [],
};

describe("collectMaintenanceLoopSummaries", () => {
  test("does not mark loops partial when only optional contributors are inactive", () => {
    const loop: MaintenanceLoop = {
      ...LOOP,
      processors: ["test.required"],
      optionalProcessors: ["test.optional"],
    };

    const [summary] = collectMaintenanceLoopSummaries({
      loops: [loop],
      activeProcessorIds: new Set(["test.required"]),
      diagnosticsByProcessor: () => [],
      unresolvedQuestions: [],
      runsByProcessor: () => [],
    });

    expect(summary).toEqual(expect.objectContaining({
      state: "quiet",
      processor_ids: ["test.required", "test.optional"],
      required_processor_ids: ["test.required"],
      optional_processor_ids: ["test.optional"],
      active_processors: ["test.required"],
      missing_processors: [],
      inactive_optional_processors: ["test.optional"],
    }));
  });

  test("keeps unresolved work attributable when a loop processor is inactive", () => {
    const ownerQuestion: QuestionRecord = {
      id: 1,
      effect: questionEffect({
        question: "What should happen?",
        sourceRefs: [REF],
        idempotencyKey: "test-question",
      }),
      processorId: "test.disabled-processor",
      adoptedCommit: commitOid("abc123"),
      askedAt: "2026-06-01T00:00:00.000Z",
      answeredAt: null,
      answer: null,
    };
    const agentQuestion: QuestionRecord = {
      ...ownerQuestion,
      id: 2,
      effect: questionEffect({
        question: "Can the agent handle this?",
        sourceRefs: [REF],
        idempotencyKey: "test-question-agent",
        metadata: {
          risk: "low",
          confidence: 0.8,
          recommendedAnswer: "yes",
          automationPolicy: "agent-safe",
        },
      }),
    };
    const modelQuestion: QuestionRecord = {
      ...ownerQuestion,
      id: 3,
      effect: questionEffect({
        question: "Can the model handle this?",
        sourceRefs: [REF],
        idempotencyKey: "test-question-model",
        metadata: {
          risk: "low",
          confidence: 0.9,
          recommendedAnswer: "yes",
          automationPolicy: "model-safe",
        },
      }),
    };

    const [summary] = collectMaintenanceLoopSummaries({
      loops: [LOOP],
      activeProcessorIds: new Set(),
      diagnosticsByProcessor: (processorId) =>
        processorId === "test.disabled-processor"
          ? [
              diagnosticEffect({
                severity: "warning",
                code: "test.warning",
                message: "Needs attention",
                sourceRefs: [REF],
              }),
            ]
          : [],
      unresolvedQuestions: [ownerQuestion, agentQuestion, modelQuestion],
      runsByProcessor: () => [],
    });

    expect(summary).toBeDefined();
    expect(summary?.state).toBe("attention");
    expect(summary?.active_processors).toEqual([]);
    expect(summary?.missing_processors).toEqual(["test.disabled-processor"]);
    expect(summary?.diagnostics).toBe(1);
    expect(summary?.attention_diagnostics).toBe(1);
    expect(summary?.drift_diagnostics).toBe(0);
    expect(summary?.questions).toBe(3);
    expect(summary?.agent_safe_questions).toBe(1);
    expect(summary?.model_safe_questions).toBe(1);
    expect(summary?.owner_needed_questions).toBe(1);
  });

  test("reports info-only diagnostics as drift instead of quiet attention", () => {
    const loop: MaintenanceLoop = {
      ...LOOP,
      processors: ["test.active-processor"],
    };

    const [summary] = collectMaintenanceLoopSummaries({
      loops: [loop],
      activeProcessorIds: new Set(["test.active-processor"]),
      diagnosticsByProcessor: (processorId) =>
        processorId === "test.active-processor"
          ? [
              diagnosticEffect({
                severity: "info",
                code: "test.info",
                message: "Visible maintenance drift",
                sourceRefs: [REF],
              }),
            ]
          : [],
      unresolvedQuestions: [],
      runsByProcessor: () => [],
    });

    expect(summary?.state).toBe("drift");
    expect(summary?.diagnostics).toBe(1);
    expect(summary?.attention_diagnostics).toBe(0);
    expect(summary?.drift_diagnostics).toBe(1);
  });
});
