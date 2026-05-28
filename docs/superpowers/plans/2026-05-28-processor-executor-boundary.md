# Processor Executor Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the alpha processor invocation path with a strict `ProcessorExecutor` boundary that validates output, enforces deadlines, records structured failures, and blocks unsafe adoption advancement.

**Supersession note:** the implemented processor executor is intentionally
single-attempt. The early snippets in this plan that mention
`retryBudgetMs` or processor-level `maxAttempts` are historical scaffolding,
not the current execution-policy surface. Durable retry policy lives on
`JobEffect` / outbox rows, and JSON repair retries remain local to
`ctx.modelInvoke.structured`.

**Architecture:** Add a dedicated executor between `ProcessorRuntime` and `applyEffect`. The executor owns invocation, timeout, cancellation signal, output validation, execution-error classification, and effect hashing; runtime owns trigger matching, context construction, run ids, and ledger writes; `applyEffect` remains the routing/capability chokepoint.

**Tech Stack:** TypeScript on Bun, `bun:test`, Zod schemas from `src/core/effect.ts`, Bun.sqlite ledger accessors, existing processor registry/runtime patterns.

---

## File Structure

- Create `src/processors/execution-error.ts`
  Structured processor execution errors, stable error codes, JSON serialization, and diagnostic conversion.

- Create `src/processors/execution-policy.ts`
  Execution classes, phase defaults, policy request/cap shapes, and policy resolution.

- Create `src/processors/executor.ts`
  `executeProcessor()` implementation: timeout race, `AbortController`, output validation, effect hashing, frozen results.

- Modify `src/core/processor.ts`
  Add `ExecutionPolicyRequest` metadata to `Processor`, `ProcessorDeclaration` schema support via exported schemas, and `signal` to `ProcessorContext`.

- Modify `src/processors/context.ts`
  Accept `signal` in `ProcessorContextInput` and freeze it onto context.

- Modify `src/processors/runtime.ts`
  Replace direct `processor.run()` invocation with `executeProcessor()`. Keep registry walking and ledger lifecycle here.

- Modify `src/ledger/runs.ts`
  Add `timed_out` and `cancelled` statuses and terminal accessors. Store structured JSON errors as strings in the existing `error` column.

- Modify `src/extensions/manifest-schema.ts`
  Parse optional `execution` metadata and reject static phase-policy violations.

- Modify `src/engine/apply-effect.ts`
  Add explicit `blocked-for-review` outcome for adoption `PatchEffect(mode: "propose")`.

- Modify `src/engine/adopt.ts`
  Treat `blocked-for-review` and adoption execution failure diagnostics as adoption-blocking.

- Tests:
  - Create `tests/processors/executor.test.ts`
  - Modify `tests/processors/context.test.ts`
  - Modify `tests/processors/runtime.test.ts`
  - Modify `tests/processors/runtime-ledger.test.ts`
  - Modify `tests/ledger/runs.test.ts`
  - Create `tests/extensions/manifest-schema.test.ts`
  - Modify `tests/engine/apply-effect.test.ts`
  - Modify `tests/engine/adopt-capability-uses.test.ts`
  - Modify `tests/harness/scenarios/lifecycle/throwing-processor-blocks-adoption.scenario.test.ts`

## Task 1: Add Context Signal and Execution Policy Types

**Files:**
- Modify: `src/core/processor.ts`
- Modify: `src/processors/context.ts`
- Modify: `tests/core/processor.test.ts`
- Modify: `tests/processors/context.test.ts`
- Create: `src/processors/execution-policy.ts`
- Test: `tests/core/processor.test.ts`
- Test: `tests/processors/context.test.ts`
- Test: `tests/processors/execution-policy.test.ts`

- [ ] **Step 1: Add failing context signal tests**

Append to `tests/processors/context.test.ts`:

```ts
describe("makeProcessorContext — cancellation signal", () => {
  test("ctx.signal is the same AbortSignal passed by the runtime", () => {
    const controller = new AbortController();
    const ctx = makeProcessorContext(
      baseInput({ input: null, signal: controller.signal }),
    );
    expect(ctx.signal).toBe(controller.signal);
    expect(ctx.signal.aborted).toBe(false);
  });
});
```

- [ ] **Step 2: Run context test to verify it fails**

Run:

```bash
bun test tests/processors/context.test.ts
```

Expected: TypeScript/runtime failure because `ProcessorContextInput` does not accept `signal` and `ProcessorContext` has no `signal`.

- [ ] **Step 3: Add `signal` to processor context types**

In `src/core/processor.ts`, add this field to `ProcessorContext<TInput>` immediately after `input`:

```ts
  readonly signal: AbortSignal;
```

In `src/processors/context.ts`, add this field to `ProcessorContextInput<TInput>` immediately after `input`:

```ts
  readonly signal: AbortSignal;
```

Then add this property to the `ctx` object built in `makeProcessorContext()`:

```ts
    signal: opts.signal,
```

- [ ] **Step 4: Update existing context test helper**

In `tests/processors/context.test.ts`, update `baseInput()` so every existing test gets a default signal:

```ts
function baseInput<TInput>(overrides: Partial<ProcessorContextInput<TInput>> & {
  input: TInput;
}): ProcessorContextInput<TInput> {
  return {
    snapshot,
    changedPaths: ["wiki/x.md"],
    proposal: null,
    runId: "run-1",
    signal: new AbortController().signal,
    ...overrides,
  };
}
```

- [ ] **Step 5: Add failing execution policy and processor metadata tests**

In `tests/core/processor.test.ts`, add a test that `defineProcessor` preserves
execution metadata:

