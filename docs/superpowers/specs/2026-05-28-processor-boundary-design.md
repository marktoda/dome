# Processor Boundary Design

## Purpose

Dome processors are extension code. They are useful because they can inspect
vault state and propose Effects, but they must not be trusted to define engine
semantics. The processor boundary must therefore be explicit, narrow, and
boring:

- processor code may return candidate output;
- the runtime decides whether that output is valid;
- the broker decides whether valid Effects are allowed;
- the engine decides whether trusted state may advance.

This design replaces alpha-era leniency with the hard v1 contract. Existing
tests or comments that pin lenient behavior are considered drift, not
compatibility requirements.

## Goals

- Give every processor invocation one finite run state machine.
- Validate processor output before routing any Effect.
- Enforce timeouts outside processor code.
- Treat adoption execution failures as blocking.
- Keep routing outcomes separate from execution outcomes.
- Make LLM and batch work possible without weakening adoption.
- Keep processor authoring simple: `Processor.run(ctx): Promise<Effect[]>`.

## Non-Goals

- Do not redesign the Effect union in this pass.
- Do not implement `AbstractSurface`, projection rebuild, or full outbox
  dispatch here.
- Do not require processors to use builder APIs before returning Effects.
  Builder helpers are outside this design; runtime validation remains mandatory.

## Design Choice

Use an explicit `ProcessorExecutor` boundary between registry matching and
effect routing:

```text
ProcessorRuntime
  -> ProcessorExecutor.invoke(...)
  -> ProcessorExecutionResult
  -> applyEffect(...) for validated Effects only
```

The executor owns invocation, timeout race, cancellation signal, output
validation, execution-error classification, failure diagnostics, and effect
hashing. `applyEffect` remains the routing and capability chokepoint.

This keeps the critical distinction clear:

- execution success means the processor returned valid Effects within policy;
- routing success means each valid Effect was accepted by phase and capability
  policy.

Capability denial is not a processor execution failure. Throwing, timing out,
or returning malformed output is.

## Registration Contract

A processor can enter the registry only after static metadata is valid:

- id and version are valid and unique;
- phase is one of `adoption`, `garden`, `view`;
- triggers are compatible with phase;
- command triggers have no collisions;
- declared capabilities are valid;
- execution policy request is valid for the phase;
- adoption processors do not declare `model.invoke`, `llm`, or `batch`.

Bundle metadata should have one reviewable source of truth. The recommended
alpha-era simplification is manifest-bound normalization:

- the manifest declares id, version, phase, triggers, capabilities, and
  execution request;
- the module export supplies the `run` function;
- loader rejects mismatches instead of merging two competing declarations.

This can be implemented incrementally, but the target boundary should not trust
module-exported capabilities over manifest-reviewed capabilities.

## Invocation Contract

Runtime gives the processor a frozen context:

```ts
type ProcessorContext<TInput> = {
  readonly snapshot: Snapshot;
  readonly changedPaths: ReadonlyArray<string>;
  readonly proposal: Proposal | null;
  readonly runId: RunId;
  readonly input: TInput;
  readonly signal: AbortSignal;
  readonly modelInvoke?: ModelInvokeFn;
  readonly projection?: ProjectionQueryView;
};
```

Processor output is treated as `unknown` until validation succeeds.

```ts
type ProcessorExecutionResult =
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
```

Structured execution errors:

```ts
type ProcessorExecutionError = {
  readonly code:
    | "processor.threw"
    | "processor.invalid-output"
    | "processor.timeout"
    | "processor.cancelled";
  readonly message: string;
  readonly retryable: boolean;
  readonly phase: ProcessorPhase;
  readonly processorId: string;
};
```

Rules:

- `succeeded` means the processor returned within timeout and every returned
  item passed `EffectSchema`.
- `failed`, `timed_out`, and `cancelled` route no processor-returned Effects.
- failure diagnostics are engine-generated.
- adoption failure diagnostics use `severity: "block"`;
- garden and view failure diagnostics are terminal run failures but do not
  block already-adopted state.
- `runs.error` stores the structured JSON error, not only `Error.message`.

## Output Validation

The executor validates returned values before any effect routing:

1. the resolved value must be an array;
2. every item must pass `EffectSchema`;
3. effect-kind invariants must hold;
4. hashes are computed only after validation;
5. the returned effect array is frozen.

Validation failure is all-or-nothing. If one returned item is malformed, no
Effects from that invocation are routed. The executor returns
`processor.invalid-output` with a diagnostic naming the processor and, when
available, the invalid effect index.

## Timeout and Cancellation

Timeouts are resolved per invocation, not just per phase:

```ts
type ProcessorExecutionPolicy = {
  readonly timeoutMs: number;
  readonly retryBudgetMs: number;
  readonly maxAttempts: number;
  readonly lateEffectBehavior: "discard";
  readonly modelCallTimeoutMs?: number;
};
```

The executor races `processor.run(ctx)` against the resolved deadline and
passes `ctx.signal` into processor context. On timeout:

- mark the run `timed_out`;
- emit `processor.timeout`;
- route no returned Effects;
- discard late resolution output.

Dome does not need to kill JavaScript execution to preserve correctness. It
only needs to guarantee that late Effects from a terminal invocation are never
routed.

## Execution Policy Resolution

Execution policy is separate from capability policy.

Capability answers: may this processor call a model or emit a powerful Effect?
Execution policy answers: how long may this invocation run, how many attempts
may it use, and what deadline applies to model calls?

Resolution order:

