// ProcessorRuntime: the adapter that satisfies the engine's
// `AdoptionPhaseRunner` callback contract by walking the loaded
// `ProcessorRegistry`, matching each adoption-phase processor's triggers
// against the per-iteration signals, packaging a `ProcessorContext` via
// `makeProcessorContext`, invoking `processor.run`, and collecting one
// `RunnerResult` per firing processor.
//
// See docs/wiki/specs/processors.md §"The three phases" + §"Triggers and
// signals" + §"Run ledger" for the operational contract this runtime
// implements, and docs/wiki/specs/adoption.md §"The fixed-point adoption
// loop" for the call site (`src/engine/adopt.ts`'s `runAdoptionProcessors`
// injection point).
//
// v1 Phase 3 scope (intentional simplifications, documented per the phase
// plan):
//
//   - Only the adoption-phase runner is exposed. Garden + view runners are
//     Phase 4+ work; the `ProcessorRuntime` type carries the slot so adding
//     them is additive, not a rename.
//   - The processor input is a uniform envelope: every adoption-phase
//     processor sees `ctx.input = { kind: "adoption", matchedTriggers }`
//     listing which of its declared triggers fired and which signal events
//     matched each. Per-processor `TInput` specialization is a Phase 4+
//     refinement.
//   - Tree-OID resolution is injected at `buildRuntime` time via the
//     `resolveTree` callback. Keeping this file pure of git imports lets
//     the consumer (`src/vault.ts` or a future `src/processors/index.ts`)
//     wire the resolver against the live git boundary while this runtime
//     stays I/O-free at the type layer.
//   - `model.invoke` is never wired on adoption-phase contexts (per
//     processors.md §"Adoption phase — bounded, deterministic,
//     merge-blocking" — adoption-phase processors never receive a model
//     handle). The factory's `modelInvoke` slot is left unset.
//   - Processor exceptions are caught per-processor and synthesized into a
//     `DiagnosticEffect` with `code: "processor-threw"`; the loop does not
//     crash. The synthesized diagnostic's severity is `error` (non-blocking)
//     so a single misbehaving processor does not refuse adoption — the
//     run-ledger surface and operator telemetry are the recovery path.
//
// House-style notes (matches src/processors/registry.ts,
// src/processors/triggers.ts, src/processors/context.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - Optional fields use `field?: T` (not `T | undefined`) for
//     `exactOptionalPropertyTypes` cleanliness.
//   - `Object.freeze` chosen over `as const` so misbehaving callers fail
//     loudly at runtime rather than silently mutating runner outputs.
//   - Imports limited to: `../core/effect` (Effect + DiagnosticEffect +
//     `diagnosticEffect` helper), `../core/processor` (Processor +
//     Capability + Snapshot + TreeOid types), `../core/source-ref`
//     (CommitOid), `../engine/runner-contract` (AdoptionPhaseRunner +
//     RunnerResult — the neutral home for the engine's outbound runner
//     contract that this runtime implements), `../ledger/db` (LedgerDb
//     handle type — the Phase 6 ledger-lifecycle seam), `../ledger/runs`
//     (insertQueued / markRunning / markSucceeded / markFailed / newRunId
//     + RunId & TriggerKind types — the per-run ledger writes pinned by
//     EVERY_PROCESSOR_RUN_IS_LEDGERED), `./registry` (ProcessorRegistry),
//     `./triggers` (matchTriggers + TriggerMatch), `./context`
//     (makeProcessorContext + ProcessorContextInput), `../run-context`
//     (makeRunContext — the no-ledger fallback for runner-result runId).
//     `node:crypto` for the `hashEffect` content hash. No filesystem
//     imports — the `resolveTree` injection point bridges to git; the
//     ledger handle's SQLite I/O is owned by `src/ledger/`.

import { createHash } from "node:crypto";

import type { DiagnosticEffect, Effect } from "../core/effect";
import { diagnosticEffect } from "../core/effect";
import type {
  Capability,
  ProcessorContext,
  Snapshot,
  TreeOid,
} from "../core/processor";
import type { CommitOid } from "../core/source-ref";
import type {
  AdoptionPhaseRunner,
  RunnerResult,
} from "../engine/runner-contract";
import type { LedgerDb } from "../ledger/db";
import {
  insertQueued,
  markFailed,
  markRunning,
  markSucceeded,
  newRunId,
  type RunId,
  type TriggerKind,
} from "../ledger/runs";
import type { ProcessorRegistry } from "./registry";
import { matchTriggers, type TriggerMatch } from "./triggers";
import {
  makeProcessorContext,
  type ProcessorContextInput,
} from "./context";
import { makeRunContext } from "../run-context";

// ----- AdoptionRunInput -----------------------------------------------------

