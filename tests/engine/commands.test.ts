import { describe, expect, test } from "bun:test";

import { diagnosticEffect } from "../../src/core/effect";
import { commitOid } from "../../src/core/source-ref";
import { noopSinks } from "../../src/engine/apply-effect";
import { runViewCommand } from "../../src/engine/commands";
import type {
  RunId,
  RunnerError,
  ViewPhaseRunner,
} from "../../src/engine/runner-contract";

describe("runViewCommand", () => {
  test("view processor execution failure returns failed instead of empty success", async () => {
    const runId = "run_test_view_failed" as RunId;
    const executionError: RunnerError = {
      code: "processor.threw",
      message: "boom",
      retryable: false,
      phase: "view",
      processorId: "test.view.throw",
    };
    const recorded: string[] = [];
    const viewRunner: ViewPhaseRunner = async () => ({
      runId,
      processorId: "test.view.throw",
      executionStatus: "failed",
      executionError,
      declared: [],
      granted: [],
      inspectedPaths: [],
      effects: [
        diagnosticEffect({
          severity: "error",
          code: "processor.threw",
          message: "test.view.throw: boom",
          sourceRefs: [],
        }),
      ],
    });

    const result = await runViewCommand({
      vault: {
        path: "/tmp/dome-test",
        config: { git: { auto_commit_workflows: false } },
      },
      adopted: commitOid("adopted"),
      commandName: "throw",
      viewRunner,
      sinks: {
        ...noopSinks(),
        recordDiagnostic: async ({ effect }) => {
          recorded.push(effect.code);
        },
      },
    });

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.runId).toBe(runId);
    expect(result.processorId).toBe("test.view.throw");
    expect(result.executionStatus).toBe("failed");
    expect(result.executionError).toEqual(executionError);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["processor.threw"]);
    expect(recorded).toEqual(["processor.threw"]);
  });
});
