// cli/commands/inspect: the `dome inspect <subject>` command.
//
// Per [[wiki/specs/cli]] §"dome inspect <subject>", `dome inspect` is the
// read-only view over the operational substrate. It opens the runtime
// (so the operational databases are initialized) but does not submit a
// Proposal, does not invoke any processor, and does not mutate state.
//
// v1.0 ships four subjects backed by existing query surfaces:
//
//   - `runs`        → `queryRuns(ledger, { limit })`
//   - `diagnostics` → `queryDiagnostics(projection)`
//   - `questions`   → `queryQuestionRecords(projection)`
//   - `outbox`      → `queryOutbox(outbox)`
//   - `quarantine`  → `executionState.quarantines()`
//
// Exit codes:
//   - 0 always on a clean read — including empty result sets.
//   - 1 on runtime-open failure.
//   - 64 on usage error (unknown subject, missing positional).
//
// House-style notes:
//   - `--limit N` caps the row or summary group count. Default 20.
//     Applied at the SQL layer for `runs`; for the projection / outbox
//     surfaces (which don't take a `limit` arg in the current query API)
//     the cap is applied post-fetch via array slicing.
//   - `diagnostics --summary` groups unresolved diagnostics by severity/code
//     so noisy real vaults have a first-glance triage view.
//   - `--json` emits structured rows.
//
// Renamed from the pre-recut `dome doctor --show <subject>` in the v1.0
// CLI surface recut (per cli.md §"dome inspect"). The previous
// `dome doctor` namespace is reserved for the v1.x health-check verb;
// this surface is the read half.

import { resolve } from "node:path";

import { openVaultRuntime, type VaultRuntime } from "../../engine/vault-runtime";
import { queryRuns } from "../../ledger/runs";
import {
  queryDiagnostics,
  type DiagnosticsFilter,
} from "../../projections/diagnostics";
import { queryQuestionRecords } from "../../projections/questions";
import { queryOutbox } from "../../outbox/dispatch";

import { resolveBundleRoots } from "./sync-shared";

import { formatJson, formatTable } from "../format";
import { parsePositiveIntegerValue } from "../parse-options";

// ----- Constants ------------------------------------------------------------

const DEFAULT_LIMIT = 20;
const VALID_SUBJECTS = new Set<string>([
  "runs",
  "diagnostics",
  "questions",
  "outbox",
  "quarantine",
]);
const VALID_DIAGNOSTIC_SEVERITIES = new Set([
  "info",
  "warning",
  "error",
  "block",
] as const);
const SEVERITY_RANK: Record<DiagnosticSeverity, number> = {
  block: 0,
  error: 1,
  warning: 2,
  info: 3,
};

export type RunInspectOptions = {
  readonly subject?: string | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly limit?: string | number | boolean | undefined;
  readonly json?: boolean | undefined;
  readonly summary?: boolean | undefined;
  readonly severity?: string | undefined;
  readonly code?: string | undefined;
  readonly processor?: string | undefined;
};

// ----- runInspect --------------------------------------------------------------

/**
 * Execute `dome inspect <subject>`. Returns the exit code.
 *
 * Subject comes from Commander's required positional argument. No flag-based
 * subject is accepted; the previous `--show <subject>` spelling is retired
 * in the recut.
 */
