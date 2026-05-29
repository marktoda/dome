// cli/commands/status: the `dome status [--json]` command.
//
// Per [[wiki/specs/cli]] §"dome status", a read-only dashboard for the
// vault's git cursor, cheap content analytics, and operational health.
// Prints:
//
//   - branch:           the current git branch (`currentBranch`).
//   - head:             the current HEAD commit OID (`currentSha`).
//   - adopted:          `refs/dome/adopted/<branch>` value, or "(uninitialized)".
//   - sync_needed:      true when HEAD and adopted differ.
//   - pending_commits:  commit count from adopted..HEAD, or null when unknown.
//   - adopted_diverged: true when adopted is initialized but not an ancestor of HEAD.
//   - dirty_modified:   working-tree paths modified/deleted/staged.
//   - dirty_untracked:  working-tree paths not present at HEAD.
//   - content_pages:    markdown pages under wiki/, notes/, and inbox/.
//   - wiki_pages:       markdown pages under wiki/.
//   - notes_pages:      markdown pages under notes/.
//   - inbox_pages:      markdown pages under inbox/.
//   - wikilinks:        total wikilink occurrences in content markdown.
//   - raw_files:        file count under raw/.
//   - raw_bytes:        byte count under raw/.
//   - last_sync:        `started_at` of the most recent succeeded run
//                       (max startedAt across queryRuns status=succeeded).
//   - pending_runs:     count of ledger rows in `status='queued'`.
//   - failed_runs:      count of ledger rows in `status='failed'`.
//   - recent_processor_runs:
//                       bounded per-processor summary from the recent run ledger.
//   - serve_status:     whether a foreground `dome serve` heartbeat is running,
//                       stale, or absent.
//   - diagnostics:      count of unresolved projection diagnostics.
//   - questions:        count of unanswered projection questions.
//   - outbox_pending:   count of pending external-action rows.
//   - outbox_failed:    count of terminally-failed external-action rows.
//   - quarantined:      count of quarantined processor trigger keys.
//
// Values are derived from cheap local read surfaces — `src/git`, a bounded
// vault filesystem walk, `src/adopted-ref`, `src/ledger/runs`, projections,
// outbox, and processor execution state. The command opens the runtime
// read-only, does not submit a Proposal, and closes on exit. Exit codes:
//   - 0 on a clean read.
//   - 1 if the vault is malformed (no git repo, runtime open failure).
//
// House-style notes:
//   - `--json` emits the snapshot as a JSON object. Text mode renders
//     a compact dashboard intended for humans and agent transcripts.

import { resolve } from "node:path";

import { countCommitsSince, currentSha, isAncestor } from "../../git";
import { getAdoptedRef, getCurrentBranch } from "../../adopted-ref";
import {
  readServeHeartbeatStatus,
  type ServeHeartbeatStatus,
} from "../../engine/compiler-host-heartbeat";
import { openVaultRuntime } from "../../engine/vault-runtime";
import { queryRuns, type RunRow, type RunStatus } from "../../ledger/runs";
import { queryOutbox } from "../../outbox/dispatch";
import { queryDiagnostics } from "../../projections/diagnostics";
import { queryQuestions } from "../../projections/questions";

import { resolveShippedBundlesRoot } from "./sync-shared";

import { formatJson } from "../format";
import { collectVaultAnalytics } from "../vault-analytics";

const RECENT_PROCESSOR_RUN_LIMIT = 100;
const PROBLEM_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "failed",
  "timed_out",
  "cancelled",
]);

// ----- Public types ---------------------------------------------------------

type ProcessorRunSummary = {
  readonly processor_id: string;
  readonly processor_version: string;
  readonly phase: RunRow["phase"];
  readonly latest_run_id: string;
  readonly latest_status: RunStatus;
  readonly latest_started_at: string;
  readonly latest_finished_at: string | null;
  readonly latest_duration_ms: number | null;
  readonly recent_runs: number;
  readonly recent_problem_runs: number;
};

/**
 * The status snapshot. Keys stay stable across vault states so agent
 * consumers can read one JSON shape.
 */
type StatusSnapshot = {
  readonly vault: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly adopted: string | null;
  readonly sync_needed: boolean;
  readonly pending_commits: number | null;
  readonly adopted_diverged: boolean;
  readonly dirty_modified: number;
  readonly dirty_untracked: number;
  readonly content_pages: number;
  readonly wiki_pages: number;
  readonly notes_pages: number;
  readonly inbox_pages: number;
  readonly wikilinks: number;
  readonly raw_files: number;
  readonly raw_bytes: number;
  readonly last_sync: string | null;
  readonly pending_runs: number;
  readonly failed_runs: number;
  readonly recent_processor_runs: ReadonlyArray<ProcessorRunSummary>;
  readonly serve_status: ServeHeartbeatStatus["status"];
  readonly serve_pid: number | null;
  readonly serve_branch: string | null;
  readonly serve_updated_at: string | null;
  readonly diagnostics: number;
  readonly questions: number;
  readonly outbox_pending: number;
  readonly outbox_failed: number;
  readonly quarantined: number;
};