/**
 * The uniform envelope every adoption-phase processor sees as `ctx.input`
 * during a Phase 3 runtime dispatch. `matchedTriggers` lists the (non-empty)
 * subset of the processor's declared triggers that fired, each annotated
 * with the SignalEvents that caused the match.
 *
 * Per-processor `TInput` specialization (e.g., a dome.index processor seeing
 * an index-update payload rather than a raw `TriggerMatch[]`) is a Phase 4+
 * refinement. For v1, the envelope is uniform across all adoption-phase
 * processors — the processor is responsible for inspecting
 * `ctx.input.matchedTriggers` if it cares which trigger fired.
 */
export type AdoptionRunInput = {
  readonly kind: "adoption";
  readonly matchedTriggers: ReadonlyArray<TriggerMatch>;
};

// ----- ProcessorRuntime -----------------------------------------------------

/**
 * The handle returned by `buildRuntime`. Carries the per-phase runner
 * callbacks the engine's adoption / garden / view entry points consume.
 *
 * v1 ships only `adoptionRunner`. The garden + view runners are Phase 4+
 * work; the type slot exists so adding them is additive, not a rename.
 */
export type ProcessorRuntime = {
  readonly adoptionRunner: AdoptionPhaseRunner;
};

// ----- BuildRuntimeOptions --------------------------------------------------

/**
 * The injected dependencies `buildRuntime` requires. `registry` is the
 * loaded ProcessorRegistry; `resolveGrants` returns the broker-resolved
 * grant set for a given processor id (typically derived from the vault's
 * capability policy against the bundle manifest); `extensionIdFor` maps a
 * processor id to its originating bundle id (for the `Dome-Extension`
 * trailer on engine commits via `makeRunContext`); `resolveTree` resolves
 * a candidate commit OID to its tree OID (the per-iteration Snapshot the
 * processor reads from).
 *
 * `resolveTree` is injected (rather than imported from `../git`) so this
 * runtime file stays I/O-free at the type layer. Whoever calls
 * `buildRuntime` (today: `src/vault.ts` or a future processors/index.ts)
 * wires the resolver against the live git boundary.
 */
export type BuildRuntimeOptions = {
  readonly registry: ProcessorRegistry;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly extensionIdFor: (processorId: string) => string;
  readonly resolveTree: (commit: CommitOid) => Promise<TreeOid>;
  /**
   * Optional run-ledger handle. When present, every dispatched processor
   * lands one row in `runs` per [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]]
   * §"Structural enforcement": `insertQueued` + `markRunning` before
   * `processor.run()`; `markSucceeded` (with effect hashes) or `markFailed`
   * (with the thrown error message) after.
   *
   * Optional during the Phase 6 transition: existing call sites
   * (`tests/processors/runtime.test.ts`, the to-be-wired `src/vault.ts`)
   * continue to operate without a ledger; Phase 7+ wires the live handle
   * end-to-end. When absent, no ledger writes occur and the runner-result
   * `runId` falls back to a `makeRunContext`-synthesized placeholder so
   * downstream `applyEffect` capability-use recording still has a slot
   * (the engine's adoption loop skips ledger writes if the ledger itself
   * is absent at its own seam).
   */
  readonly ledger?: LedgerDb;
};

// ----- buildRuntime ---------------------------------------------------------

/**
 * Build a frozen `ProcessorRuntime` handle. The returned `adoptionRunner`
 * satisfies the engine's `AdoptionPhaseRunner` contract: given the
 * per-iteration `(candidate, changedPaths, signals, iteration, proposal,
 * vault)` tuple, it walks the registry's adoption-phase processors, fires
 * each whose triggers match the signals, constructs a `ProcessorContext`,
 * invokes `processor.run`, and returns one `RunnerResult` per firing
 * processor.
 *
 * Per-processor exceptions are caught and synthesized into a
 * `DiagnosticEffect` with `code: "processor-threw"` (severity `error`,
 * non-blocking). The loop does not crash on a single misbehaving processor.
 *
 * Returned values are frozen: the outer results array, each `RunnerResult`,
 * and each effect list are `Object.freeze`d so downstream consumers (the
 * adoption loop, test mocks) cannot mutate the runner's output.
 */
