// src/cli/presenter/humanize.ts
//
// Cell formatters that turn machine values into human-scannable text.
// Pure; `relativeTime` takes `now` explicitly so it is deterministic in tests.

export function durationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function relativeTime(
  iso: string | null | undefined,
  now: Date = new Date(),
): string {
  if (iso === null || iso === undefined) return "-";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "-";
  const deltaSec = Math.round((now.getTime() - then) / 1000);
  if (deltaSec < 60) return "just now";
  const min = Math.round(deltaSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export function shortOid(oid: string | null | undefined, fallback = "none"): string {
  return oid === null || oid === undefined ? fallback : oid.slice(0, 7);
}

/**
 * USD with four decimal places — model spend per run is fractions of a
 * cent, so the two-decimal convention would render most rows as $0.00.
 */
export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return `$${value.toFixed(4)}`;
}
