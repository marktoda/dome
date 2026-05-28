import { describe, expect, test } from "bun:test";

import { diagnosticEffect, patchEffect } from "../../src/core/effect";
import type { Effect } from "../../src/core/effect";
import type { ProcessorContext } from "../../src/core/processor";
import { commitOid } from "../../src/core/source-ref";
import type { RunId } from "../../src/engine/runner-contract";
import { executeProcessor } from "../../src/processors/executor";

const RUN_ID = "run_test_executor" as RunId;

const ctx = Object.freeze({
  snapshot: Object.freeze({
    commit: commitOid("abc0000000000000000000000000000000000000"),
    tree: "tree000000000000000000000000000000000000" as never,
    readFile: async () => null,
    listMarkdownFiles: async () => [],
  }),
  changedPaths: Object.freeze([]),
  proposal: null,
  runId: RUN_ID,
  input: null,
  signal: new AbortController().signal,
  capabilities: Object.freeze({ __brand: "CapabilityToken" as const }) as never,
  sourceRef: (path: string) => ({
    commit: commitOid("abc0000000000000000000000000000000000000"),
    path,
  }),
}) as ProcessorContext<unknown>;

function validEffect(): Effect {
  return diagnosticEffect({
    severity: "info",
    code: "test.ok",
    message: "ok",
    sourceRefs: [],
  });
}

describe("executeProcessor", () => {
  test("succeeds with frozen validated effects and hashes", async () => {
    const result = await executeProcessor({
      processorId: "test.executor.success",
      phase: "adoption",
      runId: RUN_ID,
      ctx,
      policy: {
        class: "deterministic",
        timeoutMs: 100,
        retryBudgetMs: 0,
        maxAttempts: 1,
        lateEffectBehavior: "discard",
      },
      run: async () => [validEffect()],
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    expect(result.effects.length).toBe(1);
    expect(Object.isFrozen(result.effects)).toBe(true);
    expect(result.effectHashes.length).toBe(1);
    expect(result.effectHashes[0]?.length).toBe(64);
  });

  test("returned non-array fails invalid-output and routes no effects", async () => {
    const result = await executeProcessor({
      processorId: "test.executor.nonarray",
      phase: "adoption",
      runId: RUN_ID,
      ctx,
      policy: {
        class: "deterministic",
        timeoutMs: 100,
        retryBudgetMs: 0,
        maxAttempts: 1,
        lateEffectBehavior: "discard",
      },
      run: async () => "not an array" as never,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("processor.invalid-output");
    expect(result.diagnostic.severity).toBe("block");
    expect(result.diagnostic.code).toBe("processor.invalid-output");
    expect("effects" in result).toBe(false);
    expect("effectHashes" in result).toBe(false);
  });

  test("one malformed effect fails the whole invocation", async () => {
    const result = await executeProcessor({
      processorId: "test.executor.malformed",
      phase: "garden",
      runId: RUN_ID,
      ctx,
      policy: {
        class: "background",
        timeoutMs: 100,
        retryBudgetMs: 0,
        maxAttempts: 1,
        lateEffectBehavior: "discard",
      },
      run: async () => [
        validEffect(),
        patchEffect({
          mode: "auto",
          changes: [],
          reason: "bad",
          sourceRefs: [],
        }),
      ],
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("processor.invalid-output");
    expect(result.diagnostic.severity).toBe("error");
    expect(result.diagnostic.message).toContain("effect[1]");
  });

  test("throw becomes structured processor.threw", async () => {
    const result = await executeProcessor({
      processorId: "test.executor.throw",
      phase: "adoption",
      runId: RUN_ID,
      ctx,
      policy: {
        class: "deterministic",
        timeoutMs: 100,
        retryBudgetMs: 0,
        maxAttempts: 1,
        lateEffectBehavior: "discard",
      },
      run: async () => {
        throw new Error("boom");
      },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("processor.threw");
    expect(result.error.message).toContain("boom");
    expect(result.diagnostic.severity).toBe("block");
  });

  test("timeout returns timed_out and discards late effects", async () => {
    let released = false;
    const result = await executeProcessor({
      processorId: "test.executor.timeout",
      phase: "garden",
      runId: RUN_ID,
      ctx,
      policy: {
        class: "background",
        timeoutMs: 1,
        retryBudgetMs: 0,
        maxAttempts: 1,
        lateEffectBehavior: "discard",
      },
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        released = true;
        return [validEffect()];
      },
    });

    expect(result.status).toBe("timed_out");
    if (result.status !== "timed_out") return;
    expect(result.error.code).toBe("processor.timeout");
    expect(result.diagnostic.severity).toBe("error");
    expect("effects" in result).toBe(false);
    expect("effectHashes" in result).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(released).toBe(true);
  });
});
