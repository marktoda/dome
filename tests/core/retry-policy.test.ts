// tests/core/retry-policy.test.ts
//
// The shared exponential-backoff curve. These literals ARE the behavior the
// outbox dispatcher (src/outbox/dispatch.ts) and the operational job runner
// (src/engine/operational/jobs.ts) each used to implement independently — a
// curve that passes this test is provably equivalent to both prior copies.
//
// `attemptCount` is "attempts including the one that just failed": the first
// failure is n=1. delay = min(1000 * 2^max(0, n-1), 60_000) ms.

import { describe, expect, test } from "bun:test";

import { computeNextAttemptAt } from "../../src/core/retry-policy";

const EPOCH = new Date(0);
const delayFor = (n: number): number => computeNextAttemptAt(EPOCH, n).getTime();

describe("computeNextAttemptAt", () => {
  test("first failure backs off one base interval (1s)", () => {
    expect(delayFor(1)).toBe(1000);
  });

  test("doubles each subsequent attempt", () => {
    expect(delayFor(2)).toBe(2000);
    expect(delayFor(3)).toBe(4000);
    expect(delayFor(4)).toBe(8000);
  });

  test("clamps at the 60s ceiling", () => {
    // 2^9 * 1000 = 512_000ms uncapped → clamped to the max.
    expect(delayFor(10)).toBe(60_000);
    expect(delayFor(100)).toBe(60_000);
  });

  test("treats n=0 like the first attempt (exponent floors at 0)", () => {
    expect(delayFor(0)).toBe(1000);
  });

  test("returns now + delay relative to the passed clock", () => {
    const now = new Date(1_000_000);
    expect(computeNextAttemptAt(now, 2).getTime()).toBe(1_000_000 + 2000);
  });
});
