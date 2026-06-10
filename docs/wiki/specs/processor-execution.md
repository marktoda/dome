---
type: spec
created: 2026-05-28
updated: 2026-06-10
sources:
  - "[[wiki/specs/processors]]"
  - "[[wiki/specs/run-ledger]]"
  - "[[wiki/specs/effects]]"
---

# Processor execution

This spec is normative for the target contract around processor invocation: how the engine invokes processors, validates their outputs, records failures, and recovers from transient execution problems. [[wiki/specs/processors]] defines what a Processor is; this page defines the runtime contract and calls out the current implementation stage plus deferred surfaces.

The goal is boring execution semantics: a processor run has one state machine, one timeout policy, one output-validation boundary, one retry/quarantine policy, and one ledger record. State-transition bugs, timeout ambiguity, malformed JSON, and transient model/vendor failures should be visible as typed run outcomes rather than scattered special cases.

## Implementation stage

Shipped in the current v1 runtime:

- `src/processors/executor.ts` provides the executor boundary. It owns the per-invocation `AbortSignal`, asks the runtime to construct `ProcessorContext` from that signal, validates returned outputs, enforces per-invocation timeout/cancellation when called, and returns structured `ProcessorExecutionResult` variants with `processor.invalid-output`, `processor.threw`, `processor.timeout`, and `processor.cancelled` errors.
- `src/ledger/runs.ts` can persist the full terminal status set, including `timed_out` and `cancelled`, through `markTimedOut` and `markCancelled`.
- `src/processors/runtime.ts` dispatches adoption, garden, and view processors through `executeProcessor`. Runtime policy denial and quarantine are recorded as `skipped` with a structured not-invoked reason; executor terminal results are recorded as `succeeded`, `failed`, `timed_out`, or `cancelled`. The engine runner contracts accept an optional `AbortSignal`; aborting it cancels the active processor invocation and writes a terminal `cancelled` run row instead of leaving `running` state behind. Vault-level execution caps are threaded through every engine-owned processor dispatch path, including adoption/garden/view runners, schedule triggers, answer handlers, durable JobEffect drains, and deterministic projection rebuild processors.
- `src/engine/operational/operational-work.ts` is the single pump for non-adoption engine work after trusted state is stable. It runs due schedule triggers, drains due durable JobEffect rows, and dispatches due outbox rows that were already pending before the pump started, in that order. `dome sync` runs this pump after successful adoption and once even when HEAD is already in sync; `dome serve` runs it on a quiet cadence while HEAD remains in sync and threads shutdown cancellation into retryable outbox dispatch attempts.
- `RunnerResult.executionStatus` carries the runtime terminal status to engine consumers. Schedulers and other orchestration layers use this explicit status instead of inferring execution success from arbitrary processor-emitted diagnostics.
- `src/processors/execution-state.ts` and `src/engine/operational/quarantine-store.ts` maintain processor quarantine state at `.dome/state/quarantined.json`. Garden runs, including schedule-triggered garden runs, are keyed by `(phase, processorId, processorVersion, triggerHash)` and skipped with `processor.quarantined` after repeated retryable failures.
- `src/engine/core/model-invoke.ts` provides the provider-neutral `ctx.modelInvoke` shim. The core SDK imports no model vendor SDK; callers inject a `ModelProvider` or configure a command provider in `.dome/config.yaml`. The shim uses the same invocation signal as `ctx.signal`, enforces effective `model.invoke` grants, allowlists, and per-bundle daily cost caps, validates provider responses, enforces per-call timeout, retries one runtime-classified provider failure, reports structured JSON parse/schema errors, captures run-local cost, and records `model.invoke` capability-use rows.
- Vendor SDK adapters, runtime-close cancellation for operational work outside
  the `dome serve` host loop, and a public `drainProcessors()` SDK method are
  target surfaces described here for the completed architecture; they are not
  fully implemented yet.

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
| `skipped` | The runtime did not invoke the processor. Idempotency dedup skips have `error = NULL`; policy denial and quarantine skips write structured reason JSON. |
| `timed_out` | The run exceeded its phase timeout. Effects produced after timeout are discarded. |
| `cancelled` | The engine intentionally stopped the run during shutdown/drain cancellation or explicit operator intervention. |

The run ledger stores `status`, `started_at`, `finished_at`, `duration_ms`, `error`, and `effect_hashes_json`. `error` is null for `succeeded` and idempotency `skipped`; terminal failure states and reasoned skips store structured JSON with at least `code`, `message`, `phase`, and `processorId` where applicable.

## Timeouts

Timeouts are phase-scoped. The runtime resolves per-processor execution
metadata, default phase policy, and optional vault-level caps inside
`resolveExecutionPolicy`.

Vault-level configuration:

