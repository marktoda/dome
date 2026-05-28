import { describe, expect, test } from "bun:test";

import {
  EffectSchema,
  diagnosticEffect,
  externalActionEffect,
  patchEffect,
} from "../../src/core/effect";
import type { Effect } from "../../src/core/effect";
import type { ProcessorContext } from "../../src/core/processor";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import type { RunId } from "../../src/engine/runner-contract";
import {
  modelInvokeForProcessor,
  type ModelProvider,
} from "../../src/engine/model-invoke";
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
  sourceRef: (path: string) =>
    sourceRef({
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

function contextWithSignal(signal: AbortSignal): ProcessorContext<unknown> {
  return Object.freeze({
    ...ctx,
    signal,
  }) as ProcessorContext<unknown>;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

describe("executeProcessor", () => {
  test("succeeds with frozen validated effects and hashes", async () => {
    const result = await executeProcessor({
      processorId: "test.executor.success",
      phase: "adoption",
      runId: RUN_ID,
      makeContext: contextWithSignal,
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
      makeContext: contextWithSignal,
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
      makeContext: contextWithSignal,
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

  test("throwing property access during schema validation fails invalid-output", async () => {
    const hostileEffect = {
      get kind(): string {
        throw new Error("kind access exploded during schema validation");
      },
    };

    const result = await executeProcessor({
      processorId: "test.executor.hostile-output",
      phase: "garden",
      runId: RUN_ID,
      makeContext: contextWithSignal,
      policy: {
        class: "background",
        timeoutMs: 100,
        retryBudgetMs: 0,
        maxAttempts: 1,
        lateEffectBehavior: "discard",
      },
      run: async () => [hostileEffect],
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("processor.invalid-output");
    expect(result.error.message).toMatch(/validation|schema|access|throw/i);
    expect("effects" in result).toBe(false);
    expect("effectHashes" in result).toBe(false);
  });

  test("throwing output array element access fails invalid-output", async () => {
    const hostileOutput = new Proxy([validEffect()] as Array<unknown>, {
      get(target, prop, receiver) {
        if (prop === "0") {
          throw new Error("output container index 0 access exploded");
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const result = await executeProcessor({
      processorId: "test.executor.hostile-container",
      phase: "garden",
      runId: RUN_ID,
      makeContext: contextWithSignal,
      policy: {
        class: "background",
        timeoutMs: 100,
        retryBudgetMs: 0,
        maxAttempts: 1,
        lateEffectBehavior: "discard",
      },
      run: async () => hostileOutput,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("processor.invalid-output");
    expect(result.error.message).toMatch(
      /output|container|effect\[0\]|access|validation/i,
    );
    expect("effects" in result).toBe(false);
    expect("effectHashes" in result).toBe(false);
  });

  test("unhashable schema-valid effect fails invalid-output without routing effects", async () => {
    const unhashableEffect = externalActionEffect({
      capability: "test.external",
      idempotencyKey: "test.external.bigint",
      payload: 1n,
      sourceRefs: [],
    });

    expect(EffectSchema.safeParse(unhashableEffect).success).toBe(true);

    const result = await executeProcessor({
      processorId: "test.executor.unhashable",
      phase: "garden",
      runId: RUN_ID,
      makeContext: contextWithSignal,
      policy: {
        class: "background",
        timeoutMs: 100,
        retryBudgetMs: 0,
        maxAttempts: 1,
        lateEffectBehavior: "discard",
      },
      run: async () => [unhashableEffect],
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("processor.invalid-output");
    expect(result.error.message).toMatch(/hash|serial|JSON/i);
    expect(result.diagnostic.severity).toBe("error");
    expect(result.diagnostic.message).toMatch(/hash|serial|JSON/i);
    expect("effects" in result).toBe(false);
    expect("effectHashes" in result).toBe(false);
  });

  test("throw becomes structured processor.threw", async () => {
    const result = await executeProcessor({
      processorId: "test.executor.throw",
      phase: "adoption",
      runId: RUN_ID,
      makeContext: contextWithSignal,
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
    expect(result.error.retryable).toBe(false);
    expect(result.diagnostic.severity).toBe("block");
  });

  test("garden thrown error can mark itself retryable", async () => {
    const transient = Object.assign(new Error("temporary provider failure"), {
      retryable: true,
    });

    const result = await executeProcessor({
      processorId: "test.executor.retryable-throw",
      phase: "garden",
      runId: RUN_ID,
      makeContext: contextWithSignal,
      policy: {
        class: "background",
        timeoutMs: 100,
        retryBudgetMs: 0,
        maxAttempts: 1,
        lateEffectBehavior: "discard",
      },
      run: async () => {
        throw transient;
      },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("processor.threw");
    expect(result.error.retryable).toBe(true);
  });

  test("specialized model execution errors are not wrapped as processor.threw", async () => {
    const result = await executeProcessor({
      processorId: "test.executor.model-json",
      phase: "garden",
      runId: RUN_ID,
      makeContext: contextWithSignal,
      policy: {
        class: "llm",
        timeoutMs: 100,
        retryBudgetMs: 0,
        maxAttempts: 1,
        lateEffectBehavior: "discard",
      },
      run: async () => {
        throw Object.assign(new Error("invalid json for schema x"), {
          code: "model.output.invalid-json",
          retryable: false,
        });
      },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("model.output.invalid-json");
    expect(result.error.retryable).toBe(false);
    expect(result.diagnostic.code).toBe("model.output.invalid-json");
  });

  test("hostile thrown value becomes structured processor.threw", async () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    const result = await executeProcessor({
      processorId: "test.executor.hostile-throw",
      phase: "garden",
      runId: RUN_ID,
      makeContext: contextWithSignal,
      policy: {
        class: "background",
        timeoutMs: 100,
        retryBudgetMs: 0,
        maxAttempts: 1,
        lateEffectBehavior: "discard",
      },
      run: async () => {
        throw revoked.proxy;
      },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("processor.threw");
    expect("effects" in result).toBe(false);
    expect("effectHashes" in result).toBe(false);
  });

  test("huge output array length fails invalid-output before iteration", async () => {
    const hostileOutput = new Proxy([validEffect()] as Array<unknown>, {
      get(target, prop, receiver) {
        if (prop === "length") return 10_001;
        return Reflect.get(target, prop, receiver);
      },
    });

    const result = await executeProcessor({
      processorId: "test.executor.too-many-effects",
      phase: "garden",
      runId: RUN_ID,
      makeContext: contextWithSignal,
      policy: {
        class: "background",
        timeoutMs: 100,
        retryBudgetMs: 0,
        maxAttempts: 1,
        lateEffectBehavior: "discard",
      },
      run: async () => hostileOutput,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("processor.invalid-output");
    expect(result.error.message).toMatch(/too many|limit|count|length/i);
    expect("effects" in result).toBe(false);
    expect("effectHashes" in result).toBe(false);
  });

  test("pre-aborted upstream signal cancels without invoking run", async () => {
    const upstream = new AbortController();
    upstream.abort();
    let invoked = false;

    const result = await executeProcessor({
      processorId: "test.executor.preaborted",
      phase: "adoption",
      runId: RUN_ID,
      signal: upstream.signal,
      makeContext: contextWithSignal,
      policy: {
        class: "deterministic",
        timeoutMs: 100,
        retryBudgetMs: 0,
        maxAttempts: 1,
        lateEffectBehavior: "discard",
      },
      run: async () => {
        invoked = true;
        return [validEffect()];
      },
    });

    expect(invoked).toBe(false);
    expect(result.status).toBe("cancelled");
    if (result.status !== "cancelled") return;
    expect(result.error.code).toBe("processor.cancelled");
    expect(result.error.retryable).toBe(false);
    expect(result.diagnostic.severity).toBe("block");
    expect("effects" in result).toBe(false);
    expect("effectHashes" in result).toBe(false);
  });

  test("mid-flight upstream abort cancels and aborts processor signal", async () => {
    const upstream = new AbortController();
    let invoked = false;
    let observedSignalAborted = false;
    let processorSignal: AbortSignal | undefined;
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    const resultPromise = executeProcessor({
      processorId: "test.executor.cancel",
      phase: "garden",
      runId: RUN_ID,
      signal: upstream.signal,
      makeContext: contextWithSignal,
      policy: {
        class: "background",
        timeoutMs: 1_000,
        retryBudgetMs: 0,
        maxAttempts: 1,
        lateEffectBehavior: "discard",
      },
      run: async (runCtx) => {
        invoked = true;
        processorSignal = runCtx.signal;
        resolveStarted?.();
        await waitForAbort(runCtx.signal);
        observedSignalAborted = runCtx.signal.aborted;
        return [validEffect()];
      },
    });

    await started;
    expect(invoked).toBe(true);
    expect(processorSignal).not.toBe(upstream.signal);
    upstream.abort();

    const result = await resultPromise;
    await Promise.resolve();

    expect(result.status).toBe("cancelled");
    if (result.status !== "cancelled") return;
    expect(result.error.code).toBe("processor.cancelled");
    expect(result.error.retryable).toBe(false);
    expect(result.diagnostic.severity).toBe("error");
    expect(observedSignalAborted).toBe(true);
    expect("effects" in result).toBe(false);
    expect("effectHashes" in result).toBe(false);
  });

  test("timeout returns timed_out and discards late effects", async () => {
    let released = false;
    let observedSignalAborted = false;
    const result = await executeProcessor({
      processorId: "test.executor.timeout",
      phase: "garden",
      runId: RUN_ID,
      makeContext: contextWithSignal,
      policy: {
        class: "background",
        timeoutMs: 5,
        retryBudgetMs: 0,
        maxAttempts: 1,
        lateEffectBehavior: "discard",
      },
      run: async (runCtx) => {
        await waitForAbort(runCtx.signal);
        observedSignalAborted = runCtx.signal.aborted;
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
    await Promise.resolve();
    expect(observedSignalAborted).toBe(true);
    expect(released).toBe(true);
  });

  test("processor timeout aborts model provider request signal", async () => {
    const cap = Object.freeze({ kind: "model.invoke" as const });
    const policy = Object.freeze({
      class: "llm" as const,
      timeoutMs: 5,
      retryBudgetMs: 0,
      maxAttempts: 1,
      lateEffectBehavior: "discard" as const,
      modelCallTimeoutMs: 1_000,
    });
    let resolveProviderAborted: (() => void) | undefined;
    const providerAborted = new Promise<void>((resolve) => {
      resolveProviderAborted = resolve;
    });
    let providerSignalAborted = false;
    const provider: ModelProvider = async (request) => {
      await waitForAbort(request.signal);
      providerSignalAborted = request.signal.aborted;
      resolveProviderAborted?.();
      return { text: "late" };
    };

    const result = await executeProcessor({
      processorId: "test.executor.model-timeout",
      phase: "garden",
      runId: RUN_ID,
      makeContext: (signal) => {
        const modelInvoke = modelInvokeForProcessor({
          phase: "garden",
          processorId: "test.executor.model-timeout",
          declared: [cap],
          granted: [cap],
          policy,
          signal,
          provider,
        });
        if (modelInvoke === undefined) {
          throw new Error("expected modelInvoke");
        }
        return Object.freeze({
          ...contextWithSignal(signal),
          modelInvoke,
        }) as ProcessorContext<unknown>;
      },
      policy,
      run: async (runCtx) => {
        await runCtx.modelInvoke?.({ prompt: "long model call" });
        return [validEffect()];
      },
    });

    expect(result.status).toBe("timed_out");
    if (result.status !== "timed_out") return;
    await providerAborted;
    expect(providerSignalAborted).toBe(true);
    expect(result.error.code).toBe("processor.timeout");
    expect("effects" in result).toBe(false);
  });
});
