---
type: spec
created: 2026-05-28
updated: 2026-05-28
sources: ["[[wiki/specs/processors]]", "[[wiki/specs/run-ledger]]", "[[wiki/specs/effects]]"]
---

# Processor execution

This spec is normative for the target contract around processor invocation: how the engine invokes processors, validates their outputs, records failures, and recovers from transient execution problems. [[wiki/specs/processors]] defines what a Processor is; this page defines the intended runtime contract and calls out the current implementation stage where wiring is still in progress.

The goal is boring execution semantics: a processor run has one state machine, one timeout policy, one output-validation boundary, one retry/quarantine policy, and one ledger record. State-transition bugs, timeout ambiguity, malformed JSON, and transient model/vendor failures should be visible as typed run outcomes rather than scattered special cases.

## Implementation stage

As of the processor-executor-boundary branch:

- `src/processors/executor.ts` provides the executor boundary. It validates returned outputs, enforces per-invocation timeout/cancellation when called, and returns structured `ProcessorExecutionResult` variants with `processor.invalid-output`, `processor.threw`, `processor.timeout`, and `processor.cancelled` errors.
- `src/ledger/runs.ts` can persist the full terminal status set, including `timed_out` and `cancelled`, through `markTimedOut` and `markCancelled`.
- `src/processors/runtime.ts` is not yet wired through the executor. The current direct runtime path still writes success/failure rows directly and still emits the legacy thrown-processor diagnostic code `processor-threw` until Task 4 routes runtime dispatch through `executeProcessor`.
- Model invocation, retry/quarantine, and graceful drain/close integration are target surfaces described here for the completed architecture; they are not fully implemented by this branch.

## Run state machine

Every processor invocation has exactly one RunRecord in `runs.db`. The target execution contract moves through this finite state machine:

```text
queued
  -> running
  -> succeeded | failed | skipped | timed_out | cancelled
```

Terminal states are final. A terminal run never transitions again. The ledger accessors already enforce terminal transition filtering for `succeeded`, `failed`, `skipped`, `timed_out`, and `cancelled`. Runtime-wide production of `timed_out` and `cancelled` rows lands when Task 4 wires the runtime through the executor. If the process crashes while a run is `running`, the row remains `running`; health checks surface it as an orphan run.

| State | Meaning |
|---|---|
| `queued` | The engine accepted the invocation and wrote the RunRecord, but `Processor.run()` has not started. |
| `running` | `Processor.run()` is executing. Under the executor boundary it executes with a bounded context and timeout. |
| `succeeded` | `Processor.run()` returned and every emitted Effect passed schema validation at the active boundary. Capability denial of an emitted Effect does not make the run fail; the denial is a routed outcome and is ledgered separately. |
| `failed` | `Processor.run()` threw, returned a non-array, returned malformed Effects, or hit a non-timeout runtime error. Under the direct runtime path thrown processors still use the legacy `processor-threw` diagnostic until Task 4. |
| `skipped` | Idempotency dedup short-circuited the invocation before execution. |
| `timed_out` | The run exceeded its phase timeout. Effects produced after timeout are discarded. |
| `cancelled` | The engine intentionally stopped the run during shutdown/drain cancellation or explicit operator intervention. |

The run ledger stores `status`, `started_at`, `finished_at`, `duration_ms`, `error`, and `effect_hashes_json`. `error` is null for `succeeded` and `skipped`; terminal failure states store a structured JSON object with at least `code`, `message`, and `retryable`.

## Timeouts

Timeouts are phase-scoped and configurable in `.dome/config.yaml`:

```yaml
engine:
  processor_timeouts_ms:
    adoption: 2000
    garden: 120000
    view: 30000
```

Defaults:

| Phase | Default timeout | Rationale |
|---|---:|---|
| `adoption` | 2s per processor run | Adoption is the merge gate; it must be deterministic and low latency. |
| `garden` | 120s per processor run | Garden work may call models or external systems, but must still be bounded. |
| `view` | 30s per processor run | A user or protocol caller is waiting for output. |

Timeouts are enforced by the executor boundary, not by individual processors. When `executeProcessor` is used, a timed-out processor produces a `processor.timeout` diagnostic, the executor returns `status: "timed_out"`, and no returned Effects from that invocation are routed. The ledger already has `markTimedOut` for persisting that result. Runtime-wide timeout enforcement and adoption/garden routing semantics land when Task 4 wires runtime dispatch through the executor. Garden timed-out retry behavior is part of the target retry/quarantine surface below.

## Output validation

The processor boundary is:

```ts
Processor.run(ctx): Promise<Effect[]>
```

The executor boundary validates returned values before routing:

1. The resolved value must be an array.
2. Each array element must match one of the seven Effect schemas in [[wiki/specs/effects]].
3. Effect-kind-specific invariants are checked before capability enforcement: non-empty PatchEffect changes, mandatory SourceRefs where required, confidence on inferred/generated facts, valid idempotency keys, valid SourceRef path/range shape.
4. The effect list is canonicalized for hashing only after validation; the engine does not silently repair malformed effects.

Validation failure returns `status: "failed"` with `code: "processor.invalid-output"` and emits a diagnostic naming the offending processor and effect index. No effects from that executor result are routed. This all-or-nothing rule prevents partial application of a processor that returned a mixed valid/invalid effect list. Runtime-wide output-validation diagnostics follow this contract once Task 4 replaces the direct runtime dispatch path with the executor boundary.

## Model invocation and structured output

