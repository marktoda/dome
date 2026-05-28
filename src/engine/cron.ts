// engine/cron: a minimal 5-field cron expression evaluator.
//
// Dome's scheduler ([[wiki/specs/processors]] §"Triggers and signals"
// `schedule:` trigger kind) fires processors when their cron expression
// is "due." We need two operations:
//
//   - `parseCron(expr)` — parse a 5-field cron expression into a typed
//     match-set per field. Throws on invalid input (callers catch at
//     bundle load time).
//   - `nextFire(parsed, after)` — the first Date strictly after `after`
//     that matches the cron's per-field constraints. Used by the
//     scheduler to compute whether `now >= nextFire(cursor.lastFire)`.
//
// Why not pull `cron-parser` from npm: Dome's dependency surface is
// deliberately lean (no LLM, no MCP, no transitively-heavy libs per
// the [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] discipline).
// `cron-parser` brings `luxon` (~70KB) for tz handling we don't use.
// A minimal evaluator covering the patterns Dome actually emits in v1
// fits in ~120 lines and has no dependencies.
//
// Supported syntax per field (minute, hour, dom, month, dow):
//   - `*`           — every value
//   - `M`           — single value
//   - `M-N`         — inclusive range
//   - `*/N`         — every N starting from 0
//   - `M/N`         — every N starting from M (e.g., `5/15`)
//   - `M-N/S`       — range with step
//   - `A,B,C-D`     — list of any of the above
//
// NOT supported (v1.x polish if needed): named months/days
// ("JAN", "MON"), `L`/`W`/`#` non-standard extensions, timezones
// (everything is local time, which matches the harness's TestClock
// + the daemon's `Date.now()`).
//
// Field semantics:
//   - minute: 0-59
//   - hour:   0-23
//   - dom:    1-31 (day of month)
//   - month:  1-12
//   - dow:    0-6 (0 = Sunday)
//
// When BOTH dom and dow are restricted (neither is `*`), the cron
// classical disjunctive semantic applies: a time matches if EITHER
// the dom matches OR the dow matches. When only one is restricted,
// only that one must match.

export type ParsedCron = {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dom: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dow: ReadonlySet<number>;
  /** True when the original `dom` field was `*` (any day of month). */
  readonly domAny: boolean;
  /** True when the original `dow` field was `*` (any day of week). */
  readonly dowAny: boolean;
  /** The original expression for round-trip + error messages. */
  readonly expr: string;
};

// ----- parseCron ------------------------------------------------------------

/**
 * Parse a 5-field cron expression. Throws on:
 *   - wrong field count (not 5)
 *   - field value outside its allowed range
 *   - malformed step / range / list syntax
 *
 * Field bounds:
 *   minute 0-59, hour 0-23, dom 1-31, month 1-12, dow 0-6.
 */
export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `cron: expected 5 fields, got ${fields.length} in "${expr}"`,
    );
  }
  const [minuteF, hourF, domF, monthF, dowF] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  return Object.freeze({
    minute: parseField(minuteF, 0, 59, "minute"),
    hour: parseField(hourF, 0, 23, "hour"),
    dom: parseField(domF, 1, 31, "dom"),
    month: parseField(monthF, 1, 12, "month"),
    dow: parseField(dowF, 0, 6, "dow"),
    domAny: domF === "*",
    dowAny: dowF === "*",
    expr,
  });
}

/**
 * Parse one field into the set of integer values it admits. Recognizes
 * single values, ranges (M-N), step (asterisk-slash-S), base-with-step
 * (M-slash-S, M-N-slash-S), and comma-lists of any of those.
 */
function parseField(
  field: string,
  lo: number,
  hi: number,
  name: string,
): ReadonlySet<number> {
  const out = new Set<number>();
  for (const item of field.split(",")) {
    addItem(item, lo, hi, name, out);
  }
  if (out.size === 0) {
    throw new Error(`cron: ${name} field "${field}" admits no values`);
  }
  return out;
}

function addItem(
  item: string,
  lo: number,
  hi: number,
  name: string,
  out: Set<number>,
): void {
  // Split step (`<base>/<step>`).
  const stepIdx = item.indexOf("/");
  const base = stepIdx >= 0 ? item.slice(0, stepIdx) : item;
  const stepStr = stepIdx >= 0 ? item.slice(stepIdx + 1) : null;
  const step = stepStr === null ? 1 : parseInt(stepStr, 10);
  if (Number.isNaN(step) || step <= 0) {
    throw new Error(`cron: ${name} step "${stepStr}" must be a positive integer`);
  }

  // Resolve the base into [from, to].
  let from: number;
  let to: number;
  if (base === "*") {
    from = lo;
    to = hi;
  } else {
    const dashIdx = base.indexOf("-");
    if (dashIdx >= 0) {
      from = parseInt(base.slice(0, dashIdx), 10);
      to = parseInt(base.slice(dashIdx + 1), 10);
    } else {
      from = parseInt(base, 10);
      // For `M/N` (step without range), spec'd as "every N starting from M
      // up to the field's max." Matches cron-parser + standard cron.
      to = stepStr === null ? from : hi;
    }
  }
  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw new Error(`cron: ${name} field item "${item}" has non-integer bounds`);
  }
  if (from < lo || to > hi || from > to) {
    throw new Error(
      `cron: ${name} field item "${item}" out of range [${lo}, ${hi}]`,
    );
  }

  for (let v = from; v <= to; v += step) {
    out.add(v);
  }
}

// ----- nextFire -------------------------------------------------------------

/**
 * Return the first Date strictly after `after` that matches the parsed
 * cron. Uses minute-by-minute forward walking — bounded by the search
 * cap (default ~366 days) so an unsatisfiable cron (e.g., minute=*,
 * dom=31, month=2) doesn't infinite-loop.
 *
 * The returned Date is in the same timezone interpretation as `after`
 * (we use `getMinutes`/`getHours`/`getDay`/`getDate`/`getMonth` — local
 * time). The harness's TestClock + the daemon's `Date.now()` both
 * produce local-time-flavored Dates; cron matching follows.
 */
export function nextFire(
  parsed: ParsedCron,
  after: Date,
  maxIterations: number = 60 * 24 * 366,
): Date {
  // Start at `after + 1 minute`, with seconds/ms zeroed.
  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  for (let i = 0; i < maxIterations; i += 1) {
    if (matchesCron(parsed, cursor)) {
      return new Date(cursor.getTime());
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  throw new Error(
    `cron: nextFire could not find a matching minute within ${maxIterations} iterations ` +
      `for expression "${parsed.expr}" (after ${after.toISOString()})`,
  );
}

/**
 * Does `date`'s minute/hour/dom/month/dow all satisfy `parsed`'s
 * constraints? Implements the classical dom/dow disjunction: when both
 * dom and dow are restricted (neither `*`), match if EITHER is
 * satisfied; when only one is restricted, only that one must match.
 */
export function matchesCron(parsed: ParsedCron, date: Date): boolean {
  if (!parsed.minute.has(date.getMinutes())) return false;
  if (!parsed.hour.has(date.getHours())) return false;
  if (!parsed.month.has(date.getMonth() + 1)) return false;

  const domMatch = parsed.dom.has(date.getDate());
  const dowMatch = parsed.dow.has(date.getDay());

  if (parsed.domAny && parsed.dowAny) return true;
  if (parsed.domAny) return dowMatch;
  if (parsed.dowAny) return domMatch;
  // Classical cron: dom OR dow when both restricted.
  return domMatch || dowMatch;
}
