// Trigger matcher — pure logic that decides which of a processor's declared
// triggers fire for a given set of SignalEvents.
//
// See docs/wiki/specs/processors.md §"Triggers and signals" for the normative
// contract (the Trigger union, the Signal enum, the per-kind match semantics).
// Phase × trigger compatibility (which call sites use this matcher) is at
// docs/wiki/matrices/processor-phase-x-trigger.md and enforced at manifest
// validation time — this matcher does not re-check phase compatibility.
//
// v1 Phase 3 scope:
//   - `signal` triggers: matched here. An event matches when
//     `event.signal === trigger.name` AND (if `trigger.pathPattern` is set)
//     `event.path` matches the pattern glob. When `pathPattern` is absent the
//     trigger fires for the signal on any path.
//   - `path`   triggers: matched here. Any SignalEvent whose `path` matches
//     `trigger.pattern` fires the trigger — regardless of the event's
//     `signal`. (A `path` trigger is "any change touched this path glob.")
//   - `schedule` triggers: NOT matched here. Schedule matching is owned by
//     the runtime's clock-cursor layer (Phase 4's projection store carries
//     `schedule_cursors`); this matcher returns no candidates for schedule
//     triggers so a processor whose only trigger is `schedule` does not fire
//     from a signal dispatch. Schedule-driven dispatch enters the runtime via
//     a different call site that passes the due-trigger decision explicitly.
//   - `command`  triggers: NOT matched here. Command dispatch is invoked by
//     the CLI/MCP layer (not the adoption-phase signal flow); the runtime
//     resolves `command.name` against the invoking command at that call site.
//
// Pure — no I/O. Same `(triggers, signals)` → same result. The matcher does
// not mutate either input array; all returned arrays and objects are frozen.
//
// House-style notes (matches src/engine/compile-range.ts,
// src/engine/capability-broker.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - Optional fields use `field?: T` (not `T | undefined`) for
//     `exactOptionalPropertyTypes` cleanliness.
//   - `Object.freeze` chosen over `as const` so misbehaving callers fail
//     loudly at runtime rather than silently mutating matcher outputs.
//   - Imports limited to pure types from `../core/processor` plus the
//     `SignalEvent` type from `../engine/compile-range`. No runtime
//     dependency on filesystem, git, sqlite, or network.
//   - `globMatch` mirrors the helper in `src/engine/capability-broker.ts`
//     with a module-private compiled-Glob cache. A future polish pass could
//     lift this into a shared module; for Phase 3 the duplication is small
//     and the cache is independent per usage site.

import type { Trigger } from "../core/processor";
import type { SignalEvent } from "../engine/compile-range";

// ----- TriggerMatch ---------------------------------------------------------

/**
 * One firing trigger plus the SignalEvents that caused it to fire. The
 * matcher returns one `TriggerMatch` per trigger that had at least one
 * matching SignalEvent. `matchedSignals` is the (non-empty) subset of the
 * input signals that matched this trigger.
 */
export type TriggerMatch = {
  readonly trigger: Trigger;
  readonly matchedSignals: ReadonlyArray<SignalEvent>;
};

// ----- matchTriggers --------------------------------------------------------

/**
 * Decide which of `triggers` are activated by `signals`.
 *
 * For each trigger:
 *   - `signal`   — collect every event where `event.signal === trigger.name`
 *                  AND (if `trigger.pathPattern` is set) the event's path
 *                  matches the pattern glob.
 *   - `path`     — collect every event whose `path` matches `trigger.pattern`,
 *                  regardless of the event's `signal`.
 *   - `schedule` — never matches via this entry point (clock-cursor layer).
 *   - `command`  — never matches via this entry point (CLI/MCP dispatch).
 *
 * Returns one `TriggerMatch` per trigger that had ≥1 matching signal, in the
 * order the triggers appear in the input array. The result and every
 * `matchedSignals` array are frozen.
 *
 * Determinism: the function is pure — same `(triggers, signals)` always
 * produces the same result. No input mutation.
 */
export function matchTriggers(
  triggers: ReadonlyArray<Trigger>,
  signals: ReadonlyArray<SignalEvent>,
): ReadonlyArray<TriggerMatch> {
  const matches: TriggerMatch[] = [];
  for (const trigger of triggers) {
    const matched = matchedSignalsFor(trigger, signals);
    if (matched.length > 0) {
      matches.push(
        Object.freeze({
          trigger,
          matchedSignals: Object.freeze(matched),
        }),
      );
    }
  }
  return Object.freeze(matches);
}

// ----- internals ------------------------------------------------------------

/**
 * Per-trigger dispatch: returns the (possibly empty) list of SignalEvents
 * that match `trigger`. Exhaustive `switch` on `trigger.kind` with a `never`
 * exhaustiveness check so adding a fifth Trigger kind is a compile error
 * here until this function is updated.
 */
function matchedSignalsFor(
  trigger: Trigger,
  signals: ReadonlyArray<SignalEvent>,
): SignalEvent[] {
  switch (trigger.kind) {
    case "signal":
      return collectSignalMatches(trigger.name, trigger.pathPattern, signals);
    case "path":
      return collectPathMatches(trigger.pattern, signals);
    case "schedule":
    case "command":
      // Owned by the runtime's clock-cursor / CLI-dispatch layers; this
      // matcher never fires schedule or command triggers from a signal
      // dispatch. See file banner.
      return [];
  }
  const _exhaustive: never = trigger;
  return _exhaustive;
}

function collectSignalMatches(
  name: string,
  pathPattern: string | undefined,
  signals: ReadonlyArray<SignalEvent>,
): SignalEvent[] {
  const out: SignalEvent[] = [];
  for (const event of signals) {
    if (event.signal !== name) continue;
    if (pathPattern !== undefined && !globMatch(pathPattern, event.path)) {
      continue;
    }
    out.push(event);
  }
  return out;
}

function collectPathMatches(
  pattern: string,
  signals: ReadonlyArray<SignalEvent>,
): SignalEvent[] {
  const out: SignalEvent[] = [];
  for (const event of signals) {
    if (globMatch(pattern, event.path)) out.push(event);
  }
  return out;
}

/**
 * Path-glob match using Bun's built-in glob matcher. Mirrors the helper in
 * `src/engine/capability-broker.ts`: compiled `Bun.Glob` instances are
 * memoized in `globCache` below (no eviction — the pattern set is bounded by
 * the loaded bundle set, ~tens to low hundreds in practice).
 *
 * Tolerant of empty patterns / paths (returns false). Path strings are
 * POSIX-style vault-relative (matching `SignalEvent.path`).
 */
const globCache = new Map<string, Bun.Glob>();

function globMatch(pattern: string, path: string): boolean {
  if (pattern.length === 0 || path.length === 0) return false;
  // Exact-string fast path — avoids constructing a Glob for the common case
  // of a literal path in a trigger pattern.
  if (pattern === path) return true;
  let glob = globCache.get(pattern);
  if (glob === undefined) {
    glob = new Bun.Glob(pattern);
    globCache.set(pattern, glob);
  }
  return glob.match(path);
}
