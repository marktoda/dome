# Autonomous Agent Framework + Ingest Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class autonomous-agent capability to Dome — a garden-phase processor that runs a true tool-use loop against the vault and lands its edits as a PatchEffect — and ship the inbox-ingest agent as its first instance, retiring `dome.intake`.

**Architecture:** Generalize Dome's model seam by one step (`ctx.modelInvoke.step` — messages + tool schemas → tool-calls | text), provider-neutral and broker-accounted. The agent *loop* lives in the `dome.agent` bundle (calls `ctx.modelInvoke.step`, executes tool calls against `ctx.snapshot`, accumulates edits → one PatchEffect). The vendor LLM SDK never enters core. An "agent" is data — `AgentDefinition { charter, trigger, tools }` — so future agents (synthesizer, research) are new charters on the same harness. The capability *grant* is the single write boundary.

**Tech Stack:** TypeScript + Bun; Zod for boundary schemas; the Anthropic Messages API (tools) in the vault's `.dome/model-provider.ts`. Tests are `bun test`.

**Spec:** `docs/superpowers/specs/2026-06-08-autonomous-agents-ingest-design.md`

**Phases (each ends green + committable):**
1. Model step seam (D3) — core types + `ctx.modelInvoke.step` + command-provider v2 + runtime wiring.
2. The `dome.agent` framework — the loop harness.
3. The ingest agent — charter, tools, manifest, processor.
4. Retire `dome.intake` + maintenance-loops/default-config/test wiring + the init provider template.
5. Vault migration + provider step impl + docs cleanup (work vault).

> **Decision flagged for the reviewer (Phase 1 Task 3 / Phase 5):** the model-provider *step* is implemented with the **raw Anthropic Messages API via `fetch`** — extending the existing `fetch`-based provider, zero new dependencies, and the Messages API natively supports `tools`/`tool_use`. The Vercel AI SDK (`ai` + `@ai-sdk/anthropic`) is a drop-in alternative, isolated entirely to `.dome/model-provider.ts`; swap it in if preferred. Either way Dome owns the loop, so the SDK's loop machinery isn't what's being reused — only the one-shot tool-calling request. Raw `fetch` is the lighter, more consistent choice and is what this plan codes.

---

## File Structure

**Phase 1 (core seam):**
- Modify `src/core/processor.ts` — add `ModelMessage`, `ModelToolSchema`, `ModelToolCall`, `ModelStepInput`, `ModelStepResult`; extend `ModelInvokeFn` with optional `step`.
- Modify `src/engine/model-invoke.ts` — add `ModelStepRequest`/`ModelStepResponse`/`ModelStepProvider` + step-response schema; extend `modelInvokeForProcessor` to accept `stepProvider?` and attach `.step`.
- Modify `src/engine/command-model-provider.ts` — add `buildCommandModelStepProvider` + the `dome.model-provider.step/v1` wire schema.
- Modify `src/processors/runtime.ts` — thread `modelStepProvider` into `buildExecutionContext` → `modelInvokeForProcessor`.
- Modify `src/engine/vault-runtime.ts` — build the step provider next to the text provider.
- Tests: `tests/engine/model-step.test.ts`, `tests/engine/command-model-step-provider.test.ts`.

**Phase 2 (framework):**
- Create `assets/extensions/dome.agent/lib/agent-loop.ts` — the harness.
- Test: `tests/extensions/dome.agent/agent-loop.test.ts`.

**Phase 3 (ingest agent):**
- Create `assets/extensions/dome.agent/lib/ingest-charter.ts` — the charter string.
- Create `assets/extensions/dome.agent/lib/ingest-tools.ts` — the tool bindings.
- Create `assets/extensions/dome.agent/processors/ingest.ts` — the processor.
- Create `assets/extensions/dome.agent/processors/inbox-stale-check.ts` — moved from `dome.intake`.
- Create `assets/extensions/dome.agent/manifest.yaml`.
- Tests: `tests/extensions/dome.agent/ingest.test.ts`.

**Phase 4 (retire + wire):**
- Delete `assets/extensions/dome.intake/`.
- Modify `src/extensions/maintenance-loops.ts`, `src/cli/default-vault-config.ts`, `src/cli/commands/init.ts`.
- Modify tests: `tests/extensions/maintenance-loops.test.ts`, `tests/cli/commands.test.ts`, and any inventory tests.

**Phase 5 (vault, manual):**
- `~/vaults/work/.dome/model-provider.ts`, `~/vaults/work/.dome/config.yaml`, `~/vaults/work/CLAUDE.md`, `~/vaults/work/AGENTS.md`.

---

# Phase 1 — Model step seam (D3)

### Task 1.1: Add message/tool/step types to core + extend `ModelInvokeFn`

**Files:**
- Modify: `src/core/processor.ts` (after the `ModelInvokeFn` block, lines 342-367)

- [ ] **Step 1: Add the types and extend `ModelInvokeFn`.** Replace the existing `ModelInvokeFn` type (lines 362-367) with the block below (adds the new types *before* it and the `step` field *on* it):

```typescript
// ----- Tool-use step (agent loop) -------------------------------------------

/** A message in a tool-use exchange. Provider-neutral; the engine maps it to
 * the configured provider's wire format. */
export type ModelMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls?: ReadonlyArray<ModelToolCall>;
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly content: string;
    };

/** A tool the model may call. `inputSchema` is a JSON Schema object. */
export type ModelToolSchema = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
};

/** A single tool call the model requested. `input` is unvalidated provider JSON. */
export type ModelToolCall = {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
};

/** Input to one tool-use step. */
export type ModelStepInput = {
  readonly messages: ReadonlyArray<ModelMessage>;
  readonly tools: ReadonlyArray<ModelToolSchema>;
  readonly model?: string;
};

/** Result of one tool-use step: either tool calls to execute, or final text. */
export type ModelStepResult = {
  readonly toolCalls?: ReadonlyArray<ModelToolCall>;
  readonly text?: string;
};

export type ModelInvokeFn = {
  (input: ModelInvokeTextInput): Promise<string>;
  readonly structured: <T>(
    input: ModelInvokeStructuredInput<T>,
  ) => Promise<T>;
  /** One tool-use step. Present only when the runtime wired a step provider.
   * The loop itself lives in caller code (e.g. the dome.agent harness). */
  readonly step?: (input: ModelStepInput) => Promise<ModelStepResult>;
};
```

- [ ] **Step 2: Verify it compiles.**

Run: `bun run tsc --noEmit` (or the repo's typecheck script — check `package.json` `scripts`; commonly `bun run typecheck`)
Expected: no new type errors.

- [ ] **Step 3: Commit.**

```bash
git add src/core/processor.ts
git commit -m "feat(core): add tool-use step types + optional ModelInvokeFn.step"
```

---

### Task 1.2: Provider types + budget-checked `.step` in `modelInvokeForProcessor`

**Files:**
- Modify: `src/engine/model-invoke.ts`
- Test: `tests/engine/model-step.test.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/engine/model-step.test.ts`:

```typescript
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
    onCapabilityUse: opts.onUse
      ? (u) => opts.onUse?.({ outcome: u.outcome })
      : undefined,
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
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `bun test tests/engine/model-step.test.ts`
Expected: FAIL — `ModelStepProvider` not exported / `fn.step` undefined.

- [ ] **Step 3: Implement.** In `src/engine/model-invoke.ts`:

(a) Add imports — extend the existing `import type { ... } from "../core/processor"` (lines 3-9) to also import `ModelMessage`, `ModelStepInput`, `ModelStepResult`, `ModelToolCall`, `ModelToolSchema`.

(b) Add the provider types after `ModelProvider` (after line 41):

```typescript
export type ModelStepRequest = {
  readonly messages: ReadonlyArray<ModelMessage>;
  readonly tools: ReadonlyArray<ModelToolSchema>;
  readonly model?: string;
  readonly signal: AbortSignal;
};

export type ModelStepResponse = {
  readonly toolCalls?: ReadonlyArray<ModelToolCall>;
  readonly text?: string;
  readonly model?: string;
  readonly costUsd?: number;
};

export type ModelStepProvider = (
  request: ModelStepRequest,
) => Promise<ModelStepResponse>;

const ModelStepResponseSchema = z.object({
  toolCalls: z
    .array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          input: z.unknown(),
        })
        .strip(),
    )
    .optional(),
  text: z.string().optional(),
  model: z.string().optional(),
  costUsd: z.number().finite().nonnegative().optional(),
});

