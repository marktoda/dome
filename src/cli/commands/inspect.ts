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
//   - `--limit N` caps the row count. Default 20. Applied at the SQL
//     layer for `runs`; for the projection / outbox surfaces (which
//     don't take a `limit` arg in the current query API) the cap is
//     applied post-fetch via array slicing.
//   - `--json` emits structured rows.
//
// Renamed from the pre-recut `dome doctor --show <subject>` in the v1.0
// CLI surface recut (per cli.md §"dome inspect"). The previous
// `dome doctor` namespace is reserved for the v1.x health-check verb;
// this surface is the read half.

import { resolve } from "node:path";

import { openVaultRuntime, type VaultRuntime } from "../../engine/vault-runtime";
import { queryRuns } from "../../ledger/runs";
import { queryDiagnostics } from "../../projections/diagnostics";
import { queryQuestionRecords } from "../../projections/questions";
import { queryOutbox } from "../../outbox/dispatch";

import { resolveShippedBundlesRoot } from "./sync-shared";

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

export type RunInspectOptions = {
  readonly subject?: string | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly limit?: string | number | boolean | undefined;
  readonly json?: boolean | undefined;
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

  // Default `bundlesRoot` is the SDK's shipped first-party bundles.
  // Override via `--bundles-root <path>` for vault-local third-party
  // bundles or testing.
  const bundlesRoot = options.bundlesRoot ?? resolveShippedBundlesRoot();
  const runtimeResult = await openVaultRuntime({ vaultPath, bundlesRoot });
  if (!runtimeResult.ok) {
    console.error(
      `dome inspect: openVaultRuntime failed (${runtimeResult.error.kind}). Run \`dome init\` first to initialize the vault.`,
    );
    return 1;
  }
  const runtime = runtimeResult.value;

  try {
    let rows: ReadonlyArray<Row>;
    try {
      rows = collectRows(subject, runtime, limit);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `dome inspect ${subject}: state read failed. The operational database may be corrupt: ${msg}`,
      );
      return 1;
    }
    if (options.json === true) {
      console.log(formatJson(rows));
    } else {
      console.log(`dome inspect ${subject}:`);
      console.log(formatTable(rows));
    }
    return 0;
  } finally {
    await runtime.close();
  }
}

// ----- internals ------------------------------------------------------------

type Row = Record<string, unknown>;

/**
 * Dispatch on the subject. Each branch queries the relevant surface and
 * projects to a flat `Record<string, unknown>` shape suitable for table
 * rendering (no nested objects in the displayed columns).
 *
 * The subject is already narrowed to one of the four valid strings.
 */
function collectRows(
  subject: string,
  runtime: VaultRuntime,
  limit: number,
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
      const all = queryDiagnostics(runtime.projectionDb);
      return all.slice(0, limit).map((d) => ({
        severity: d.severity,
        code: d.code,
        message: d.message,
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
