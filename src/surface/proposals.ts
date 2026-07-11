// surface/proposals: the human-side decision surface for garden propose-mode
// patches — the third remote-write operation beside `performCapture` and
// `performSettle` (docs/wiki/specs/task-lifecycle.md; the review loop's
// architecture note in docs/superpowers/plans/2026-07-06-product-review-4-tier1.md
// §"Task 5").
//
// A garden processor's `PatchEffect` under `mode: "propose"` is enqueued as a
// durable row in `proposals.db` by the engine sink (Task 3); this file never
// touches that sink or the engine. It only reads the durable store and, on
// `performApply`, writes the working tree and lands ONE ordinary human commit
// via `commitFilesOnHead` — exactly the settle pattern. The daemon constructs
// the Proposal from the resulting branch drift like any other terminal
// capture (PROPOSALS_ARE_THE_ONLY_WRITE_PATH); this seam never calls the
// engine, never writes projections, never opens the runtime.
//
//   - collectProposals → read-only list view (`ProposalView[]`), computing
//     `stale` (any change's path drifted from its recorded `baseContents`
//     since enqueue) and a lightweight `diffStat` for display.
//   - performApply     → staleness check (working tree vs `baseContents`) →
//     write/delete every eligible change → ONE commit → CAS the row to
//     `applied`. Delete-changes remove the path from the working tree and
//     pass a `content: null` entry to `commitFilesOnHead` (tree removal). A
//     delete whose working file is already absent is treated as already
//     satisfied — skipped, not stale — so a proposal that is entirely
//     already-satisfied deletes applies with no commit (mirrors
//     `performSettle`'s `keep`).
//   - performReject    → CAS the row to `rejected`. Touches no files.
//
// Mutation-boundary note: like `src/surface/capture.ts` and
// `src/surface/settle.ts`, this is the human-side write path at the compiler
// boundary — an edit + `git commit` in one verb, not an engine write path.
// Whitelisted in `tests/integration/no-direct-mutation-outside-boundaries.test.ts`.
//
// `performApply` opens `proposals.db` read-write from the surface process;
// the daemon (via `vault-runtime.ts`) may also hold the same file open at the
// same time. SQLite's own locking handles the concurrency — transactions
// here are short (a single CAS `UPDATE`), and the handle is always closed in
// a `finally` so it never lingers across the write.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { FileChange } from "../core/effect";
import { commitFilesOnHead, currentBranch, currentSha, findGitRoot } from "../git";
import { openProposalsDb } from "../proposals/db";
import {
  decideProposal,
  getProposal,
  listProposals,
  type PendingProposalRow,
  type ProposalStatus,
} from "../proposals/pending-proposals";
import { lineDiffStat } from "../proposals/diff-stat";
import { resolveVaultPath } from "./resolve-vault";

// ----- Public types ----------------------------------------------------------

export const PROPOSALS_SCHEMA = "dome.proposals/v1";
export const APPLY_SCHEMA = "dome.apply/v1";
export const REJECT_SCHEMA = "dome.reject/v1";

export type ProposalView = {
  readonly id: number;
  readonly processorId: string;
  readonly reason: string;
  readonly paths: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly status: ProposalStatus;
  readonly sourceRefs: ReadonlyArray<import("../core/source-ref").SourceRef>;
  /**
   * true when any change's path in the working tree no longer matches the
   * `baseContents` recorded at enqueue time. A delete whose working file is
   * already absent is treated as already-satisfied, not stale.
   */
  readonly stale: boolean;
  readonly diffStat: ReadonlyArray<{
    readonly path: string;
    readonly added: number;
    readonly removed: number;
  }>;
};

export type ApplyResult =
  | {
      readonly status: "applied";
      readonly id: number;
      /**
       * Absent when the proposal was entirely already-satisfied deletes —
       * nothing was left to write or remove, so no commit landed (mirrors
       * `performSettle`'s `keep`).
       */
      readonly commit?: string;
    }
  | {
      readonly status: "stale";
      readonly id: number;
      readonly changedPaths: ReadonlyArray<string>;
      readonly message: string;
    }
  | {
      readonly status: "not-found" | "not-pending" | "invalid";
      readonly message: string;
    };

