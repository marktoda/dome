// Neutral home for the engine's outbound runner contracts. The engine layer
// owns these types (the engine consumes them as injection points); the
// processors layer implements them. This file exists to break the backward
// import that would otherwise force a processors → engine/adopt cycle when
// garden + view runners ship in Phase 4+.
//
// Living inside `src/engine/` (not `src/processors/`) reflects ownership: the
// engine's adoption / garden / view entry points consume these callbacks as
// injection points; the processors layer is the *implementer* of the
// contract, not its owner. Co-locating the contract with the consumers keeps
// the dependency arrow processors → engine and avoids the inverted import
// that lifted these types from `./adopt` in Phase 3.
//
// House-style notes (matches src/engine/compile-range.ts,
// src/engine/closure-commit.ts, src/engine/capability-broker.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - Optional fields use `field?: T` (not `T | undefined`) for
//     `exactOptionalPropertyTypes` cleanliness.
//   - Pure type module: zero value exports, zero runtime imports. The
//     `Object.freeze`-over-`as const` convention that sibling engine files
//     follow does not apply here — no runtime values are produced.
//   - Imports limited to pure types from `../core/` (Effect, Capability,
//     Proposal, CommitOid) and the `SignalEvent` type from
//     `./compile-range`, plus the `Vault` type from `../vault`.

import type { Effect } from "../core/effect";
import type { Capability } from "../core/processor";
import type { Proposal } from "../core/proposal";
import type { CommitOid } from "../core/source-ref";
import type { Vault } from "../vault";
import type { SignalEvent } from "./compile-range";

// ----- Branded RunId --------------------------------------------------------
//
// The engine ↔ runtime contract owns the run id brand. The processors runtime
// allocates ids (via `ledger/runs.newRunId`) and surfaces them on
// `RunnerResult.runId`; the engine threads them through `applyEffect` /
// `recordCapabilityUse` / `updateOutputCommit`; the ledger persists them.
// Living here (not in `../ledger/runs`) keeps the import arrow pointing from
// the ledger consumer toward the engine contract, not the other way around.
//
// Structurally branded so a raw `string` cannot accidentally flow into a slot
// expecting a RunId. The format is normative (per
// docs/wiki/specs/run-ledger.md §"Tables — runs":
// `run_<unix-ms>_<6-char-rand>`); the brand makes the lifecycle accessors
// refuse arbitrary strings.

/** A ledger run id, formatted `run_<unix-ms>_<6-char-rand>` per spec. */
export type RunId = string & { readonly __brand: "RunId" };

// ----- AdoptionPhaseRunner --------------------------------------------------

/**
 * The injected processor-runtime callback. The loop calls the runner once
 * per iteration with the candidate snapshot, the per-iteration changed-paths
 * delta, and the synthesized signals; the runner returns one record per
 * processor that fired, carrying the processor's id, its declared
 * capabilities, its effective granted capabilities, and the effects it
 * emitted.
 *
 * Phase 3 wires the actual processor-registry runner; Phase 2 accepts the
 * injection point so the loop is testable in isolation (a test passes a
 * stub callback returning predetermined records).
 *
 * Returning an empty array is the runner's signal that no processor fired
 * this iteration — the loop interprets it as "no effects produced" and
 * may reach a fixed point on the next no-patch check.
 */
export type AdoptionPhaseRunner = (input: {
  readonly vault: Vault;
  readonly candidate: CommitOid;
  readonly changedPaths: ReadonlyArray<string>;
  readonly signals: ReadonlyArray<SignalEvent>;
  readonly iteration: number;
  readonly proposal: Proposal;
}) => Promise<ReadonlyArray<RunnerResult>>;

/**
 * One per-processor record returned by the `AdoptionPhaseRunner` for an
 * iteration. The loop iterates `effects` and routes each through
 * `applyEffect` with the per-processor `(declared, granted)` so the broker
 * decision is correctly scoped.
 *
 * `runId` is the ledger run id allocated by the runtime when it dispatched
 * the processor. The engine threads it through `applyEffect` so the broker
 * records capability uses against the correct row — joining the
 * `capability_uses` and `runs` tables on this key (per
 * [[wiki/specs/run-ledger]] §"Tables — capability_uses"). When the runtime
 * is built without a ledger (the Phase 6 transitional state — see
 * `src/processors/runtime.ts`'s `BuildRuntimeOptions.ledger` slot), the
 * runtime synthesizes a placeholder id via `makeRunContext` so the engine
 * keeps its single-source-of-truth contract; nothing is recorded in that
 * case, but the type slot stays populated.
 */
export type RunnerResult = {
  readonly runId: RunId;
  readonly processorId: string;
  readonly declared: ReadonlyArray<Capability>;
  readonly granted: ReadonlyArray<Capability>;
  readonly effects: ReadonlyArray<Effect>;
};
