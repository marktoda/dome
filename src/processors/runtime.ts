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
//     `resolveTree` callback (kept injected for testability + symmetry with
//     the per-iteration resolve site). Phase 11d adds direct `../git`
//     imports (`readBlob` / `readTree`) wired through the Snapshot's read
//     closures — adoption-phase processors need to read blob content +
//     enumerate the candidate tree to do their work, and the runtime is
//     where that boundary is constructed. The git imports are only
//     exercised lazily via the closure call sites.
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
//     `node:crypto` for the `hashEffect` content hash. The `../git` import
//     surfaces `readBlob` / `readTree` for the Snapshot's read closures
//     (`readFile`, `listMarkdownFiles`); the closures are lazy — invoked
//     only when an adoption-phase processor reads from `ctx.snapshot` —
//     so runtimes whose processors don't touch the snapshot incur no git
//     I/O. The ledger handle's SQLite I/O is owned by `src/ledger/`.

import { createHash } from "node:crypto";
import { posix } from "node:path";

import type { DiagnosticEffect, Effect } from "../core/effect";
import { diagnosticEffect } from "../core/effect";
import type {
  Capability,
  Processor,
  ProcessorContext,
  Snapshot,
  TreeOid,
} from "../core/processor";
import type { Proposal } from "../core/proposal";
import type { CommitOid } from "../core/source-ref";
import { readBlob, readTree } from "../git";
import type {
  AdoptionPhaseRunner,
  GardenPhaseRunner,
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

// ----- GardenRunInput -------------------------------------------------------

/**
 * The uniform envelope every garden-phase processor sees as `ctx.input`
 * during a Phase 4a runtime dispatch. `matchedTriggers` lists the (non-empty)
 * subset of the processor's declared triggers that fired against the
 * post-adoption signal stream, each annotated with the SignalEvents that
 * caused the match.
 *
 * Symmetric with `AdoptionRunInput` — the `kind` field is the only
 * structural difference, letting downstream processors branch on phase if
 * they handle both adoption and garden invocations (rare; most processors
 * declare a single phase).
 *
 * The orchestrator at `src/engine/garden.ts` constructs the envelope from
 * the gardenRunner's matched-triggers output; processors that care about
 * which trigger fired inspect `ctx.input.matchedTriggers`.
 */
export type GardenRunInput = {
  readonly kind: "garden";
  readonly matchedTriggers: ReadonlyArray<TriggerMatch>;
};

// ----- ProcessorRuntime -----------------------------------------------------

/**
 * The handle returned by `buildRuntime`. Carries the per-phase runner
 * callbacks the engine's adoption / garden / view entry points consume.
 *
 * Phase 4a ships `adoptionRunner` + `gardenRunner`. The view runner is
 * Phase 4b work; the type slot will land there.
 */
export type ProcessorRuntime = {
  readonly adoptionRunner: AdoptionPhaseRunner;
  readonly gardenRunner: GardenPhaseRunner;
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

    const snapshot = await makeSnapshot(
      input.vault.path,
      input.candidate,
      resolveTree,
    );

    const results: RunnerResult[] = [];
    for (const processor of adoptionProcessors) {
      const matches = matchTriggers(processor.triggers, input.signals);
      if (matches.length === 0) continue;

      const result = await dispatchOneProcessor({
        processor,
        phase: "adoption",
        envelope: Object.freeze({
          kind: "adoption" as const,
          matchedTriggers: matches,
        }),
        snapshot,
        changedPaths: input.changedPaths,
        proposal: input.proposal,
        inputCommit: input.candidate,
        matches,
        resolveGrants,
        extensionIdFor,
        ledger,
      });
      results.push(result);
    }

    return Object.freeze(results);
  };

  const gardenRunner: GardenPhaseRunner = async (input) => {
    const gardenProcessors = registry.byPhase("garden");
    if (gardenProcessors.length === 0) {
      return Object.freeze([]);
    }

    // Garden's Snapshot is built against the **adopted** commit — the
    // new trusted state — not a candidate. Same closures, different
    // commit. Processors read from this snapshot via `ctx.snapshot`.
    const snapshot = await makeSnapshot(
      input.vault.path,
      input.adopted,
      resolveTree,
    );

    const results: RunnerResult[] = [];
    for (const processor of gardenProcessors) {
      const matches = matchTriggers(processor.triggers, input.signals);
      if (matches.length === 0) continue;

      const result = await dispatchOneProcessor({
        processor,
        phase: "garden",
        envelope: Object.freeze({
          kind: "garden" as const,
          matchedTriggers: matches,
        }),
        snapshot,
        changedPaths: input.changedPaths,
        proposal: input.proposal,
        // `inputCommit` for garden is the adopted commit — the snapshot
        // the processor read from. This is what lands in
        // `runs.input_commit` for the audit trail; it joins to the
        // closure commit of the adoption that just completed.
        inputCommit: input.adopted,
        matches,
        resolveGrants,
        extensionIdFor,
        ledger,
      });
      results.push(result);
    }

    return Object.freeze(results);
  };

  return Object.freeze({ adoptionRunner, gardenRunner });
}