export function parseModelStepResponse(response: unknown): ModelStepResponse {
  const parsed = ModelStepResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw invalidProviderResponse(modelProviderResponseError(parsed.error));
  }
  const value = parsed.data;
  return Object.freeze({
    ...(value.toolCalls !== undefined
      ? { toolCalls: Object.freeze(value.toolCalls.map((c) => Object.freeze(c))) }
      : {}),
    ...(value.text !== undefined ? { text: value.text } : {}),
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(value.costUsd !== undefined ? { costUsd: value.costUsd } : {}),
  });
}
```

(c) Add `stepProvider?: ModelStepProvider` to the `modelInvokeForProcessor` opts object (after `provider?` on line 62).

(d) Inside `modelInvokeForProcessor`, before `return Object.freeze(fn);` (line 127), build and attach `.step`:

```typescript
  if (opts.stepProvider !== undefined) {
    const stepProvider = opts.stepProvider;
    const invokeStep = async (
      input: ModelStepInput,
    ): Promise<ModelStepResult> => {
      let model: string | undefined;
      try {
        model = resolveStepModel(input.model, modelPolicy);
        enforceBudgetBeforeCall(modelPolicy, opts.spentUsdToday);
      } catch (error) {
        recordModelCapabilityUse(opts.onCapabilityUse, {
          resource: input.model ?? null,
          outcome: "denied",
        });
        throw error;
      }
      recordModelCapabilityUse(opts.onCapabilityUse, {
        resource: model ?? null,
        outcome: "allowed",
      });
      const response = await stepProvider({
        messages: input.messages,
        tools: input.tools,
        ...(model !== undefined ? { model } : {}),
        signal: opts.signal,
      });
      if (
        response.costUsd !== undefined &&
        Number.isFinite(response.costUsd) &&
        response.costUsd > 0
      ) {
        opts.onCost?.(response.costUsd);
        enforceBudgetAfterCall(modelPolicy, opts.spentUsdToday);
      }
      return Object.freeze({
        ...(response.toolCalls !== undefined
          ? { toolCalls: response.toolCalls }
          : {}),
        ...(response.text !== undefined ? { text: response.text } : {}),
      });
    };
    Object.defineProperty(fn, "step", { value: invokeStep, enumerable: true });
  }
```

(e) Add the `resolveStepModel` helper near `normalizeRequest` (it reuses the allowlist logic without the prompt check):

```typescript
function resolveStepModel(
  requested: string | undefined,
  policy: EffectiveModelPolicy,
): string | undefined {
  if (policy.allowlist === null) return requested;
  if (policy.allowlist.length === 0) {
    throw modelError(
      "model.invoke.denied",
      "model.invoke has no model allowed by both declaration and grant.",
      false,
    );
  }
  const model = requested ?? policy.allowlist[0];
  if (model === undefined || !policy.allowlist.includes(model)) {
    throw modelError(
      "model.invoke.denied",
      `model.invoke denied model '${String(model)}'; allowed models: ${policy.allowlist.join(", ")}`,
      false,
    );
  }
  return model;
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `bun test tests/engine/model-step.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full model-invoke suite to confirm no regressions.**

Run: `bun test tests/engine/model-invoke.test.ts tests/engine/model-step.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/engine/model-invoke.ts tests/engine/model-step.test.ts
git commit -m "feat(engine): budget-checked ctx.modelInvoke.step via injected step provider"
```

---

### Task 1.3: Command step provider (`dome.model-provider.step/v1`)

**Files:**
- Modify: `src/engine/command-model-provider.ts`
- Test: `tests/engine/command-model-step-provider.test.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/engine/command-model-step-provider.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommandModelStepProvider } from "../../src/engine/command-model-provider";

function fakeProviderScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "dome-step-"));
  const path = join(dir, "provider.ts");
  // Echoes a tool call back; asserts it received the step schema.
  writeFileSync(
    path,
    [
      "const req = JSON.parse(await Bun.stdin.text());",
      "if (req.schema !== 'dome.model-provider.step/v1') { console.error('bad schema'); process.exit(1); }",
      "process.stdout.write(JSON.stringify({",
      "  toolCalls: [{ id: 'c1', name: 'readPage', input: { path: 'a.md' } }],",
      "  costUsd: 0.001,",
      "}));",
    ].join("\n"),
  );
  return path;
}