export function buildRuntime(opts: BuildRuntimeOptions): ProcessorRuntime {
  const {
    registry,
    resolveGrants,
    extensionIdFor,
    resolveTree,
    ledger,
  } = opts;

  const adoptionRunner: AdoptionPhaseRunner = async (input) => {
    const adoptionProcessors = registry.byPhase("adoption");
    if (adoptionProcessors.length === 0) {
      return Object.freeze([]);
    }

    // Resolve the candidate tree OID once per iteration — every firing
    // processor sees the same Snapshot for the same candidate.
    const tree = await resolveTree(input.candidate);
    const snapshot: Snapshot = Object.freeze({
      commit: input.candidate,
      tree,
    });

    const results: RunnerResult[] = [];
    for (const processor of adoptionProcessors) {
      const matches = matchTriggers(processor.triggers, input.signals);
      if (matches.length === 0) continue;

      const declared = processor.capabilities;
      const granted = resolveGrants(processor.id);
      const extensionId = extensionIdFor(processor.id);

      // Allocate the run id. When a ledger is wired we use the ledger's
      // `newRunId` so the id is the same one stored in the row; when no
      // ledger is wired we fall back to the `makeRunContext`-synthesized
      // form (identical shape — both produce `run_<unix-ms>_<6-char-rand>`).
      // Either way, downstream `applyEffect` calls see a populated runId.
      //
      // The fallback path's `makeRunContext().runId` is a plain `string`
      // (the engine-trailer primitive predates the ledger brand). Branding
      // it via `as RunId` at this single seam keeps every downstream slot —
      // RunnerResult, ApplyEffectSinks, recordCapabilityUse — strongly typed.
      const startedAt = new Date();
      const runId: RunId =
        ledger !== undefined
          ? newRunId(startedAt)
          : (makeRunContext({
              extensionId,
              base: input.proposal.base,
              sourceHead: input.proposal.head,
            }).runId as RunId);

      // Ledger lifecycle: queued + running, both synchronously before the
      // processor runs. Per [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]]
      // §"Structural enforcement" §1. The first matched trigger drives the
      // `trigger_kind` + `trigger_payload_json` columns — capturing every
      // matched trigger in the payload preserves the audit detail (a future
      // schema can promote multiple triggers to a structured column).
      if (ledger !== undefined) {
        insertQueued(ledger, {
          id: runId,
          proposalId: input.proposal.id,
          processorId: processor.id,
          processorVersion: processor.version,
          phase: "adoption",
          inputCommit: input.candidate,
          triggerKind: triggerKindOf(matches),
          triggerPayload: triggerPayloadOf(matches),
          startedAt,
        });
        markRunning(ledger, runId, startedAt);
      }

      const ctxInput: ProcessorContextInput<AdoptionRunInput> = {
        snapshot,
        changedPaths: input.changedPaths,
        proposal: input.proposal,
        runId,
        input: Object.freeze({
          kind: "adoption" as const,
          matchedTriggers: matches,
        }),
        // `modelInvoke` intentionally unset — adoption-phase processors
        // never receive a model handle (processors.md §"Adoption phase").
      };
      const ctx = makeProcessorContext(ctxInput);

      const runOutcome = await runOneProcessor(
        processor.run,
        ctx,
        processor.id,
      );

      // Ledger lifecycle: terminal mark. `markSucceeded` / `markFailed`
      // both filter by `status = 'running'` (per `src/ledger/runs.ts`) so
      // an aborted-elsewhere row is a no-op. The `effect_hashes_json`
      // column carries the sha256 of every emitted effect, even the
      // synthesized `processor-threw` diagnostic — the audit trail
      // captures what the engine actually saw.
      if (ledger !== undefined) {
        const finishedAt = new Date();
        const durationMs = finishedAt.getTime() - startedAt.getTime();
        if (runOutcome.error === null) {
          markSucceeded(ledger, {
            id: runId,
            effectHashes: runOutcome.effects.map(hashEffect),
            // Phase 6 does not wire `modelInvoke` cost tracking; the
            // `cost_usd` column stays null until a future phase plumbs the
            // model-invocation accounting through `ProcessorContext`.
            costUsd: null,
            durationMs,
            // `output_commit` is the closure-commit OID, computed *after*
            // every adoption-iteration's effects have been routed (see
            // `src/engine/adopt.ts`'s `makeClosureCommit` + the
            // `updateOutputCommit` call). `markSucceeded` writes NULL here;
            // the engine later UPDATEs the column once the closure commit
            // OID is known. See
            // [[wiki/gotchas/run-succeeded-before-closure]] for why these
            // are two separate writes.
            outputCommit: null,
            finishedAt,
          });
        } else {
          markFailed(ledger, {
            id: runId,
            error: runOutcome.error,
            durationMs,
            finishedAt,
          });
        }
      }

      results.push(
        Object.freeze({
          runId,
          processorId: processor.id,
          declared,
          granted,
          effects: runOutcome.effects,
        }),
      );
    }

    return Object.freeze(results);
  };

  return Object.freeze({ adoptionRunner });
}

// ----- internals ------------------------------------------------------------

/**
 * The result of one `processor.run()` dispatch. `effects` is the (possibly
 * synthesized) effect list returned to the adoption loop; `error` is `null`
 * on the success path and the error message on the failure path. The
 * separation lets the ledger lifecycle write the correct terminal state
 * (`markSucceeded` vs `markFailed`) while preserving the synthesized
 * `processor-threw` DiagnosticEffect for the engine loop's existing
 * "non-blocking diagnostic" behavior.
 */