export type RunStatusOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
};

// ----- runStatus ------------------------------------------------------------

/**
 * Execute `dome status`. Returns the exit code.
 */
export async function runStatus(
  options: RunStatusOptions = {},
): Promise<number> {
  const vaultPath = resolve(options.vault ?? process.cwd());

  // Read the git-side state first. These accessors return null on missing
  // / detached HEAD / uninitialized adopted ref — all valid states.
  const branch = await getCurrentBranch(vaultPath);
  const head = await currentSha(vaultPath);
  const adopted = branch === null ? null : await getAdoptedRef(vaultPath, branch);
  const pendingCommits = await countPendingCommits({
    vaultPath,
    head,
    adopted,
  });
  const adoptedDiverged = await isAdoptedDiverged({
    vaultPath,
    head,
    adopted,
  });
  const syncNeeded = branch !== null && head !== null && head !== adopted;

  // Open the runtime to read the ledger. If the runtime can't open (no
  // .dome/extensions/, missing bundles), surface a useful error and exit
  // non-zero — the ledger is part of the snapshot.
  //
  // Default `bundlesRoot` is the SDK's shipped first-party bundles
  // (`resolveShippedBundlesRoot`). The vault-local `.dome/extensions/`
  // is no longer the default; `--bundles-root <path>` overrides.
  const bundlesRoot = options.bundlesRoot ?? resolveShippedBundlesRoot();
  const runtimeResult = await openVaultRuntime({ vaultPath, bundlesRoot });
  if (!runtimeResult.ok) {
    console.error(
      `dome status: openVaultRuntime failed (${runtimeResult.error.kind}). Run \`dome init\` to initialize the vault.`,
    );
    return 1;
  }
  const runtime = runtimeResult.value;

  try {
    const analytics = await collectVaultAnalytics(vaultPath);

    // Most recent succeeded run, ordered by started_at desc (the
    // `queryRuns` default ordering). The limit-1 cap keeps the read
    // cheap; the result either has one row (the most recent succeeded
    // run) or is empty (no successful adoption yet).
    const recent = queryRuns(runtime.ledgerDb, {
      status: "succeeded",
      limit: 1,
    });
    const last_sync = recent[0]?.startedAt ?? null;

    // Pending = queued. The dispatcher should drain queued rows quickly;
    // a persistently non-zero count is a "stuck" indicator the operator
    // surfaces via `dome inspect runs`.
    const queued = queryRuns(runtime.ledgerDb, { status: "queued" });
    const pending_runs = queued.length;
    const failed_runs = queryRuns(runtime.ledgerDb, {
      status: "failed",
    }).length;
    const recent_processor_runs = summarizeRecentProcessorRuns(
      queryRuns(runtime.ledgerDb, {
        limit: RECENT_PROCESSOR_RUN_LIMIT,
      }),
    );
    const serve = await readServeHeartbeatStatus({ vaultPath });
    const diagnostics = queryDiagnostics(runtime.projectionDb).length;
    const questions = queryQuestions(runtime.projectionDb, {
      resolved: false,
    }).length;
    const outbox_pending = queryOutbox(runtime.outboxDb, {
      status: "pending",
    }).length;
    const outbox_failed = queryOutbox(runtime.outboxDb, {
      status: "failed",
    }).length;
    const quarantined =
      runtime.processorRuntime.executionState.quarantines().length;

    const snapshot: StatusSnapshot = {
      vault: vaultPath,
      branch,
      head,
      adopted,
      sync_needed: syncNeeded,
      pending_commits: pendingCommits,
      adopted_diverged: adoptedDiverged,
      dirty_modified: analytics.dirty_modified,
      dirty_untracked: analytics.dirty_untracked,
      content_pages: analytics.content_pages,
      wiki_pages: analytics.wiki_pages,
      notes_pages: analytics.notes_pages,
      inbox_pages: analytics.inbox_pages,
      wikilinks: analytics.wikilinks,
      raw_files: analytics.raw_files,
      raw_bytes: analytics.raw_bytes,
      last_sync,
      pending_runs,
      failed_runs,
      recent_processor_runs,
      serve_status: serve.status,
      serve_pid: serve.pid,
      serve_branch: serve.branch,
      serve_updated_at: serve.updatedAt,
      diagnostics,
      questions,
      outbox_pending,
      outbox_failed,
      quarantined,
    };

    if (options.json === true) {
      console.log(formatJson(snapshot));
    } else {
      printStatusText(snapshot);
    }
    return 0;
  } finally {
    await runtime.close();
  }
}

