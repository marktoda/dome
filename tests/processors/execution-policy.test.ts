import { describe, expect, test } from "bun:test";

import {
  DEFAULT_EXECUTION_POLICY_BY_CLASS,
  resolveExecutionPolicy,
  type ExecutionPolicyRequest,
} from "../../src/processors/execution-policy";

describe("resolveExecutionPolicy", () => {
  test("adoption resolves to deterministic 2s default", () => {
    const result = resolveExecutionPolicy({
      phase: "adoption",
      request: undefined,
      vaultCap: undefined,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.class).toBe("deterministic");
    expect(result.value.timeoutMs).toBe(2000);
    expect(result.value.lateEffectBehavior).toBe("discard");
  });

  test("garden llm request can resolve to explicit longer timeout", () => {
    const request: ExecutionPolicyRequest = {
      class: "llm",
      timeoutMs: 600_000,
      maxAttempts: 1,
      modelCallTimeoutMs: 180_000,
    };

    const result = resolveExecutionPolicy({
      phase: "garden",
      request,
      vaultCap: {
        timeoutMs: 600_000,
        maxAttempts: 2,
        modelCallTimeoutMs: 180_000,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.class).toBe("llm");
    expect(result.value.timeoutMs).toBe(600_000);
    expect(result.value.maxAttempts).toBe(1);
    expect(result.value.modelCallTimeoutMs).toBe(180_000);
  });

  test("vault cap wins over manifest timeout request", () => {
    const result = resolveExecutionPolicy({
      phase: "garden",
      request: { class: "llm", timeoutMs: 900_000, maxAttempts: 3 },
      vaultCap: { timeoutMs: 300_000, maxAttempts: 2 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.timeoutMs).toBe(300_000);
    expect(result.value.maxAttempts).toBe(2);
  });

  test("adoption rejects llm execution class", () => {
    const result = resolveExecutionPolicy({
      phase: "adoption",
      request: { class: "llm", timeoutMs: 600_000 },
      vaultCap: undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("execution-policy.phase-class-denied");
  });

  test("default class table keeps llm separate from background", () => {
    expect(DEFAULT_EXECUTION_POLICY_BY_CLASS.background.timeoutMs).toBe(120_000);
    expect(DEFAULT_EXECUTION_POLICY_BY_CLASS.llm.timeoutMs).toBe(600_000);
  });
});
