// The four-trailer primitive backing ENGINE_COMMITS_CARRY_DOME_TRAILERS.
// Consumed by `commitEngineChange` (the engine-commit chokepoint today) and by
// closure-pass / patch-mediated extension-effect callers.
//
// Lives in its own file (rather than inside `src/engine/adopt.ts`) because the
// per-commit RunContext primitive has a different change surface than the
// once-per-sync state machine in `engine/adopt.ts`. See
// docs/wiki/specs/adoption.md §"Engine commit trailers".

import { randomBytes } from "node:crypto";

/**
 * The four trailers every engine commit carries (per
 * ENGINE_COMMITS_CARRY_DOME_TRAILERS). Constructed via `makeRunContext`,
 * consumed by `commitEngineChange`.
 */
export interface RunContext {
  /** `run_<unix-ms>_<6-char-random>` — sortable, debuggable, unique. */
  readonly runId: string;
  /**
   * Extension name for engine commits (e.g., `"dome.agent"`); the well-known
   * `ENGINE_EXTENSION_ID` (`"engine"`) for closure-pass commits made directly
   * by the engine; bundle-originated commits carry their own bundle id.
   */
  readonly extensionId: string;
  /** Adopted ref SHA at run start, or `ZERO_SHA` when uninitialized. */
  readonly base: string;
  /** HEAD SHA at run start (before this commit was made). */
  readonly sourceHead: string;
}

/**
 * The all-zeros SHA used as the `Dome-Base` trailer value when the adopted
 * ref is uninitialized at run start. Matches git's convention for "no
 * previous value" in reflog entries and ref-update hooks.
 */
export const ZERO_SHA = "0000000000000000000000000000000000000000";

/**
 * The well-known `Dome-Extension` value for engine-driven commits that
 * don't originate from a named bundle — closure-pass commits
 * made directly by `src/engine/adopt.ts`'s close step.
 */
export const ENGINE_EXTENSION_ID = "engine";

/**
 * Build a RunContext. The `runId` is generated as `run_<unix-ms>_<6-rand>`;
 * the random component is six lowercase hex chars from a 4-byte source
 * (enough entropy for per-process uniqueness even under rapid bursts).
 */
export function makeRunContext(opts: {
  extensionId: string;
  base: string;
  sourceHead: string;
}): RunContext {
  return {
    runId: `run_${Date.now()}_${randomBytes(4).toString("hex").slice(0, 6)}`,
    extensionId: opts.extensionId,
    base: opts.base,
    sourceHead: opts.sourceHead,
  };
}