```text
engine defaults
  -> phase defaults
  -> processor manifest request
  -> vault grant/config cap
  -> invocation or job override
```

Default classes:

| Class | Intended use | Default |
|---|---|---:|
| `deterministic` | adoption-safe computation | 2s in adoption |
| `interactive` | view commands and user waits | 30s |
| `background` | normal garden work | 120s |
| `llm` | garden model work | 10m |
| `batch` | scheduled or resumable jobs | job-policy defined |

Rules:

- adoption hard-caps at the deterministic timeout;
- adoption cannot receive `ctx.modelInvoke`;
- `model.invoke` requires both capability grant and execution policy;
- retries and model backoff must fit within the remaining run deadline;
- static policy violations fail registration;
- dynamic policy denials create a `skipped` run with a clear diagnostic before
  processor code starts.

Example manifest request:

```yaml
execution:
  class: llm
  timeoutMs: 600000
  maxAttempts: 1
  modelCallTimeoutMs: 180000
```

Example vault cap:

```yaml
extensions:
  dome.intake:
    enabled: true
    grants:
      model.invoke:
        modelAllowlist: ["gpt-5.1", "gpt-5.1-mini"]
        maxDailyCostUsd: 5
      execution:
        timeoutMs: 600000
        modelCallTimeoutMs: 180000
        maxAttempts: 2
```

## Routing and Ledger Semantics

The ledger has execution terminal states:

```text
queued -> running -> succeeded | failed | timed_out | cancelled | skipped
```

Execution status is written by the processor runtime. Effect routing outcomes
are recorded separately per effect:

- `applied`;
- `downgraded`;
- `denied`;
- `rejected-by-phase`;
- `blocked-for-review`.

A run may be `succeeded` even when one valid Effect is denied. The processor
produced valid output; the broker rejected the requested power.

Phase mismatch is also a routing outcome, not an executor failure, unless the
Effect itself is malformed.

Adoption-phase propose patches are special routing outcomes. They are valid
Effects, but they are not adoptable Effects. They must route to
`blocked-for-review` and emit a blocking diagnostic. They must not be silently
dropped through an `applyPatch` sink returning `null`.

## Module Structure

Recommended file responsibilities:

- `src/processors/executor.ts`
  Invoke `processor.run`, enforce timeout/cancellation, validate output,
  classify execution errors, compute effect hashes, and return
  `ProcessorExecutionResult`.

- `src/processors/execution-policy.ts`
  Define execution classes, defaults, manifest request shape, vault cap shape,
  and policy resolution.

- `src/processors/execution-error.ts`
  Define `ProcessorExecutionError`, stable error codes, JSON serialization, and
  diagnostic conversion.

- `src/processors/runtime.ts`
  Keep registry walking, trigger matching, snapshot construction, context
  construction, run-id allocation, ledger lifecycle, and executor invocation.
  Stop directly calling `processor.run`.

- `src/ledger/runs.ts`
  Add `timed_out` and `cancelled`; support structured JSON errors.

- `src/core/processor.ts`
  Add optional static `execution` metadata and `ctx.signal`.

- `src/extensions/manifest-schema.ts`
  Parse manifest execution metadata and reject invalid phase-policy
  combinations.

- `src/engine/apply-effect.ts`
  Represent adoption propose-patch routing as `blocked-for-review`.

## Test Strategy

Executor tests:

- returned non-array fails `processor.invalid-output`;
- one malformed Effect makes the whole result fail;
- thrown error becomes structured `processor.threw`;
- timeout becomes `timed_out`;
- late Effects after timeout are discarded;
- success returns frozen validated Effects and hashes.

Runtime and ledger tests:

- `failed`, `timed_out`, and `cancelled` statuses persist;
- `runs.error` is structured JSON;
- adoption execution failure produces a blocking diagnostic;
- garden execution failure records diagnostics without blocking adopted state.

Routing tests:

- adoption propose patch blocks for review;
- downgraded auto-to-propose patch blocks for review;
- denied Effects are routing outcomes, not execution failures;
- phase mismatch is a routing outcome, not executor failure.

Policy tests:

- adoption cannot receive `model.invoke`;
- LLM garden processor can receive longer explicit timeout;
- vault cap wins over manifest request;
- excessive static manifest request fails registration;
- dynamic policy denial creates a `skipped` run with a clear diagnostic.

Regression rewrites:

- replace the scenario that expects throwing adoption processors to adopt;
- replace auto-to-propose tests that expect successful adoption;
- replace structural invariant tests for processor execution with behavioral
  enforcement tests.

## Rollout Plan

1. Add executor and executor tests without integrating it.
2. Add ledger statuses and structured error serialization.
3. Route `ProcessorRuntime` through the executor.
4. Make adoption execution failures block adoption.
5. Add execution policy resolution.
6. Fix adoption propose-patch routing.
7. Rewrite old lenient tests.
8. Update normative docs to match final implemented names.

Each step should be test-first and independently committable.

## Acceptance Criteria

- No processor-returned value reaches `applyEffect` before `EffectSchema`
  validation.
- A thrown, timed-out, cancelled, or invalid-output adoption processor prevents
  adopted-ref advancement.
- A thrown, timed-out, cancelled, or invalid-output garden/view processor
  records a terminal run failure and routes no returned Effects.
- A valid Effect denied by capability enforcement does not change
  `runs.status` from `succeeded` to `failed`.
- Adoption propose patches and downgraded auto-to-propose patches block for
  review.
- LLM processors can request longer deadlines only through explicit execution
  policy and vault caps.
- Existing tests no longer encode alpha-era leniency as expected behavior.
