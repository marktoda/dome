import { describe, expect, test } from "bun:test";

import { formatMaintenanceLoopDetailLines } from "../../src/cli/maintenance-loop-summary";
import { collectMaintenanceLoopSummaries } from "../../src/surface/maintenance-loop-summary";
import { diagnosticEffect, questionEffect } from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import type { MaintenanceLoop } from "../../src/extensions/maintenance-loops";
import { newRunId, type RunRow, type RunStatus } from "../../src/ledger/runs";
import type { QuestionRecord } from "../../src/projections/questions";

// Minimal ASCII caps (unicode: false) so tree connectors are ASCII |-/`-.
const ASCII_CAPS = Object.freeze({
  color: false,
  unicode: false,
  width: 120,
});

const REF = sourceRef({
  commit: commitOid("abc123"),
  path: "wiki/test.md",
  range: { startLine: 1, endLine: 1 },
});

const SETTLEMENT_CHECKS: MaintenanceLoop["settlement"]["checks"] = [
  {
    kind: "required-processors-active",
    name: "required-processors-active",
    description: "Required processors are active.",
  },
  {
    kind: "no-attention-diagnostics",
    name: "no-attention-diagnostics",
    description: "No attention diagnostics remain.",
  },
  {
    kind: "no-drift-diagnostics",
    name: "no-drift-diagnostics",
    description: "No drift diagnostics remain.",
  },
  {
    kind: "no-open-questions",
    name: "no-open-questions",
    description: "No open questions remain.",
  },
  {
    kind: "no-recent-problem-runs",
    name: "no-recent-problem-runs",
    description: "No recent problem runs remain.",
  },
];