// ----- internals ------------------------------------------------------------

/**
 * Render the snapshot as a compact dashboard. The rows intentionally
 * group facts by the question a user is asking: where is git, what is
 * in the vault, is the engine healthy?
 */
function printStatusText(s: StatusSnapshot): void {
  console.log("DOME status");
  console.log(`vault     ${s.vault}`);
  const syncState = s.adopted_diverged
    ? "diverged"
    : s.sync_needed
      ? "needed"
      : "ok";
  console.log(
    `git       branch ${s.branch ?? "(detached)"} | head ${shortOid(s.head, "(none)")} | adopted ${shortOid(s.adopted, "(uninitialized)")} | sync ${syncState} | pending ${formatPendingCommits(s.pending_commits)}`,
  );
  console.log(
    `draft     ${s.dirty_modified} modified | ${s.dirty_untracked} untracked`,
  );
  console.log(
    `content   ${s.content_pages} pages | wiki ${s.wiki_pages} | notes ${s.notes_pages} | inbox ${s.inbox_pages} | links ${s.wikilinks} | raw ${s.raw_files} files (${formatBytes(s.raw_bytes)})`,
  );
  console.log(
    `engine    last sync ${s.last_sync ?? "(never)"} | pending ${s.pending_runs} | failed ${s.failed_runs} | serve ${formatServe(s)}`,
  );
  console.log(
    `health    diagnostics ${s.diagnostics} | questions ${s.questions} | outbox ${s.outbox_pending} pending / ${s.outbox_failed} failed | quarantine ${s.quarantined}`,
  );
}

function formatServe(s: StatusSnapshot): string {
  if (s.serve_status === "off") return "off";
  const branch =
    s.serve_branch !== null && s.serve_branch !== s.branch
      ? ` on ${s.serve_branch}`
      : "";
  return `${s.serve_status}${branch}`;
}

function shortOid(oid: string | null, fallback: string): string {
  return oid === null ? fallback : oid.slice(0, 7);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MB`;
  return `${(mib / 1024).toFixed(1)} GB`;
}

async function countPendingCommits(opts: {
  readonly vaultPath: string;
  readonly head: string | null;
  readonly adopted: string | null;
}): Promise<number | null> {
  if (opts.head === null) return null;
  if (opts.adopted === null) return null;
  return countCommitsSince({
    path: opts.vaultPath,
    ancestor: opts.adopted,
    descendant: opts.head,
  });
}

async function isAdoptedDiverged(opts: {
  readonly vaultPath: string;
  readonly head: string | null;
  readonly adopted: string | null;
}): Promise<boolean> {
  if (opts.head === null || opts.adopted === null) return false;
  if (opts.head === opts.adopted) return false;
  return !(await isAncestor({
    path: opts.vaultPath,
    ancestor: opts.adopted,
    descendant: opts.head,
  }));
}

function formatPendingCommits(count: number | null): string {
  return count === null ? "unknown" : String(count);
}

function summarizeRecentProcessorRuns(
  rows: ReadonlyArray<RunRow>,
): ReadonlyArray<ProcessorRunSummary> {
  const byProcessor = new Map<string, MutableProcessorRunSummary>();
  for (const row of rows) {
    const existing = byProcessor.get(row.processorId);
    if (existing === undefined) {
      byProcessor.set(row.processorId, {
        processor_id: row.processorId,
        processor_version: row.processorVersion,
        phase: row.phase,
        latest_run_id: row.id,
        latest_status: row.status,
        latest_started_at: row.startedAt,
        latest_finished_at: row.finishedAt,
        latest_duration_ms: row.durationMs,
        recent_runs: 1,
        recent_problem_runs: PROBLEM_RUN_STATUSES.has(row.status) ? 1 : 0,
      });
      continue;
    }
    existing.recent_runs++;
    if (PROBLEM_RUN_STATUSES.has(row.status)) {
      existing.recent_problem_runs++;
    }
  }
  return Object.freeze(
    [...byProcessor.values()].map((summary) => Object.freeze({ ...summary })),
  );
}

type MutableProcessorRunSummary = {
  -readonly [K in keyof ProcessorRunSummary]: ProcessorRunSummary[K];
};