```ts
  test("defineProcessor preserves execution metadata", () => {
    const p = defineProcessor({
      id: "test.execution",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "signal", name: "file.created" }],
      capabilities: [],
      execution: {
        class: "llm",
        timeoutMs: 600_000,
        maxAttempts: 1,
        modelCallTimeoutMs: 180_000,
      },
      run: async () => [],
    });

    expect(p.execution?.class).toBe("llm");
    expect(p.execution?.timeoutMs).toBe(600_000);
  });
```

Create `tests/processors/execution-policy.test.ts`:

```ts
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
```

- [ ] **Step 6: Run policy test to verify it fails**

Run:

```bash
bun test tests/core/processor.test.ts tests/processors/execution-policy.test.ts
```

Expected: FAIL with module not found for `src/processors/execution-policy`.
`tests/core/processor.test.ts` should also fail until `Processor.execution` is
added.

- [ ] **Step 7: Add core execution metadata and implement `src/processors/execution-policy.ts`**

In `src/core/processor.ts`, add these types near the phase/capability type
definitions:

```ts
export type ExecutionClass =
  | "deterministic"
  | "interactive"
  | "background"
  | "llm"
  | "batch";

export type ExecutionPolicyRequest = {
  readonly class: ExecutionClass;
  readonly timeoutMs?: number;
  readonly retryBudgetMs?: number;
  readonly maxAttempts?: number;
  readonly modelCallTimeoutMs?: number;
};
```

Add this field to `Processor<TInput>`:

```ts
  readonly execution?: ExecutionPolicyRequest;
```

Add these Zod schemas near the other static-data schemas:

```ts
export const ExecutionClassSchema = z.enum([
  "deterministic",
  "interactive",
  "background",
  "llm",
  "batch",
]);

export const ExecutionPolicyRequestSchema = z
  .object({
    class: ExecutionClassSchema,
    timeoutMs: z.number().int().positive().optional(),
    retryBudgetMs: z.number().int().nonnegative().optional(),
    maxAttempts: z.number().int().positive().optional(),
    modelCallTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();
```

Create `src/processors/execution-policy.ts`:

```ts
import type {
  ExecutionClass,
  ExecutionPolicyRequest,
  ProcessorPhase,
} from "../core/processor";
import { err, ok, type Result } from "../types";

export type { ExecutionPolicyRequest } from "../core/processor";

export type ExecutionPolicyCap = {
  readonly timeoutMs?: number;
  readonly retryBudgetMs?: number;
  readonly maxAttempts?: number;
  readonly modelCallTimeoutMs?: number;
};

export type ResolvedExecutionPolicy = {
  readonly class: ExecutionClass;
  readonly timeoutMs: number;
  readonly retryBudgetMs: number;
  readonly maxAttempts: number;
  readonly lateEffectBehavior: "discard";
  readonly modelCallTimeoutMs?: number;
};

export type ExecutionPolicyError = {
  readonly code: "execution-policy.phase-class-denied";
  readonly message: string;
};

export const DEFAULT_EXECUTION_POLICY_BY_CLASS: Readonly<Record<ExecutionClass, ResolvedExecutionPolicy>> =
  Object.freeze({
    deterministic: Object.freeze({
      class: "deterministic",
      timeoutMs: 2_000,
      retryBudgetMs: 0,
      maxAttempts: 1,
      lateEffectBehavior: "discard",
    }),
    interactive: Object.freeze({
      class: "interactive",
      timeoutMs: 30_000,
      retryBudgetMs: 0,
      maxAttempts: 1,
      lateEffectBehavior: "discard",
    }),
    background: Object.freeze({
      class: "background",
      timeoutMs: 120_000,
      retryBudgetMs: 0,
      maxAttempts: 1,
      lateEffectBehavior: "discard",
    }),
    llm: Object.freeze({
      class: "llm",
      timeoutMs: 600_000,
      retryBudgetMs: 0,
      maxAttempts: 1,
      lateEffectBehavior: "discard",
      modelCallTimeoutMs: 180_000,
    }),
    batch: Object.freeze({
      class: "batch",
      timeoutMs: 600_000,
      retryBudgetMs: 0,
      maxAttempts: 1,
      lateEffectBehavior: "discard",
    }),
  });

export function defaultExecutionClassForPhase(
  phase: ProcessorPhase,
): ExecutionClass {
  switch (phase) {
    case "adoption":
      return "deterministic";
    case "garden":
      return "background";
    case "view":
      return "interactive";
  }
}

export function resolveExecutionPolicy(opts: {
  readonly phase: ProcessorPhase;
  readonly request: ExecutionPolicyRequest | undefined;
  readonly vaultCap: ExecutionPolicyCap | undefined;
}): Result<ResolvedExecutionPolicy, ExecutionPolicyError> {
  const requestedClass = opts.request?.class ?? defaultExecutionClassForPhase(opts.phase);
  if (opts.phase === "adoption" && requestedClass !== "deterministic") {
    return err({
      code: "execution-policy.phase-class-denied",
      message: `adoption processors must use deterministic execution, got '${requestedClass}'`,
    });
  }

  const base = DEFAULT_EXECUTION_POLICY_BY_CLASS[requestedClass];
  const requestedTimeout = opts.request?.timeoutMs ?? base.timeoutMs;
  const requestedRetryBudget = opts.request?.retryBudgetMs ?? base.retryBudgetMs;
  const requestedMaxAttempts = opts.request?.maxAttempts ?? base.maxAttempts;
  const requestedModelTimeout =
    opts.request?.modelCallTimeoutMs ?? base.modelCallTimeoutMs;

  const timeoutMs = Math.min(requestedTimeout, opts.vaultCap?.timeoutMs ?? requestedTimeout);
  const retryBudgetMs = Math.min(
    requestedRetryBudget,
    opts.vaultCap?.retryBudgetMs ?? requestedRetryBudget,
  );
  const maxAttempts = Math.min(
    requestedMaxAttempts,
    opts.vaultCap?.maxAttempts ?? requestedMaxAttempts,
  );
  const modelCallTimeoutMs =
    requestedModelTimeout === undefined
      ? undefined
      : Math.min(
          requestedModelTimeout,
          opts.vaultCap?.modelCallTimeoutMs ?? requestedModelTimeout,
        );

  return ok(
    Object.freeze({
      class: requestedClass,
      timeoutMs,
      retryBudgetMs,
      maxAttempts,
      lateEffectBehavior: "discard" as const,
      ...(modelCallTimeoutMs !== undefined ? { modelCallTimeoutMs } : {}),
    }),
  );
}
```