export async function runInspect(
  options: RunInspectOptions = {},
): Promise<number> {
  const subject = options.subject;
  if (typeof subject !== "string" || subject.length === 0) {
    console.error(
      "dome inspect: subject is required. Subjects: runs, diagnostics, questions, outbox, quarantine.",
    );
    return 64;
  }
  if (!VALID_SUBJECTS.has(subject)) {
    console.error(
      `dome inspect: unknown subject '${subject}'. Available: runs, diagnostics, questions, outbox, quarantine.`,
    );
    return 64;
  }

  const vaultPath = resolve(options.vault ?? process.cwd());

  const limit = parseLimit(options.limit);
  if (limit === null) {
    console.error("dome inspect: --limit must be a positive integer.");
    return 64;
  }
  const diagnosticOptions = parseDiagnosticOptions({
    subject,
    ...(options.summary !== undefined ? { summary: options.summary } : {}),
    ...(options.severity !== undefined ? { severity: options.severity } : {}),
    ...(options.code !== undefined ? { code: options.code } : {}),
    ...(options.processor !== undefined ? { processor: options.processor } : {}),
  });
  if (diagnosticOptions.ok === false) {
    console.error(diagnosticOptions.message);
    return 64;
  }

  const bundleRoots = resolveBundleRoots({
    vaultPath,
    bundlesRoot: options.bundlesRoot,
  });
  const runtimeResult = await openVaultRuntime({ vaultPath, ...bundleRoots });
  if (!runtimeResult.ok) {
    console.error(
      `dome inspect: openVaultRuntime failed (${runtimeResult.error.kind}). Run \`dome init\` first to initialize the vault.`,
    );
    return 1;
  }
  const runtime = runtimeResult.value;

  try {
    let result: InspectResult;
    try {
      result = collectInspectResult({
        subject,
        runtime,
        limit,
        diagnosticOptions: diagnosticOptions.value,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `dome inspect ${subject}: state read failed. The operational database may be corrupt: ${msg}`,
      );
      return 1;
    }
    if (options.json === true) {
      console.log(formatJson(jsonForResult(result)));
    } else {
      printTextResult(subject, result);
    }
    return 0;
  } finally {
    await runtime.close();
  }
}

// ----- internals ------------------------------------------------------------

type Row = Record<string, unknown>;
type DiagnosticSeverity = "info" | "warning" | "error" | "block";
type ParsedDiagnosticOptions = {
  readonly summary: boolean;
  readonly filter: DiagnosticsFilter;
  readonly code?: string;
};
type ParseDiagnosticOptionsResult =
  | { readonly ok: true; readonly value: ParsedDiagnosticOptions | null }
  | { readonly ok: false; readonly message: string };

type DiagnosticGroup = {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly count: number;
  readonly first_message: string;
  readonly first_source_refs: string;
};

type DiagnosticSummary = {
  readonly total: number;
  readonly group_count: number;
  readonly shown_groups: number;
  readonly groups: ReadonlyArray<DiagnosticGroup>;
};

type InspectResult =
  | { readonly kind: "rows"; readonly rows: ReadonlyArray<Row> }
  | { readonly kind: "diagnostic-summary"; readonly summary: DiagnosticSummary };

/**
 * Dispatch on the subject. Each branch queries the relevant surface and
 * projects to a flat `Record<string, unknown>` shape suitable for table
 * rendering (no nested objects in the displayed columns).
 *
 * The subject is already narrowed to one of the four valid strings.
 */
function collectInspectResult(opts: {
  readonly subject: string;
  readonly runtime: VaultRuntime;
  readonly limit: number;
  readonly diagnosticOptions: ParsedDiagnosticOptions | null;
}): InspectResult {
  if (
    opts.subject === "diagnostics" &&
    opts.diagnosticOptions?.summary === true
  ) {
    return {
      kind: "diagnostic-summary",
      summary: summarizeDiagnostics(
        opts.runtime,
        opts.limit,
        opts.diagnosticOptions,
      ),
    };
  }
  return {
    kind: "rows",
    rows: collectRows(
      opts.subject,
      opts.runtime,
      opts.limit,
      opts.diagnosticOptions,
    ),
  };
}

function collectRows(
  subject: string,
  runtime: VaultRuntime,
  limit: number,
  diagnosticOptions: ParsedDiagnosticOptions | null,
): ReadonlyArray<Row> {
  switch (subject) {
    case "runs": {
      const runs = queryRuns(runtime.ledgerDb, { limit });
      return runs.map((r) => ({
        id: r.id,
        processor: r.processorId,
        phase: r.phase,
        status: r.status,
        started_at: r.startedAt,
        duration_ms: r.durationMs,
        proposal: r.proposalId,
      }));
    }
    case "diagnostics": {
      const all = filteredDiagnostics(runtime, diagnosticOptions);
      return all.slice(0, limit).map((d) => ({
        severity: d.severity,
        code: d.code,
        message: d.message,
        source_refs: formatSourceRefs(d.sourceRefs),
      }));
    }
    case "questions": {
      const all = queryQuestionRecords(runtime.projectionDb);
      return all.slice(0, limit).map((q) => ({
        id: q.id,
        status: q.answeredAt === null ? "open" : "answered",
        question: q.effect.question,
        options: q.effect.options ?? "-",
        answer: q.answer ?? "-",
        asked_at: q.askedAt,
        answered_at: q.answeredAt ?? "-",
        idempotency_key: q.effect.idempotencyKey,
      }));
    }
    case "outbox": {
      const all = queryOutbox(runtime.outboxDb);
      return all.slice(0, limit).map((o) => ({
        id: o.id,
        capability: o.capability,
        status: o.status,
        attempts: o.attempts,
        enqueued_at: o.enqueuedAt,
        next_attempt_at: o.nextAttemptAt,
        last_error: o.lastError,
      }));
    }
    case "quarantine": {
      const all = runtime.processorRuntime.executionState.quarantines();
      return all.slice(0, limit).map((q) => ({
        phase: q.key.phase,
        processor: q.key.processorId,
        version: q.key.processorVersion,
        trigger_hash: q.key.triggerHash,
        quarantine_id: q.quarantineId,
        failures: q.consecutiveRetryableFailures,
        quarantined_at: q.quarantinedAt.toISOString(),
        reason: q.reason,
      }));
    }
    default:
      // Unreachable — VALID_SUBJECTS guard above enforces this.
      return [];
  }
}

function summarizeDiagnostics(
  runtime: VaultRuntime,
  limit: number,
  diagnosticOptions: ParsedDiagnosticOptions,
): DiagnosticSummary {
  const diagnostics = filteredDiagnostics(runtime, diagnosticOptions);
  const grouped = new Map<string, DiagnosticGroup>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.severity}\u0000${diagnostic.code}`;
    const existing = grouped.get(key);
    if (existing !== undefined) {
      grouped.set(key, {
        ...existing,
        count: existing.count + 1,
      });
      continue;
    }
    grouped.set(key, {
      severity: diagnostic.severity,
      code: diagnostic.code,
      count: 1,
      first_message: diagnostic.message,
      first_source_refs: formatSourceRefs(diagnostic.sourceRefs),
    });
  }

  const groups = [...grouped.values()].sort(compareDiagnosticGroups);
  return Object.freeze({
    total: diagnostics.length,
    group_count: groups.length,
    shown_groups: Math.min(limit, groups.length),
    groups: Object.freeze(groups.slice(0, limit)),
  });
}

function filteredDiagnostics(
  runtime: VaultRuntime,
  diagnosticOptions: ParsedDiagnosticOptions | null,
): ReturnType<typeof queryDiagnostics> {
  const diagnostics = queryDiagnostics(
    runtime.projectionDb,
    diagnosticOptions?.filter,
  );
  const code = diagnosticOptions?.code;
  if (code === undefined) return diagnostics;
  return Object.freeze(diagnostics.filter((d) => d.code === code));
}

function compareDiagnosticGroups(
  a: DiagnosticGroup,
  b: DiagnosticGroup,
): number {
  if (b.count !== a.count) return b.count - a.count;
  if (SEVERITY_RANK[a.severity] !== SEVERITY_RANK[b.severity]) {
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  }
  return a.code.localeCompare(b.code);
}

function jsonForResult(
  result: InspectResult,
): ReadonlyArray<Row> | DiagnosticSummary {
  return result.kind === "rows" ? result.rows : result.summary;
}

function printTextResult(subject: string, result: InspectResult): void {
  if (result.kind === "rows") {
    console.log(`dome inspect ${subject}:`);
    console.log(formatTable(result.rows));
    return;
  }
  console.log("dome inspect diagnostics summary:");
  console.log(
    `total ${result.summary.total} | groups ${result.summary.shown_groups}/${result.summary.group_count}`,
  );
  console.log(formatTable(result.summary.groups));
}

function parseDiagnosticOptions(opts: {
  readonly subject: string;
  readonly summary?: boolean;
  readonly severity?: string;
  readonly code?: string;
  readonly processor?: string;
}): ParseDiagnosticOptionsResult {
  const hasDiagnosticOption =
    opts.summary === true ||
    opts.severity !== undefined ||
    opts.code !== undefined ||
    opts.processor !== undefined;
  if (!hasDiagnosticOption) {
    return { ok: true, value: null };
  }
  if (opts.subject !== "diagnostics") {
    return {
      ok: false,
      message:
        "dome inspect: --summary, --severity, --code, and --processor are only valid for the diagnostics subject.",
    };
  }

  let severity: DiagnosticSeverity | undefined;
  if (opts.severity !== undefined) {
    if (!isDiagnosticSeverity(opts.severity)) {
      return {
        ok: false,
        message:
          "dome inspect diagnostics: --severity must be one of info, warning, error, block.",
      };
    }
    severity = opts.severity;
  }

  return {
    ok: true,
    value: {
      summary: opts.summary === true,
      filter: {
        ...(severity !== undefined ? { severity } : {}),
        ...(opts.processor !== undefined ? { processorId: opts.processor } : {}),
      },
      ...(opts.code !== undefined ? { code: opts.code } : {}),
    },
  };
}

function isDiagnosticSeverity(value: string): value is DiagnosticSeverity {
  return VALID_DIAGNOSTIC_SEVERITIES.has(value as DiagnosticSeverity);
}

function formatSourceRefs(
  refs: ReadonlyArray<{
    readonly path: string;
    readonly commit?: string;
    readonly range?: {
      readonly startLine: number;
      readonly endLine: number;
    };
  }>,
): string {
  if (refs.length === 0) return "-";
  return refs.map(formatSourceRef).join(", ");
}

function formatSourceRef(ref: {
  readonly path: string;
  readonly commit?: string;
  readonly range?: {
    readonly startLine: number;
    readonly endLine: number;
  };
}): string {
  const range =
    ref.range === undefined
      ? ""
      : ref.range.endLine === ref.range.startLine
        ? `:${ref.range.startLine}`
        : `:${ref.range.startLine}-${ref.range.endLine}`;
  const commit = ref.commit === undefined ? "" : ` @ ${ref.commit.slice(0, 7)}`;
  return `${ref.path}${range}${commit}`;
}

/**
 * Parse the `--limit` flag. Returns the default when absent, the parsed
 * integer when valid, or `null` on a malformed value (caller treats as
 * usage error).
 */
function parseLimit(
  raw: string | number | boolean | undefined,
): number | null {
  return parsePositiveIntegerValue(raw, DEFAULT_LIMIT);
}
