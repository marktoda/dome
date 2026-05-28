// cli/commands/show: the `dome show <subject>` command.
//
// Per [[wiki/specs/cli]] §"dome show <subject>", `dome show` is the
// read-only view over the operational substrate. It opens the runtime
// (so the three databases are initialized) but does not submit a
// Proposal, does not invoke any processor, and does not mutate state.
//
// v1.0 ships four subjects backed by existing query surfaces:
//
//   - `runs`        → `queryRuns(ledger, { limit })`
//   - `diagnostics` → `queryDiagnostics(projection)`
//   - `questions`   → `queryQuestions(projection)`
//   - `outbox`      → `queryOutbox(outbox)`
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
// Renamed from `dome doctor --show <subject>` in the v1.0 CLI surface
// recut (per cli.md §"dome show"). The previous `dome doctor` namespace
// is reserved for the v1.x health-check verb; this surface is the read
// half.

import { resolve } from "node:path";

import { openVaultRuntime, type VaultRuntime } from "../../engine/vault-runtime";
import { queryRuns } from "../../ledger/runs";
import { queryDiagnostics } from "../../projections/diagnostics";
import { queryQuestions } from "../../projections/questions";
import { queryOutbox } from "../../outbox/dispatch";

import { resolveShippedBundlesRoot } from "./sync-shared";

import type { ParsedArgs } from "../args";
import { formatJson, formatTable } from "../format";

// ----- Constants ------------------------------------------------------------

const DEFAULT_LIMIT = 20;
const VALID_SUBJECTS = new Set<string>([
  "runs",
  "diagnostics",
  "questions",
  "outbox",
]);

// ----- runShow --------------------------------------------------------------

/**
 * Execute `dome show <subject>`. Returns the exit code.
 *
 * Subject is the first positional argument (`args.positionals[0]`).
 * No flag-based subject is accepted; the previous `--show <subject>`
 * spelling is retired in the recut.
 */
export async function runShow(args: ParsedArgs): Promise<number> {
  const subject = args.positionals[0];
  if (typeof subject !== "string" || subject.length === 0) {
    console.error(
      "dome show: subject is required. Subjects: runs, diagnostics, questions, outbox.",
    );
    return 64;
  }
  if (!VALID_SUBJECTS.has(subject)) {
    console.error(
      `dome show: unknown subject '${subject}'. Available: runs, diagnostics, questions, outbox.`,
    );
    return 64;
  }

  const vaultFlag = args.flags["vault"];
  const vaultPath = resolve(
    typeof vaultFlag === "string" ? vaultFlag : process.cwd(),
  );

  const limit = parseLimit(args.flags["limit"]);
  if (limit === null) {
    console.error("dome show: --limit must be a positive integer.");
    return 64;
  }

  // Default `bundlesRoot` is the SDK's shipped first-party bundles.
  // Override via `--bundles-root <path>` for vault-local third-party
  // bundles or testing.
  const bundlesRootFlag = args.flags["bundles-root"];
  const bundlesRoot =
    typeof bundlesRootFlag === "string"
      ? bundlesRootFlag
      : resolveShippedBundlesRoot();
  const runtimeResult = await openVaultRuntime({ vaultPath, bundlesRoot });
  if (!runtimeResult.ok) {
    console.error(
      `dome show: openVaultRuntime failed (${runtimeResult.error.kind}). Run \`dome init\` first to initialize the vault.`,
    );
    return 1;
  }
  const runtime = runtimeResult.value;

  try {
    const rows = collectRows(subject, runtime, limit);
    if (args.flags["json"] === true) {
      console.log(formatJson(rows));
    } else {
      console.log(`dome show ${subject}:`);
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
      const all = queryQuestions(runtime.projectionDb);
      return all.slice(0, limit).map((q) => ({
        idempotency_key: q.idempotencyKey,
        question: q.question,
        options: q.options ?? "-",
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
        last_error: o.lastError,
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
function parseLimit(raw: string | boolean | undefined): number | null {
  if (raw === undefined || raw === true) return DEFAULT_LIMIT;
  if (raw === false) return null;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) return null;
  return n;
}