describe("buildCommandModelStepProvider", () => {
  test("sends the step schema and parses tool calls", async () => {
    const provider = buildCommandModelStepProvider({
      kind: "command",
      command: ["bun", fakeProviderScript()],
    });
    const res = await provider({
      messages: [{ role: "user", content: "go" }],
      tools: [{ name: "readPage", description: "read", inputSchema: {} }],
      signal: new AbortController().signal,
    });
    expect(res.toolCalls?.[0]?.name).toBe("readPage");
    expect(res.costUsd).toBeCloseTo(0.001);
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `bun test tests/engine/command-model-step-provider.test.ts`
Expected: FAIL — `buildCommandModelStepProvider` not exported.

- [ ] **Step 3: Implement.** In `src/engine/command-model-provider.ts`:

(a) Extend the imports (lines 2-7) to also import `parseModelStepResponse`, `type ModelStepProvider`, `type ModelStepRequest`, `type ModelStepResponse`.

(b) Add after line 9:

```typescript
const STEP_REQUEST_SCHEMA = "dome.model-provider.step/v1";

type CommandModelStepRequest = {
  readonly schema: typeof STEP_REQUEST_SCHEMA;
  readonly messages: ModelStepRequest["messages"];
  readonly tools: ModelStepRequest["tools"];
  readonly model?: string;
};
```

(c) Add the builder + invoker after `buildCommandModelProvider` (after line 23):

```typescript
export function buildCommandModelStepProvider(
  config: CommandModelProviderConfig,
  opts: { readonly cwd?: string } = {},
): ModelStepProvider {
  return async (request) => invokeCommandStepProvider(config, request, opts);
}

async function invokeCommandStepProvider(
  config: CommandModelProviderConfig,
  request: ModelStepRequest,
  opts: { readonly cwd?: string },
): Promise<ModelStepResponse> {
  if (request.signal.aborted) {
    throw new Error("model provider command was aborted before it started");
  }
  const proc = Bun.spawn([...config.command], {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const onAbort = (): void => {
    proc.kill();
  };
  request.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const payload: CommandModelStepRequest = {
      schema: STEP_REQUEST_SCHEMA,
      messages: request.messages,
      tools: request.tools,
      ...(request.model !== undefined ? { model: request.model } : {}),
    };
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `model provider command exited ${exitCode}${formatStderr(stderr)}`,
      );
    }
    return parseStepResponse(stdout);
  } finally {
    request.signal.removeEventListener("abort", onAbort);
  }
}

function parseStepResponse(stdout: string): ModelStepResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `model provider command returned invalid JSON: ${messageFor(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("model provider command response must be a JSON object");
  }
  return parseModelStepResponse(parsed);
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `bun test tests/engine/command-model-step-provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/engine/command-model-provider.ts tests/engine/command-model-step-provider.test.ts
git commit -m "feat(engine): command step provider (dome.model-provider.step/v1)"
```

---

### Task 1.4: Wire the step provider through the runtime

**Files:**
- Modify: `src/engine/vault-runtime.ts` (the `buildModelProvider` helper + `BuildRuntimeOptions`/dispatch threading)
- Modify: `src/processors/runtime.ts` (`buildExecutionContext` → `modelInvokeForProcessor`)

> This task is integration plumbing: thread one new optional value (`modelStepProvider`) alongside the existing `modelProvider`. There is no new behavior to unit-test in isolation beyond Tasks 1.2/1.3; correctness is verified by the Phase 3 ingest tests (which run a real `ctx.modelInvoke.step`) and the existing runtime suite staying green.

- [ ] **Step 1: vault-runtime — build the step provider.** In `src/engine/vault-runtime.ts`, extend the imports to include `buildCommandModelStepProvider` and `type ModelStepProvider`. Update the `buildModelProvider` helper (the function that switches on `provider.kind`) to also return a step provider. Change its return type to `{ text?: ModelProvider; step?: ModelStepProvider } | undefined` and the `command` case to:

```typescript
    case "command":
      return {
        text: buildCommandModelProvider(provider, { cwd: vaultPath }),
        step: buildCommandModelStepProvider(provider, { cwd: vaultPath }),
      };
```

Update its single call site: where the result was passed as `modelProvider`, pass `built?.text` as `modelProvider` and `built?.step` as `modelStepProvider` into `buildRuntime(...)`. (Search `buildModelProvider(` in this file to find the call site; it currently assigns to a `modelProvider` field on the runtime options object — add a sibling `modelStepProvider`.)

- [ ] **Step 2: runtime — accept and thread `modelStepProvider`.** In `src/processors/runtime.ts`:
  - In `BuildRuntimeOptions` (the type for `buildRuntime`'s options, near line 306) add `readonly modelStepProvider?: ModelStepProvider;` and import `type ModelStepProvider` from `../engine/model-invoke`.
  - In `DispatchOneProcessorOptions` add the same optional field, and thread it wherever `modelProvider` is threaded (search `modelProvider` in this file — pass `modelStepProvider` alongside it through `dispatchOneProcessor`).
  - In `buildExecutionContext` (line ~986), in the `modelInvokeForProcessor({ ... })` call, add after the `provider` spread:

```typescript
        ...(opts.modelStepProvider !== undefined
          ? { stepProvider: opts.modelStepProvider }
          : {}),
```

- [ ] **Step 3: Typecheck + run the runtime/engine suites.**

Run: `bun run tsc --noEmit && bun test tests/processors tests/engine`
Expected: PASS (no regressions).

- [ ] **Step 4: Commit.**

```bash
git add src/engine/vault-runtime.ts src/processors/runtime.ts
git commit -m "feat(engine): thread model step provider through runtime to ctx.modelInvoke.step"
```

---

# Phase 2 — The `dome.agent` framework (loop harness)

### Task 2.1: The agent-loop harness

**Files:**
- Create: `assets/extensions/dome.agent/lib/agent-loop.ts`
- Test: `tests/extensions/dome.agent/agent-loop.test.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/extensions/dome.agent/agent-loop.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
  runAgentLoop,
  type AgentTool,
  type ModelStepFn,
} from "../../../assets/extensions/dome.agent/lib/agent-loop";

function scriptedStep(
  responses: ReadonlyArray<Awaited<ReturnType<ModelStepFn>>>,
): ModelStepFn {
  let i = 0;
  return async () => {
    const r = responses[i] ?? { text: "done" };
    i += 1;
    return r;
  };
}

const writePage: AgentTool = {
  schema: { name: "writePage", description: "write", inputSchema: {} },
  execute: async (input, state) => {
    const { path, content } = input as { path: string; content: string };
    state.edits.set(path, { kind: "write", path, content });
    return `wrote ${path}`;
  },
};

const askOwner: AgentTool = {
  schema: { name: "askOwner", description: "ask", inputSchema: {} },
  execute: async (input, state) => {
    const { question } = input as { question: string };
    state.questions.push({ question, idempotencyKey: `q:${question}` });
    return "asked";
  },
};

describe("runAgentLoop", () => {
  test("executes tool calls in order then stops on final text", async () => {
    const step = scriptedStep([
      {
        toolCalls: [
          { id: "1", name: "writePage", input: { path: "wiki/a.md", content: "A" } },
          { id: "2", name: "askOwner", input: { question: "ok?" } },
        ],
      },
      { text: "all done" },
    ]);
    const result = await runAgentLoop({
      charter: "c",
      task: "t",
      tools: [writePage, askOwner],
      step,
      maxSteps: 10,
    });
    expect(result.stopReason).toBe("final");
    expect(result.finalText).toBe("all done");
    expect(result.state.edits.get("wiki/a.md")).toEqual({
      kind: "write",
      path: "wiki/a.md",
      content: "A",
    });
    expect(result.state.questions[0]?.question).toBe("ok?");
  });

  test("stops at maxSteps and keeps accumulated edits", async () => {
    const step = scriptedStep([
      { toolCalls: [{ id: "1", name: "writePage", input: { path: "x.md", content: "X" } }] },
      { toolCalls: [{ id: "2", name: "writePage", input: { path: "y.md", content: "Y" } }] },
      { toolCalls: [{ id: "3", name: "writePage", input: { path: "z.md", content: "Z" } }] },
    ]);
    const result = await runAgentLoop({
      charter: "c", task: "t", tools: [writePage], step, maxSteps: 2,
    });
    expect(result.stopReason).toBe("budget");
    expect(result.steps).toBe(2);
    expect(result.state.edits.size).toBe(2);
  });

  test("unknown tool returns an error result without throwing", async () => {
    const step = scriptedStep([
      { toolCalls: [{ id: "1", name: "nope", input: {} }] },
      { text: "fine" },
    ]);
    const result = await runAgentLoop({
      charter: "c", task: "t", tools: [writePage], step, maxSteps: 5,
    });
    expect(result.stopReason).toBe("final");
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `bun test tests/extensions/dome.agent/agent-loop.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.** Create `assets/extensions/dome.agent/lib/agent-loop.ts`:

```typescript
// dome.agent — the autonomous-agent loop harness.
//
// Drives a true tool-use loop using an injected model-step function (in
// production, ctx.modelInvoke.step). The loop is provider-neutral: every step
// rides the model.invoke seam. Tools execute in-process and accumulate edits +
// questions into AgentRunState; the calling processor translates that state
// into a single PatchEffect + QuestionEffects. Injecting `step` is the test
// seam — no network in unit tests.

import type {
  ModelMessage,
  ModelStepInput,
  ModelStepResult,
  ModelToolSchema,
} from "../../../../src/core/processor";

export type AgentEdit =
  | { readonly kind: "write"; readonly path: string; readonly content: string }
  | { readonly kind: "delete"; readonly path: string };

export type AgentQuestion = {
  readonly question: string;
  readonly idempotencyKey: string;
};

/** Mutable accumulator threaded to every tool's execute. Last write per path wins. */
export type AgentRunState = {
  readonly edits: Map<string, AgentEdit>;
  readonly questions: AgentQuestion[];
};

export type AgentTool = {
  readonly schema: ModelToolSchema;
  readonly execute: (input: unknown, state: AgentRunState) => Promise<string>;
};

export type ModelStepFn = (input: ModelStepInput) => Promise<ModelStepResult>;

export type AgentRunResult = {
  readonly state: AgentRunState;
  readonly stopReason: "final" | "budget";
  readonly steps: number;
  readonly finalText: string | null;
};

export async function runAgentLoop(opts: {
  readonly charter: string;
  readonly task: string;
  readonly tools: ReadonlyArray<AgentTool>;
  readonly step: ModelStepFn;
  readonly maxSteps: number;
}): Promise<AgentRunResult> {
  const messages: ModelMessage[] = [
    { role: "system", content: opts.charter },
    { role: "user", content: opts.task },
  ];
  const state: AgentRunState = { edits: new Map(), questions: [] };
  const schemas = opts.tools.map((t) => t.schema);
  const toolByName = new Map(opts.tools.map((t) => [t.schema.name, t] as const));

  let steps = 0;
  while (steps < opts.maxSteps) {
    steps += 1;
    const resp = await opts.step({ messages, tools: schemas });
    const calls = resp.toolCalls ?? [];
    if (calls.length === 0) {
      return {
        state,
        stopReason: "final",
        steps,
        finalText: resp.text ?? null,
      };
    }
    messages.push({
      role: "assistant",
      content: resp.text ?? "",
      toolCalls: calls,
    });
    for (const call of calls) {
      const tool = toolByName.get(call.name);
      const content =
        tool === undefined
          ? `error: unknown tool "${call.name}"`
          : await runTool(tool, call.input, state);
      messages.push({
        role: "tool",
        toolCallId: call.id,
        toolName: call.name,
        content,
      });
    }
  }
  return { state, stopReason: "budget", steps, finalText: null };
}

async function runTool(
  tool: AgentTool,
  input: unknown,
  state: AgentRunState,
): Promise<string> {
  try {
    return await tool.execute(input, state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `error: ${message}`;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `bun test tests/extensions/dome.agent/agent-loop.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add assets/extensions/dome.agent/lib/agent-loop.ts tests/extensions/dome.agent/agent-loop.test.ts
git commit -m "feat(dome.agent): tool-use loop harness with injectable step seam"
```

---

# Phase 3 — The ingest agent

### Task 3.1: The ingest charter

**Files:**
- Create: `assets/extensions/dome.agent/lib/ingest-charter.ts`

- [ ] **Step 1: Create the charter** (no test — it's a constant string; covered indirectly by Task 3.3). Create `assets/extensions/dome.agent/lib/ingest-charter.ts`:

```typescript
// The ingest agent's charter (system prompt). Knowledge-integration first;
// task-routing opportunistic. The capability grant is the write boundary.

export const INGEST_CHARTER = [
  "You are Dome's ingest agent. A raw source has landed in the inbox. Integrate it into the vault's knowledge graph end-to-end, then consume the source. Work autonomously and finish in one run.",
  "",
  "## What to produce",
  "1. A source page at wiki/sources/<kebab-slug>.md — a faithful summary: key claims/findings, why it matters, and a `sources:` frontmatter entry. Use the page format below.",
  "2. For each person / org / project / protocol the source meaningfully discusses: create or UPDATE the relevant wiki/entities/<slug>.md page, weaving in the new knowledge. Merge and rewrite freely — git is the safety net.",
  "3. For each significant idea / pattern / technical topic: create or UPDATE wiki/concepts/<slug>.md.",
  "4. Bidirectional [[wikilinks]] between related pages (the source page links entities/concepts; those pages link back to the source).",
  "5. Update index.md: add new pages, refresh changed descriptions.",
  "6. Append one dated line to log.md summarizing what you did.",
  "7. Route action-items (only if the source contains real, still-open commitments) to task surfaces (see below).",
  "8. Call archiveSource on the raw inbox path when done.",
  "",
  "## Page format (every wiki/ page)",
  "Frontmatter with: type (entity|concept|source|synthesis), created (YYYY-MM-DD), updated (YYYY-MM-DD), sources (array of [[wikilinks]] to the informing source(s)). Then `# Title`, markdown body with [[wikilinks]], and a `## See Also` section.",
  "",
  "## No one-shot pages",
  "Only create a new entity/concept page when it recurs, is explicitly named, or is structurally needed. Otherwise fold the knowledge into an existing page. Do not create a page per passing mention.",
  "",
  "## Substrate vs. task",
  "Things that became TRUE are substrate -> wiki pages. Action items (\"I should follow up\", \"TODO\", \"I owe X\") are tasks -> task surfaces. If something is both, write both.",
  "",
  "## Task surfaces + format",
  "Tactical task -> append to today's daily note (path given in the task turn) under a `# Captured today` section. Durable follow-up on a person/project -> append under a `## Open threads` section on that entity page.",
  "Task line: `- [ ] #task <description> <priority?> <due?> <wikilink?>` where priority is one of 🔺⏫🔼🔽 (omit if none), due is `📅 YYYY-MM-DD` (omit if none), wikilink is `[[wiki/entities/<slug>]]` when tied to a person/project. The `#task` tag is REQUIRED — it is what surfaces the line.",
  "",
  "## Tools",
  "- readPage(path): read current content (or null).",
  "- listPages(): list all readable markdown paths.",
  "- searchVault(query): find existing pages related to a term before deciding create-vs-update.",
  "- writePage(path, content): create or fully replace a page. Read first when updating, then write the merged whole.",
  "- appendToPage(path, content): append a block to the end of an existing file (use for log.md and simple task appends).",
  "- archiveSource(rawPath): move the consumed inbox source out of inbox/raw.",
  "- askOwner(question): ask the owner when a claim is genuinely uncertain. Prefer integrating with a hedge over asking.",
  "",
  "Be decisive. Search before creating. Prefer updating existing pages over making new ones. When you have finished all integration and called archiveSource, reply with a one-line summary and no tool call.",
].join("\n");
```

- [ ] **Step 2: Commit.**

```bash
git add assets/extensions/dome.agent/lib/ingest-charter.ts
git commit -m "feat(dome.agent): ingest charter prompt"
```

---

### Task 3.2: The ingest tool bindings

**Files:**
- Create: `assets/extensions/dome.agent/lib/ingest-tools.ts`
- Test: `tests/extensions/dome.agent/ingest-tools.test.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/extensions/dome.agent/ingest-tools.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { makeIngestTools } from "../../../assets/extensions/dome.agent/lib/ingest-tools";
import type { AgentRunState } from "../../../assets/extensions/dome.agent/lib/agent-loop";

function freshState(): AgentRunState {
  return { edits: new Map(), questions: [] };
}

const reader = (files: Record<string, string>) => ({
  readFile: async (p: string) => files[p] ?? null,
  listMarkdownFiles: async () => Object.keys(files),
});

describe("ingest tools", () => {
  test("writePage accumulates a write edit", async () => {
    const tools = makeIngestTools({ reader: reader({}) });
    const t = tools.find((x) => x.schema.name === "writePage")!;
    const state = freshState();
    await t.execute({ path: "wiki/sources/a.md", content: "hi" }, state);
    expect(state.edits.get("wiki/sources/a.md")).toEqual({
      kind: "write", path: "wiki/sources/a.md", content: "hi",
    });
  });

  test("appendToPage appends to current snapshot content", async () => {
    const tools = makeIngestTools({ reader: reader({ "log.md": "line1" }) });
    const t = tools.find((x) => x.schema.name === "appendToPage")!;
    const state = freshState();
    await t.execute({ path: "log.md", content: "line2" }, state);
    const edit = state.edits.get("log.md");
    expect(edit?.kind === "write" && edit.content).toBe("line1\nline2");
  });

  test("archiveSource deletes the raw path and writes a processed copy", async () => {
    const tools = makeIngestTools({ reader: reader({ "inbox/raw/x.md": "body" }) });
    const t = tools.find((x) => x.schema.name === "archiveSource")!;
    const state = freshState();
    await t.execute({ rawPath: "inbox/raw/x.md" }, state);
    expect(state.edits.get("inbox/raw/x.md")).toEqual({
      kind: "delete", path: "inbox/raw/x.md",
    });
    const processed = state.edits.get("inbox/processed/x.md");
    expect(processed?.kind).toBe("write");
  });

  test("askOwner records a question", async () => {
    const tools = makeIngestTools({ reader: reader({}) });
    const t = tools.find((x) => x.schema.name === "askOwner")!;
    const state = freshState();
    await t.execute({ question: "is X true?" }, state);
    expect(state.questions[0]?.question).toBe("is X true?");
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `bun test tests/extensions/dome.agent/ingest-tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.** Create `assets/extensions/dome.agent/lib/ingest-tools.ts`:

```typescript
// Tool bindings for the ingest agent. Each tool's execute reads through the
// injected reader (ctx.snapshot in production) and mutates AgentRunState. The
// reader is the test seam.

import type { AgentRunState, AgentTool } from "./agent-loop";

export type VaultReader = {
  readonly readFile: (path: string) => Promise<string | null>;
  readonly listMarkdownFiles: () => Promise<ReadonlyArray<string>>;
};

const STRING = { type: "string" } as const;

function objectSchema(
  props: Record<string, unknown>,
  required: ReadonlyArray<string>,
): Readonly<Record<string, unknown>> {
  return { type: "object", properties: props, required, additionalProperties: false };
}

async function currentContent(
  path: string,
  state: AgentRunState,
  reader: VaultReader,
): Promise<string | null> {
  const pending = state.edits.get(path);
  if (pending?.kind === "write") return pending.content;
  if (pending?.kind === "delete") return null;
  return reader.readFile(path);
}

export function makeIngestTools(opts: {
  readonly reader: VaultReader;
}): ReadonlyArray<AgentTool> {
  const { reader } = opts;
  return [
    {
      schema: {
        name: "readPage",
        description: "Read a vault file's current content. Returns null if absent.",
        inputSchema: objectSchema({ path: STRING }, ["path"]),
      },
      execute: async (input, state) => {
        const { path } = input as { path: string };
        const content = await currentContent(path, state, reader);
        return content ?? `(no file at ${path})`;
      },
    },
    {
      schema: {
        name: "listPages",
        description: "List all readable markdown paths in the vault.",
        inputSchema: objectSchema({}, []),
      },
      execute: async () => (await reader.listMarkdownFiles()).join("\n"),
    },
    {
      schema: {
        name: "searchVault",
        description: "Find readable markdown paths whose content contains the query (case-insensitive).",
        inputSchema: objectSchema({ query: STRING }, ["query"]),
      },
      execute: async (input) => {
        const { query } = input as { query: string };
        const needle = query.toLowerCase();
        const hits: string[] = [];
        for (const path of await reader.listMarkdownFiles()) {
          const content = await reader.readFile(path);
          if (content !== null && content.toLowerCase().includes(needle)) {
            hits.push(path);
          }
          if (hits.length >= 25) break;
        }
        return hits.length === 0 ? "(no matches)" : hits.join("\n");
      },
    },
    {
      schema: {
        name: "writePage",
        description: "Create or fully replace a file. Read first when updating.",
        inputSchema: objectSchema({ path: STRING, content: STRING }, ["path", "content"]),
      },
      execute: async (input, state) => {
        const { path, content } = input as { path: string; content: string };
        state.edits.set(path, { kind: "write", path, content });
        return `wrote ${path}`;
      },
    },
    {
      schema: {
        name: "appendToPage",
        description: "Append a block to the end of a file (creates it if absent).",
        inputSchema: objectSchema({ path: STRING, content: STRING }, ["path", "content"]),
      },
      execute: async (input, state) => {
        const { path, content } = input as { path: string; content: string };
        const existing = await currentContent(path, state, reader);
        const next =
          existing === null || existing.trim() === ""
            ? content
            : `${existing.replace(/\s+$/, "")}\n${content}`;
        state.edits.set(path, { kind: "write", path, content: next });
        return `appended to ${path}`;
      },
    },
    {
      schema: {
        name: "archiveSource",
        description: "Move a consumed inbox/raw source to inbox/processed.",
        inputSchema: objectSchema({ rawPath: STRING }, ["rawPath"]),
      },
      execute: async (input, state) => {
        const { rawPath } = input as { rawPath: string };
        const body = (await currentContent(rawPath, state, reader)) ?? "";
        const processedPath = rawPath.replace(/^inbox\/raw\//, "inbox/processed/");
        state.edits.set(processedPath, {
          kind: "write",
          path: processedPath,
          content: body,
        });
        state.edits.set(rawPath, { kind: "delete", path: rawPath });
        return `archived ${rawPath} -> ${processedPath}`;
      },
    },
    {
      schema: {
        name: "askOwner",
        description: "Ask the owner a question when a claim is genuinely uncertain.",
        inputSchema: objectSchema({ question: STRING }, ["question"]),
      },
      execute: async (input, state) => {
        const { question } = input as { question: string };
        state.questions.push({
          question,
          idempotencyKey: `dome.agent.ingest:${question}`,
        });
        return "asked the owner";
      },
    },
  ];
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `bun test tests/extensions/dome.agent/ingest-tools.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit.**

```bash
git add assets/extensions/dome.agent/lib/ingest-tools.ts tests/extensions/dome.agent/ingest-tools.test.ts
git commit -m "feat(dome.agent): ingest tool bindings"
```

---

### Task 3.3: The ingest processor

**Files:**
- Create: `assets/extensions/dome.agent/processors/ingest.ts`
- Test: `tests/extensions/dome.agent/ingest.test.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/extensions/dome.agent/ingest.test.ts`. This drives the processor with a fake `ctx` whose `modelInvoke.step` is scripted:

```typescript
import { describe, expect, test } from "bun:test";
import ingest from "../../../assets/extensions/dome.agent/processors/ingest";
import type {
  ProcessorContext,
  ModelStepResult,
} from "../../../src/core/processor";
import type { PatchEffect, QuestionEffect } from "../../../src/core/effect";

function makeCtx(opts: {
  files: Record<string, string>;
  changedPaths: ReadonlyArray<string>;
  steps?: ReadonlyArray<ModelStepResult>;
}): ProcessorContext {
  const steps = opts.steps;
  let i = 0;
  const step =
    steps === undefined
      ? undefined
      : async (): Promise<ModelStepResult> => {
          const r = steps[i] ?? { text: "done" };
          i += 1;
          return r;
        };
  const modelInvoke =
    step === undefined
      ? undefined
      : (Object.assign(async () => "", {
          structured: async () => ({}) as never,
          step,
        }) as never);
  return {
    snapshot: {
      commit: "c" as never,
      tree: "t" as never,
      readFile: async (p: string) => opts.files[p] ?? null,
      listMarkdownFiles: async () => Object.keys(opts.files),
      getFileInfo: async () => null,
    },
    changedPaths: opts.changedPaths,
    proposal: null,
    runId: "run1",
    input: { kind: "signal" },
    now: () => new Date("2026-06-08T12:00:00Z"),
    signal: new AbortController().signal,
    capabilities: {} as never,
    extensionConfig: {},
    ...(modelInvoke !== undefined ? { modelInvoke } : {}),
    sourceRef: (path: string) => ({ path }) as never,
  } as ProcessorContext;
}

describe("dome.agent.ingest", () => {
  test("no-op when no model step is wired", async () => {
    const ctx = makeCtx({
      files: { "inbox/raw/x.md": "body" },
      changedPaths: ["inbox/raw/x.md"],
    });
    expect(await ingest.run(ctx)).toEqual([]);
  });

  test("no-op when no raw captures changed", async () => {
    const ctx = makeCtx({
      files: { "wiki/a.md": "x" },
      changedPaths: ["wiki/a.md"],
      steps: [{ text: "done" }],
    });
    expect(await ingest.run(ctx)).toEqual([]);
  });

  test("emits one PatchEffect with the agent's edits + a source ref", async () => {
    const ctx = makeCtx({
      files: { "inbox/raw/x.md": "Acme raised a round." },
      changedPaths: ["inbox/raw/x.md"],
      steps: [
        {
          toolCalls: [
            {
              id: "1",
              name: "writePage",
              input: { path: "wiki/sources/acme-round.md", content: "# Acme" },
            },
            { id: "2", name: "archiveSource", input: { rawPath: "inbox/raw/x.md" } },
          ],
        },
        { text: "ingested" },
      ],
    });
    const effects = await ingest.run(ctx);
    const patch = effects.find((e) => e.kind === "patch") as PatchEffect;
    expect(patch.mode).toBe("auto");
    const paths = patch.changes.map((c) => c.path);
    expect(paths).toContain("wiki/sources/acme-round.md");
    expect(paths).toContain("inbox/raw/x.md"); // delete
    expect(patch.sourceRefs.length).toBeGreaterThan(0);
  });

  test("emits a QuestionEffect when the agent asks the owner", async () => {
    const ctx = makeCtx({
      files: { "inbox/raw/x.md": "Unclear claim." },
      changedPaths: ["inbox/raw/x.md"],
      steps: [
        { toolCalls: [{ id: "1", name: "askOwner", input: { question: "true?" } }] },
        { text: "done" },
      ],
    });
    const effects = await ingest.run(ctx);
    const q = effects.find((e) => e.kind === "question") as QuestionEffect;
    expect(q.question).toBe("true?");
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `bun test tests/extensions/dome.agent/ingest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.** Create `assets/extensions/dome.agent/processors/ingest.ts`:

```typescript
// dome.agent.ingest — autonomous knowledge-integration agent for inbox sources.

import {
  patchEffect,
  questionEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import { runAgentLoop } from "../lib/agent-loop";
import { makeIngestTools } from "../lib/ingest-tools";
import { INGEST_CHARTER } from "../lib/ingest-charter";

const MAX_STEPS = 25;

const ingest = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const step = ctx.modelInvoke?.step;
    if (step === undefined) return Object.freeze([]); // clean no-op without a model

    const rawPaths = ctx.changedPaths.filter(isRawCapturePath);
    if (rawPaths.length === 0) return Object.freeze([]);

    const tools = makeIngestTools({
      reader: {
        readFile: (p) => ctx.snapshot.readFile(p),
        listMarkdownFiles: () => ctx.snapshot.listMarkdownFiles(),
      },
    });

    const effects: Effect[] = [];
    for (const sourcePath of rawPaths) {
      const source = await ctx.snapshot.readFile(sourcePath);
      if (source === null) continue;

      const result = await runAgentLoop({
        charter: INGEST_CHARTER,
        task: taskTurn(sourcePath, source, ctx.now()),
        tools,
        step,
        maxSteps: MAX_STEPS,
      });

      const changes = [...result.state.edits.values()].map((e) =>
        e.kind === "write"
          ? ({ kind: "write", path: e.path, content: e.content } as const)
          : ({ kind: "delete", path: e.path } as const),
      );
      if (changes.length > 0) {
        effects.push(
          patchEffect({
            mode: "auto",
            changes,
            reason: `dome.agent: ingest ${sourcePath}`,
            sourceRefs: [ctx.sourceRef(sourcePath)],
          }),
        );
      }
      for (const q of result.state.questions) {
        effects.push(
          questionEffect({
            question: q.question,
            idempotencyKey: q.idempotencyKey,
            sourceRefs: [ctx.sourceRef(sourcePath)],
          }),
        );
      }
    }
    return Object.freeze(effects);
  },
});

export default ingest;

function isRawCapturePath(path: string): boolean {
  return /^inbox\/raw\/[^/]+\.md$/.test(path);
}

function taskTurn(sourcePath: string, source: string, now: Date): string {
  const today = now.toISOString().slice(0, 10);
  return [
    `Raw source path: ${sourcePath}`,
    `Today's daily note path: notes/${today}.md`,
    "",
    "Source content:",
    source,
  ].join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `bun test tests/extensions/dome.agent/ingest.test.ts`
Expected: PASS (4 tests).

> Note: the test's scheduled/activation re-scan behavior (running over all `inbox/raw/*` on a schedule trigger) is intentionally omitted from v1 for simplicity — the manifest's signal trigger on `inbox/raw/*.md` covers the dump-and-forget case. If a schedule sweep is wanted later, mirror `rawCapturePathsForRun` from the old `extract-capture.ts`.

- [ ] **Step 5: Commit.**

```bash
git add assets/extensions/dome.agent/processors/ingest.ts tests/extensions/dome.agent/ingest.test.ts
git commit -m "feat(dome.agent): ingest processor (loop -> single PatchEffect + questions)"
```

---

### Task 3.4: Move `inbox-stale-check` into `dome.agent`

**Files:**
- Create: `assets/extensions/dome.agent/processors/inbox-stale-check.ts` (copy of `assets/extensions/dome.intake/processors/inbox-stale-check.ts`, with the import depth unchanged — both are `processors/` two levels under `assets/extensions/<bundle>/`, so `../../../../src/...` paths are identical and need no edit)

- [ ] **Step 1: Copy the file verbatim.**

Run:
```bash
cp assets/extensions/dome.intake/processors/inbox-stale-check.ts \
   assets/extensions/dome.agent/processors/inbox-stale-check.ts
```

- [ ] **Step 2: Verify the relative imports still resolve** (the path depth is identical, so they should). Open the copied file and confirm every `../../../../src/...` import points at a real file.

Run: `bun run tsc --noEmit`
Expected: no new errors referencing the copied file.

- [ ] **Step 3: Commit.**

```bash
git add assets/extensions/dome.agent/processors/inbox-stale-check.ts
git commit -m "chore(dome.agent): re-home inbox-stale-check from dome.intake"
```

---

### Task 3.5: The `dome.agent` manifest

**Files:**
- Create: `assets/extensions/dome.agent/manifest.yaml`

- [ ] **Step 1: Create the manifest.** Create `assets/extensions/dome.agent/manifest.yaml`:

```yaml
id: dome.agent
version: 0.1.0
processors:
  - id: dome.agent.ingest
    version: 0.1.0
    phase: garden
    triggers:
      - kind: signal
        name: file.created
        pathPattern: "inbox/raw/*.md"
      - kind: signal
        name: document.changed
        pathPattern: "inbox/raw/*.md"
    capabilities:
      - kind: read
        paths:
          - "wiki/**/*.md"
          - "notes/**/*.md"
          - "inbox/**/*.md"
          - "index.md"
          - "log.md"
      - kind: patch.auto
        paths:
          - "wiki/**/*.md"
          - "notes/**/*.md"
          - "index.md"
          - "log.md"
          - "inbox/processed/*.md"
          - "inbox/raw/*.md"
      - kind: model.invoke
        maxDailyCostUsd: 5
      - kind: question.ask
    execution:
      class: llm
      timeoutMs: 900000
      modelCallTimeoutMs: 180000
    module: processors/ingest.ts

  - id: dome.agent.inbox-stale-check
    version: 0.1.0
    phase: garden
    triggers:
      - kind: schedule
        cron: "0 * * * *"
      - kind: signal
        name: file.created
        pathPattern: "inbox/**/*.md"
      - kind: signal
        name: document.changed
        pathPattern: "inbox/**/*.md"
      - kind: signal
        name: file.deleted
        pathPattern: "inbox/**/*.md"
    capabilities:
      - kind: read
        paths: ["inbox/**/*.md"]
    module: processors/inbox-stale-check.ts
```

> Note: `inbox-stale-check.ts` declares its processor id internally only via the manifest binding — confirm the copied module does not hardcode the old id `dome.intake.inbox-stale-check` in any string (e.g. a diagnostic `code` or question `idempotencyKey`). If it does, update those strings to `dome.agent.inbox-stale-check` in this task and re-run its tests.

- [ ] **Step 2: Load the bundle to verify the manifest is valid.**

Run: `bun test tests/extensions/dome.agent/`
Expected: PASS (existing dome.agent tests still pass; the loader is exercised in Phase 4 inventory tests).

- [ ] **Step 3: Commit.**

```bash
git add assets/extensions/dome.agent/manifest.yaml
git commit -m "feat(dome.agent): bundle manifest (ingest + inbox-stale-check)"
```

---

# Phase 4 — Retire `dome.intake` + wire `dome.agent`

### Task 4.1: Maintenance-loops — swap intake processors for agent processors

**Files:**
- Modify: `src/extensions/maintenance-loops.ts` (the `dome.capture.digest` loop, lines ~213-249; and the `dome.question.continuity` `optionalProcessors`, lines ~384-385)
- Test: `tests/extensions/maintenance-loops.test.ts`

- [ ] **Step 1: Update the loop definitions.** In `src/extensions/maintenance-loops.ts`, in the `dome.capture.digest` loop, replace the `processors:` array (currently the six `dome.intake.*` ids) with:

```typescript
      processors: [
        "dome.agent.ingest",
        "dome.agent.inbox-stale-check",
      ],
```

In the `dome.question.continuity` loop, replace the `optionalProcessors:` array (currently `["dome.intake.low-confidence-answer", "dome.warden.integrity", "dome.warden.integrity-answer"]`) with:

```typescript
      optionalProcessors: [
        "dome.warden.integrity",
        "dome.warden.integrity-answer",
      ],
```

(If the loop's human-facing `title`/`description` text references "intake", reword to "ingest" to match.)

- [ ] **Step 2: Run the maintenance-loops suite to see what breaks.**

Run: `bun test tests/extensions/maintenance-loops.test.ts`
Expected: the five-loop id test still PASSES (we kept all five ids). The "cover every shipped first-party maintenance processor" test now FAILS — it loads bundles from disk, and `dome.intake.*` no longer exist while `dome.agent.*` must be covered. (We delete `dome.intake` in Task 4.4; until then this test sees both.) Proceed — it goes green after Task 4.4.

- [ ] **Step 3: Commit.**

```bash
git add src/extensions/maintenance-loops.ts
git commit -m "refactor(loops): route dome.capture.digest through dome.agent processors"
```

---

### Task 4.2: default-vault-config — replace the `dome.intake` entry with `dome.agent`

**Files:**
- Modify: `src/cli/default-vault-config.ts` (the `dome.intake` entry, lines 48-65)

- [ ] **Step 1: Replace the entry.** Delete the `extension("dome.intake", false, { ... })` block (lines 48-65) and insert in its place:

```typescript
    extension("dome.agent", false, {
      read: [
        "wiki/**/*.md",
        "notes/**/*.md",
        "inbox/**/*.md",
        "index.md",
        "log.md",
      ],
      "patch.auto": [
        "wiki/**/*.md",
        "notes/**/*.md",
        "index.md",
        "log.md",
        "inbox/processed/*.md",
        "inbox/raw/*.md",
      ],
      "model.invoke": Object.freeze({ maxDailyCostUsd: 5 }),
      "question.ask": true,
    }),
```

- [ ] **Step 2: Typecheck.**

Run: `bun run tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add src/cli/default-vault-config.ts
git commit -m "feat(config): default dome.agent extension; drop dome.intake default"
```

---

### Task 4.3: init.ts — extend the model-provider template with the step schema

**Files:**
- Modify: `src/cli/commands/init.ts` (the `ANTHROPIC_MODEL_PROVIDER_TEMPLATE` string, lines ~837-1004)

- [ ] **Step 1: Add step handling to the template.** The template is the literal source that `dome init` writes to `<vault>/.dome/model-provider.ts`. It currently handles only `dome.model-provider.request/v1` (text). Add step support so a freshly-initialized vault's provider can serve the agent loop. Inside the template string, add the step branch. Replace the template's `main()` body so it dispatches on the request schema:

```typescript
// (inside ANTHROPIC_MODEL_PROVIDER_TEMPLATE)
async function main(): Promise<void> {
  if (API_KEY === undefined || API_KEY.trim().length === 0) {
    throw new Error("ANTHROPIC_API_KEY is required");
  }
  const raw = JSON.parse(await Bun.stdin.text());
  if (raw.schema === "dome.model-provider.step/v1") {
    process.stdout.write(JSON.stringify(await runStep(raw)));
    return;
  }
  if (raw.schema === "dome.model-provider.request/v1") {
    process.stdout.write(JSON.stringify(await runText(raw)));
    return;
  }
  throw new Error("unsupported Dome model provider request schema");
}
```

Then add (still inside the template) `runText` (the existing text path, refactored from the current `main`) and `runStep` using the Anthropic Messages tools API:

```typescript
async function runStep(req: {
  messages: Array<
    | { role: "system"; content: string }
    | { role: "user"; content: string }
    | { role: "assistant"; content: string; toolCalls?: Array<{ id: string; name: string; input: unknown }> }
    | { role: "tool"; toolCallId: string; toolName: string; content: string }
  >;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  model?: string;
}): Promise<{ toolCalls?: Array<{ id: string; name: string; input: unknown }>; text?: string; model?: string; costUsd?: number }> {
  const model = req.model ?? DEFAULT_MODEL;
  const system = req.messages.filter((m) => m.role === "system").map((m) => (m as { content: string }).content).join("\n\n");
  const messages = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => toAnthropicMessage(m));
  const body: Record<string, unknown> = {
    model,
    max_tokens: MAX_TOKENS,
    messages,
    tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
  };
  if (system.length > 0) body.system = system;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Anthropic request failed ${response.status}: ${errBody.slice(0, 1000)}`);
  }
  const parsed = await response.json();
  const blocks: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> = parsed.content ?? [];
  const toolCalls = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ id: String(b.id), name: String(b.name), input: b.input }));
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
  const costUsd = costFromUsage(parsed.usage);
  return {
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(text.length > 0 ? { text } : {}),
    model: parsed.model ?? model,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function toAnthropicMessage(m: { role: string; content: string; toolCalls?: Array<{ id: string; name: string; input: unknown }>; toolCallId?: string; toolName?: string }): unknown {
  if (m.role === "assistant") {
    const content: unknown[] = [];
    if (m.content.length > 0) content.push({ type: "text", text: m.content });
    for (const c of m.toolCalls ?? []) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
    return { role: "assistant", content };
  }
  if (m.role === "tool") {
    return { role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] };
  }
  return { role: "user", content: m.content };
}
```

(Keep the existing `costFromUsage`, `numberEnv`, `positiveIntegerEnv`, `textFromAnthropicResponse`, and `DEFAULT_MODEL`/`MAX_TOKENS`/`API_KEY` declarations; `runText` wraps the existing fetch+parse logic.)

- [ ] **Step 2: Typecheck + run any init template test.**

Run: `bun run tsc --noEmit && bun test tests/cli/commands.test.ts`
Expected: typecheck PASS. `commands.test.ts` may FAIL on processor-inventory assertions (handled in Task 4.5) — note which assertions fail.

- [ ] **Step 3: Commit.**

```bash
git add src/cli/commands/init.ts
git commit -m "feat(init): model-provider template serves dome.model-provider.step/v1 (Anthropic tools)"
```

---

### Task 4.4: Delete the `dome.intake` bundle

**Files:**
- Delete: `assets/extensions/dome.intake/` (entire directory)

- [ ] **Step 1: Remove the bundle.**

Run: `git rm -r assets/extensions/dome.intake`

- [ ] **Step 2: Find any remaining references to delete/redirect.**

Run: `rg -n "dome\.intake" src tests assets docs`
Expected: hits only in (a) docs/spec files (handled in Task 4.6), (b) tests that still assert the old inventory (Task 4.5). There must be **no** remaining `dome.intake` reference in `src/` runtime code (maintenance-loops + default-vault-config were updated in 4.1/4.2). If any `src/` reference remains, fix it now.

- [ ] **Step 3: Run the maintenance-loops coverage test.**

Run: `bun test tests/extensions/maintenance-loops.test.ts`
Expected: now PASS — shipped bundles are `dome.agent.*` (covered by `dome.capture.digest`) and the `dome.intake.*` ids are gone.

- [ ] **Step 4: Commit.**

```bash
git add -A assets/extensions
git commit -m "feat: retire dome.intake bundle (superseded by dome.agent)"
```

---

### Task 4.5: Update inventory tests (processor/model-processor counts)

**Files:**
- Modify: `tests/cli/commands.test.ts` (model-processor / processor-count assertions that referenced `dome.intake`)
- Verify: `tests/invariants/model-processors-emit-no-durable-facts.test.ts` (should pass unchanged)

- [ ] **Step 1: Run the CLI suite and read the failures.**

Run: `bun test tests/cli/commands.test.ts`
Expected: FAIL on assertions that count model processors or name `dome.intake`. The old shipped model processors were `dome.intake.extract-capture`, `dome.intake.synthesize-capture`, `dome.intake.synthesize-rollup`, `dome.warden.integrity` (4 garden `model.invoke` processors). After this change they are `dome.agent.ingest` + `dome.warden.integrity` (2). Note each failing assertion's expected/received numbers and the surrounding `expect(...)`.

- [ ] **Step 2: Update each failing assertion** to the new inventory. For a count assertion, change the expected number (e.g. model-processor count `4` → `2`). For a name list, replace `dome.intake.*` entries with `dome.agent.ingest`. Make the minimal edit per failing `expect`. (Do not change assertion *intent* — only the expected values, which are facts about the shipped bundle set.)

- [ ] **Step 3: Run the invariant test (no edit expected).**

Run: `bun test tests/invariants/model-processors-emit-no-durable-facts.test.ts`
Expected: PASS — `dome.agent.ingest` declares `model.invoke` and **not** `graph.write`, so the invariant holds.

- [ ] **Step 4: Run the full suite.**

Run: `bun test`
Expected: ALL PASS. If any other test enumerated `dome.intake` (e.g. a sync/status snapshot test), update its expected inventory the same way — minimal expected-value edits only.

- [ ] **Step 5: Commit.**

```bash
git add tests
git commit -m "test: update shipped-bundle inventory assertions for dome.agent"
```

---

### Task 4.6: Spec/docs — record the new bundle + the grant-as-boundary rule

**Files:**
- Create: `docs/wiki/specs/autonomous-agents.md`
- Modify: `docs/index.md` (link the new spec)
- Modify: `docs/wiki/specs/task-lifecycle.md` (the "Wardens" framing already says "an agent is a processor"; add a one-line pointer to the agents spec) — optional, only if it reduces drift.

- [ ] **Step 1: Write the normative spec** distilling the design doc — the agent-as-processor model, the `ctx.modelInvoke.step` seam, the loop-in-bundle rule, grant-as-boundary (invariants kept; conventions loosened; the two hard floors: Obsidian-Tasks interop skip + `raw/` immutability), and the `dome.agent.ingest` instance. Reference the existing invariants it honors (`ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY`, `MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS`). (Prose; mirror the structure of `task-lifecycle.md`.)

- [ ] **Step 2: Add the spec to `docs/index.md`** under the specs list, with a one-line description.

- [ ] **Step 3: Confirm no broken substrate links.**

Run: `rg -n "dome\.intake|prompts-and-workflows" docs/index.md` and fix any dangling references the retirement created.

- [ ] **Step 4: Commit.**

```bash
git add docs
git commit -m "docs: autonomous-agents spec + index; retire dome.intake references"
```

---

# Phase 5 — Vault migration + provider step + docs (work vault)

> This phase runs against the live work vault at `~/vaults/work` (whose `node_modules/@dome/sdk` symlinks this repo). **Check for a running `dome serve` first** (`pgrep -fl "dome serve"`); stop it before editing `.dome/` to avoid adopted-ref divergence. These are manual/smoke steps — no unit tests.

### Task 5.1: Update the live `.dome/model-provider.ts`

**Files:**
- Modify: `/Users/mark.toda/vaults/work/.dome/model-provider.ts`

- [ ] **Step 1: Apply the same step support** added to the init template in Task 4.3 (the `main()` schema dispatch + `runStep` + `toAnthropicMessage` + `runText`). The live file and the template should end up functionally identical.

- [ ] **Step 2: Smoke-test the step path directly.**

Run:
```bash
cd ~/vaults/work && echo '{"schema":"dome.model-provider.step/v1","messages":[{"role":"user","content":"Call readPage on a.md"}],"tools":[{"name":"readPage","description":"read a page","inputSchema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}]}' | ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" bun .dome/model-provider.ts
```
Expected: JSON with a `toolCalls` array calling `readPage` (the model should choose the tool), or `text`. Confirms the wire path works against the real API.

### Task 5.2: Swap the vault config + docs

**Files:**
- Modify: `/Users/mark.toda/vaults/work/.dome/config.yaml`
- Modify: `/Users/mark.toda/vaults/work/CLAUDE.md`, `/Users/mark.toda/vaults/work/AGENTS.md`

- [ ] **Step 1: Replace the `dome.intake` config block** with `dome.agent`:

```yaml
  dome.agent:
    enabled: true
    grant:
      read:
        - wiki/**/*.md
        - notes/**/*.md
        - inbox/**/*.md
        - index.md
        - log.md
      patch.auto:
        - wiki/**/*.md
        - notes/**/*.md
        - index.md
        - log.md
        - inbox/processed/*.md
        - inbox/raw/*.md
      model.invoke:
        maxDailyCostUsd: 5
      question.ask: true
```

- [ ] **Step 2: Update `CLAUDE.md` "Operating Rules"** — replace the "`notes/` is user-owned … today's daily is the exception" language with grant-as-boundary wording: *"Dome agents write what their capability grant allows. `raw/` is read-only (provenance). Obsidian-Tasks dashboards are left untouched. Everything else is governed by the grant in `.dome/config.yaml`, with git history (the `Dome-Run` trailer split) and the integrity warden as the safety nets."* Mirror the change in `AGENTS.md` where it repeats the rule. Remove the stale "### Ingest-of-captures handled by `ingest-augment.md`" pointer.

- [ ] **Step 3: Smoke-test end to end.** With `ANTHROPIC_API_KEY` exported, run `dome serve` (or one `dome sync`), then drop a real source:

```bash
cd ~/vaults/work
cp ~/some-article.md inbox/raw/test-ingest.md   # or: pbpaste > inbox/raw/test-ingest.md
# wait for the garden phase to run (watch serve logs)
git log --oneline -5
```
Expected: a `Dome-Run`-trailered commit creating `wiki/sources/<slug>.md`, touching related entity/concept pages, updating `index.md`/`log.md`, and removing `inbox/raw/test-ingest.md` (archived to `inbox/processed/`). Inspect the diff; if the integration is wrong, `git revert` it (the rollback net) and tune the charter.

- [ ] **Step 4 (no commit unless asked):** the work vault commits are produced by the engine; do not hand-commit vault content. Report the smoke-test diff to the owner.

---

## Self-Review

**1. Spec coverage** (design §-by-§):
- §3 framework / §5 harness → Phase 2 (Task 2.1). ✓
- §4 model-seam D3 → Phase 1 (Tasks 1.1–1.4). ✓
- §6 grant-as-boundary → Phase 4 Task 4.2 (grant) + Task 4.6 (spec) + Phase 5 Task 5.2 (vault docs). ✓
- §7 ingest agent (charter/tools/manifest/grant, Sonnet, `maxSteps:25`, `maxDailyCostUsd:5`) → Phase 3 + manifest Task 3.5. ✓ (Sonnet is the vault `ANTHROPIC_MODEL`; set in the serve env — noted in Phase 5.)
- §8 data flow → exercised by Phase 5 smoke test. ✓
- §9 error handling: no-op (Task 3.3 test), budget stop (Task 2.1 test), capability downgrade (engine-existing). ✓ — *gap:* a truncation **diagnostic** on `stopReason:"budget"` is described in §9 but not emitted. **Resolution:** add a `diagnosticEffect({ severity:"warning", code:"dome.agent.truncated", ... })` when `result.stopReason==="budget"` in Task 3.3's processor (and a test). Add this as Task 3.3 Step 3a if desired; minor.
- §10 testing → each module has a TDD test. ✓
- §11 retire intake + cleanup → Phase 4 (4.1, 4.4) + Phase 5 (5.2). The `lint-frontmatter` leniency review (§11) is **deferred** (open decision §13.3) — not in this plan; flag to reviewer.
- §12 invariants → Task 4.5 Step 3 (model-processors), bundle-deps unaffected (verified in exploration). ✓

**2. Placeholder scan:** No "TBD"/"handle errors"/"similar to". Test code is concrete. The one soft reference is Task 1.2's `policy` fixture ("mirror the existing model-invoke tests") — acceptable because `ResolvedExecutionPolicy`'s full shape isn't reproduced here; the implementer copies the existing fixture.

**3. Type consistency:** `ModelStepInput`/`ModelStepResult`/`ModelMessage`/`ModelToolSchema`/`ModelToolCall` defined in Task 1.1 are used identically in Tasks 1.2, 1.3, 2.1, 3.3. `AgentRunState`/`AgentTool`/`ModelStepFn`/`runAgentLoop` defined in 2.1 are consumed unchanged in 3.2/3.3. `makeIngestTools({reader})` signature matches between 3.2 and 3.3. `patchEffect`/`questionEffect` calls match the verbatim constructors. ✓

> **Optional addition flagged above:** Task 3.3 truncation diagnostic (§9). Add if you want the budget-stop signal; otherwise the loop still stops safely.
