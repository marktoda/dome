// engine/host/health/sources: daily-path + sources subscription config probes
// (path mismatch, default-timeout footgun, missing fetch script).
import { compareStrings } from "../../../core/compare";
import type { HealthFinding } from "./types";

export function dailyPathMismatchFindings(opts: {
  readonly extensions: ReadonlyArray<{ readonly name: string }>;
  readonly extensionConfigFor: (
    extensionId: string,
  ) => Readonly<Record<string, unknown>>;
}): ReadonlyArray<HealthFinding> {
  const enabled = new Set(opts.extensions.map((extension) => extension.name));
  if (!enabled.has("dome.daily") || !enabled.has("dome.agent")) {
    return Object.freeze([]);
  }
  const dailyDailyPath = dailyPathConfigValue(
    opts.extensionConfigFor("dome.daily"),
  );
  const agentDailyPath = dailyPathConfigValue(
    opts.extensionConfigFor("dome.agent"),
  );
  if (dailyDailyPath === agentDailyPath) return Object.freeze([]);
  const render = (value: string | null): string =>
    value === null ? "(unset — bundle default)" : `"${value}"`;
  return Object.freeze([
    Object.freeze({
      code: "config.daily-path-mismatch" as const,
      severity: "warning" as const,
      subject: "config" as const,
      id: "daily_path" as const,
      message:
        "dome.daily and dome.agent resolve the daily note from different " +
        `daily_path values (dome.daily: ${render(dailyDailyPath)}, ` +
        `dome.agent: ${render(agentDailyPath)}); the morning brief would ` +
        "write a different file than create-daily, leaving a wrong-path " +
        "brief plus a duplicate daily skeleton.",
      recovery:
        "Declare the path once: set shared_config.daily_path in " +
        ".dome/config.yaml and remove the per-extension " +
        "extensions.*.config.daily_path overrides (an extension's own key " +
        "overrides the shared value, which is how this fork happened).",
      config: Object.freeze({ dailyDailyPath, agentDailyPath }),
    }),
  ]);
}

export function dailyPathConfigValue(
  config: Readonly<Record<string, unknown>>,
): string | null {
  const raw = config.daily_path;
  return typeof raw === "string" ? raw : null;
}

/**
 * The model-fetcher timeout footgun (wiki/specs/sources.md §"Timeout").
 * Trigger — the simplest honest one: ANY dome.sources subscription is
 * enabled while `engine.external_handler_timeout_ms` is unset. The 30s
 * dispatch default fits direct API fetchers (which is why this stays
 * info severity, never ill health), but a model-backed fetch command
 * (the shipped claude-calendar template) rides the timeout out and dies;
 * discovering that from failed outbox rows is miserable. Doctor says it
 * up front instead. We deliberately do NOT sniff the command for a
 * "claude" pattern — a wrapper script hides it, and a fast fetcher named
 * claude-anything would false-positive; subscription-enabled + timeout-
 * unset is the honest observable.
 */
export function sourcesHandlerTimeoutFindings(opts: {
  readonly extensions: ReadonlyArray<{ readonly name: string }>;
  readonly extensionConfigFor: (
    extensionId: string,
  ) => Readonly<Record<string, unknown>>;
  readonly externalHandlerTimeoutConfigured: boolean;
}): ReadonlyArray<HealthFinding> {
  if (opts.externalHandlerTimeoutConfigured) return Object.freeze([]);
  if (!opts.extensions.some((e) => e.name === "dome.sources")) {
    return Object.freeze([]);
  }
  const enabledKinds = enabledSubscriptionKinds(
    opts.extensionConfigFor("dome.sources"),
  );
  if (enabledKinds.length === 0) return Object.freeze([]);
  return Object.freeze([
    Object.freeze({
      code: "config.sources-timeout-default" as const,
      severity: "info" as const,
      subject: "config" as const,
      id: "sources_timeout" as const,
      message:
        `dome.sources subscription(s) ${enabledKinds.join(", ")} are enabled ` +
        "while engine.external_handler_timeout_ms is unset — each fetch " +
        "attempt is bounded by the 30s dispatch default. Direct API " +
        "fetchers fit; a model-backed fetch command (the claude-calendar " +
        "template) will time out.",
      recovery:
        "If the fetch command runs a headless model, set " +
        "engine.external_handler_timeout_ms: 300000 in .dome/config.yaml; " +
        "if it is a direct API fetcher, ignore this.",
      config: Object.freeze({ enabledKinds }),
    }),
  ]);
}

/**
 * Minimal, fallback-not-crash read of
 * `extensions.dome.sources.config.subscriptions` for the timeout finding:
 * map entries whose `enabled` is exactly true. Deliberately does not
 * import the bundle's resolver — src never imports assets/, and the
 * finding only needs intent (enabled), not validity.
 */