export type RejectResult =
  | { readonly status: "rejected"; readonly id: number }
  | { readonly status: "not-found" | "not-pending" | "invalid"; readonly message: string };

// ----- collectProposals -------------------------------------------------------

/**
 * List proposals as a `dome.proposals/v1` document body. Defaults to pending
 * rows only; `opts.all` lists every status. Best-effort: an uninitialized (or
 * schema-refused) proposals store yields an empty list rather than throwing —
 * this is a read view, not a write path, and CLI/HTTP/MCP surfaces should
 * render "no proposals" rather than fail their own preconditions here.
 */
export async function collectProposals(
  vault: string,
  opts?: { readonly all?: boolean },
): Promise<{ schema: typeof PROPOSALS_SCHEMA; proposals: ReadonlyArray<ProposalView> }> {
  const vaultPath = resolveVaultPath(vault);
  const opened = await openProposalsDb({ path: proposalsDbPath(vaultPath) });
  if (!opened.ok) {
    return Object.freeze({ schema: PROPOSALS_SCHEMA, proposals: [] });
  }
  const { db } = opened.value;
  try {
    const rows = listProposals(db, opts?.all ? undefined : { status: "pending" });
    const proposals = rows.map((row) => toProposalView(vaultPath, row));
    return Object.freeze({ schema: PROPOSALS_SCHEMA, proposals: Object.freeze(proposals) });
  } finally {
    db.close();
  }
}

// ----- performApply -----------------------------------------------------------

/**
 * Apply a pending proposal's changes as one ordinary human commit — the
 * settle pattern. See the module header for the step-by-step contract:
 * vault preconditions → open store → not-found/not-pending guards →
 * per-change staleness classification → write/delete the eligible changes →
 * commit (skipped when nothing is eligible) → CAS decide. The commit is
 * truth: if the CAS decide races and loses (e.g. the row was concurrently
 * decided elsewhere), the already-landed commit is still reported as
 * `applied`.
 */
