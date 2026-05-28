---
type: spec
created: 2026-05-28
updated: 2026-05-28
sources: ["[[wiki/specs/processors]]", "[[wiki/specs/run-ledger]]", "[[wiki/specs/effects]]"]
---

# Processor execution

This spec is normative for how the engine invokes processors, validates their outputs, records failures, and recovers from transient execution problems. [[wiki/specs/processors]] defines what a Processor is; this page defines the runtime contract around a processor invocation.

The goal is boring execution semantics: a processor run has one state machine, one timeout policy, one output-validation boundary, one retry/quarantine policy, and one ledger record. State-transition bugs, timeout ambiguity, malformed JSON, and transient model/vendor failures should be visible as typed run outcomes rather than scattered special cases.

## Run state machine

Every processor invocation has exactly one RunRecord in `runs.db` and moves through this finite state machine:

```text
queued
  -> running
  -> succeeded | failed | skipped | timed_out | cancelled
```

Terminal states are final. A terminal run never transitions again. If the process crashes while a run is `running`, the row remains `running`; health checks surface it as an orphan run.

| State | Meaning |
|---|---|
| `queued` | The engine accepted the invocation and wrote the RunRecord, but `Processor.run()` has not started. |
| `running` | `Processor.run()` is executing with a bounded context and timeout. |
| `succeeded` | `Processor.run()` returned and every emitted Effect passed schema validation. Capability denial of an emitted Effect does not make the run fail; the denial is a routed outcome and is ledgered separately. |
| `failed` | `Processor.run()` threw, returned a non-array, returned malformed Effects, or hit a non-timeout runtime error. |
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

Timeouts are enforced by the runtime wrapper, not by individual processors. A timed-out processor produces a `processor.timeout` diagnostic, the RunRecord transitions to `timed_out`, and no returned Effects from that invocation are routed. Garden timed-out runs may be retried per §"Retries and quarantine"; adoption timed-out runs block adoption because the fixed-point loop cannot prove the candidate safe.

## Output validation

The processor boundary is:

```ts
Processor.run(ctx): Promise<Effect[]>
```

The runtime validates returned values before routing:

1. The resolved value must be an array.
2. Each array element must match one of the seven Effect schemas in [[wiki/specs/effects]].
3. Effect-kind-specific invariants are checked before capability enforcement: non-empty PatchEffect changes, mandatory SourceRefs where required, confidence on inferred/generated facts, valid idempotency keys, valid SourceRef path/range shape.
4. The effect list is canonicalized for hashing only after validation; the engine does not silently repair malformed effects.

Validation failure marks the run `failed` with `code: "processor.invalid-output"` and emits a diagnostic naming the offending processor and effect index. No effects from that run are routed. This all-or-nothing rule prevents partial application of a processor that returned a mixed valid/invalid effect list.

## Model invocation and structured output

Processors never import LLM SDKs directly. A processor with `model.invoke` receives `ctx.modelInvoke`; processors without the capability receive no model function.

`ctx.modelInvoke` is a runtime boundary with these guarantees:

- Checks the processor's `model.invoke` grant, model allowlist, and daily cost cap before the call.
- Records token/cost metadata into the current RunRecord.
- Supports structured output by requiring a Zod schema or JSON schema at the call site.
- Retries provider-transient failures with bounded backoff inside the run timeout.
- Returns typed success or throws a structured `model.invoke.*` error.

Structured-output parse failures are not repaired by prompt-only retry loops unless the processor explicitly asks for one through `ctx.modelInvoke({ retries: n })`. After retries are exhausted, the run fails with `code: "model.output.invalid-json"` or `code: "model.output.schema-mismatch"`. The diagnostic includes the schema name and a short parse reason, not the full prompt or full model output.

Adoption-phase processors cannot receive `ctx.modelInvoke`. Registration rejects an adoption-phase manifest that declares `model.invoke`.

## Retries and quarantine

The runtime classifies run failures:

| Class | Examples | Retry behavior |
|---|---|---|
| `deterministic` | invalid output, phase mismatch, capability schema violation | No automatic retry. Mark failed. |
| `transient` | model provider 429/5xx, network timeout, temporary SQLite busy | Retry with exponential backoff within the run's phase policy. |
| `timeout` | phase timeout exceeded | No in-run retry. Garden jobs may be rescheduled if their JobEffect policy allows it. |
| `operator` | cancellation, shutdown | Mark cancelled; no retry unless explicitly re-run. |

Garden and scheduled runs maintain consecutive failure counters keyed by `(processorId, processorVersion, triggerHash)`. After three consecutive retryable terminal failures, the processor trigger is quarantined and future matching invocations are skipped with a `processor.quarantined` diagnostic until the user or a health processor clears the quarantine.

Adoption-phase processors are never quarantined automatically. If an adoption processor fails, adoption blocks: trusted state cannot advance while the deterministic gate is unhealthy.

## Drain and shutdown

`drainProcessors()` waits for queued and running garden/view work to settle up to the configured drain timeout. It does not start new schedule-triggered work while draining. On graceful shutdown:

1. Stop accepting new garden/view invocations.
2. Wait for currently running invocations to finish until the drain timeout.
3. Mark still-running garden/view runs `cancelled`.
4. Preserve adoption-phase atomicity: an adoption loop either finishes and advances the adopted ref, or exits without advancing.
5. Close SQLite handles after terminal run rows are written.

`close()` calls `drainProcessors()` and is one-shot. Calls against a closed Vault return a typed `vault-closed` error rather than throwing.

## Diagnostics

Execution diagnostics use stable codes:

| Code | When emitted |
|---|---|
| `processor.invalid-output` | Return value is not `Effect[]` or an effect fails schema validation. |
| `processor.timeout` | Phase timeout exceeded. |
| `processor.failed` | Processor threw a non-specialized runtime error. |
| `processor.cancelled` | Engine cancelled the run during shutdown/operator intervention. |
| `processor.quarantined` | A matching trigger is skipped because the processor is quarantined. |
| `model.invoke.denied` | Missing model capability, model not allowlisted, or cost cap exceeded. |
| `model.output.invalid-json` | Structured model output was not parseable JSON after retries. |
| `model.output.schema-mismatch` | Structured model output parsed but failed the requested schema. |

Diagnostics point at the processor/run, not at arbitrary vault content, unless the failed Effect carried valid SourceRefs before validation failed.

## Test guarantees

The execution contract is pinned by focused tests:

- Runtime state-machine tests assert legal transitions and terminal-state immutability.
- Timeout tests assert adoption timeout blocks adoption, garden timeout records `timed_out`, and late effects are discarded.
- Output-validation tests assert malformed effect lists fail all-or-nothing.
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
