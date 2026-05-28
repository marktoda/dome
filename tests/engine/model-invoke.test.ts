import { describe, expect, test } from "bun:test";

import {
  modelInvokeForProcessor,
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
  retryBudgetMs: 0,
  maxAttempts: 1,
  lateEffectBehavior: "discard",
  modelCallTimeoutMs: 500,
});

function buildInvoke(opts?: {
  readonly declared?: ReadonlyArray<Capability>;
  readonly granted?: ReadonlyArray<Capability>;
  readonly provider?: ModelProvider;
  readonly onCost?: (costUsd: number) => void;
}) {
  return modelInvokeForProcessor({
    phase: "garden",
    processorId: "test.model",
    declared: opts?.declared ?? [MODEL_CAP],
    granted: opts?.granted ?? [MODEL_CAP],
    policy: POLICY,
    signal: new AbortController().signal,
    ...(opts?.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts?.onCost !== undefined ? { onCost: opts.onCost } : {}),
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
});