This section describes the target model-invocation surface. It is not fully implemented by the current processor-executor-boundary branch.

Processors should never import LLM SDKs directly. A processor with `model.invoke` receives `ctx.modelInvoke`; processors without the capability receive no model function.

The planned `ctx.modelInvoke` runtime boundary has these guarantees:

- Checks the processor's `model.invoke` grant, model allowlist, and daily cost cap before the call.
- Records token/cost metadata into the current RunRecord.
- Supports structured output by requiring a Zod schema or JSON schema at the call site.
- Retries provider-transient failures with bounded backoff inside the run timeout.
- Returns typed success or throws a structured `model.invoke.*` error.

Structured-output parse failures are not repaired by prompt-only retry loops unless the processor explicitly asks for one through `ctx.modelInvoke({ retries: n })`. After retries are exhausted, the run fails with `code: "model.output.invalid-json"` or `code: "model.output.schema-mismatch"`. The diagnostic includes the schema name and a short parse reason, not the full prompt or full model output.

Adoption-phase processors cannot receive `ctx.modelInvoke`. Registration rejects an adoption-phase manifest that declares `model.invoke`.

## Retries and quarantine

This section describes the target retry/quarantine policy. It is not fully implemented by the current processor-executor-boundary branch.

The target runtime classifies run failures:

| Class | Examples | Retry behavior |
|---|---|---|
| `deterministic` | invalid output, phase mismatch, capability schema violation | No automatic retry. Mark failed. |
| `transient` | model provider 429/5xx, network timeout, temporary SQLite busy | Retry with exponential backoff within the run's phase policy. |
| `timeout` | phase timeout exceeded | No in-run retry. Garden jobs may be rescheduled if their JobEffect policy allows it. |
| `operator` | cancellation, shutdown | Mark cancelled; no retry unless explicitly re-run. |

In the target architecture, garden and scheduled runs maintain consecutive failure counters keyed by `(processorId, processorVersion, triggerHash)`. After three consecutive retryable terminal failures, the processor trigger is quarantined and future matching invocations are skipped with a `processor.quarantined` diagnostic until the user or a health processor clears the quarantine.

Adoption-phase processors are never quarantined automatically. If an adoption processor fails, adoption blocks: trusted state cannot advance while the deterministic gate is unhealthy.

## Drain and shutdown

This section describes the target drain/close contract. It is not fully implemented by the current processor-executor-boundary branch.

`drainProcessors()` waits for queued and running garden/view work to settle up to the configured drain timeout. It does not start new schedule-triggered work while draining. On graceful shutdown:

1. Stop accepting new garden/view invocations.
2. Wait for currently running invocations to finish until the drain timeout.
3. Mark still-running garden/view runs `cancelled`.
4. Preserve adoption-phase atomicity: an adoption loop either finishes and advances the adopted ref, or exits without advancing.
5. Close SQLite handles after terminal run rows are written.

`close()` calls `drainProcessors()` and is one-shot. Calls against a closed Vault return a typed `vault-closed` error rather than throwing.

## Diagnostics

The executor contract uses stable diagnostic codes:

| Code | When emitted |
|---|---|
| `processor.invalid-output` | Return value is not `Effect[]` or an effect fails schema validation. |
| `processor.timeout` | Phase timeout exceeded. |
| `processor.threw` | Processor threw a non-specialized runtime error under the executor contract / post-Task-4 runtime path. The legacy direct runtime path still emits `processor-threw` until Task 4 lands. |
| `processor.cancelled` | Engine cancelled the run during shutdown/operator intervention. |
| `processor.quarantined` | A matching trigger is skipped because the processor is quarantined. |
| `model.invoke.denied` | Missing model capability, model not allowlisted, or cost cap exceeded. |
| `model.output.invalid-json` | Structured model output was not parseable JSON after retries. |
| `model.output.schema-mismatch` | Structured model output parsed but failed the requested schema. |

Diagnostics point at the processor/run, not at arbitrary vault content, unless the failed Effect carried valid SourceRefs before validation failed.

## Test guarantees

The execution contract is pinned in stages.

Already pinned in this branch:

- Executor-boundary tests assert success, thrown errors, invalid output, timeout, cancellation, diagnostic severity, and discarded late effects at `executeProcessor`.
- Ledger tests assert `timed_out` / `cancelled` status persistence, structured error JSON, query filtering, and terminal transition filtering.

Pending once runtime integration lands:

- Runtime state-machine tests assert legal transitions and terminal-state immutability through live dispatch.
- Runtime timeout tests assert adoption timeout blocks adoption, garden timeout records `timed_out`, and late effects are discarded through the engine path.
- Runtime output-validation tests assert malformed effect lists fail all-or-nothing through live dispatch.
- Model-invoke tests assert capability denial, invalid JSON, schema mismatch, and cost-cap errors become structured run failures.
- Quarantine tests assert three consecutive retryable garden failures quarantine matching triggers and subsequent invocations skip with diagnostics.
- Drain tests assert `close()` cancels or settles in-flight runs and releases SQLite handles only after run records are terminal.

## Related

- [[wiki/specs/processors]] — Processor type and phases
- [[wiki/specs/effects]] — Effect schemas
- [[wiki/specs/capabilities]] — broker and `model.invoke`
- [[wiki/specs/run-ledger]] — RunRecord tables
- [[wiki/specs/projection-store]] — scheduled jobs and projection rebuild
- [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]]
- [[wiki/gotchas/processor-idempotency]]
