import { describe, expect, test } from "bun:test";
import { modelInvokeForProcessor } from "../../src/engine/model-invoke";
import type {
  ModelStepProvider,
} from "../../src/engine/model-invoke";
import type { Capability } from "../../src/core/processor";

// A ResolvedExecutionPolicy fixture. Mirror the one in the existing
// model-invoke tests (same fields used by the text path).
const policy = { timeoutMs: 1000, modelCallTimeoutMs: 1000 } as never;

const modelCap: Capability = { kind: "model.invoke", maxDailyCostUsd: 5 };

function build(opts: {
  stepProvider?: ModelStepProvider;
  spent?: number;
  onUse?: (use: { outcome: "allowed" | "denied" }) => void;
}) {
  return modelInvokeForProcessor({
    phase: "garden",
    processorId: "test.agent",
    declared: [modelCap],
    granted: [modelCap],
    policy,
    signal: new AbortController().signal,
    ...(opts.stepProvider !== undefined ? { stepProvider: opts.stepProvider } : {}),
    ...(opts.onUse !== undefined
      ? { onCapabilityUse: (u: { outcome: "allowed" | "denied" }) => opts.onUse?.({ outcome: u.outcome }) }
      : {}),
    spentUsdToday: () => opts.spent ?? 0,
  });
}

describe("modelInvokeForProcessor.step", () => {
  test("returns provider tool calls and records an allowed capability use", async () => {
    const uses: string[] = [];
    const stepProvider: ModelStepProvider = async () => ({
      toolCalls: [{ id: "c1", name: "readPage", input: { path: "a.md" } }],
    });
    const fn = build({ stepProvider, onUse: (u) => uses.push(u.outcome) });
    expect(fn?.step).toBeDefined();
    const result = await fn!.step!({
      messages: [{ role: "user", content: "go" }],
      tools: [{ name: "readPage", description: "", inputSchema: {} }],
    });
    expect(result.toolCalls?.[0]?.name).toBe("readPage");
    expect(uses).toContain("allowed");
  });

  test("step is undefined when no step provider is wired", () => {
    const fn = build({});
    expect(fn?.step).toBeUndefined();
  });

  test("step denies when the daily budget is already spent", async () => {
    const stepProvider: ModelStepProvider = async () => ({ text: "done" });
    const fn = build({ stepProvider, spent: 99 });
    await expect(
      fn!.step!({ messages: [{ role: "user", content: "go" }], tools: [] }),
    ).rejects.toThrow(/budget/i);
  });
});