// ----- shared dispatch helpers ----------------------------------------------

/**
 * Build the per-iteration Snapshot. Resolves the tree OID once per
 * (vaultPath, commit) pair; the read closures (`readFile`,
 * `listMarkdownFiles`) bind lazily so processors that don't touch the
 * snapshot incur no git I/O.
 *
 * Used by both `adoptionRunner` (commit = candidate) and `gardenRunner`
 * (commit = adopted). Identical shape; the only variation is which commit
 * the closures resolve against.
 */
async function makeSnapshot(
  vaultPath: string,
  commit: CommitOid,
  resolveTree: (commit: CommitOid) => Promise<TreeOid>,
): Promise<Snapshot> {
  const tree = await resolveTree(commit);
  return Object.freeze({
    commit,
    tree,
    readFile: (path: string) =>
      readBlob({ path: vaultPath, commit, filepath: path }),
    listMarkdownFiles: () => listMarkdownPathsInTree(vaultPath, commit),
  });
}

/**
 * Per-processor dispatch — shared between adoption and garden runners.
 * Handles run-id allocation, ledger lifecycle (queued → running →
 * succeeded/failed), context construction, exception synthesis, and
 * RunnerResult assembly.
 *
 * The only per-phase variation in this lifecycle is the `phase` value
 * stored in the ledger row and the `envelope` shape passed as
 * `ctx.input`. Both are parameters here; the body is identical
 * otherwise. Centralizing the dispatch keeps the two runners' bodies
 * focused on phase-specific filtering + snapshot-commit choice; the
 * audit lifecycle (the load-bearing
 * [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]] contract) is
 * structurally identical across phases.
 */