export function enabledSubscriptionKinds(
  config: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> {
  return Object.freeze(
    enabledSubscriptionEntries(config).map((entry) => entry.kind),
  );
}

/**
 * The `enabled: true` entries of
 * `extensions.dome.sources.config.subscriptions`, sorted by kind.
 * Fallback-not-crash like `enabledSubscriptionKinds` (which derives from
 * this): junk shapes yield no entries.
 */
export function enabledSubscriptionEntries(
  config: Readonly<Record<string, unknown>>,
): ReadonlyArray<{
  readonly kind: string;
  readonly subscription: Readonly<Record<string, unknown>>;
}> {
  const raw = config.subscriptions;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return Object.freeze([]);
  }
  return Object.freeze(
    Object.entries(raw as Record<string, unknown>)
      .filter(
        (pair): pair is [string, Record<string, unknown>] => {
          const entry = pair[1];
          return (
            entry !== null &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            (entry as Record<string, unknown>).enabled === true
          );
        },
      )
      .map(([kind, subscription]) => Object.freeze({ kind, subscription }))
      .sort((a, b) => compareStrings(a.kind, b.kind)),
  );
}

/**
 * The missing-fetch-script probe (`sources.fetch-script-missing`): an
 * enabled dome.sources subscription whose command references a script file
 * that is missing (or not a regular file) fails on every scheduled fetch.
 * Doctor says so up front — kind, path, and an explicit configuration
 * recovery — instead of leaving the owner to decode failed outbox rows the
 * next morning.
 *
 * STATIC by design: doctor never executes the fetch command (it would hit
 * Slack/calendar for real). The script reference is derived without running
 * anything: command[0] when it contains a path separator, else command[1]
 * for the standard `["sh", ".dome/bin/fetch-<kind>.sh"]` interpreter shape
 * (skipping flag arguments). Commands with no checkable reference — bare
 * PATH lookups, `sh -c` inline scripts — are skipped: a false positive on a
 * working command would be worse than silence, and their failures still
 * surface through the outbox findings.
 */
export function sourcesFetchScriptFindings(opts: {
  readonly extensions: ReadonlyArray<{ readonly name: string }>;
  readonly extensionConfigFor: (
    extensionId: string,
  ) => Readonly<Record<string, unknown>>;
  /** Whether `path` (vault-relative or absolute) is an existing regular file. */
  readonly scriptIsFile: (path: string) => boolean;
}): ReadonlyArray<HealthFinding> {
  if (!opts.extensions.some((e) => e.name === "dome.sources")) {
    return Object.freeze([]);
  }
  const findings: HealthFinding[] = [];
  for (const { kind, subscription } of enabledSubscriptionEntries(
    opts.extensionConfigFor("dome.sources"),
  )) {
    const scriptPath = referencedScriptPath(subscription.command);
    if (scriptPath === null) continue;
    if (opts.scriptIsFile(scriptPath)) continue;
    findings.push(
      Object.freeze({
        code: "sources.fetch-script-missing" as const,
        severity: "warning" as const,
        subject: "config" as const,
        id: `sources_fetch:${kind}`,
        message:
          `The enabled dome.sources "${kind}" subscription's fetch command ` +
          `references ${scriptPath}, which is missing or not a regular ` +
          "file — every scheduled fetch will fail.",
        recovery:
          `Create and review an explicit fetch adapter at ${scriptPath}, ` +
          "or fix the subscription command in .dome/config.yaml; dedicated source setup is planned for M9.",
        sources: Object.freeze({ kind, scriptPath }),
      }),
    );
  }
  return Object.freeze(findings);
}

/**
 * The script file a subscription command references, if any can be derived
 * statically: command[0] when it carries a path separator (a direct script
 * invocation), else command[1] when command[0] is a bare interpreter name
 * and command[1] looks like a path rather than a flag. Null means "nothing
 * checkable" — never a finding.
 */
export function referencedScriptPath(command: unknown): string | null {
  if (!Array.isArray(command)) return null;
  const first = command[0];
  if (typeof first !== "string" || first.length === 0) return null;
  if (first.includes("/")) return first;
  const second = command[1];
  if (
    typeof second === "string" &&
    !second.startsWith("-") &&
    second.includes("/")
  ) {
    return second;
  }
  return null;
}

// ----- Daily-edition choreography probes --------------------------------------
//
// "Did my morning happen" without reading the daily note. Two read-only,
// idempotent probes over the run ledger + the working tree, normative at
// docs/wiki/specs/daily-surface.md §"Doctor choreography findings". Never an
// error: the edition's absence is degradation, not corruption.

/**
 * The two daily-edition findings:
 *
 * - `daily.edition-not-compiled` (warning) — the brief is enabled, its cron
 *   time has passed today, the ledger has no brief run started today, and
 *   the ledger DOES record a brief run on some earlier day (the pipeline was
 *   alive before — this is a recovery signal, not an onboarding nag; a
 *   freshly enabled vault stays quiet until its first morning lands). The
 *   usual cause is a stopped host (cron fires only while `dome serve` runs)
 *   or a sick model provider.
 * - `daily.calendar-source-missing` (info) — `sources/calendar/<date>.md`
 *   is absent for BOTH of the brief's two most recent run days. One missing
 *   day is normal; two ledger-evidenced agenda-less mornings suggest the
 *   vault-side calendar fetcher (vault-layout's recipe) is not wired or has
 *   stopped. Cheap-derivation call: "existed at brief time" is approximated
 *   by "exists in the working tree now" — calendar files are committed feeds
 *   and essentially never backfilled, and a backfill self-heals the finding,
 *   which is acceptable at info severity. "Consecutive days" means the two
 *   most recent RUN days, not wall-calendar days, so a host that was off for
 *   a day neither manufactures nor suppresses the signal.
 */