- [ ] **Step 8: Run Task 1 tests**

Run:

```bash
bun test tests/core/processor.test.ts tests/processors/context.test.ts tests/processors/execution-policy.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 1**

```bash
git add src/core/processor.ts src/processors/context.ts src/processors/execution-policy.ts tests/core/processor.test.ts tests/processors/context.test.ts tests/processors/execution-policy.test.ts
git commit -m "feat: add processor execution policy and signal"
```

## Task 2: Add Processor Executor Unit

**Files:**
- Create: `src/processors/execution-error.ts`
- Create: `src/processors/executor.ts`
- Create: `tests/processors/executor.test.ts`
- Test: `tests/processors/executor.test.ts`

- [ ] **Step 1: Write failing executor tests**

Create `tests/processors/executor.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { diagnosticEffect, patchEffect } from "../../src/core/effect";
import type { Effect } from "../../src/core/effect";
import type { ProcessorContext } from "../../src/core/processor";
import { commitOid } from "../../src/core/source-ref";
import type { RunId } from "../../src/engine/runner-contract";
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
  sourceRef: (path: string) => ({ commit: commitOid("abc0000000000000000000000000000000000000"), path }),
}) as ProcessorContext<unknown>;

function validEffect(): Effect {
  return diagnosticEffect({
    severity: "info",
    code: "test.ok",
    message: "ok",
    sourceRefs: [],
  });
}