```yaml
engine:
  # Optional global caps applied after manifest/default policy resolution.
  processor_timeout_ms: 600000
  model_call_timeout_ms: 180000
  # Per-attempt bound for external outbox handlers (default 30000). Not a
  # processor timeout — it caps the handler side of ExternalActionEffect
  # dispatch ([[wiki/specs/capabilities]] §"external"); raise it when a
  # dome.sources fetch command runs a headless model ([[wiki/specs/sources]]).
  external_handler_timeout_ms: 30000
```

Default execution class by phase:

| Phase | Default class | Rationale |
|---|---|---|
| `adoption` | `deterministic` | Adoption is the merge gate; it must be deterministic and low latency. |
| `garden` | `background` | Garden work may be slower and asynchronous. |
| `view` | `interactive` | A user or protocol caller is waiting for output. |

Timeout defaults by execution class:

| Class | Default timeout | Model-call timeout |
|---|---:|---:|
| `deterministic` | 10s | n/a |
| `interactive` | 30s | n/a |
| `background` | 120s | n/a |
| `llm` | 600s | 180s |
| `batch` | 600s | n/a |

Processor manifests may request a different execution class and explicit
timeouts where the phase allows it. Adoption processors are always capped to
deterministic execution; garden and view processors may request `llm` or
`batch` when their capabilities and product role justify longer runs.

Timeouts are enforced by the executor boundary, not by individual processors.
A timed-out processor produces a `processor.timeout` diagnostic, the executor
returns `status: "timed_out"`, and no returned Effects from that invocation
are routed. The runtime records the timed-out row through `markTimedOut`; late
effects leave `effect_hashes_json` empty because the invocation did not
succeed. Timeouts are not retried inside the same processor invocation.
Durable JobEffect retries may schedule a later attempt when the terminal
failure is retryable, and repeated retryable timeouts can contribute to
garden/scheduled quarantine.

The same resolved timeout policy applies no matter which engine subsystem
initiates the run. Schedule-triggered processors, answer handlers, durable
jobs, direct adoption/garden/view runners, and projection-rebuild dispatch all
call the shared runtime boundary with the vault cap from `.dome/config.yaml`;
none of those paths owns a private timeout interpretation.

The executor-created invocation signal is the only signal a processor observes.
`ctx.signal` and `ctx.modelInvoke` share that lifecycle: when the executor
times out or cancels the run, in-flight provider calls receive an aborted
request signal and late model responses cannot update the run after its terminal
ledger row has been written.

## Output validation

The processor boundary is:

```ts
Processor.run(ctx): Promise<Effect[]>
```

The executor boundary validates returned values before routing:

1. The resolved value must be an array.
2. Each array element must match one of the eleven Effect schemas in [[wiki/specs/effects]].
3. Effect-kind-specific invariants are checked before capability enforcement: non-empty PatchEffect changes, mandatory SourceRefs where required, confidence on inferred/generated facts, valid idempotency keys, valid SourceRef path/range shape.
4. Runtime output policy is checked before routing. Today that policy requires non-adoption processors with an effective `model.invoke` grant to include at least one SourceRef on every PatchEffect.
5. A bounded runaway guard rejects a single invocation that returns more than 100,000 effects. This protects the engine from accidental unbounded output while leaving deterministic indexers enough room for real-vault scale.
6. The effect list is canonicalized for hashing only after validation; the engine does not silently repair malformed effects.

Validation failure returns `status: "failed"` with `code: "processor.invalid-output"` and emits a diagnostic naming the offending processor and effect index. `processor.invalid-output` is executor-created from returned output; a processor-thrown object that happens to carry this code is still classified as `processor.threw`. No effects from that executor result are routed. This all-or-nothing rule prevents partial application of a processor that returned a mixed valid/invalid effect list.

## Model invocation and structured output

Processors should never import LLM SDKs directly. A non-adoption processor with an effective `model.invoke` declaration + grant receives `ctx.modelInvoke`; processors without the capability receive no model function. Core stays provider-neutral through the `ModelProvider` interface. Callers may inject a provider directly; vaults may also configure `model_provider: { kind: "command", command: [...] }`, which runs from the vault root, receives `dome.model-provider.request/v1` JSON on stdin, and returns provider response JSON on stdout (the same command also serves the `dome.model-provider.step/v1` tool-use step and the `dome.model-provider.probe/v1` liveness probe — see [[wiki/specs/capabilities]] §"model.invoke"). Vendor-specific adapters may live in a workflow package or vault-local command script, but they are outside the `@dome/sdk` root import graph.

Model-capable processors remain subject to the same Effect/capability pipeline as every other processor. A PatchEffect emitted by such a processor must be source-backed before it reaches the router: an empty `sourceRefs` array fails the run with `processor.invalid-output`, and non-empty refs are then broker-checked against effective `read` grants before any patch capability is considered. Deterministic processors may still create source-less generated files when their effect schema allows it; the stricter rule is tied to effective `model.invoke`.

