import { afterEach, describe, expect, test } from "bun:test";

import { runRetry } from "../../src/cli/commands/retry";
import type {
  ModelProvider,
  ModelStepProvider,
} from "../../src/engine/core/model-invoke";
import type { HomeModelRuntime } from "../../src/product-host/home-model-provider";
import type { RetryScheduledProcessorResult, Vault } from "../../src/vault";

const originalLog = console.log;
const originalError = console.error;

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

type CompletedResult = Extract<
  RetryScheduledProcessorResult,
  { readonly kind: "completed" }
>;

function completed(
  diagnostics: ReadonlyArray<{
    severity: "info" | "warning" | "error" | "block";
    code: string;
    message: string;
  }> = [],
  overrides: Partial<CompletedResult> = {},
): CompletedResult {
  return {
    kind: "completed" as const,
    processorId: "dome.agent.brief",
    runId: "run_1_abcdef" as never,
    executionStatus: "succeeded" as const,
    executionError: null,
    routing: {
      authorizedPatchCount: 1,
      spawnedPatchCount: 1,
      rejectedPatchCount: 0,
    },
    diagnostics,
    subProposals: { attempted: 1, adopted: 1, blocked: 0 },
    adopted: "a".repeat(40) as never,
    ...overrides,
  };
}

describe("dome retry", () => {
  test("injects Home's Keychain-backed model runtime into the Vault open", async () => {
    const provider = (async () => ({ text: "unused", usage: null })) as ModelProvider;
    const stepProvider = (async () => ({
      text: "unused",
      toolCalls: [],
      usage: null,
    })) as ModelStepProvider;
    let openedWith: unknown = null;
    let closed = false;
    const vault = {
      retryScheduled: async () => completed(),
      close: async () => {
        closed = true;
      },
    } as unknown as Vault;
    const output: string[] = [];
    console.log = (...parts: unknown[]) => output.push(parts.join(" "));
    console.error = (...parts: unknown[]) => output.push(parts.join(" "));

    const exit = await runRetry(
      {
        processorId: "dome.agent.brief",
        vault: "/tmp/test-home-vault",
        json: true,
      },
      {
        resolveModel: async (): Promise<HomeModelRuntime> => Object.freeze({
          configuration: "shipped-anthropic",
          credential: "present",
          modelState: "ready",
          probe: null,
          detail: null,
          modelProvider: provider,
          modelStepProvider: stepProvider,
        }),
        open: async (options) => {
          openedWith = options;
          return { ok: true as const, value: vault };
        },
      },
    );

    expect(exit).toBe(0);
    expect(openedWith).toMatchObject({
      path: "/tmp/test-home-vault",
      modelProvider: provider,
      modelStepProvider: stepProvider,
    });
    expect(closed).toBe(true);
    expect(JSON.parse(output[0]!)).toMatchObject({
      schema: "dome.retry/v1",
      status: "succeeded",
      processorId: "dome.agent.brief",
    });
  });

  test("returns nonzero when a handled processor warning says recovery failed", async () => {
    const vault = {
      retryScheduled: async () => completed([{
        severity: "warning",
        code: "dome.agent.brief-failed",
        message: "provider still unavailable",
      }]),
      close: async () => {},
    } as unknown as Vault;
    const output: string[] = [];
    console.log = (...parts: unknown[]) => output.push(parts.join(" "));
    console.error = () => {};

    const exit = await runRetry(
      { processorId: "dome.agent.brief", vault: "/tmp/test", json: true },
      {
        resolveModel: async () => Object.freeze({
          configuration: "missing" as const,
          credential: "not-managed" as const,
          modelState: "unconfigured" as const,
          probe: null,
          detail: null,
        }),
        open: async () => ({ ok: true as const, value: vault }),
      },
    );

    expect(exit).toBe(1);
    expect(JSON.parse(output[0]!).reason).toContain(
      "dome.agent.brief-failed: provider still unavailable",
    );
  });

  test("names blocked, rejected, and quarantined recovery reasons", async () => {
    const cases: ReadonlyArray<{
      readonly result: CompletedResult;
      readonly reason: string;
    }> = [
      {
        result: completed([], {
          subProposals: { attempted: 1, adopted: 0, blocked: 1 },
        }),
        reason: "generated change proposal(s) were blocked",
      },
      {
        result: completed([], {
          routing: {
            authorizedPatchCount: 0,
            spawnedPatchCount: 0,
            rejectedPatchCount: 1,
          },
          subProposals: { attempted: 0, adopted: 0, blocked: 0 },
        }),
        reason: "patch effect(s) were rejected",
      },
      {
        result: completed([], {
          executionStatus: "skipped",
          executionError: {
            code: "processor.quarantined",
            message: "processor is quarantined after repeated failures",
            retryable: false,
            phase: "garden",
            processorId: "dome.agent.brief",
          },
          routing: {
            authorizedPatchCount: 0,
            spawnedPatchCount: 0,
            rejectedPatchCount: 0,
          },
          subProposals: { attempted: 0, adopted: 0, blocked: 0 },
        }),
        reason: "processor.quarantined: processor is quarantined",
      },
    ];

    for (const entry of cases) {
      const output: string[] = [];
      console.log = (...parts: unknown[]) => output.push(parts.join(" "));
      console.error = () => {};
      const vault = {
        retryScheduled: async () => entry.result,
        close: async () => {},
      } as unknown as Vault;
      const exit = await runRetry(
        { processorId: "dome.agent.brief", vault: "/tmp/test", json: true },
        {
          resolveModel: async () => Object.freeze({
            configuration: "missing" as const,
            credential: "not-managed" as const,
            modelState: "unconfigured" as const,
            probe: null,
            detail: null,
          }),
          open: async () => ({ ok: true as const, value: vault }),
        },
      );
      expect(exit).toBe(1);
      expect(JSON.parse(output[0]!).reason).toContain(entry.reason);
    }
  });

  test("leaves custom providers to the normal Vault environment", async () => {
    const customProvider = (async () => ({
      text: "unused",
      usage: null,
    })) as ModelProvider;
    let openedWith: unknown = null;
    const vault = {
      retryScheduled: async () => completed(),
      close: async () => {},
    } as unknown as Vault;
    console.log = () => {};
    console.error = () => {};

    const exit = await runRetry(
      { processorId: "dome.agent.brief", vault: "/tmp/custom-provider" },
      {
        resolveModel: async () => Object.freeze({
          configuration: "custom" as const,
          credential: "not-managed" as const,
          modelState: "ready" as const,
          probe: null,
          detail: null,
          modelProvider: customProvider,
        }),
        open: async (options) => {
          openedWith = options;
          return { ok: true as const, value: vault };
        },
      },
    );

    expect(exit).toBe(0);
    expect(openedWith).toEqual({ path: "/tmp/custom-provider" });
  });
});
