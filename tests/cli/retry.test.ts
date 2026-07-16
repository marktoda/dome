import { afterEach, describe, expect, test } from "bun:test";

import { runRetry } from "../../src/cli/commands/retry";
import type {
  ModelProvider,
  ModelStepProvider,
} from "../../src/engine/core/model-invoke";
import type { HomeModelRuntime } from "../../src/product-host/home-model-provider";
import type { Vault } from "../../src/vault";

const originalLog = console.log;
const originalError = console.error;

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

function completed(
  diagnostics: ReadonlyArray<{
    severity: "info" | "warning" | "error" | "block";
    code: string;
    message: string;
  }> = [],
) {
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
    console.log = () => {};
    console.error = () => {};

    const exit = await runRetry(
      { processorId: "dome.agent.brief", vault: "/tmp/test" },
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