async function dispatchOneProcessor<TEnvelope>(opts: {
  readonly processor: Processor<unknown>;
  readonly phase: "adoption" | "garden";
  readonly envelope: TEnvelope;
  readonly snapshot: Snapshot;
  readonly changedPaths: ReadonlyArray<string>;
  readonly proposal: Proposal;
  readonly inputCommit: CommitOid;
  readonly matches: ReadonlyArray<TriggerMatch>;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly extensionIdFor: (processorId: string) => string;
  readonly ledger: LedgerDb | undefined;
}): Promise<RunnerResult> {
  const {
    processor,
    phase,
    envelope,
    snapshot,
    changedPaths,
    proposal,
    inputCommit,
    matches,
    resolveGrants,
    extensionIdFor,
    ledger,
  } = opts;

  const declared = processor.capabilities;
  const granted = resolveGrants(processor.id);
  const extensionId = extensionIdFor(processor.id);

  // Allocate the run id. When a ledger is wired we use the ledger's
  // `newRunId` so the id is the same one stored in the row; when no
  // ledger is wired we fall back to the `makeRunContext`-synthesized
  // form (identical shape).
  const startedAt = new Date();
  const runId: RunId =
    ledger !== undefined
      ? newRunId(startedAt)
      : (makeRunContext({
          extensionId,
          base: proposal.base,
          sourceHead: proposal.head,
        }).runId as RunId);

  // Ledger lifecycle: queued + running, both synchronously before the
  // processor runs. Per [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]]
  // §"Structural enforcement" §1.
  if (ledger !== undefined) {
    insertQueued(ledger, {
      id: runId,
      proposalId: proposal.id,
      processorId: processor.id,
      processorVersion: processor.version,
      phase,
      inputCommit,
      triggerKind: triggerKindOf(matches),
      triggerPayload: triggerPayloadOf(matches),
      startedAt,
    });
    markRunning(ledger, runId, startedAt);
  }

  const ctxInput: ProcessorContextInput<TEnvelope> = {
    snapshot,
    changedPaths,
    proposal,
    runId,
    input: envelope,
    // `modelInvoke` intentionally unset for both phases in Phase 4a.
    // Adoption never receives a model handle (processors.md §"Adoption
    // phase"). Garden MAY receive one when the `model.invoke` capability
    // wiring lands in a later phase (Phase 4d-adjacent), but Phase 4a
    // does not enable it — garden processors that require LLMs are
    // deferred bundles (dome.intake), and their wiring lands when
    // model.invoke is plumbed through ProcessorContext.
  };
  const ctx = makeProcessorContext(ctxInput);

  const runOutcome = await runOneProcessor(
    processor.run,
    ctx,
    processor.id,
    phase,
  );

  // Ledger lifecycle: terminal mark.
  if (ledger !== undefined) {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    if (runOutcome.error === null) {
      markSucceeded(ledger, {
        id: runId,
        effectHashes: runOutcome.effects.map(hashEffect),
        costUsd: null,
        durationMs,
        // `output_commit` is the closure-commit OID for adoption-phase
        // runs (back-filled by the engine's `updateOutputCommit` after
        // closure). Garden-phase runs land NULL here; garden's audit
        // trail is the parent adoption's closure commit (recoverable
        // via `proposal_id` joining back through the ledger).
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

  return Object.freeze({
    runId,
    processorId: processor.id,
    declared,
    granted,
    effects: runOutcome.effects,
  });
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
async function runOneProcessor<TEnvelope>(
  run: (ctx: ProcessorContext<unknown>) => Promise<ReadonlyArray<Effect>>,
  ctx: ProcessorContext<TEnvelope>,
  processorId: string,
  phase: "adoption" | "garden",
): Promise<RunOutcome> {
  try {
    const effects = await run(ctx as ProcessorContext<unknown>);
    return { effects: Object.freeze([...effects]), error: null };
  } catch (e) {
    const message = errorMessage(e);
    const synthesized: DiagnosticEffect = diagnosticEffect({
      severity: "error",
      code: "processor-threw",
      message: `Processor ${processorId} threw during ${phase}-phase run: ${message}`,
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

/**
 * Walk the tree at `commit` and return every blob path ending in `.md`,
 * sorted lexicographically for determinism. Used to back the
 * `Snapshot.listMarkdownFiles` closure — adoption-phase processors that
 * resolve wikilink targets need the full markdown file set for the
 * candidate snapshot.
 *
 * Path strings are POSIX-joined (matches the convention in
 * `src/engine/compile-range.ts`'s walker). Non-blob entries (subtrees) are
 * recursed into; the recursion is bounded by the tree's natural depth.
 */
async function listMarkdownPathsInTree(
  vaultPath: string,
  commit: CommitOid,
): Promise<ReadonlyArray<string>> {
  const out: string[] = [];
  await walkTreeForMarkdown(vaultPath, commit, "", out);
  out.sort();
  return Object.freeze(out);
}

async function walkTreeForMarkdown(
  vaultPath: string,
  oid: string,
  prefix: string,
  out: string[],
): Promise<void> {
  const tree = await readTree({ path: vaultPath, oid });
  for (const entry of tree.tree) {
    const path = prefix === "" ? entry.path : posix.join(prefix, entry.path);
    if (entry.type === "tree") {
      await walkTreeForMarkdown(vaultPath, entry.oid, path, out);
    } else if (entry.type === "blob" && path.endsWith(".md")) {
      out.push(path);
    }
  }
}
