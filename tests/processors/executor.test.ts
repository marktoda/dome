import { describe, expect, test } from "bun:test";

import {
  EffectSchema,
  diagnosticEffect,
  externalActionEffect,
  patchEffect,
} from "../../src/core/effect";
import type { Effect } from "../../src/core/effect";
import { transientProcessorError } from "../../src/core/processor-error";
import type { ProcessorContext } from "../../src/core/processor";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import type { RunId } from "../../src/engine/core/runner-contract";
import {
  modelInvokeForProcessor,
  type ModelProvider,
} from "../../src/engine/core/model-invoke";
import {
  MAX_EFFECTS_PER_INVOCATION,
  executeProcessor,
} from "../../src/processors/executor";

const RUN_ID = "run_test_executor" as RunId;

const ctx = Object.freeze({
  snapshot: Object.freeze({
    commit: commitOid("abc0000000000000000000000000000000000000"),
    tree: "tree000000000000000000000000000000000000" as never,
    readFile: async () => null,
    listMarkdownFiles: async () => [],
    getFileInfo: async () => null,
  }),
  changedPaths: Object.freeze([]),
  proposal: null,
  runId: RUN_ID,
  input: null,
  now: () => new Date("2026-01-02T00:00:00.000Z"),
  signal: new AbortController().signal,
  capabilities: Object.freeze({ __brand: "CapabilityToken" as const }) as never,
  extensionConfig: Object.freeze({}),
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

  test("QuestionEffect with an unmodeled metadata key is rejected at emit, attributable to the processor", async () => {
    // Emit-time validation (the (a) half of chunk-11 Task 1): a processor that
    // emits a QuestionEffect carrying a metadata key the strict
    // QuestionEffectSchema does not model must fail LOUDLY and ATTRIBUTABLY at
    // its own effect — never reaching the questions table to poison a later
    // read. The bad key is raw (the typed constructor cannot express it).
    const processorId = "test.executor.bad-question-metadata";
    const hostileQuestion = {
      kind: "question",
      question: "is this ok?",
      sourceRefs: [],
      idempotencyKey: "q-bad-meta",
      metadata: { risk: "low", unmodeledLegacyKey: "boom" },
    };
    // Guard: the schema genuinely rejects this shape (mirror of the read schema).
    expect(EffectSchema.safeParse(hostileQuestion).success).toBe(false);

    const result = await executeProcessor({
      processorId,
      phase: "garden",
      runId: RUN_ID,
      makeContext: contextWithSignal,
      policy: {
        class: "background",
        timeoutMs: 100,
        lateEffectBehavior: "discard",
      },
      run: async () => [hostileQuestion as unknown as Effect],
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("processor.invalid-output");
    expect(result.error.processorId).toBe(processorId);
    expect(result.error.message).toContain("effect[0]");
    expect("effects" in result).toBe(false);
  });

  test("source-backed patch output policy rejects empty PatchEffect provenance", async () => {
    const result = await executeProcessor({
      processorId: "test.executor.model-patch-policy",
      phase: "garden",
      runId: RUN_ID,
      makeContext: contextWithSignal,
      policy: {
        class: "llm",
        timeoutMs: 100,
        lateEffectBehavior: "discard",
      },
      outputPolicy: { requireSourceBackedPatchEffects: true },
      run: async () => [
        patchEffect({
          mode: "auto",
          changes: [
            {
              kind: "write",
              path: "wiki/generated.md",
              content: "# Generated\n",
            },
          ],
          reason: "generated by model",
          sourceRefs: [],
        }),
      ],
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("processor.invalid-output");
    expect(result.error.message).toContain("SourceRef");
    expect(result.error.message).toContain("effect[0]");
    expect("effects" in result).toBe(false);
  });

  test("source-backed patch output policy accepts sourced PatchEffect provenance", async () => {
    const result = await executeProcessor({
      processorId: "test.executor.model-patch-policy-ok",
      phase: "garden",
      runId: RUN_ID,
      makeContext: contextWithSignal,
      policy: {
        class: "llm",
        timeoutMs: 100,
        lateEffectBehavior: "discard",
      },
      outputPolicy: { requireSourceBackedPatchEffects: true },
      run: async () => [
        patchEffect({
          mode: "auto",
          changes: [
            {
              kind: "write",
              path: "wiki/generated.md",
              content: "# Generated\n",
            },
          ],
          reason: "generated by model",
          sourceRefs: [ctx.sourceRef("inbox/raw/source.md")],
        }),
      ],
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]?.kind).toBe("patch");
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

  test("non-JSON payload effect fails invalid-output without routing effects", async () => {
    const unhashableEffect = externalActionEffect({
      capability: "test.external",
      idempotencyKey: "test.external.bigint",
      payload: 1n as unknown as import("../../src/core/effect").JsonValue,
      sourceRefs: [],
    });

    expect(EffectSchema.safeParse(unhashableEffect).success).toBe(false);

    const result = await executeProcessor({
      processorId: "test.executor.unhashable",
      phase: "garden",
      runId: RUN_ID,
      makeContext: contextWithSignal,
      policy: {
        class: "background",
        timeoutMs: 100,
        lateEffectBehavior: "discard",
      },
      run: async () => [unhashableEffect],
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("processor.invalid-output");
    expect(result.error.message).toMatch(/effect\[0\]|payload/i);
    expect(result.diagnostic.severity).toBe("error");
    expect(result.diagnostic.message).toMatch(/effect\[0\]|payload/i);
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

  test("garden transientProcessorError marks itself retryable", async () => {
    const result = await executeProcessor({
      processorId: "test.executor.retryable-throw",
      phase: "garden",
      runId: RUN_ID,
      makeContext: contextWithSignal,
      policy: {
        class: "background",
        timeoutMs: 100,
        lateEffectBehavior: "discard",
      },
      run: async () => {
        throw transientProcessorError("temporary provider failure");
      },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("processor.threw");
    expect(result.error.retryable).toBe(true);
  });

  test("retryable-shaped processor throws are not retryable", async () => {
    const result = await executeProcessor({
      processorId: "test.executor.retryable-spoof",
      phase: "garden",
      runId: RUN_ID,
      makeContext: contextWithSignal,
      policy: {
        class: "background",
        timeoutMs: 100,
        lateEffectBehavior: "discard",
      },
      run: async () => {
        throw Object.assign(new Error("fake transient failure"), {
          retryable: true,
        });
      },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("processor.threw");
    expect(result.error.message).toContain("fake transient failure");
    expect(result.error.retryable).toBe(false);
  });

  test("SDK-created model execution errors are not wrapped as processor.threw", async () => {
    const cap = Object.freeze({ kind: "model.invoke" as const });
    const policy = Object.freeze({
      class: "llm" as const,
      timeoutMs: 100,
      lateEffectBehavior: "discard" as const,
      modelCallTimeoutMs: 100,
    });
    const provider: ModelProvider = async () => ({ text: "not json" });

    const result = await executeProcessor({
      processorId: "test.executor.model-json",
      phase: "garden",
      runId: RUN_ID,
      makeContext: (signal) => {
        const modelInvoke = modelInvokeForProcessor({
          phase: "garden",
          processorId: "test.executor.model-json",
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
        if (runCtx.modelInvoke === undefined) {
          throw new Error("expected modelInvoke");
        }
        await runCtx.modelInvoke.structured({
          prompt: "return json",
          schemaName: "x",
          parse: (value) => value,
        });
        return [];
      },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("model.output.invalid-json");
    expect(result.error.retryable).toBe(false);
    expect(result.diagnostic.code).toBe("model.output.invalid-json");
  });

  test("processor-thrown model-shaped errors are still processor.threw", async () => {
    const result = await executeProcessor({
      processorId: "test.executor.model-spoof",
      phase: "garden",
      runId: RUN_ID,
      makeContext: contextWithSignal,
      policy: {
        class: "background",
        timeoutMs: 100,
        lateEffectBehavior: "discard",
      },
      run: async () => {
        throw Object.assign(new Error("fake model json failure"), {
          code: "model.output.invalid-json",
          retryable: true,
        });
      },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("processor.threw");
    expect(result.error.message).toContain("fake model json failure");
    expect(result.error.retryable).toBe(false);
    expect(result.diagnostic.code).toBe("processor.threw");
  });

  test("processor-thrown invalid-output-shaped errors are still processor.threw", async () => {
    const result = await executeProcessor({
      processorId: "test.executor.invalid-output-spoof",
      phase: "garden",
      runId: RUN_ID,
      makeContext: contextWithSignal,
      policy: {
        class: "background",
        timeoutMs: 100,
        lateEffectBehavior: "discard",
      },
      run: async () => {
        throw Object.assign(new Error("fake validation failure"), {
          code: "processor.invalid-output",
          retryable: false,
        });
      },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("processor.threw");
    expect(result.error.message).toContain("fake validation failure");
    expect(result.error.retryable).toBe(false);
    expect(result.diagnostic.code).toBe("processor.threw");
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
        if (prop === "length") return MAX_EFFECTS_PER_INVOCATION + 1;
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
