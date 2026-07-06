// proposals/pending-proposals: per-row accessors for the pending-proposals
// store (`proposals.db`). Garden-phase processors emit `PatchEffect`s under
// `mode: "propose"`; the engine's propose-mode sink enqueues one row per
// distinct (processorId, changes) pair here, and the CLI/HTTP/MCP surfaces
// (later tasks) drive the human apply/reject decision against these rows.
//
// Dedup: `proposalDedupeKey` hashes the processor id + the change set (order
// -independent — changes are sorted by path before hashing), so a
// re-emission of the identical patch (e.g. a garden run replayed after a
// crash, or re-triggered before the owner has reviewed the first proposal)
// does not create a second row. `enqueuePendingProposal` relies on
// `INSERT OR IGNORE` against the `dedupe_key` UNIQUE constraint for this.
//
// That same mechanism means a DECIDED row is sticky against re-emission: once
// a proposal is rejected (or applied), a later emission of the identical
// patch still collides on the same dedupe key and is silently ignored — the
// row stays `rejected`/`applied`, it does not reset to `pending`. This is
// intentional: a rejected proposal is a decision the owner already made, and
// garden re-runs should not re-nag them with a patch they turned down. A
// processor that wants a fresh decision must propose different content
// (which changes the dedupe key).
//
// A dedupe-hit against a still-PENDING row is different: the processor read
// the CURRENT working-tree snapshot to produce this (identical) patch, so its
// re-emission means "these changes, against today's base" — not "today's
// base equals whatever the first emission saw." `enqueuePendingProposal`
// refreshes that row's `base_contents_json`/`base_commit` in place (leaving
// `created_at`, `dedupe_key`, `status`, and `changes_json` untouched) so the
// owner's later `dome apply` staleness check compares against the current
// tree instead of wedging permanently stale. This is the "stale-pending
// wedge" fix; see `EnqueuePendingProposalResult.refreshed`.

import type { FileChange } from "../core/effect";
import type { SourceRef } from "../core/source-ref";
import { mapRows } from "../sqlite/rows";
import type { ProposalsDb } from "./db";

export type ProposalStatus = "pending" | "applied" | "rejected";

export type PendingProposalRow = {
  readonly id: number;
  readonly dedupeKey: string;
  readonly processorId: string;
  readonly extensionId: string;
  readonly runId: string | null;
  readonly reason: string;
  readonly changes: ReadonlyArray<FileChange>;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
  readonly baseCommit: string;
  /** path → full file content at enqueue time (null = file absent then). Drives staleness + diff rendering. */
  readonly baseContents: Readonly<Record<string, string | null>>;
  readonly createdAt: string; // ISO
  readonly status: ProposalStatus;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly appliedCommit: string | null;
  readonly note: string | null;
};

export type EnqueuePendingProposalInput = Omit<
  PendingProposalRow,
  "id" | "dedupeKey" | "status" | "decidedAt" | "decidedBy" | "appliedCommit" | "note"
>;

export type EnqueuePendingProposalResult = {
  readonly inserted: boolean;
  /**
   * True when this call hit an existing **pending** row's dedupe key and
   * refreshed its recorded `baseContents`/`baseCommit` in place (the
   * stale-pending wedge fix — see the module header's "refresh" paragraph).
   * False for a fresh insert, and false for a dedupe-hit against an
   * `applied`/`rejected` row (those stay decided, untouched).
   */
  readonly refreshed: boolean;
  readonly id: number | null;
};

export type DecideProposalInput = {
  readonly id: number;
  readonly status: "applied" | "rejected";
  readonly decidedBy: string;
  readonly appliedCommit?: string;
  readonly note?: string;
  readonly decidedAt: string;
};

const INSERT_SQL = `
INSERT OR IGNORE INTO pending_proposals (
  dedupe_key, processor_id, extension_id, run_id, reason,
  changes_json, source_refs_json, base_commit, base_contents_json, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`.trim();

const SELECT_ID_STATUS_BY_DEDUPE_KEY_SQL = `
SELECT id, status FROM pending_proposals WHERE dedupe_key = ?
`.trim();

const REFRESH_BASE_SQL = `
UPDATE pending_proposals
SET base_contents_json = ?, base_commit = ?, created_at = created_at
WHERE id = ? AND status = 'pending'
`.trim();

const SELECT_COLUMNS = `
  id, dedupe_key, processor_id, extension_id, run_id, reason,
  changes_json, source_refs_json, base_commit, base_contents_json,
  created_at, status, decided_at, decided_by, applied_commit, note
`.trim();

const SELECT_BY_ID_SQL = `
SELECT ${SELECT_COLUMNS} FROM pending_proposals WHERE id = ?
`.trim();

const DECIDE_SQL = `
UPDATE pending_proposals
SET status = ?, decided_at = ?, decided_by = ?, applied_commit = ?, note = ?
WHERE id = ? AND status = 'pending'
`.trim();

/**
 * Stable, order-independent identity for a processor's proposed change set.
 * `new Bun.CryptoHasher("sha256")` over `processorId`, then for each change
 * — sorted by `path` so the processor's emission order doesn't affect the
 * key — `kind`, `path`, and (`content` for writes, empty string for
 * deletes). Two proposals with the same key are the same patch; see the
 * module header for how `enqueuePendingProposal` uses this for dedup.
 */
export function proposalDedupeKey(
  processorId: string,
  changes: ReadonlyArray<FileChange>,
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(processorId);
  hasher.update(" ");
  const sorted = [...changes].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  for (const change of sorted) {
    hasher.update(change.kind);
    hasher.update(" ");
    hasher.update(change.path);
    hasher.update(" ");
    hasher.update(change.kind === "write" ? change.content : "");
  }
  return hasher.digest("hex");
}