The `ctx.modelInvoke` runtime boundary has these guarantees:

- Checks the processor's effective `model.invoke` grant and model allowlist before the call.
- Fails with `model.invoke.denied` when no provider is configured, the prompt is empty, the requested model is outside the effective allowlist, or the bundle's effective daily cost budget is spent.
- Records a `capability_uses` row for each model-call attempt: `allowed` when the provider call is authorized, `denied` when the model call is rejected before provider invocation.
- Records provider-reported run-local cost into the current RunRecord, including failed structured-output runs.
- Supports structured output through `ctx.modelInvoke.structured({ schemaName, parse })`, where `parse` is a caller-supplied schema parser (Zod parse functions fit naturally; JSON Schema validators can be adapted without adding AJV to core). The runtime accepts exact JSON and the common whole-response `json` code-fence shape, but still rejects prose-wrapped or ambiguous output as invalid JSON.
- Retries one retryable `model.invoke.provider-failed` provider attempt inside the same invocation. `model.invoke.timeout` is not retried inside the call; the processor timeout remains the outer cap.
- Enforces a per-call timeout bounded by `modelCallTimeoutMs` / the resolved run timeout.
- Aborts provider calls when the processor invocation times out or is cancelled.
- Validates provider responses before returning them to processors: `text` must be a string; optional `model` must be a string; optional `costUsd` must be a finite non-negative number.
- Returns typed success or throws a nominal runtime-created `model.invoke.*` / `model.output.*` error that the executor preserves in the run ledger. Processor-thrown or provider-thrown lookalikes are not trusted by shape.

Structured-output parse failures are not repaired by prompt-only retry loops unless the processor explicitly asks for one through `ctx.modelInvoke.structured({ retries: n, ... })`. After retries are exhausted, the run fails with `code: "model.output.invalid-json"` or `code: "model.output.schema-mismatch"`. The diagnostic includes the schema name and a short parse reason, not the full prompt or full model output.

Adoption-phase processors cannot receive `ctx.modelInvoke`. Registration rejects an adoption-phase manifest that declares `model.invoke`.

## Retries and quarantine

Dome does not perform generic immediate whole-processor retries for adoption,
garden, schedule, or command dispatch. `executeProcessor` remains a
single-attempt boundary for timeout/cancellation/output validation. Durable
whole-run retries belong to JobEffect rows in `scheduled_jobs`; model-provider
transient retries belong inside the `ctx.modelInvoke` boundary while still
respecting the run timeout.

The target runtime classifies run failures:

| Class | Examples | Retry behavior |
|---|---|---|
| `deterministic` | invalid output, phase mismatch, capability schema violation | No automatic retry. Mark failed. |
| `transient` | model provider 429/5xx, network timeout, temporary SQLite busy | No generic processor rerun. Model calls may retry internally; JobEffect attempts may retry durably. Retryable terminal failures count toward quarantine. |
| `timeout` | phase timeout exceeded | No in-run retry. Garden jobs may be rescheduled if their JobEffect policy allows it. Retryable timeouts count toward quarantine. |
| `operator` | cancellation, shutdown | Mark cancelled; no retry unless explicitly re-run. |

Processor code can opt into transient classification by throwing
`transientProcessorError(message)` from `@dome/sdk`. The executor recognizes
that nominal SDK-created error and records the run as `processor.threw` with
`retryable: true`. A plain thrown object with a `retryable: true` property is
not trusted by shape and remains a non-retryable `processor.threw`.

Garden runs, including schedule-triggered garden runs, maintain consecutive failure counters keyed by `(phase, processorId, processorVersion, triggerHash)`, persisted under `.dome/state/quarantined.json`. `triggerHash` is computed from the matched trigger payload, not from volatile execution envelope fields such as a schedule fire timestamp. When a key enters quarantine, the runtime assigns a durable `quarantineId` generation token. After three consecutive retryable terminal failures, the processor trigger is quarantined and future matching invocations are skipped with a `processor.quarantined` diagnostic until the user approves a `dome.health` recovery question whose answer handler emits `QuarantineRecoveryEffect` for the current generation.

Adoption-phase processors are never quarantined automatically. If an adoption processor fails, adoption blocks: trusted state cannot advance while the deterministic gate is unhealthy.

## Drain and shutdown

The processor runtime now owns an internal lifecycle boundary. `close()` stops
new runner invocations, aborts in-flight garden/view processor dispatch through
the same executor signal used for explicit cancellation, waits for active
runner promises to settle, and only then returns to the outer `VaultRuntime`
close path. `VaultRuntime.close()` calls this processor-runtime close before
closing projection, answers, ledger, or outbox SQLite handles, so cancelled
processor invocations have terminal run rows before the DB handles are
released.

