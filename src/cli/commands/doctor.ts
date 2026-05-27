// cli/commands/doctor: the `dome doctor --show <subject>` command.
//
// Per [[wiki/specs/cli]] §"dome doctor", the full surface has many
// subjects (`runs`, `cost`, `outbox`, `diagnostics`, `questions`,
// `orphan-runs`, `recent-activity`, `recent-processor-divergence`) plus
// repair flags. Phase 9 ships the four read-only subjects backed by
// existing v1 query surfaces:
//
//   - `--show runs`        → `queryRuns(ledger, { limit })`
//   - `--show diagnostics` → `queryDiagnostics(projection)`
//   - `--show questions`   → `queryQuestions(projection)`
//   - `--show outbox`      → `queryOutbox(outbox)`
//
// Read-only: this command opens the runtime (so the three DBs are
// initialized) but does not submit a Proposal. Exit codes:
//   - 0 always on a clean read — including empty result sets.
//   - 1 on runtime-open failure.
//   - 64 on usage error (unknown subject, missing --show).
//
// House-style notes:
//   - `--limit N` caps the row count. Default 20. Applied at the SQL
//     layer for `runs`; for the projection / outbox surfaces (which
//     don't take a `limit` arg in the current query API) the cap is
//     applied post-fetch via array slicing.
//   - `--json` emits structured rows.

import { resolve } from "node:path";

import { openVaultRuntime, type VaultRuntime } from "../../engine/vault-runtime";
import { queryRuns } from "../../ledger/runs";
import { queryDiagnostics } from "../../projections/diagnostics";
import { queryQuestions } from "../../projections/questions";
import { queryOutbox } from "../../outbox/dispatch";

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

// ----- runDoctor ------------------------------------------------------------

/**
 * Execute `dome doctor --show <subject>`. Returns the exit code.
 */
export async function runDoctor(args: ParsedArgs): Promise<number> {
  const showFlag = args.flags["show"];
  if (typeof showFlag !== "string") {
    console.error(
      "dome doctor: --show <subject> is required. Subjects: runs, diagnostics, questions, outbox.",
    );
    return 64;
  }
  if (!VALID_SUBJECTS.has(showFlag)) {
    console.error(
      `dome doctor: unknown subject '${showFlag}'. Available: runs, diagnostics, questions, outbox.`,
    );
    return 64;
  }

  const vaultFlag = args.flags["vault"];
  const vaultPath = resolve(
    typeof vaultFlag === "string" ? vaultFlag : process.cwd(),
  );

  const limit = parseLimit(args.flags["limit"]);
  if (limit === null) {
    console.error(
      "dome doctor: --limit must be a positive integer.",
    );
    return 64;
  }

  const bundlesRootFlag = args.flags["bundles-root"];
  const bundlesRoot =
    typeof bundlesRootFlag === "string"
      ? bundlesRootFlag
      : `${vaultPath}/.dome/extensions`;
  const runtimeResult = await openVaultRuntime({ vaultPath, bundlesRoot });
  if (!runtimeResult.ok) {
    console.error(
      `dome doctor: openVaultRuntime failed (${runtimeResult.error.kind}). Make sure ${vaultPath}/.dome/extensions/ exists (run \`dome init\` first).`,
    );
    return 1;
  }
  const runtime = runtimeResult.value;

  try {
    const rows = collectRows(showFlag, runtime, limit);
    if (args.flags["json"] === true) {
      console.log(formatJson(rows));
    } else {
      console.log(`dome doctor --show ${showFlag}:`);
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
