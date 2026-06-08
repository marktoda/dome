// ProcessorRegistry: the engine's loaded-processor index.
//
// The bundle loader (per docs/wiki/specs/sdk-surface.md §"Bundle load
// lifecycle", step 4 — "Processors register into the engine's processor
// registry under each processor's manifest id") hands a flat list of
// `Processor<unknown>` values to `buildRegistry`. The registry validates
// the set, indexes by id and by phase, and exposes a sealed query surface
// the runtime uses to walk per-phase candidates, look up by id, and
// iterate the full set in stable order.
//
// Normative references:
//   - docs/wiki/specs/processors.md §"The Processor type"
//   - docs/wiki/specs/processors.md §"Registration"
//   - docs/wiki/specs/sdk-surface.md §"Adding a processor"
//   - docs/wiki/specs/sdk-surface.md §"Extension bundles" / "Bundle load lifecycle"
//
// v1 scope:
//   - Pure data structure. No filesystem, no git, no sqlite, no network.
//     The bundle loader (today: `src/extensions/loader.ts`; future Phase 6
//     cleanup: a unified loader) constructs the input list; this file
//     just validates + indexes.
//   - Type-erased at storage. The registry stores `Processor<unknown>`;
//     per-processor `TInput` narrowing happens at invocation time in the
//     processor runtime (Phase 3 next task), not here. Generic-preserving
//     registries in TypeScript cost more than they pay for a v1 surface.
//   - Convention (not enforced here): manifest ids are fully qualified
//     with the bundle namespace (e.g., `dome.agent.ingest`).
//     This file treats ids as opaque strings and only enforces uniqueness.
//   - Validation is structural, not Zod. Manifest-owned static fields are
//     already shape-checked by `parseManifest`; the registry's checks cover
//     whole-set properties TypeScript and per-manifest validation cannot
//     catch: duplicate ids, duplicate command triggers, empty trigger arrays,
//     and (defensively) phase-enum values outside the closed `ProcessorPhase`
//     union.
//
// House-style notes (matches src/core/source-ref.ts, src/core/effect.ts,
// src/engine/capability-broker.ts, src/engine/compile-range.ts,
// src/engine/apply-effect.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - Optional fields use `field?: T` (not `T | undefined`) for
//     `exactOptionalPropertyTypes` cleanliness.
//   - Exhaustive `switch` where a closed union is the input; here the
//     phase check uses a closed-union allowlist (`ProcessorPhase`).
//   - `Object.freeze` chosen over `as const` so misbehaving callers fail
//     loudly at runtime rather than silently mutating the indexes.
//   - Returns `Result<T, E>` — never throws. The runtime opener wraps
//     failures as `registry-build-failed` so startup fails before any
//     ambiguous processor dispatch can happen.
//   - Imports limited to pure types from `../core/processor` plus the
//     `Result` / `ok` / `err` triple from `../types`. No engine-layer
//     imports — the registry is upstream of the engine runtime.

import type { Processor, ProcessorPhase } from "../core/processor";
import { type Result, ok, err } from "../types";

// ----- RegistryError --------------------------------------------------------

/**
 * The closed set of registry-build failures. Each variant carries the
 * minimum field set the caller (the bundle loader) needs to surface a
 * useful error to the operator.
 *
 *   - `duplicate-processor-id`     — two or more processors registered
 *                                    under the same id. `processors` lists
 *                                    every id that collided on `id` (the
 *                                    full set, not just the first pair).
 *   - `duplicate-command-trigger`   — two view processors, or one malformed
 *                                    view processor with repeated triggers,
 *                                    claim the same command name. View
 *                                    dispatch must be unambiguous.
 *   - `processor-no-triggers`      — a processor declared an empty
 *                                    `triggers` array. Per processors.md
 *                                    §"The Processor type", a processor
 *                                    without triggers can never fire and
 *                                    is a registration-time defect.
 *   - `processor-invalid-phase`    — defensive runtime re-check of the
 *                                    closed `ProcessorPhase` union. The
 *                                    static type already forbids invalid
 *                                    values; this fires only if a
 *                                    loader fed in an untyped value.
 */