Adoption-phase work is tracked but not force-aborted by runtime close. This
preserves adoption atomicity: a running adoption processor finishes, times out,
or is cancelled by an explicit caller-supplied signal under the normal adoption
loop contract before close proceeds.

The `dome serve` host threads shutdown cancellation into the operational pump,
so in-flight outbox handler attempts abort promptly and leave their rows
pending without burning retry budget. The still-planned public
`drainProcessors()` surface will make the same lifecycle operation addressable
before full runtime close and generalize operational-work cancellation beyond
the foreground host loop.

`drainProcessors()` waits for queued and running garden/view work to settle up to the configured drain timeout. It does not start new schedule-triggered work while draining. On graceful shutdown:

1. Stop accepting new garden/view invocations.
2. Wait for currently running invocations to finish until the drain timeout.
3. Mark still-running garden/view runs `cancelled`.
4. Preserve adoption-phase atomicity: an adoption loop either finishes and advances the adopted ref, or exits without advancing.
5. Close SQLite handles after terminal run rows are written.

Current `close()` behavior satisfies the internal processor drain ordering and
is idempotent. The future public SDK close path still needs a closed-state
guard so calls against a closed Vault return a typed `vault-closed` error
rather than throwing.

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
| `model.invoke.provider-failed` | The injected provider threw or returned a malformed response. |
| `model.invoke.timeout` | A model call exceeded its per-call timeout or was aborted by the invocation boundary. |
| `model.output.invalid-json` | Structured model output was not parseable JSON after retries. |
| `model.output.schema-mismatch` | Structured model output parsed but failed the requested schema. |

Diagnostics point at the processor/run, not at arbitrary vault content, unless the failed Effect carried valid SourceRefs before validation failed.

Engine orchestration layers may add diagnostics outside a processor run: adoption emits `engine.adoption` rows for structural blockages such as `fixed-point.divergence`; the scheduler emits `engine.scheduler` rows for invalid cron or dispatch crashes; queued jobs emit `engine.jobs` rows for missing targets or dispatch crashes. These diagnostics are returned to callers for immediate control flow and also written through the same diagnostic projection sink so `dome inspect diagnostics` is the durable operator surface.

## Test guarantees

The execution contract is pinned in stages.

Already pinned:

- Executor-boundary tests assert success, thrown errors, invalid output, timeout, cancellation, diagnostic severity, discarded late effects, and model-provider abort propagation at `executeProcessor`.
- Ledger tests assert `timed_out` / `cancelled` status persistence, structured error JSON, query filtering, and terminal transition filtering.
- Runtime tests assert adoption failures become block diagnostics, garden failures become error diagnostics, invalid output is rejected, execution-policy denial skips without invoking `run`, garden timeout discards late output while recording `timed_out`, and runner cancellation records `cancelled` without leaving orphan `running` rows.
- Runtime close tests assert `close()` cancels in-flight garden work, waits for
  the runner to settle, and leaves no orphan `running` rows before returning.
- Lifecycle scenarios assert a throwing adoption processor records a failed ledger row, persists a block diagnostic for inspection, and does not advance the adopted ref.
- Quarantine tests assert three consecutive retryable garden failures quarantine matching triggers, subsequent invocations skip with diagnostics, the skipped row is ledgered, and the file-backed quarantine store survives reopen.
- Model-invoke tests assert missing-provider denial, allowlist denial, provider cost capture, valid structured JSON, invalid JSON, schema mismatch, explicit structured retry, provider response validation, one retry for retryable provider failures, no retry for model-call timeouts, pre-aborted invocation denial before provider calls, daily budget denial before and after provider calls, executor preservation of model error codes, ledgered model cost on failed structured-output runs, and quarantine after repeated retryable model timeouts.
- Harness scenarios assert scheduled `model.invoke` processors run through the live operational pump, including model-output failure, cost ledgering, daily budget denial, in-sync `tick()` drains, explicit `drainOperationalWork()`, source-backed model PatchEffect routing/rejection, and vault-level timeout caps on scheduled and answer-triggered dispatch.

Pending:

- Public `drainProcessors()` and closed-Vault typed error tests.
- Runtime-close tests for in-flight outbox dispatch once public drain
  generalizes the foreground-host cancellation path.

## Related

- [[wiki/specs/processors]] — Processor type and phases
- [[wiki/specs/effects]] — Effect schemas
- [[wiki/specs/capabilities]] — broker and `model.invoke`
- [[wiki/specs/run-ledger]] — RunRecord tables
- [[wiki/specs/projection-store]] — scheduled jobs and projection rebuild
- [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]]
- [[wiki/gotchas/processor-idempotency]]
