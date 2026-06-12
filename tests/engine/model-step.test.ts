import { describe, expect, test } from "bun:test";
import { modelInvokeForProcessor } from "../../src/engine/core/model-invoke";
import type {
  ModelStepProvider,
} from "../../src/engine/core/model-invoke";
import type { Capability } from "../../src/core/processor";

// A ResolvedExecutionPolicy fixture. Mirror the one in the existing
// model-invoke tests (same fields used by the text path).
const policy = { timeoutMs: 1000, modelCallTimeoutMs: 1000 } as never;

const modelCap: Capability = { kind: "model.invoke", maxDailyCostUsd: 5 };

function build(opts: {
  provider?: (request: { prompt: string }) => Promise<{ text: string }>;
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
    ...(opts.provider !== undefined ? { provider: opts.provider as never } : {}),
    ...(opts.stepProvider !== undefined ? { stepProvider: opts.stepProvider } : {}),
    ...(opts.onUse !== undefined
      ? { onCapabilityUse: (u: { outcome: "allowed" | "denied" }) => opts.onUse?.({ outcome: u.outcome }) }
      : {}),
    spentUsdTodayByProcessor: () => opts.spent ?? 0,
    spentUsdTodayByExtension: () => opts.spent ?? 0,
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

  test("step is undefined when NO provider is wired at all", () => {
    // No provider, no step provider — the processor's `step === undefined`
    // silent no-op is the intended posture; doctor's model.provider-missing
    // carries the signal.
    const fn = build({});
    expect(fn?.step).toBeUndefined();
  });

  test("text-only wiring attaches a THROWING step, not an undefined one", async () => {
    // A provider exists but no step provider: an in-process host wired a
    // text-only model. Silence here would make agent processors no-op
    // forever with nothing reporting it; instead the step entry point
    // exists and fails loudly with a typed denial the processors' existing
    // error paths surface as diagnostics.
    const fn = build({ provider: async () => ({ text: "ok" }) });
    expect(fn?.step).toBeDefined();
    expect(
      fn!.step!({
        messages: [{ role: "user", content: "go" }],
        tools: [],
      }),
    ).rejects.toThrow(/does not support tool-step/);
  });

  test("step denies when the daily budget is already spent", async () => {
    const stepProvider: ModelStepProvider = async () => ({ text: "done" });
    const fn = build({ stepProvider, spent: 99 });
    await expect(
      fn!.step!({ messages: [{ role: "user", content: "go" }], tools: [] }),
    ).rejects.toThrow(/budget/i);
  });

  // The step path carries the same guard rail as the text path: per-call
  // timeout, response validation, and one retryable-provider retry. It used
  // to call the provider bare.

  test("step enforces the per-call timeout (model.invoke.timeout)", async () => {
    const stepProvider: ModelStepProvider = () =>
      new Promise(() => {
        // never resolves
      });
    const fn = modelInvokeForProcessor({
      phase: "garden",
      processorId: "test.agent",
      declared: [modelCap],
      granted: [modelCap],
      policy: { timeoutMs: 1000, modelCallTimeoutMs: 25 } as never,
      signal: new AbortController().signal,
      stepProvider,
      spentUsdTodayByProcessor: () => 0,
      spentUsdTodayByExtension: () => 0,
    });
    await expect(
      fn!.step!({ messages: [{ role: "user", content: "go" }], tools: [] }),
    ).rejects.toThrow(/per-call timeout/);
  });

  test("step validates the provider response shape", async () => {
    const stepProvider = (async () => ({
      toolCalls: "not-an-array",
    })) as unknown as ModelStepProvider;
    const fn = build({ stepProvider });
    await expect(
      fn!.step!({ messages: [{ role: "user", content: "go" }], tools: [] }),
    ).rejects.toThrow(/invalid response/);
  });

  test("step retries ONE retryable provider failure, then succeeds", async () => {
    let calls = 0;
    const uses: string[] = [];
    const stepProvider: ModelStepProvider = async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient provider hiccup");
      return { text: "done" };
    };
    const fn = build({ stepProvider, onUse: (u) => uses.push(u.outcome) });
    const result = await fn!.step!({
      messages: [{ role: "user", content: "go" }],
      tools: [],
    });
    expect(result.text).toBe("done");
    expect(calls).toBe(2);
    // One capability-use row per attempt, mirroring the text path.
    expect(uses.filter((u) => u === "allowed")).toHaveLength(2);
  });

  // Per-processor model routing (dome.agent model_overrides / dome.warden
  // model_override) rides the existing step({model}) field. These two tests
  // pin the allowlist semantics that routing leans on: with NO modelAllowlist
  // on either the declared or granted capability (the dome.agent/dome.warden
  // manifests declare none), an arbitrary requested model flows to the
  // provider unchecked; when an allowlist IS granted, an out-of-list override
  // is denied — routing cannot bypass the allowlist.

  test("step passes an arbitrary requested model through when NO allowlist is declared", async () => {
    const seen: Array<string | undefined> = [];
    const stepProvider: ModelStepProvider = async (request) => {
      seen.push(request.model);
      return { text: "done" };
    };
    const fn = build({ stepProvider });
    const result = await fn!.step!({
      messages: [{ role: "user", content: "go" }],
      tools: [],
      model: "claude-haiku-4-5",
    });
    expect(result.text).toBe("done");
    expect(seen).toEqual(["claude-haiku-4-5"]);
  });

  test("step denies a requested model outside the declared ∩ granted allowlist", async () => {
    const stepProvider: ModelStepProvider = async () => ({ text: "done" });
    const fn = modelInvokeForProcessor({
      phase: "garden",
      processorId: "test.agent",
      declared: [{ kind: "model.invoke" }],
      granted: [{ kind: "model.invoke", modelAllowlist: ["claude-sonnet-4-6"] }],
      policy,
      signal: new AbortController().signal,
      stepProvider,
      spentUsdTodayByProcessor: () => 0,
      spentUsdTodayByExtension: () => 0,
    });
    await expect(
      fn!.step!({
        messages: [{ role: "user", content: "go" }],
        tools: [],
        model: "claude-haiku-4-5",
      }),
    ).rejects.toThrow(/denied model 'claude-haiku-4-5'/);
  });

  test("step does NOT retry a second consecutive provider failure", async () => {
    let calls = 0;
    const stepProvider: ModelStepProvider = async () => {
      calls += 1;
      throw new Error("still down");
    };
    const fn = build({ stepProvider });
    await expect(
      fn!.step!({ messages: [{ role: "user", content: "go" }], tools: [] }),
    ).rejects.toThrow(/still down/);
    expect(calls).toBe(2);
  });
});