/**
 * Enqueue a garden-proposed patch. `INSERT OR IGNORE` on the `dedupe_key`
 * UNIQUE constraint: a re-emission of the identical (processorId, changes)
 * pair against an already-DECIDED row (`applied`/`rejected`) is a pure no-op
 * — `{inserted: false, refreshed: false, id: <the existing row's id>}` — per
 * the module header's "stays decided" rationale. A re-emission that dedupe-
 * hits a still-PENDING row instead refreshes that row's recorded
 * `baseContents`/`baseCommit` from this call's input (the "stale-pending
 * wedge" fix — module header) and returns `{inserted: false, refreshed:
 * true, id}`. Transactional: the insert attempt, the dedupe-key lookup, and
 * the conditional refresh all run inside one `db.raw.transaction`.
 */
export function enqueuePendingProposal(
  db: ProposalsDb,
  input: EnqueuePendingProposalInput,
): EnqueuePendingProposalResult {
  const dedupeKey = proposalDedupeKey(input.processorId, input.changes);
  const run = db.raw.transaction(
    (): EnqueuePendingProposalResult => {
      const inserted = db.raw.query(INSERT_SQL).run(
        dedupeKey,
        input.processorId,
        input.extensionId,
        input.runId,
        input.reason,
        JSON.stringify(input.changes),
        JSON.stringify(input.sourceRefs),
        input.baseCommit,
        JSON.stringify(input.baseContents),
        input.createdAt,
      );
      if (inserted.changes > 0) {
        return { inserted: true, refreshed: false, id: Number(inserted.lastInsertRowid) };
      }

      const existing = db.raw
        .query<{ id: number; status: string }, [string]>(
          SELECT_ID_STATUS_BY_DEDUPE_KEY_SQL,
        )
        .get(dedupeKey);
      if (existing === null) {
        return { inserted: false, refreshed: false, id: null };
      }
      if (existing.status !== "pending") {
        return { inserted: false, refreshed: false, id: existing.id };
      }

      db.raw.query(REFRESH_BASE_SQL).run(
        JSON.stringify(input.baseContents),
        input.baseCommit,
        existing.id,
      );
      return { inserted: false, refreshed: true, id: existing.id };
    },
  );
  return Object.freeze(run());
}

/**
 * List proposals, optionally filtered by status, newest-first
 * (`created_at DESC`, `id DESC` as the tiebreak for same-timestamp rows).
 */
export function listProposals(
  db: ProposalsDb,
  filter?: { readonly status?: ProposalStatus; readonly limit?: number },
): ReadonlyArray<PendingProposalRow> {
  const status = filter?.status;
  const limit = filter?.limit;
  let sql = `SELECT ${SELECT_COLUMNS} FROM pending_proposals`;
  const params: Array<string | number> = [];
  if (status !== undefined) {
    sql += " WHERE status = ?";
    params.push(status);
  }
  sql += " ORDER BY created_at DESC, id DESC";
  if (limit !== undefined) {
    sql += " LIMIT ?";
    params.push(limit);
  }
  const rows = db.raw
    .query<PendingProposalRawRow, Array<string | number>>(sql)
    .all(...params);
  return mapRows(rows, rowToProposal);
}

export function getProposal(db: ProposalsDb, id: number): PendingProposalRow | null {
  const row = db.raw
    .query<PendingProposalRawRow, [number]>(SELECT_BY_ID_SQL)
    .get(id);
  return row === null ? null : rowToProposal(row);
}

/**
 * Compare-and-swap the decision onto a pending row: `UPDATE ... WHERE id = ?
 * AND status = 'pending'`. Returns `true` when exactly one row was updated
 * (the row was pending), `false` when it wasn't (already decided, or the id
 * doesn't exist) — the caller treats `false` as "nothing to do," not an
 * error.
 */
export function decideProposal(db: ProposalsDb, input: DecideProposalInput): boolean {
  const result = db.raw.query(DECIDE_SQL).run(
    input.status,
    input.decidedAt,
    input.decidedBy,
    input.appliedCommit ?? null,
    input.note ?? null,
    input.id,
  );
  return result.changes === 1;
}

// ----- internals -------------------------------------------------------------

type PendingProposalRawRow = {
  readonly id: number;
  readonly dedupe_key: string;
  readonly processor_id: string;
  readonly extension_id: string;
  readonly run_id: string | null;
  readonly reason: string;
  readonly changes_json: string;
  readonly source_refs_json: string;
  readonly base_commit: string;
  readonly base_contents_json: string;
  readonly created_at: string;
  readonly status: string;
  readonly decided_at: string | null;
  readonly decided_by: string | null;
  readonly applied_commit: string | null;
  readonly note: string | null;
};

function rowToProposal(row: PendingProposalRawRow): PendingProposalRow {
  return Object.freeze({
    id: row.id,
    dedupeKey: row.dedupe_key,
    processorId: row.processor_id,
    extensionId: row.extension_id,
    runId: row.run_id,
    reason: row.reason,
    changes: JSON.parse(row.changes_json) as ReadonlyArray<FileChange>,
    sourceRefs: JSON.parse(row.source_refs_json) as ReadonlyArray<SourceRef>,
    baseCommit: row.base_commit,
    baseContents: JSON.parse(row.base_contents_json) as Readonly<
      Record<string, string | null>
    >,
    createdAt: row.created_at,
    status: parseStatus(row.status),
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    appliedCommit: row.applied_commit,
    note: row.note,
  });
}

function parseStatus(value: string): ProposalStatus {
  if (value === "applied" || value === "rejected") return value;
  return "pending";
}