describe("executeProcessor", () => {
  test("succeeds with frozen validated effects and hashes", async () => {
    const result = await executeProcessor({
      processorId: "test.executor.success",
      phase: "adoption",
      runId: RUN_ID,
      ctx,
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
      ctx,
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
  });

  test("one malformed effect fails the whole invocation", async () => {
    const result = await executeProcessor({
      processorId: "test.executor.malformed",
      phase: "garden",
      runId: RUN_ID,
      ctx,
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

  test("throw becomes structured processor.threw", async () => {
    const result = await executeProcessor({
      processorId: "test.executor.throw",
      phase: "adoption",
      runId: RUN_ID,
      ctx,
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
    expect(result.diagnostic.severity).toBe("block");
  });

  test("timeout returns timed_out and discards late effects", async () => {
    let released = false;
    const result = await executeProcessor({
      processorId: "test.executor.timeout",
      phase: "garden",
      runId: RUN_ID,
      ctx,
      policy: {
        class: "background",
        timeoutMs: 1,
        retryBudgetMs: 0,
        maxAttempts: 1,
        lateEffectBehavior: "discard",
      },
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        released = true;
        return [validEffect()];
      },
    });

    expect(result.status).toBe("timed_out");
    if (result.status !== "timed_out") return;
    expect(result.error.code).toBe("processor.timeout");
    expect(result.diagnostic.severity).toBe("error");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(released).toBe(true);
  });
});
```

- [ ] **Step 2: Run executor test to verify it fails**

Run:

```bash
bun test tests/processors/executor.test.ts
```

Expected: FAIL with module not found for `src/processors/executor`.

- [ ] **Step 3: Implement execution error helper**

Create `src/processors/execution-error.ts`:

```ts
import { diagnosticEffect, type DiagnosticEffect } from "../core/effect";
import type { ProcessorPhase } from "../core/processor";

export type ProcessorExecutionErrorCode =
  | "processor.threw"
  | "processor.invalid-output"
  | "processor.timeout"
  | "processor.cancelled";

export type ProcessorExecutionError = {
  readonly code: ProcessorExecutionErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly phase: ProcessorPhase;
  readonly processorId: string;
};

export function makeExecutionError(input: ProcessorExecutionError): ProcessorExecutionError {
  return Object.freeze({ ...input });
}

export function executionErrorToJson(error: ProcessorExecutionError): string {
  return JSON.stringify(error);
}

export function diagnosticForExecutionError(
  error: ProcessorExecutionError,
): DiagnosticEffect {
  return diagnosticEffect({
    severity: error.phase === "adoption" ? "block" : "error",
    code: error.code,
    message: `${error.processorId}: ${error.message}`,
    sourceRefs: [],
  });
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
```

- [ ] **Step 4: Implement executor**

Create `src/processors/executor.ts`:

```ts
import { createHash } from "node:crypto";

import { EffectSchema, type DiagnosticEffect, type Effect } from "../core/effect";
import type { ProcessorContext, ProcessorPhase } from "../core/processor";
import type { RunId } from "../engine/runner-contract";
import type { ResolvedExecutionPolicy } from "./execution-policy";
import {
  diagnosticForExecutionError,
  errorMessage,
  makeExecutionError,
  type ProcessorExecutionError,
} from "./execution-error";

export type ProcessorExecutionResult =
  | {
      readonly status: "succeeded";
      readonly runId: RunId;
      readonly processorId: string;
      readonly effects: ReadonlyArray<Effect>;
      readonly effectHashes: ReadonlyArray<string>;
      readonly durationMs: number;
    }
  | {
      readonly status: "failed" | "timed_out" | "cancelled";
      readonly runId: RunId;
      readonly processorId: string;
      readonly error: ProcessorExecutionError;
      readonly diagnostic: DiagnosticEffect;
      readonly durationMs: number;
    };

export async function executeProcessor<TEnvelope>(opts: {
  readonly processorId: string;
  readonly phase: ProcessorPhase;
  readonly runId: RunId;
  readonly ctx: ProcessorContext<TEnvelope>;
  readonly policy: ResolvedExecutionPolicy;
  readonly run: (ctx: ProcessorContext<TEnvelope>) => Promise<unknown>;
}): Promise<ProcessorExecutionResult> {
  const startedAt = Date.now();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutSentinel = Symbol("processor-timeout");

  const timeout = new Promise<typeof timeoutSentinel>((resolve) => {
    timeoutId = setTimeout(() => resolve(timeoutSentinel), opts.policy.timeoutMs);
  });

  try {
    const raw = await Promise.race([opts.run(opts.ctx), timeout]);
    if (raw === timeoutSentinel) {
      return failure({
        status: "timed_out",
        code: "processor.timeout",
        message: `processor exceeded timeout of ${opts.policy.timeoutMs}ms`,
        retryable: opts.phase !== "adoption",
        opts,
        startedAt,
      });
    }

    const validation = validateEffects(raw);
    if (!validation.ok) {
      return failure({
        status: "failed",
        code: "processor.invalid-output",
        message: validation.message,
        retryable: false,
        opts,
        startedAt,
      });
    }

    const effects = Object.freeze([...validation.effects]);
    return Object.freeze({
      status: "succeeded" as const,
      runId: opts.runId,
      processorId: opts.processorId,
      effects,
      effectHashes: Object.freeze(effects.map(hashEffect)),
      durationMs: Date.now() - startedAt,
    });
  } catch (e) {
    return failure({
      status: "failed",
      code: "processor.threw",
      message: errorMessage(e),
      retryable: false,
      opts,
      startedAt,
    });
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

function validateEffects(raw: unknown):
  | { readonly ok: true; readonly effects: ReadonlyArray<Effect> }
  | { readonly ok: false; readonly message: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, message: "processor returned a non-array value" };
  }
  const effects: Effect[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const parsed = EffectSchema.safeParse(raw[i]);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const issueText =
        issue === undefined
          ? "unknown schema issue"
          : `${issue.path.join(".")}: ${issue.message}`;
      return {
        ok: false,
        message: `processor returned invalid effect[${i}]: ${issueText}`,
      };
    }
    effects.push(parsed.data as Effect);
  }
  return { ok: true, effects: Object.freeze(effects) };
}

function failure<TEnvelope>(input: {
  readonly status: "failed" | "timed_out" | "cancelled";
  readonly code: ProcessorExecutionError["code"];
  readonly message: string;
  readonly retryable: boolean;
  readonly opts: {
    readonly processorId: string;
    readonly phase: ProcessorPhase;
    readonly runId: RunId;
  };
  readonly startedAt: number;
}): ProcessorExecutionResult {
  const error = makeExecutionError({
    code: input.code,
    message: input.message,
    retryable: input.retryable,
    phase: input.opts.phase,
    processorId: input.opts.processorId,
  });
  return Object.freeze({
    status: input.status,
    runId: input.opts.runId,
    processorId: input.opts.processorId,
    error,
    diagnostic: diagnosticForExecutionError(error),
    durationMs: Date.now() - input.startedAt,
  });
}

export function hashEffect(effect: Effect): string {
  return createHash("sha256").update(JSON.stringify(effect)).digest("hex");
}
```

- [ ] **Step 5: Run executor tests**

Run:

```bash
bun test tests/processors/executor.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/processors/execution-error.ts src/processors/executor.ts tests/processors/executor.test.ts
git commit -m "feat: add processor executor"
```

## Task 3: Extend Ledger Statuses and Structured Errors

**Files:**
- Modify: `src/ledger/runs.ts`
- Modify: `tests/ledger/runs.test.ts`
- Test: `tests/ledger/runs.test.ts`

- [ ] **Step 1: Add failing ledger tests for new terminal states**

In `tests/ledger/runs.test.ts`, add `markTimedOut` and `markCancelled` to the import from `../../src/ledger/runs`.

Append inside the existing `describe("runs lifecycle", () => {` block in
`tests/ledger/runs.test.ts`:

```ts
  it("queued → running → timed_out captures structured error JSON", () => {
    const id = freshId();
    queue(id);
    markRunning(db, id, new Date());

    const finishedAt = new Date("2026-05-27T12:00:03.000Z");
    markTimedOut(db, {
      id,
      error: {
        code: "processor.timeout",
        message: "processor exceeded timeout of 2000ms",
        retryable: false,
        phase: "adoption",
        processorId: "dome.intake.extract",
      },
      durationMs: 2000,
      finishedAt,
    });

    const done = getRun(db, id);
    expect(done?.status).toBe("timed_out");
    expect(done?.durationMs).toBe(2000);
    expect(done?.finishedAt).toBe(finishedAt.toISOString());
    expect(JSON.parse(done?.error ?? "{}")).toEqual({
      code: "processor.timeout",
      message: "processor exceeded timeout of 2000ms",
      retryable: false,
      phase: "adoption",
      processorId: "dome.intake.extract",
    });
  });

  it("queued → running → cancelled captures structured error JSON", () => {
    const id = freshId();
    queue(id);
    markRunning(db, id, new Date());

    const finishedAt = new Date("2026-05-27T12:00:04.000Z");
    markCancelled(db, {
      id,
      error: {
        code: "processor.cancelled",
        message: "processor cancelled during shutdown",
        retryable: false,
        phase: "garden",
        processorId: "dome.intake.extract",
      },
      durationMs: 100,
      finishedAt,
    });

    const done = getRun(db, id);
    expect(done?.status).toBe("cancelled");
    expect(done?.durationMs).toBe(100);
    expect(JSON.parse(done?.error ?? "{}").code).toBe("processor.cancelled");
  });
```

- [ ] **Step 2: Run ledger tests to verify failure**

Run:

```bash
bun test tests/ledger/runs.test.ts
```

Expected: FAIL because `markTimedOut`, `markCancelled`, and statuses are missing.

- [ ] **Step 3: Implement ledger statuses and accessors**

In `src/ledger/runs.ts`, update `RunStatus`:

```ts
export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "timed_out"
  | "cancelled";
```

Import `type ProcessorExecutionError` from `../processors/execution-error`.

Add option types:

```ts
export type MarkTimedOutOpts = {
  readonly id: RunId;
  readonly error: ProcessorExecutionError;
  readonly durationMs: number;
  readonly finishedAt: Date;
};

export type MarkCancelledOpts = {
  readonly id: RunId;
  readonly error: ProcessorExecutionError;
  readonly durationMs: number;
  readonly finishedAt: Date;
};
```

Add SQL:

```ts
const MARK_TIMED_OUT_SQL = `
UPDATE runs
SET status = 'timed_out',
    error = ?,
    duration_ms = ?,
    finished_at = ?
WHERE id = ? AND status = 'running'
`.trim();

const MARK_CANCELLED_SQL = `
UPDATE runs
SET status = 'cancelled',
    error = ?,
    duration_ms = ?,
    finished_at = ?
WHERE id = ? AND status = 'running'
`.trim();
```

Add functions:

```ts
export function markTimedOut(db: LedgerDb, opts: MarkTimedOutOpts): void {
  db.raw.query(MARK_TIMED_OUT_SQL).run(
    JSON.stringify(opts.error),
    opts.durationMs,
    opts.finishedAt.toISOString(),
    opts.id,
  );
}

export function markCancelled(db: LedgerDb, opts: MarkCancelledOpts): void {
  db.raw.query(MARK_CANCELLED_SQL).run(
    JSON.stringify(opts.error),
    opts.durationMs,
    opts.finishedAt.toISOString(),
    opts.id,
  );
}
```

Update `narrowStatus()` to include:

```ts
    case "timed_out":
    case "cancelled":
```

- [ ] **Step 4: Change `markFailed` to accept structured errors**

Change `MarkFailedOpts.error` to:

```ts
  readonly error: string | ProcessorExecutionError;
```

Change `markFailed()` to serialize objects:

```ts
const error =
  typeof opts.error === "string" ? opts.error : JSON.stringify(opts.error);
db.raw.query(MARK_FAILED_SQL).run(
  error,
  opts.durationMs,
  opts.finishedAt.toISOString(),
  opts.id,
);
```

Existing tests expecting string errors should still pass.

- [ ] **Step 5: Run ledger tests**

Run:

```bash
bun test tests/ledger/runs.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/ledger/runs.ts tests/ledger/runs.test.ts
git commit -m "feat: add terminal processor run statuses"
```

## Task 4: Wire Runtime Through Executor

**Files:**
- Modify: `src/processors/runtime.ts`
- Modify: `tests/processors/runtime.test.ts`
- Modify: `tests/processors/runtime-ledger.test.ts`
- Test: `tests/processors/runtime.test.ts`
- Test: `tests/processors/runtime-ledger.test.ts`

- [ ] **Step 1: Rewrite runtime throw test for strict blocking diagnostic**

In `tests/processors/runtime.test.ts`, replace the existing `"processor that throws"` test expectations with:

```ts
    expect(results.length).toBe(1);
    const effects = results[0]?.effects ?? [];
    expect(effects.length).toBe(1);
    const synthesized = effects[0];
    expect(synthesized?.kind).toBe("diagnostic");
    if (synthesized?.kind !== "diagnostic") return;
    expect(synthesized.code).toBe("processor.threw");
    expect(synthesized.severity).toBe("block");
    expect(synthesized.message).toContain("test.thrower");
    expect(synthesized.message).toContain("boom");
```

Add this invalid-output test in the same `describe` block:

```ts
  test("processor returning malformed effect → processor.invalid-output block diagnostic", async () => {
    const p = makeFixtureProcessor({
      id: "test.invalid-output",
      phase: "adoption",
      triggers: [{ kind: "signal", name: "file.created" }],
      run: async () => [{ kind: "patch", mode: "auto", changes: [], reason: "bad", sourceRefs: [] } as never],
    });
    const rt = buildRuntimeFor([p]);

    const results = await rt.adoptionRunner({
      vault: STUB_VAULT,
      candidate: CANDIDATE,
      changedPaths: ["wiki/a.md"],
      signals: [SIGNAL_CREATED],
      iteration: 1,
      proposal,
    });

    expect(results.length).toBe(1);
    const effect = results[0]?.effects[0];
    expect(effect?.kind).toBe("diagnostic");
    if (effect?.kind !== "diagnostic") return;
    expect(effect.code).toBe("processor.invalid-output");
    expect(effect.severity).toBe("block");
  });
```

- [ ] **Step 2: Rewrite runtime ledger throw test for structured error**

In `tests/processors/runtime-ledger.test.ts`, replace:

```ts
    expect(row.error).toContain("boom from test");
```

with:

```ts
    const parsed = JSON.parse(row.error ?? "{}");
    expect(parsed.code).toBe("processor.threw");
    expect(parsed.message).toContain("boom from test");
    expect(parsed.processorId).toBe("test.ledger.thrower");
```

Also change the comment above the result assertion to:

```ts
    // The engine-generated block diagnostic flows back to the adoption loop.
```

- [ ] **Step 3: Run runtime tests to verify failures**

Run:

```bash
bun test tests/processors/runtime.test.ts tests/processors/runtime-ledger.test.ts
```

Expected: FAIL because runtime still emits `processor-threw` with severity `error` and string ledger errors.

- [ ] **Step 4: Update runtime imports**

In `src/processors/runtime.ts`, remove the local `createHash` import and remove the `DiagnosticEffect` type import after deleting `runOneProcessor`. Keep the `diagnosticEffect` value import because the policy-denial branch below uses it.

Replace the existing ledger import block with this exact block:

```ts
import { executeProcessor } from "./executor";
import { resolveExecutionPolicy } from "./execution-policy";
import {
  insertQueued,
  markCancelled,
  markFailed,
  markRunning,
  markSkipped,
  markSucceeded,
  markTimedOut,
  newRunId,
  type RunId,
  type TriggerKind,
} from "../ledger/runs";
```

- [ ] **Step 5: Resolve policy before marking the run `running`**

In `dispatchOneProcessor()`, policy resolution must happen after `insertQueued`
and before `markRunning`. Move the existing `markRunning(ledger, runId,
startedAt)` call so it runs only after the policy check succeeds.

Add this block after the queued row is inserted:

```ts
  const policyResult = resolveExecutionPolicy({
    phase,
    request: processor.execution,
    vaultCap: undefined,
  });
  if (!policyResult.ok) {
    const finishedAt = new Date();
    if (ledger !== undefined) {
      markSkipped(ledger, { id: runId, finishedAt });
    }
    return Object.freeze({
      runId,
      processorId: processor.id,
      declared,
      granted,
      effects: Object.freeze([
        diagnosticEffect({
          severity: phase === "adoption" ? "block" : "error",
          code: policyResult.error.code,
          message: `${processor.id}: ${policyResult.error.message}`,
          sourceRefs: [],
        }),
      ]),
    });
  }

  if (ledger !== undefined) {
    markRunning(ledger, runId, startedAt);
  }
```

- [ ] **Step 6: Pass signal into context and call executor**

In `dispatchOneProcessor()`, before `ctxInput`, create:

```ts
  const controller = new AbortController();
```

Add to `ctxInput`:

```ts
    signal: controller.signal,
```

Replace the old `runOneProcessor` call with:

```ts
  const execution = await executeProcessor({
    processorId: processor.id,
    phase,
    runId,
    ctx,
    policy: policyResult.value,
    run: processor.run as (ctx: ProcessorContext<TEnvelope>) => Promise<unknown>,
  });
```

Keep `diagnosticEffect` import if using it for policy denial.

- [ ] **Step 7: Update ledger terminal mark**

Replace the `runOutcome` terminal block with:

```ts
  if (ledger !== undefined) {
    const finishedAt = new Date();
    if (execution.status === "succeeded") {
      markSucceeded(ledger, {
        id: runId,
        effectHashes: execution.effectHashes,
        costUsd: null,
        durationMs: execution.durationMs,
        outputCommit: null,
        finishedAt,
      });
    } else if (execution.status === "timed_out") {
      markTimedOut(ledger, {
        id: runId,
        error: execution.error,
        durationMs: execution.durationMs,
        finishedAt,
      });
    } else if (execution.status === "cancelled") {
      markCancelled(ledger, {
        id: runId,
        error: execution.error,
        durationMs: execution.durationMs,
        finishedAt,
      });
    } else {
      markFailed(ledger, {
        id: runId,
        error: execution.error,
        durationMs: execution.durationMs,
        finishedAt,
      });
    }
  }
```

- [ ] **Step 8: Return validated effects or failure diagnostic**

Replace the returned `effects` field with:

```ts
    effects:
      execution.status === "succeeded"
        ? execution.effects
        : Object.freeze([execution.diagnostic]),
```

- [ ] **Step 9: Delete old local helpers**

Delete from `src/processors/runtime.ts`:

- `type RunOutcome`
- `runOneProcessor`
- local `hashEffect`
- local `errorMessage`

- [ ] **Step 10: Run runtime tests**

Run:

```bash
bun test tests/processors/runtime.test.ts tests/processors/runtime-ledger.test.ts tests/processors/executor.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit Task 4**

```bash
git add src/processors/runtime.ts tests/processors/runtime.test.ts tests/processors/runtime-ledger.test.ts
git commit -m "feat: run processors through executor"
```

## Task 5: Make Adoption Processor Execution Failures Block

**Files:**
- Modify: `tests/harness/scenarios/lifecycle/throwing-processor-blocks-adoption.scenario.test.ts`
- Test: `tests/harness/scenarios/lifecycle/throwing-processor-blocks-adoption.scenario.test.ts`

- [ ] **Step 1: Rewrite lifecycle scenario expectations**

In `tests/harness/scenarios/lifecycle/throwing-processor-blocks-adoption.scenario.test.ts`, change the top comment to state:

```ts
// A processor that throws unconditionally: the runtime records a failed
// ledger row and synthesizes a `processor.threw` DiagnosticEffect. Because
// this processor runs in adoption phase, the diagnostic is severity `block`
// and adoption does not advance.
```

Change Step 3 assertions:

```ts
    const result = await h.tick();
    expect(result.adopted).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "processor.threw")).toBe(true);
```

Change Step 5 assertions:

```ts
    expect(diag.code).toBe("processor.threw");
    expect(diag.severity).toBe("block");
```

- [ ] **Step 2: Run lifecycle scenario to verify failure or pass**

Run:

```bash
bun test tests/harness/scenarios/lifecycle/throwing-processor-blocks-adoption.scenario.test.ts
```

Expected after Task 4: PASS.

- [ ] **Step 3: Commit Task 5**

```bash
git add tests/harness/scenarios/lifecycle/throwing-processor-blocks-adoption.scenario.test.ts
git commit -m "test: require adoption processor failures to block"
```

## Task 6: Add Manifest Execution Metadata

**Files:**
- Modify: `src/extensions/manifest-schema.ts`
- Create: `tests/extensions/manifest-schema.test.ts`
- Test: `tests/extensions/manifest-schema.test.ts`

- [ ] **Step 1: Add failing manifest tests**

Create `tests/extensions/manifest-schema.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { parseManifest } from "../../src/extensions/manifest-schema";

const baseProcessor = {
  id: "test.proc",
  version: "0.0.1",
  phase: "garden",
  triggers: [{ kind: "signal", name: "file.created" }],
  capabilities: [],
  module: "./processors/proc.ts",
};

describe("parseManifest — execution metadata", () => {
  test("accepts garden llm execution metadata", () => {
    const result = parseManifest({
      id: "test.bundle",
      version: "0.0.1",
      processors: [
        {
          ...baseProcessor,
          execution: {
            class: "llm",
            timeoutMs: 600_000,
            maxAttempts: 1,
            modelCallTimeoutMs: 180_000,
          },
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.processors[0]?.execution?.class).toBe("llm");
  });

  test("rejects adoption llm execution metadata", () => {
    const result = parseManifest({
      id: "test.bundle",
      version: "0.0.1",
      processors: [
        {
          ...baseProcessor,
          phase: "adoption",
          execution: { class: "llm", timeoutMs: 600_000 },
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("execution-policy-mismatch");
    if (result.error.kind !== "execution-policy-mismatch") return;
    expect(result.error.processorId).toBe("test.proc");
  });
});
```

- [ ] **Step 2: Run manifest tests to verify failure**

Run:

```bash
bun test tests/extensions/manifest-schema.test.ts
```

Expected: FAIL because manifest parsing does not accept `execution` metadata.

- [ ] **Step 3: Update manifest schema**

In `src/extensions/manifest-schema.ts`, import `ExecutionPolicyRequestSchema` and `type ExecutionPolicyRequest`.

Add to `ProcessorDeclaration`:

```ts
  readonly execution?: ExecutionPolicyRequest;
```

Add to `ProcessorDeclarationSchema`:

```ts
    execution: ExecutionPolicyRequestSchema.optional(),
```

Extend `ManifestError`:

```ts
  | {
      readonly kind: "execution-policy-mismatch";
      readonly processorId: string;
      readonly phase: ProcessorPhase;
      readonly executionClass: string;
    };
```

Add a manifest check:

```ts
function checkExecutionPolicyMatrix(
  manifest: Manifest,
): Result<void, ManifestError> {
  for (const decl of manifest.processors) {
    if (
      decl.phase === "adoption" &&
      decl.execution !== undefined &&
      decl.execution.class !== "deterministic"
    ) {
      return err({
        kind: "execution-policy-mismatch",
        processorId: decl.id,
        phase: decl.phase,
        executionClass: decl.execution.class,
      });
    }
  }
  return ok(undefined);
}
```

Call it in `parseManifest()` after `checkPhaseTriggerMatrix()`.

- [ ] **Step 4: Run manifest tests**

Run:

```bash
bun test tests/extensions/manifest-schema.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```bash
git add src/extensions/manifest-schema.ts tests/extensions/manifest-schema.test.ts
git commit -m "feat: add processor execution metadata"
```

## Task 7: Block Adoption Propose Patches Explicitly

**Files:**
- Modify: `src/engine/apply-effect.ts`
- Modify: `src/engine/adopt.ts`
- Modify: `tests/engine/apply-effect.test.ts`
- Modify: `tests/engine/adopt-capability-uses.test.ts`
- Test: `tests/engine/apply-effect.test.ts`
- Test: `tests/engine/adopt-capability-uses.test.ts`

- [ ] **Step 1: Add failing apply-effect tests**

In `tests/engine/apply-effect.test.ts`, add:

```ts
describe("adoption propose patches block for review", () => {
  test("PatchEffect mode propose in adoption returns blocked-for-review", async () => {
    const propose: Capability = { kind: "patch.propose", paths: ["wiki/**"] };
    const r = await applyEffect({
      ...baseOpts,
      declared: [propose],
      granted: [propose],
      phase: "adoption",
      effect: patchEffect({
        mode: "propose",
        changes: [{ kind: "write", path: "wiki/x.md", content: "x\n" }],
        reason: "needs review",
        sourceRefs: [ref],
      }),
    });

    expect(r.outcome).toBe("blocked-for-review");
    expect(r.appliedEffect).toBeNull();
    expect(r.diagnostics[0]?.severity).toBe("block");
    expect(r.diagnostics[0]?.code).toBe("patch.propose.requires-review");
  });

  test("auto downgraded to propose blocks for review", async () => {
    const propose: Capability = { kind: "patch.propose", paths: ["wiki/**"] };
    const r = await applyEffect({
      ...baseOpts,
      declared: [propose],
      granted: [propose],
      phase: "adoption",
      effect: patchEffect({
        mode: "auto",
        changes: [{ kind: "write", path: "wiki/x.md", content: "x\n" }],
        reason: "needs auto",
        sourceRefs: [ref],
      }),
    });

    expect(r.outcome).toBe("blocked-for-review");
    expect(r.capabilityUse?.capability).toBe("patch.auto");
    expect(r.capabilityUse?.outcome).toBe("downgraded");
  });
});
```

- [ ] **Step 2: Run apply-effect tests to verify failure**

Run:

```bash
bun test tests/engine/apply-effect.test.ts
```

Expected: FAIL because `blocked-for-review` is not implemented.

- [ ] **Step 3: Extend `ApplyEffectResult` outcome**

In `src/engine/apply-effect.ts`, change the outcome union to include:

```ts
  readonly outcome:
    | "applied"
    | "downgraded"
    | "denied"
    | "rejected-by-phase"
    | "blocked-for-review";
```

- [ ] **Step 4: Add blocked-for-review branch after capability enforcement**

After `routed` and `verdictDiagnostics` are computed, before `routeToSink()`, add:

```ts
  if (opts.phase === "adoption" && routed.kind === "patch" && routed.mode === "propose") {
    const reviewDiagnostic = diagnosticEffect({
      severity: "block",
      code: "patch.propose.requires-review",
      message: `PatchEffect from ${opts.processorId} requires review before adoption: ${routed.reason}`,
      sourceRefs: routed.sourceRefs,
    });
    const capabilityOutcome: "allowed" | "downgraded" =
      verdict.kind === "downgrade" ? "downgraded" : "allowed";
    return frozen({
      outcome: "blocked-for-review",
      appliedEffect: null,
      diagnostics: Object.freeze([...verdictDiagnostics, reviewDiagnostic]),
      ...maybeCapabilityUse(opts.effect, capabilityOutcome),
    });
  }
```

This branch must run after broker enforcement so denied propose patches remain `denied`, and downgraded auto patches still record `patch.auto` as `downgraded`.

- [ ] **Step 5: Run apply-effect tests**

Run:

```bash
bun test tests/engine/apply-effect.test.ts
```

Expected: PASS.

- [ ] **Step 6: Rewrite adoption capability tests**

In `tests/engine/adopt-capability-uses.test.ts`:

Change the first test name to:

```ts
test("PatchEffect (propose) with patch.propose granted → blocks adoption and records 'allowed' row", async () => {
```

Change its adoption assertion:

```ts
    expect(r.adopted).toBe(false);
    expect(r.diagnostics.some((d) => d.code === "patch.propose.requires-review")).toBe(true);
```

Change the downgraded test assertion:

```ts
    expect(r.adopted).toBe(false);
    expect(r.diagnostics.some((d) => d.code === "patch.propose.requires-review")).toBe(true);
```

In the denied test, store the adoption result and assert:

```ts
    const r = await adopt({
      vault: f.vault,
      proposal,
      runAdoptionProcessors: runner,
      sinks: noopSinks(),
      ledger: f.ledger,
    });

    expect(r.adopted).toBe(false);
```

In the no-ledger propose test, change:

```ts
    expect(r.adopted).toBe(false);
```

- [ ] **Step 7: Run adoption capability tests**

Run:

```bash
bun test tests/engine/adopt-capability-uses.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 7**

```bash
git add src/engine/apply-effect.ts src/engine/adopt.ts tests/engine/apply-effect.test.ts tests/engine/adopt-capability-uses.test.ts
git commit -m "feat: block adoption propose patches"
```

## Task 8: Run Focused Regression Suite and Update Docs

**Files:**
- Modify: `docs/wiki/specs/processor-execution.md`
- Modify: `docs/wiki/specs/effects.md`
- Modify: `docs/wiki/specs/run-ledger.md`
- Modify: `docs/superpowers/specs/2026-05-28-processor-boundary-design.md` only if implementation names differ
- Test: focused runtime, ledger, engine, and harness tests

- [ ] **Step 1: Run focused regression tests**

Run:

```bash
bun test tests/processors/executor.test.ts tests/processors/context.test.ts tests/processors/execution-policy.test.ts tests/processors/runtime.test.ts tests/processors/runtime-ledger.test.ts tests/ledger/runs.test.ts tests/core/processor.test.ts tests/extensions/manifest-schema.test.ts tests/engine/apply-effect.test.ts tests/engine/adopt-capability-uses.test.ts tests/harness/scenarios/lifecycle/throwing-processor-blocks-adoption.scenario.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run invariant and gotcha lockstep tests**

Run:

```bash
bun test tests/integration/invariant-coverage.test.ts tests/integration/gotcha-coverage.test.ts
```

Expected: PASS.

- [ ] **Step 3: Update docs for implemented names**

In `docs/wiki/specs/processor-execution.md`, ensure these exact names appear:

```md
- `processor.threw`
- `processor.invalid-output`
- `processor.timeout`
- `processor.cancelled`
- `timed_out`
- `cancelled`
- `blocked-for-review`
```

In `docs/wiki/specs/effects.md`, ensure adoption `mode: "propose"` says it produces `blocked-for-review` and a blocking diagnostic.

In `docs/wiki/specs/run-ledger.md`, ensure terminal states list:

```text
succeeded | failed | skipped | timed_out | cancelled
```

and that `error` is described as structured JSON for execution failures.

- [ ] **Step 4: Run doc diff checks**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 5: Run full test suite if focused tests are green**

Run:

```bash
bun test
```

Expected: PASS.

- [ ] **Step 6: Commit Task 8**

```bash
git add docs/wiki/specs/processor-execution.md docs/wiki/specs/effects.md docs/wiki/specs/run-ledger.md docs/superpowers/specs/2026-05-28-processor-boundary-design.md
git commit -m "docs: align processor execution boundary"
```

## Final Verification

- [ ] Run final status:

```bash
git status --short
```

Expected: no output.

- [ ] Confirm commit sequence:

```bash
git log --oneline -n 8
```

Expected: shows the task commits in order.

- [ ] Summarize remaining known out-of-scope work:

```md
Out of scope for this plan:
- real vault grant parsing / declared ∩ granted enforcement;
- projection rebuild implementation;
- AbstractSurface / MCP implementation;
- outbox handler dispatch loop;
- full modelInvoke provider implementation.
```
