import { describe, expect, test } from "bun:test";

import {
  modelInvokeForProcessor,
  type ModelInvokeCapabilityUse,
  type ModelProvider,
} from "../../src/engine/model-invoke";
import type { Capability } from "../../src/core/processor";
import type { ResolvedExecutionPolicy } from "../../src/processors/execution-policy";

const MODEL_CAP: Capability = Object.freeze({
  kind: "model.invoke",
  modelAllowlist: Object.freeze(["fast", "smart"]),
});

const POLICY: ResolvedExecutionPolicy = Object.freeze({
  class: "llm",
  timeoutMs: 1_000,
  lateEffectBehavior: "discard",
  modelCallTimeoutMs: 500,
});

function buildInvoke(opts?: {
  readonly declared?: ReadonlyArray<Capability>;
  readonly granted?: ReadonlyArray<Capability>;
  readonly provider?: ModelProvider;
  readonly onCost?: (costUsd: number) => void;
  readonly spentUsdToday?: () => number;
  readonly signal?: AbortSignal;
  readonly policy?: ResolvedExecutionPolicy;
  readonly onCapabilityUse?: (use: ModelInvokeCapabilityUse) => void;
}) {
  return modelInvokeForProcessor({
    phase: "garden",
    processorId: "test.model",
    declared: opts?.declared ?? [MODEL_CAP],
    granted: opts?.granted ?? [MODEL_CAP],
    policy: opts?.policy ?? POLICY,
    signal: opts?.signal ?? new AbortController().signal,
    ...(opts?.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts?.onCost !== undefined ? { onCost: opts.onCost } : {}),
    ...(opts?.spentUsdToday !== undefined
      ? { spentUsdToday: opts.spentUsdToday }
      : {}),
    ...(opts?.onCapabilityUse !== undefined
      ? { onCapabilityUse: opts.onCapabilityUse }
      : {}),
  });
}

