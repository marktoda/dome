// src/core/retry-policy.ts
//
// The single home for the engine's retry backoff curve. The external-action
// outbox dispatcher (src/outbox/dispatch.ts) reschedules failed work on this
// exact curve; keeping it here means tuning the backoff can't silently
// diverge from any future retry surface that needs the same shape.
//
// Curve: exponential backoff, one base interval after the first failure,
// doubling each attempt, clamped at a ceiling.
//
//   delay(n) = min(BASE_RETRY_DELAY_MS * 2^max(0, n-1), MAX_RETRY_DELAY_MS)
//
// where `n` ("attemptCount") is the number of attempts including the one that
// just failed — the first failure is n=1. Per [[wiki/gotchas/outbox-stuck]]:
// "exponential backoff up to maxAttempts, default 3".

const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60_000;

/** The backoff delay in ms for the `attemptCount`-th attempt. */
function retryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, attemptCount - 1);
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** exponent, MAX_RETRY_DELAY_MS);
}

/**
 * The wall-clock time a failed item should next be retried: `now` plus the
 * backoff delay for `attemptCount` (attempts including the just-failed one).
 */
export function computeNextAttemptAt(now: Date, attemptCount: number): Date {
  return new Date(now.getTime() + retryDelayMs(attemptCount));
}