export type RegistryError =
  | {
      readonly kind: "duplicate-processor-id";
      readonly id: string;
      readonly processors: ReadonlyArray<string>;
    }
  | {
      readonly kind: "duplicate-command-trigger";
      readonly commandName: string;
      readonly processors: ReadonlyArray<string>;
    }
  | {
      readonly kind: "processor-no-triggers";
      readonly id: string;
    }
  | {
      readonly kind: "processor-invalid-phase";
      readonly id: string;
      readonly phase: string;
    };

// ----- ProcessorRegistry ----------------------------------------------------

/**
 * The sealed query handle returned by `buildRegistry`. Callers see only
 * the read operations; the underlying maps are closed over by the
 * factory and are unreachable from outside this module. The handle
 * itself is `Object.freeze`d, so the function references cannot be
 * swapped post-construction.
 *
 *   - `get(id)`         — point lookup by canonical id (bundle-prefixed
 *                         per the §"Bundle load lifecycle" convention).
 *                         Returns `undefined` if no processor is
 *                         registered under that id.
 *   - `byPhase(phase)`  — every processor whose `phase` matches,
 *                         alphabetical by id. The returned array is
 *                         frozen; the same array instance is reused for
 *                         repeat calls (no per-call allocation).
 *   - `all()`           — every processor, alphabetical by id. The
 *                         returned array is frozen; the same instance
 *                         is reused for repeat calls.
 *   - `size`            — total processor count. Useful for boot-time
 *                         observability (`info: loaded N processors`).
 */
export type ProcessorRegistry = {
  readonly get: (id: string) => Processor<unknown> | undefined;
  readonly byPhase: (phase: ProcessorPhase) => ReadonlyArray<Processor<unknown>>;
  readonly all: () => ReadonlyArray<Processor<unknown>>;
  readonly size: number;
};

// ----- valid phase set (defensive runtime check) ----------------------------

/**
 * Closed set of `ProcessorPhase` literal values. The static type already
 * forbids other strings; this runtime check defends against untyped
 * inputs from a third-party loader handing the registry an untyped object
 * cast to `Processor<unknown>`.
 */
const VALID_PHASES: ReadonlySet<ProcessorPhase> = new Set<ProcessorPhase>([
  "adoption",
  "garden",
  "view",
]);

// ----- buildRegistry --------------------------------------------------------

/**
 * Validate and index a flat list of processors into a sealed
 * `ProcessorRegistry` handle. The order of validation is:
 *
 *   1. Per-processor structural checks (phase enum membership; non-empty
 *      triggers). Returns the *first* such failure encountered.
 *   2. Cross-processor duplicate-id detection. If any id appears more
 *      than once, every collision is reported together in a single
 *      `duplicate-processor-id` error whose `processors` array lists
 *      every offending id (not just the first pair). This matches the
 *      acceptance criterion that callers see the full conflict set, not
 *      a piecemeal trickle of errors.
 *   3. View command trigger collision detection. A command name is a
 *      protocol surface and must resolve to at most one processor.
 *
 * On success, returns a frozen registry handle whose indexes (by id, by
 * phase, the alphabetical all-list) are computed once and shared across
 * every query. The returned arrays are frozen; the same instances are
 * reused for repeat calls.
 *
 * Determinism: per-phase and all-list orderings are deterministic
 * (lexicographic ascending by `id`), so a snapshot of `registry.all()`
 * round-trips identically across boots given the same input set.
 */