describe("modelInvokeForProcessor", () => {
  test("returns undefined without effective model.invoke capability", () => {
    expect(buildInvoke({ declared: [], granted: [MODEL_CAP] })).toBeUndefined();
    expect(buildInvoke({ declared: [MODEL_CAP], granted: [] })).toBeUndefined();
  });

  test("denies a granted call when no provider is configured", async () => {
    const invoke = buildInvoke();
    if (invoke === undefined) throw new Error("expected invoke");

    await expect(invoke({ prompt: "hello" })).rejects.toMatchObject({
      code: "model.invoke.denied",
      retryable: false,
    });
  });

  test("enforces declared ∩ granted model allowlist", async () => {
    const calls: string[] = [];
    const invoke = buildInvoke({
      declared: [
        { kind: "model.invoke", modelAllowlist: ["fast", "smart"] },
      ],
      granted: [
        { kind: "model.invoke", modelAllowlist: ["smart"] },
      ],
      provider: async (request) => {
        calls.push(request.model ?? "");
        return { text: "ok" };
      },
    });
    if (invoke === undefined) throw new Error("expected invoke");

    await expect(
      invoke({ prompt: "hello", model: "fast" }),
    ).rejects.toMatchObject({
      code: "model.invoke.denied",
      retryable: false,
    });
    expect(await invoke({ prompt: "hello" })).toBe("ok");
    expect(calls).toEqual(["smart"]);
  });

  test("records provider-reported cost", async () => {
    let cost = 0;
    const invoke = buildInvoke({
      onCost: (n) => {
        cost += n;
      },
      provider: async () => ({ text: "ok", costUsd: 0.25 }),
    });
    if (invoke === undefined) throw new Error("expected invoke");

    expect(await invoke({ prompt: "hello", model: "fast" })).toBe("ok");
    expect(cost).toBe(0.25);
  });

  test("denies calls once the effective daily cost budget is spent", async () => {
    let calls = 0;
    const invoke = buildInvoke({
      declared: [{ kind: "model.invoke", maxDailyCostUsd: 1 }],
      granted: [{ kind: "model.invoke", maxDailyCostUsd: 1 }],
      spentUsdToday: () => 1,
      provider: async () => {
        calls += 1;
        return { text: "ok", costUsd: 0.25 };
      },
    });
    if (invoke === undefined) throw new Error("expected invoke");

    await expect(invoke({ prompt: "hello" })).rejects.toMatchObject({
      code: "model.invoke.denied",
      retryable: false,
    });
    expect(calls).toBe(0);
  });

  test("records cost then denies output when a provider response exceeds budget", async () => {
    let cost = 0;
    const invoke = buildInvoke({
      declared: [{ kind: "model.invoke", maxDailyCostUsd: 1 }],
      granted: [{ kind: "model.invoke", maxDailyCostUsd: 0.5 }],
      spentUsdToday: () => cost,
      onCost: (n) => {
        cost += n;
      },
      provider: async () => ({ text: "ok", costUsd: 0.75 }),
    });
    if (invoke === undefined) throw new Error("expected invoke");

    await expect(invoke({ prompt: "hello" })).rejects.toMatchObject({
      code: "model.invoke.denied",
      retryable: false,
    });
    expect(cost).toBe(0.75);
  });

  test("structured parses valid JSON through caller schema parser", async () => {
    const invoke = buildInvoke({
      provider: async () => ({ text: "{\"answer\":42}" }),
    });
    if (invoke === undefined) throw new Error("expected invoke");

    const parsed = await invoke.structured({
      prompt: "json",
      schemaName: "answer/v1",
      parse: (value) => {
        if (
          typeof value === "object" &&
          value !== null &&
          (value as { readonly answer?: unknown }).answer === 42
        ) {
          return value as { readonly answer: 42 };
        }
        throw new Error("answer missing");
      },
    });

    expect(parsed.answer).toBe(42);
  });

  test("structured accepts a single whole-response JSON code fence", async () => {
    const invoke = buildInvoke({
      provider: async () => ({
        text: "```json\n{\"answer\":42}\n```",
      }),
    });
    if (invoke === undefined) throw new Error("expected invoke");

    const parsed = await invoke.structured({
      prompt: "json",
      schemaName: "answer/v1",
      parse: (value) => {
        if (
          typeof value === "object" &&
          value !== null &&
          (value as { readonly answer?: unknown }).answer === 42
        ) {
          return value as { readonly answer: 42 };
        }
        throw new Error("answer missing");
      },
    });

    expect(parsed.answer).toBe(42);
  });

  test("structured rejects fenced JSON with extra prose", async () => {
    const invoke = buildInvoke({
      provider: async () => ({
        text: "Here is the JSON:\n```json\n{\"answer\":42}\n```",
      }),
    });
    if (invoke === undefined) throw new Error("expected invoke");

    await expect(
      invoke.structured({
        prompt: "json",
        schemaName: "answer/v1",
        parse: (value) => value,
      }),
    ).rejects.toMatchObject({
      code: "model.output.invalid-json",
      retryable: false,
    });
  });

  test("structured retries invalid JSON when requested, then succeeds", async () => {
    let calls = 0;
    const invoke = buildInvoke({
      provider: async () => {
        calls += 1;
        return { text: calls === 1 ? "not-json" : "{\"ok\":true}" };
      },
    });
    if (invoke === undefined) throw new Error("expected invoke");

    const parsed = await invoke.structured({
      prompt: "json",
      schemaName: "ok/v1",
      retries: 1,
      parse: (value) => value as { readonly ok: true },
    });

    expect(parsed.ok).toBe(true);
    expect(calls).toBe(2);
  });

  test("structured invalid JSON and schema mismatch throw stable model codes", async () => {
    const invalidJson = buildInvoke({
      provider: async () => ({ text: "not-json" }),
    });
    if (invalidJson === undefined) throw new Error("expected invoke");

    await expect(
      invalidJson.structured({
        prompt: "json",
        schemaName: "x/v1",
        parse: (value) => value,
      }),
    ).rejects.toMatchObject({
      code: "model.output.invalid-json",
      retryable: false,
    });

    const mismatch = buildInvoke({
      provider: async () => ({ text: "{\"ok\":false}" }),
    });
    if (mismatch === undefined) throw new Error("expected invoke");

    await expect(
      mismatch.structured({
        prompt: "json",
        schemaName: "ok/v1",
        parse: () => {
          throw new Error("not ok");
        },
      }),
    ).rejects.toMatchObject({
      code: "model.output.schema-mismatch",
      retryable: false,
    });
  });

  test("malformed provider responses throw stable provider-failed errors", async () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly response: unknown;
    }> = [
      { name: "null", response: null },
      { name: "non-object", response: "ok" },
      { name: "missing text", response: {} },
      { name: "non-string text", response: { text: 42 } },
      { name: "invalid cost", response: { text: "ok", costUsd: Number.NaN } },
      { name: "negative cost", response: { text: "ok", costUsd: -1 } },
      { name: "non-string model", response: { text: "ok", model: 42 } },
    ];

    for (const c of cases) {
      const invoke = buildInvoke({
        provider: async () => c.response as never,
      });
      if (invoke === undefined) throw new Error(`expected invoke for ${c.name}`);

      await expect(invoke({ prompt: "hello" })).rejects.toMatchObject({
        code: "model.invoke.provider-failed",
        retryable: true,
      });
    }
  });

  test("provider-thrown model-shaped errors are provider failures", async () => {
    const invoke = buildInvoke({
      provider: async () => {
        throw Object.assign(new Error("spoofed model failure"), {
          code: "model.output.invalid-json",
          retryable: false,
        });
      },
    });
    if (invoke === undefined) throw new Error("expected invoke");

    await expect(invoke({ prompt: "hello" })).rejects.toMatchObject({
      code: "model.invoke.provider-failed",
      retryable: true,
    });
  });

  test("retries transient provider failures once inside the model boundary", async () => {
    let calls = 0;
    const uses: ModelInvokeCapabilityUse[] = [];
    const invoke = buildInvoke({
      onCapabilityUse: (use) => uses.push(use),
      provider: async () => {
        calls += 1;
        if (calls === 1) throw new Error("429 rate limited");
        return { text: "ok" };
      },
    });
    if (invoke === undefined) throw new Error("expected invoke");

    expect(await invoke({ prompt: "hello" })).toBe("ok");
    expect(calls).toBe(2);
    expect(uses).toEqual([
      { capability: "model.invoke", resource: "fast", outcome: "allowed" },
      { capability: "model.invoke", resource: "fast", outcome: "allowed" },
    ]);
  });

  test("does not retry model-call timeouts", async () => {
    let calls = 0;
    const invoke = buildInvoke({
      policy: {
        ...POLICY,
        timeoutMs: 20,
        modelCallTimeoutMs: 5,
      },
      provider: async (request) => {
        calls += 1;
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return { text: "late" };
      },
    });
    if (invoke === undefined) throw new Error("expected invoke");

    await expect(invoke({ prompt: "hello" })).rejects.toMatchObject({
      code: "model.invoke.timeout",
      retryable: true,
    });
    expect(calls).toBe(1);
  });

  test("pre-aborted processor signal prevents provider invocation", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const invoke = buildInvoke({
      signal: controller.signal,
      provider: async () => {
        called = true;
        return { text: "late" };
      },
    });
    if (invoke === undefined) throw new Error("expected invoke");

    await expect(invoke({ prompt: "hello" })).rejects.toMatchObject({
      code: "model.invoke.timeout",
      retryable: true,
    });
    expect(called).toBe(false);
  });
});
