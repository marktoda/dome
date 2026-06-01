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
  test("keeps unresolved work attributable when a loop processor is inactive", () => {
    const question: QuestionRecord = {
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
      unresolvedQuestions: [question],
      runsByProcessor: () => [],
    });

    expect(summary).toBeDefined();
    expect(summary?.state).toBe("attention");
    expect(summary?.active_processors).toEqual([]);
    expect(summary?.missing_processors).toEqual(["test.disabled-processor"]);
    expect(summary?.diagnostics).toBe(1);
    expect(summary?.attention_diagnostics).toBe(1);
    expect(summary?.questions).toBe(1);
  });
});