const LOOP: MaintenanceLoop = {
  id: "test.loop",
  goal: "Keep test work visible.",
  evidence: [{ kind: "operational", name: "diagnostics" }],
  processors: ["test.disabled-processor"],
  surfaces: [{ kind: "status", name: "status" }],
  settlement: {
    key: "test key",
    noOpWhen: "test work is represented",
    checks: SETTLEMENT_CHECKS,
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
    expect(summary?.settlement).toEqual(expect.objectContaining({
      settled: true,
      failed_checks: [],
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
      runId: "run-test-fixture",
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
    expect(summary?.settlement.settled).toBe(false);
    expect(summary?.settlement.failed_checks).toEqual([
      "required-processors-active",
      "no-attention-diagnostics",
      "no-open-questions",
    ]);
    expect(summary?.settlement.checks.find((check) =>
      check.name === "no-open-questions"
    )).toEqual(expect.objectContaining({
      status: "fail",
      observed: 3,
      expected: "0 open question(s)",
    }));
  });

  test("can summarize all unresolved questions for cross-cutting loops", () => {
    const loop: MaintenanceLoop = {
      ...LOOP,
      processors: ["test.answer-handler"],
      questionScope: "all",
    };
    const unrelatedQuestion: QuestionRecord = {
      id: 1,
      effect: questionEffect({
        question: "Should this global uncertainty stay visible?",
        sourceRefs: [REF],
        idempotencyKey: "test-global-question",
        metadata: {
          risk: "low",
          confidence: 0.8,
          recommendedAnswer: "yes",
          automationPolicy: "agent-safe",
        },
      }),
      processorId: "test.question-emitter",
      runId: "run-test-fixture",
      adoptedCommit: commitOid("abc123"),
      askedAt: "2026-06-01T00:00:00.000Z",
      answeredAt: null,
      answer: null,
    };

    const [summary] = collectMaintenanceLoopSummaries({
      loops: [loop],
      activeProcessorIds: new Set(["test.answer-handler"]),
      diagnosticsByProcessor: () => [],
      unresolvedQuestions: [unrelatedQuestion],
      runsByProcessor: () => [],
    });

    expect(summary).toEqual(expect.objectContaining({
      state: "attention",
      question_scope: "all",
      questions: 1,
      agent_safe_questions: 1,
      model_safe_questions: 0,
      owner_needed_questions: 0,
    }));
    expect(summary?.settlement.settled).toBe(false);
    expect(summary?.settlement.failed_checks).toEqual(["no-open-questions"]);
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
    expect(summary?.settlement.settled).toBe(false);
    expect(summary?.settlement.failed_checks).toEqual([
      "no-drift-diagnostics",
    ]);
  });

  test("keeps disposition-classified noise visible without making the loop drift", () => {
    const loop: MaintenanceLoop = {
      ...LOOP,
      processors: ["test.active-processor"],
    };
    const historicalDailyRef = sourceRef({
      commit: commitOid("abc123"),
      path: "notes/2025-10-08.md",
      range: { startLine: 3, endLine: 3 },
    });

    const [summary] = collectMaintenanceLoopSummaries({
      loops: [loop],
      activeProcessorIds: new Set(["test.active-processor"]),
      diagnosticsByProcessor: (processorId) =>
        processorId === "test.active-processor"
          ? [
              diagnosticEffect({
                severity: "info",
                code: "dome.markdown.broken-wikilink",
                message:
                  "Wikilink [[dailies/2025-10-07]] does not resolve to any markdown file in the vault.",
                sourceRefs: [historicalDailyRef],
              }),
            ]
          : [],
      unresolvedQuestions: [],
      runsByProcessor: () => [],
    });

    expect(summary?.state).toBe("quiet");
    expect(summary?.diagnostics).toBe(1);
    expect(summary?.attention_diagnostics).toBe(0);
    expect(summary?.drift_diagnostics).toBe(0);
    expect(summary?.noise_diagnostics).toBe(1);
    expect(summary?.settlement.settled).toBe(true);
    expect(summary?.settlement.failed_checks).toEqual([]);
  });

  test("recovered processor runs do not keep a loop in attention", () => {
    const loop: MaintenanceLoop = {
      ...LOOP,
      processors: ["test.active-processor"],
    };

    const [summary] = collectMaintenanceLoopSummaries({
      loops: [loop],
      activeProcessorIds: new Set(["test.active-processor"]),
      diagnosticsByProcessor: () => [],
      unresolvedQuestions: [],
      runsByProcessor: (processorId) =>
        processorId === "test.active-processor"
          ? [
              runRow({
                processorId,
                status: "succeeded",
                startedAt: "2026-06-02T12:01:00.000Z",
              }),
              runRow({
                processorId,
                status: "timed_out",
                startedAt: "2026-06-02T12:00:00.000Z",
              }),
            ]
          : [],
    });

    expect(summary?.state).toBe("quiet");
    expect(summary?.recent_runs).toBe(2);
    expect(summary?.recent_problem_runs).toBe(0);
    expect(summary?.latest_run_at).toBe("2026-06-02T12:01:00.000Z");
    expect(summary?.last_successful_run_at).toBe(
      "2026-06-02T12:01:00.000Z",
    );
    expect(summary?.latest_problem_run_at).toBeNull();
    expect(summary?.settlement.settled).toBe(true);
    expect(summary?.settlement.failed_checks).toEqual([]);
  });

  test("latest active problem runs keep a loop in attention", () => {
    const loop: MaintenanceLoop = {
      ...LOOP,
      processors: ["test.active-processor"],
    };

    const [summary] = collectMaintenanceLoopSummaries({
      loops: [loop],
      activeProcessorIds: new Set(["test.active-processor"]),
      diagnosticsByProcessor: () => [],
      unresolvedQuestions: [],
      runsByProcessor: (processorId) =>
        processorId === "test.active-processor"
          ? [
              runRow({
                processorId,
                status: "timed_out",
                startedAt: "2026-06-02T12:02:00.000Z",
              }),
              runRow({
                processorId,
                status: "succeeded",
                startedAt: "2026-06-02T12:01:00.000Z",
              }),
            ]
          : [],
    });

    expect(summary?.state).toBe("attention");
    expect(summary?.recent_runs).toBe(2);
    expect(summary?.recent_problem_runs).toBe(1);
    expect(summary?.latest_run_at).toBe("2026-06-02T12:02:00.000Z");
    expect(summary?.last_successful_run_at).toBe(
      "2026-06-02T12:01:00.000Z",
    );
    expect(summary?.latest_problem_run_at).toBe(
      "2026-06-02T12:02:00.000Z",
    );
    expect(summary?.settlement.settled).toBe(false);
    expect(summary?.settlement.failed_checks).toEqual([
      "no-recent-problem-runs",
    ]);
  });

  test("reports the newest successful and active problem run across processors", () => {
    const loop: MaintenanceLoop = {
      ...LOOP,
      processors: ["test.first-processor", "test.second-processor"],
    };

    const [summary] = collectMaintenanceLoopSummaries({
      loops: [loop],
      activeProcessorIds: new Set([
        "test.first-processor",
        "test.second-processor",
      ]),
      diagnosticsByProcessor: () => [],
      unresolvedQuestions: [],
      runsByProcessor: (processorId) => {
        if (processorId === "test.first-processor") {
          return [
            runRow({
              processorId,
              status: "failed",
              startedAt: "2026-06-02T12:05:00.000Z",
            }),
            runRow({
              processorId,
              status: "succeeded",
              startedAt: "2026-06-02T12:04:00.000Z",
            }),
          ];
        }
        if (processorId === "test.second-processor") {
          return [
            runRow({
              processorId,
              status: "succeeded",
              startedAt: "2026-06-02T12:06:00.000Z",
            }),
            runRow({
              processorId,
              status: "timed_out",
              startedAt: "2026-06-02T12:03:00.000Z",
            }),
          ];
        }
        return [];
      },
    });

    expect(summary?.state).toBe("attention");
    expect(summary?.recent_runs).toBe(4);
    expect(summary?.recent_problem_runs).toBe(1);
    expect(summary?.latest_run_at).toBe("2026-06-02T12:06:00.000Z");
    expect(summary?.last_successful_run_at).toBe(
      "2026-06-02T12:06:00.000Z",
    );
    expect(summary?.latest_problem_run_at).toBe(
      "2026-06-02T12:05:00.000Z",
    );
  });
});

describe("formatMaintenanceLoopDetailLines", () => {
  test("renders each loop as a tree node with label and child detail lines", () => {
    const loop: MaintenanceLoop = {
      ...LOOP,
      processors: ["test.active-processor"],
    };
    const [summary] = collectMaintenanceLoopSummaries({
      loops: [loop],
      activeProcessorIds: new Set(["test.active-processor"]),
      diagnosticsByProcessor: () => [],
      unresolvedQuestions: [],
      runsByProcessor: () => [],
    });
    expect(summary).toBeDefined();
    if (summary === undefined) return;

    const lines = formatMaintenanceLoopDetailLines([summary], ASCII_CAPS);
    const text = lines.join("\n");

    // Tree connector on the only (last) node
    expect(text).toContain("`-");
    // Label has state tag and loop id
    expect(text).toContain("[quiet] test.loop: Keep test work visible.");
    // Processors child line
    expect(text).toContain("processors: 1/1 active");
    // Settlement
    expect(text).toContain("settlement: settled (5/5)");
    // No-op line
    expect(text).toContain("no-op:");
    // No null timestamp lines emitted
    expect(text).not.toContain("latest run:");
    expect(text).not.toContain("last success:");
  });

  test("suppresses zero-count attention parts and omits the line when all zero", () => {
    const loop: MaintenanceLoop = {
      ...LOOP,
      processors: ["test.active-processor"],
    };
    const [summary] = collectMaintenanceLoopSummaries({
      loops: [loop],
      activeProcessorIds: new Set(["test.active-processor"]),
      diagnosticsByProcessor: () => [],
      unresolvedQuestions: [],
      runsByProcessor: () => [],
    });
    expect(summary).toBeDefined();
    if (summary === undefined) return;

    const lines = formatMaintenanceLoopDetailLines([summary], ASCII_CAPS);
    const text = lines.join("\n");

    // When all attention counts are zero, no attention line is emitted
    expect(text).not.toContain("attention:");
    expect(text).not.toContain("0 attention");
    expect(text).not.toContain("0 drift");
    expect(text).not.toContain("0 question");
  });

  test("emits non-zero attention parts and suppresses zero-count terms", () => {
    const loop: MaintenanceLoop = {
      ...LOOP,
      processors: ["test.active-processor"],
    };
    const ownerQuestion: QuestionRecord = {
      id: 1,
      effect: questionEffect({
        question: "What should happen?",
        sourceRefs: [REF],
        idempotencyKey: "test-q",
      }),
      processorId: "test.active-processor",
      runId: "run-test",
      adoptedCommit: commitOid("abc123"),
      askedAt: "2026-06-01T00:00:00.000Z",
      answeredAt: null,
      answer: null,
    };
    const [summary] = collectMaintenanceLoopSummaries({
      loops: [loop],
      activeProcessorIds: new Set(["test.active-processor"]),
      diagnosticsByProcessor: () => [],
      unresolvedQuestions: [ownerQuestion],
      runsByProcessor: () => [],
    });
    expect(summary).toBeDefined();
    if (summary === undefined) return;

    const lines = formatMaintenanceLoopDetailLines([summary], ASCII_CAPS);
    const text = lines.join("\n");

    // Attention line should show questions but not drift/noise/problem-runs
    expect(text).toContain("attention:");
    expect(text).toContain("1 question(s)");
    expect(text).not.toContain("0 drift");
    expect(text).not.toContain("0 noise");
    // Question breakdown by policy
    expect(text).toContain("questions:");
    expect(text).toContain("owner-needed");
  });

  test("uses |- connector for non-last node and `- for last", () => {
    const loopA: MaintenanceLoop = { ...LOOP, id: "test.loop.a", processors: ["test.a"] };
    const loopB: MaintenanceLoop = { ...LOOP, id: "test.loop.b", processors: ["test.b"] };
    const summaries = collectMaintenanceLoopSummaries({
      loops: [loopA, loopB],
      activeProcessorIds: new Set(["test.a", "test.b"]),
      diagnosticsByProcessor: () => [],
      unresolvedQuestions: [],
      runsByProcessor: () => [],
    });

    const lines = formatMaintenanceLoopDetailLines(summaries, ASCII_CAPS);
    const text = lines.join("\n");

    expect(text).toContain("|- [quiet] test.loop.a:");
    expect(text).toContain("`- [quiet] test.loop.b:");
  });

  test("shows latest run and last success timestamps when present", () => {
    const loop: MaintenanceLoop = {
      ...LOOP,
      processors: ["test.active-processor"],
    };
    const [summary] = collectMaintenanceLoopSummaries({
      loops: [loop],
      activeProcessorIds: new Set(["test.active-processor"]),
      diagnosticsByProcessor: () => [],
      unresolvedQuestions: [],
      runsByProcessor: (processorId) =>
        processorId === "test.active-processor"
          ? [
              runRow({
                processorId,
                status: "succeeded",
                startedAt: "2026-06-03T10:00:00.000Z",
              }),
            ]
          : [],
    });
    expect(summary).toBeDefined();
    if (summary === undefined) return;

    const lines = formatMaintenanceLoopDetailLines([summary], ASCII_CAPS);
    const text = lines.join("\n");

    expect(text).toContain("latest run: 2026-06-03T10:00:00.000Z");
    expect(text).toContain("last success: 2026-06-03T10:00:00.000Z");
  });
});

function runRow(input: {
  readonly processorId: string;
  readonly status: RunStatus;
  readonly startedAt: string;
}): RunRow {
  const startedAt = new Date(input.startedAt);
  return Object.freeze({
    id: newRunId(startedAt, () =>
      input.status === "succeeded" ? "00cede" : "badbad"
    ),
    proposalId: null,
    processorId: input.processorId,
    processorVersion: "0.0.1",
    phase: "view",
    inputCommit: commitOid("abc123"),
    outputCommit: null,
    status: input.status,
    effectHashes: Object.freeze([]),
    costUsd: null,
    durationMs: 1,
    error: input.status === "succeeded" ? null : "processor timed out",
    triggerKind: "command",
    triggerPayload: Object.freeze({}),
    startedAt: input.startedAt,
    finishedAt: new Date(startedAt.getTime() + 1).toISOString(),
  });
}
