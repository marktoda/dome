// tests/harness/test-clock.ts — deterministic simulated clock for the harness.
//
// `TestClock` implements `TestClockHandle` from `./types`. Tests don't wait
// for real time — they call `clock.advance(ms)` to move time forward. H1
// does NOT wire this clock into the daemon's setTimeout; schedule triggers
// don't exist in the system yet. The clock exists as a hook later phases
// will plug into (the always-true invariants' "stuck > 60s" cutoffs already
// consume it).

import type { TestClockHandle } from "./types";

const DEFAULT_START_ISO = "2026-01-01T00:00:00.000Z";

/**
 * Mutable in-memory clock starting at a fixed ISO timestamp. `advance(ms)`
 * is the only mutation site; `now*()` readers are pure projections of the
 * internal millisecond counter.
 */
export class TestClock implements TestClockHandle {
  private ms: number;

  constructor(startIso: string = DEFAULT_START_ISO) {
    const parsed = Date.parse(startIso);
    if (Number.isNaN(parsed)) {
      throw new Error(
        `TestClock: invalid startIso ${JSON.stringify(startIso)} — expected ISO-8601.`,
      );
    }
    this.ms = parsed;
  }

  nowMs(): number {
    return this.ms;
  }

  now(): Date {
    return new Date(this.ms);
  }

  nowIso(): string {
    return new Date(this.ms).toISOString();
  }

  advance(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(
        `TestClock.advance: ms must be a non-negative finite number; got ${ms}`,
      );
    }
    this.ms += ms;
    return this.ms;
  }
}