export async function performApply(vault: string, id: number): Promise<ApplyResult> {
  const vaultPath = resolveVaultPath(vault);
  const precondition = await checkVaultPreconditions(vaultPath, "applying");
  if (precondition !== null) return invalid(precondition);

  const opened = await openProposalsDb({ path: proposalsDbPath(vaultPath) });
  if (!opened.ok) {
    return invalid(`could not open the proposals store: ${opened.error.kind}`);
  }
  const { db } = opened.value;
  try {
    const row = getProposal(db, id);
    if (row === null) {
      return Object.freeze({
        status: "not-found" as const,
        message: `no proposal with id ${id}`,
      });
    }
    if (row.status !== "pending") {
      return Object.freeze({
        status: "not-pending" as const,
        message: `proposal P${id} is already ${row.status}`,
      });
    }
    // Per-change staleness classification: every change is `eligible`
    // (working content matches the recorded base — safe to apply),
    // `satisfied` (a delete whose working file is already absent — the
    // change already happened, idempotent no-op), or `stale` (working
    // content drifted from base). Any stale change aborts before any write.
    const classified = row.changes.map((change) => ({
      change,
      status: classifyChangeStatus(vaultPath, row, change),
    }));
    const changedPaths = classified
      .filter((c) => c.status === "stale")
      .map((c) => c.change.path);
    if (changedPaths.length > 0) {
      return Object.freeze({
        status: "stale" as const,
        id,
        changedPaths: Object.freeze(changedPaths),
        message: `proposal P${id} is stale: ${changedPaths.join(", ")} changed since it was proposed`,
      });
    }

    const eligible = classified.filter((c) => c.status === "eligible").map((c) => c.change);
    const writes = eligible.filter(
      (change): change is Extract<FileChange, { kind: "write" }> => change.kind === "write",
    );
    const deletes = eligible.filter(
      (change): change is Extract<FileChange, { kind: "delete" }> => change.kind === "delete",
    );

    for (const change of writes) {
      await mkdir(dirname(join(vaultPath, change.path)), { recursive: true });
      await writeFile(join(vaultPath, change.path), change.content, "utf8");
    }
    for (const change of deletes) {
      try {
        await unlink(join(vaultPath, change.path));
      } catch (e) {
        if (!isEnoent(e)) throw e;
      }
    }

    const files = [
      ...writes.map((change) => ({ filepath: change.path, content: change.content as string | null })),
      ...deletes.map((change) => ({ filepath: change.path, content: null as string | null })),
    ];

    // All changes were already-satisfied deletes: nothing to write or
    // remove, so there is nothing to commit — mirrors performSettle's
    // `keep` (applied, no commit).
    const commit =
      files.length > 0
        ? await commitFilesOnHead({
            path: vaultPath,
            files,
            message: `apply(P${id}): ${row.reason.slice(0, 60)}`,
            author: { name: "dome apply", email: "dome-apply@local" },
          })
        : undefined;

    // Commit is truth: report `applied` with the landed commit regardless of
    // whether the CAS below wins the race (see module header).
    decideProposal(db, {
      id,
      status: "applied",
      decidedBy: "owner",
      ...(commit !== undefined ? { appliedCommit: commit } : {}),
      decidedAt: new Date().toISOString(),
    });

    return Object.freeze({ status: "applied" as const, id, ...(commit !== undefined ? { commit } : {}) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return invalid(`apply failed: ${msg}`);
  } finally {
    db.close();
  }
}

// ----- performReject -----------------------------------------------------------

/** Reject a pending proposal. Touches no files; CAS-decides the row only. */
export async function performReject(
  vault: string,
  id: number,
  note?: string,
): Promise<RejectResult> {
  const vaultPath = resolveVaultPath(vault);
  const precondition = await checkVaultPreconditions(vaultPath, "rejecting");
  if (precondition !== null) return { status: "invalid", message: precondition };

  const opened = await openProposalsDb({ path: proposalsDbPath(vaultPath) });
  if (!opened.ok) {
    return { status: "invalid", message: `could not open the proposals store: ${opened.error.kind}` };
  }
  const { db } = opened.value;
  try {
    const row = getProposal(db, id);
    if (row === null) {
      return { status: "not-found", message: `no proposal with id ${id}` };
    }
    if (row.status !== "pending") {
      return { status: "not-pending", message: `proposal P${id} is already ${row.status}` };
    }
    decideProposal(db, {
      id,
      status: "rejected",
      decidedBy: "owner",
      ...(note !== undefined ? { note } : {}),
      decidedAt: new Date().toISOString(),
    });
    return { status: "rejected", id };
  } finally {
    db.close();
  }
}

// ----- JSON mappers -----------------------------------------------------------

/** Render a `collectProposals` result as its `dome.proposals/v1` document body. */
export function proposalsJson(
  v: Awaited<ReturnType<typeof collectProposals>>,
): Record<string, unknown> {
  return {
    schema: v.schema,
    proposals: v.proposals.map((p) => ({
      id: p.id,
      processor_id: p.processorId,
      reason: p.reason,
      paths: p.paths,
      created_at: p.createdAt,
      status: p.status,
      stale: p.stale,
      diff_stat: p.diffStat.map((d) => ({ path: d.path, added: d.added, removed: d.removed })),
    })),
  };
}

/** Render an `ApplyResult` as its `dome.apply/v1` document body — mirrors `settleResultJson`. */
export function applyResultJson(r: ApplyResult): Record<string, unknown> {
  if (r.status === "applied") {
    return { schema: APPLY_SCHEMA, status: "applied", id: r.id, commit: r.commit ?? null };
  }
  if (r.status === "stale") {
    return {
      schema: APPLY_SCHEMA,
      status: "stale",
      id: r.id,
      changed_paths: r.changedPaths,
      message: r.message,
    };
  }
  return { schema: APPLY_SCHEMA, status: r.status, message: r.message };
}

/** Render a `RejectResult` as its `dome.reject/v1` document body — mirrors `applyResultJson`. */
export function rejectResultJson(r: RejectResult): Record<string, unknown> {
  if (r.status === "rejected") {
    return { schema: REJECT_SCHEMA, status: "rejected", id: r.id };
  }
  return { schema: REJECT_SCHEMA, status: r.status, message: r.message };
}

// ----- internals ---------------------------------------------------------------

function proposalsDbPath(vaultPath: string): string {
  return join(vaultPath, ".dome", "state", "proposals.db");
}

function invalid(message: string): ApplyResult {
  return Object.freeze({ status: "invalid" as const, message });
}

/**
 * Vault preconditions — mirrors `performSettle` (`src/surface/settle.ts`
 * lines 142–158) exactly: git root + `.dome/config.yaml` present, at least
 * one commit, and HEAD on a branch (not detached). Returns the failure
 * message, or `null` when all preconditions hold.
 */
async function checkVaultPreconditions(
  vaultPath: string,
  verb: string,
): Promise<string | null> {
  const gitRoot = await findGitRoot(vaultPath);
  if (gitRoot === null || !existsSync(join(vaultPath, ".dome", "config.yaml"))) {
    return `not an initialized Dome vault (missing ${
      gitRoot === null ? "git repository" : ".dome/config.yaml"
    }); run \`dome init\` first`;
  }
  if ((await currentSha(vaultPath)) === null) {
    return "the vault has no commits yet; run `dome init` first";
  }
  const branch = await currentBranch(vaultPath);
  if (branch === null) {
    return `detached HEAD: ${verb} needs a branch; check out a branch first`;
  }
  return null;
}

/**
 * Read a working-tree file's full content. `null` when the file doesn't
 * exist — not an error condition, since a change's path may not exist yet
 * (a new-file write) or may already be gone (a satisfied delete). Any other
 * read failure (permissions, I/O error) propagates — mirrors the
 * ENOENT-only helper in `src/projections/sinks.ts`.
 */
function readWorkingFile(vaultPath: string, relPath: string): string | null {
  try {
    return readFileSync(join(vaultPath, relPath), "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function baseContentFor(row: PendingProposalRow, change: FileChange): string | null {
  return row.baseContents[change.path] ?? null;
}

type ChangeApplyStatus = "eligible" | "satisfied" | "stale";

/**
 * Classify one change against the working tree relative to its recorded
 * base content:
 *   - `eligible`  — working content matches `baseContents[path]`; safe to
 *     apply (write the proposed content, or delete the path).
 *   - `satisfied` — a delete whose working file is already absent: the
 *     change already happened outside this proposal (idempotent no-op),
 *     not stale.
 *   - `stale`     — working content has drifted from the recorded base.
 */
function classifyChangeStatus(
  vaultPath: string,
  row: PendingProposalRow,
  change: FileChange,
): ChangeApplyStatus {
  const base = baseContentFor(row, change);
  const working = readWorkingFile(vaultPath, change.path);
  if (change.kind === "delete" && working === null) return "satisfied";
  return working === base ? "eligible" : "stale";
}

function toProposalView(vaultPath: string, row: PendingProposalRow): ProposalView {
  let stale = false;
  const diffStat = row.changes.map((change) => {
    const base = baseContentFor(row, change);
    if (classifyChangeStatus(vaultPath, row, change) === "stale") stale = true;
    const proposed = change.kind === "write" ? change.content : null;
    return { path: change.path, ...lineDiffStat(base, proposed) };
  });
  return Object.freeze({
    id: row.id,
    processorId: row.processorId,
    reason: row.reason,
    paths: Object.freeze(row.changes.map((c) => c.path)),
    createdAt: row.createdAt,
    status: row.status,
    sourceRefs: Object.freeze([...row.sourceRefs]),
    stale,
    diffStat: Object.freeze(diffStat),
  });
}
