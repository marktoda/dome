---
type: spec
created: 2026-05-28
updated: 2026-05-28
sources: ["[[wiki/specs/processors]]", "[[wiki/specs/run-ledger]]", "[[wiki/specs/effects]]"]
---

# Processor execution

This spec is normative for the target contract around processor invocation: how the engine invokes processors, validates their outputs, records failures, and recovers from transient execution problems. [[wiki/specs/processors]] defines what a Processor is; this page defines the runtime contract and calls out the current implementation stage plus deferred surfaces.

The goal is boring execution semantics: a processor run has one state machine, one timeout policy, one output-validation boundary, one retry/quarantine policy, and one ledger record. State-transition bugs, timeout ambiguity, malformed JSON, and transient model/vendor failures should be visible as typed run outcomes rather than scattered special cases.

## Implementation stage

As of the processor-executor-boundary branch:

- `src/processors/executor.ts` provides the executor boundary. It validates returned outputs, enforces per-invocation timeout/cancellation when called, and returns structured `ProcessorExecutionResult` variants with `processor.invalid-output`, `processor.threw`, `processor.timeout`, and `processor.cancelled` errors.
- `src/ledger/runs.ts` can persist the full terminal status set, including `timed_out` and `cancelled`, through `markTimedOut` and `markCancelled`.
- `src/processors/runtime.ts` dispatches adoption, garden, and view processors through `executeProcessor`. Runtime policy denial is recorded as `skipped` with a structured not-invoked reason; executor terminal results are recorded as `succeeded`, `failed`, `timed_out`, or `cancelled`.
- Model invocation, retry/quarantine, and graceful drain/close integration are target surfaces described here for the completed architecture; they are not fully implemented by this branch.

## Run state machine

Every processor invocation has exactly one RunRecord in `runs.db`. The target execution contract moves through this finite state machine:

```text
queued
  -> skipped
  -> running
       -> succeeded | failed | timed_out | cancelled
```

Terminal states are final. A terminal run never transitions again. The ledger accessors enforce terminal transition filtering for `succeeded`, `failed`, `skipped`, `timed_out`, and `cancelled`. If the process crashes while a run is `running`, the row remains `running`; health checks surface it as an orphan run.

| State | Meaning |
|---|---|
| `queued` | The engine accepted the invocation and wrote the RunRecord, but `Processor.run()` has not started. |
| `running` | `Processor.run()` is executing. Under the executor boundary it executes with a bounded context and timeout. |
| `succeeded` | `Processor.run()` returned and every emitted Effect passed schema validation at the active boundary. Capability denial of an emitted Effect does not make the run fail; the denial is a routed outcome and is ledgered separately. |
| `failed` | `Processor.run()` threw, returned a non-array, returned malformed Effects, or hit a non-timeout runtime error. |
| `skipped` | The runtime did not invoke the processor. Idempotency dedup skips have `error = NULL`; policy denial and future quarantine skips write structured reason JSON. |
| `timed_out` | The run exceeded its phase timeout. Effects produced after timeout are discarded. |
| `cancelled` | The engine intentionally stopped the run during shutdown/drain cancellation or explicit operator intervention. |

The run ledger stores `status`, `started_at`, `finished_at`, `duration_ms`, `error`, and `effect_hashes_json`. `error` is null for `succeeded` and idempotency `skipped`; terminal failure states and reasoned skips store structured JSON with at least `code`, `message`, `phase`, and `processorId` where applicable.

## Timeouts

Timeouts are phase-scoped. The current runtime resolves per-processor
execution metadata and default phase policy inside `resolveExecutionPolicy`;
vault-level timeout caps from `.dome/config.yaml` are a planned v1.x policy
surface, not yet wired through `src/processors/runtime.ts`.

Planned vault-level configuration:

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

Timeouts are enforced by the executor boundary, not by individual processors.
A timed-out processor produces a `processor.timeout` diagnostic, the executor
returns `status: "timed_out"`, and no returned Effects from that invocation
are routed. The runtime records the timed-out row through `markTimedOut`; late
effects leave `effect_hashes_json` empty because the invocation did not
succeed. Garden timed-out retry behavior is part of the target
retry/quarantine surface below.

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

Validation failure returns `status: "failed"` with `code: "processor.invalid-output"` and emits a diagnostic naming the offending processor and effect index. No effects from that executor result are routed. This all-or-nothing rule prevents partial application of a processor that returned a mixed valid/invalid effect list.

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
| `processor.threw` | Processor threw a non-specialized runtime error under the executor contract. |
| `processor.cancelled` | Engine cancelled the run during shutdown/operator intervention. |
| `execution-policy.phase-class-denied` | Runtime refused to invoke a processor because its declared execution class is invalid for the phase; the run is marked `skipped`. |
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
- Runtime tests assert adoption failures become block diagnostics, garden failures become error diagnostics, invalid output is rejected, execution-policy denial skips without invoking `run`, and garden timeout discards late output while recording `timed_out`.
- Lifecycle scenarios assert a throwing adoption processor records a failed ledger row, persists a block diagnostic for inspection, and does not advance the adopted ref.

Pending:

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