export function buildRegistry(
  processors: ReadonlyArray<Processor<unknown>>,
): Result<ProcessorRegistry, RegistryError> {
  // 1. Per-processor structural checks.
  for (const p of processors) {
    if (!VALID_PHASES.has(p.phase)) {
      return err({
        kind: "processor-invalid-phase",
        id: p.id,
        phase: p.phase,
      });
    }
    if (p.triggers.length === 0) {
      return err({ kind: "processor-no-triggers", id: p.id });
    }
  }

  // 2. Duplicate-id detection. Single pass: bucket by id, then surface
  //    the full collision set if any bucket has > 1 entry. Reporting all
  //    duplicates in one error lets the operator fix the bundle config
  //    in one edit pass rather than discovering them one boot at a time.
  const buckets = new Map<string, number>();
  for (const p of processors) {
    buckets.set(p.id, (buckets.get(p.id) ?? 0) + 1);
  }
  const duplicates: string[] = [];
  for (const [id, count] of buckets) {
    if (count > 1) duplicates.push(id);
  }
  if (duplicates.length > 0) {
    duplicates.sort();
    const firstId = duplicates[0];
    // `firstId` is non-undefined here because `duplicates.length > 0`,
    // but `noUncheckedIndexedAccess` requires the narrowing.
    if (firstId === undefined) {
      // unreachable; satisfies the type checker without an `as`.
      return err({
        kind: "duplicate-processor-id",
        id: "",
        processors: Object.freeze([]),
      });
    }
    return err({
      kind: "duplicate-processor-id",
      id: firstId,
      processors: Object.freeze([...duplicates]),
    });
  }

  const commandCollision = findCommandTriggerCollision(processors);
  if (commandCollision !== null) {
    return err(commandCollision);
  }

  // 3. Build indexes. The all-list is alphabetical by id; per-phase
  //    lists are filtered views of the all-list (so per-phase order is
  //    also alphabetical and is consistent with `all()`).
  const allSorted: ReadonlyArray<Processor<unknown>> = Object.freeze(
    [...processors].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  );

  const byId = new Map<string, Processor<unknown>>();
  for (const p of allSorted) byId.set(p.id, p);

  const byPhaseIndex: ReadonlyMap<
    ProcessorPhase,
    ReadonlyArray<Processor<unknown>>
  > = buildPhaseIndex(allSorted);

  const EMPTY: ReadonlyArray<Processor<unknown>> = Object.freeze([]);

  const handle: ProcessorRegistry = Object.freeze({
    get: (id: string): Processor<unknown> | undefined => byId.get(id),
    byPhase: (phase: ProcessorPhase): ReadonlyArray<Processor<unknown>> =>
      byPhaseIndex.get(phase) ?? EMPTY,
    all: (): ReadonlyArray<Processor<unknown>> => allSorted,
    size: allSorted.length,
  });

  return ok(handle);
}

// ----- internals ------------------------------------------------------------

function findCommandTriggerCollision(
  processors: ReadonlyArray<Processor<unknown>>,
): Extract<RegistryError, { readonly kind: "duplicate-command-trigger" }> | null {
  const buckets = new Map<
    string,
    { readonly processorIds: Set<string>; count: number }
  >();
  for (const processor of processors) {
    if (processor.phase !== "view") continue;
    for (const trigger of processor.triggers) {
      if (trigger.kind !== "command") continue;
      const existing =
        buckets.get(trigger.name) ??
        { processorIds: new Set<string>(), count: 0 };
      existing.processorIds.add(processor.id);
      existing.count += 1;
      buckets.set(trigger.name, existing);
    }
  }

  const collisions = [...buckets.entries()]
    .filter(([, bucket]) => bucket.count > 1)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const first = collisions[0];
  if (first === undefined) return null;
  const [commandName, bucket] = first;
  return {
    kind: "duplicate-command-trigger",
    commandName,
    processors: Object.freeze([...bucket.processorIds].sort()),
  };
}

/**
 * Bucket the alphabetically-sorted processor list by phase. Returns a
 * frozen map keyed by every `ProcessorPhase` value; absent phases map to
 * a frozen empty array (so `byPhase("view")` is always a valid array
 * even when no view-phase processors are loaded).
 */
function buildPhaseIndex(
  sorted: ReadonlyArray<Processor<unknown>>,
): ReadonlyMap<ProcessorPhase, ReadonlyArray<Processor<unknown>>> {
  const adoption: Processor<unknown>[] = [];
  const garden: Processor<unknown>[] = [];
  const view: Processor<unknown>[] = [];
  for (const p of sorted) {
    switch (p.phase) {
      case "adoption":
        adoption.push(p);
        break;
      case "garden":
        garden.push(p);
        break;
      case "view":
        view.push(p);
        break;
    }
  }
  const out = new Map<ProcessorPhase, ReadonlyArray<Processor<unknown>>>();
  out.set("adoption", Object.freeze(adoption));
  out.set("garden", Object.freeze(garden));
  out.set("view", Object.freeze(view));
  return out;
}