type RunOutcome = {
  readonly effects: ReadonlyArray<Effect>;
  readonly error: string | null;
};

/**
 * Invoke a processor's `run` method with try/catch insulation. A thrown
 * exception (including async rejection) is synthesized into a single
 * `DiagnosticEffect` with `code: "processor-threw"` and severity `error`
 * (non-blocking — a single misbehaving processor should not refuse
 * adoption; the operator surface is the run ledger + telemetry). The
 * returned `error` field carries the thrown message so the caller's
 * ledger-lifecycle writer can land `status: "failed"` with `error` set.
 *
 * The processor's static `TInput` is its own concern; the runtime stores
 * processors as `Processor<unknown>` (per registry.ts §"Type-erased at
 * storage"). The cast from `ProcessorContext<AdoptionRunInput>` to
 * `ProcessorContext<unknown>` is structurally safe — `unknown` is the top
 * type, and `AdoptionRunInput` is assignable to it; the cast is needed
 * because `ProcessorContext` is invariant in `TInput`.
 */
async function runOneProcessor(
  run: (ctx: ProcessorContext<unknown>) => Promise<ReadonlyArray<Effect>>,
  ctx: ProcessorContext<AdoptionRunInput>,
  processorId: string,
): Promise<RunOutcome> {
  try {
    const effects = await run(ctx as ProcessorContext<unknown>);
    return { effects: Object.freeze([...effects]), error: null };
  } catch (e) {
    const message = errorMessage(e);
    const synthesized: DiagnosticEffect = diagnosticEffect({
      severity: "error",
      code: "processor-threw",
      message: `Processor ${processorId} threw during adoption-phase run: ${message}`,
      sourceRefs: [],
    });
    return { effects: Object.freeze([synthesized]), error: message };
  }
}

/**
 * Stable, deterministic content hash for an Effect — `sha256(JSON.stringify(e))`,
 * hex-encoded. The hash lands in `runs.effect_hashes_json` so a future audit
 * surface can dedupe / diff effects across runs without storing the effect
 * payloads themselves.
 *
 * `JSON.stringify` ordering matches the construction order of the effect
 * literal — processors emit effects via the `*Effect()` constructor helpers
 * in `src/core/effect.ts`, which build object literals with a deterministic
 * key order. The hash is therefore stable across runs of the same effect.
 */
function hashEffect(effect: Effect): string {
  return createHash("sha256").update(JSON.stringify(effect)).digest("hex");
}

/**
 * Stringify an arbitrary thrown value for the ledger's `error` column.
 * Mirrors the helper in `src/projections/db.ts` / `src/outbox/db.ts` —
 * `Error` → `.message`; raw string → itself; otherwise JSON-stringify with
 * a `String(e)` last-resort fallback for non-serializable values.
 */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * Extract the `trigger_kind` column value from the matched-triggers list.
 * The runtime guarantees `matches.length > 0` at the call site (only firing
 * processors enter the ledger lifecycle), so reading `matches[0]` is safe;
 * `noUncheckedIndexedAccess` requires the `=== undefined` guard for the
 * type narrowing.
 *
 * A processor whose triggers fire from multiple kinds in one iteration is
 * uncommon in v1 — most adoption-phase processors declare a single
 * `{ kind: "signal" }` or `{ kind: "path" }` trigger. The first-match
 * convention keeps the column scalar; the full `trigger_payload_json`
 * carries the per-trigger detail for forensics.
 */
function triggerKindOf(matches: ReadonlyArray<TriggerMatch>): TriggerKind {
  const first = matches[0];
  if (first === undefined) {
    // Defensive: the caller guards `matches.length === 0` before invoking
    // this helper. Reaching here is a programmer error — surface loudly.
    throw new Error("runtime: triggerKindOf called with empty matches");
  }
  return first.trigger.kind;
}

/**
 * Capture the matched-trigger detail as the `trigger_payload_json` column
 * value (per-trigger kind + matched signal events). The full match list is
 * stored, not just the first match — a future audit surface can replay the
 * exact fan-in that caused the run.
 *
 * The matched events are the (signal, path) pairs that fired the trigger;
 * they're the input the processor saw, modulo the runtime's
 * `ProcessorContext` envelope construction.
 */
function triggerPayloadOf(
  matches: ReadonlyArray<TriggerMatch>,
): ReadonlyArray<{ readonly trigger: TriggerMatch["trigger"]; readonly matchedSignals: TriggerMatch["matchedSignals"] }> {
  return matches.map((m) => ({
    trigger: m.trigger,
    matchedSignals: m.matchedSignals,
  }));
}
