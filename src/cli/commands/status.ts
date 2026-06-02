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
//   - projection_stale: true when projection rows need rebuild before
//                       projection-backed views can be trusted.
//   - projection_cache_drift:
//                       true when loaded extension/processor/policy cache
//                       keys differ from the last built projection keys.
//   - attention_required:
//                       true when any status field needs user/agent action.
//   - attention:        stable reason codes explaining attention_required.
//   - next_actions:     stable command suggestions for agent routing.
//   - dirty_modified:   working-tree paths modified/deleted/staged.
//   - dirty_untracked:  working-tree paths not present at HEAD.
//   - content_pages:    markdown pages under wiki/, notes/, and inbox/.
//   - wiki_pages:       markdown pages under wiki/.
//   - notes_pages:      markdown pages under notes/.
//   - inbox_pages:      markdown pages under inbox/.
//   - inbox_raw_pages:  top-level markdown captures under inbox/raw/.
//   - wikilinks:        total wikilink occurrences in content markdown.
//   - raw_files:        file count under raw/.
//   - raw_bytes:        byte count under raw/.
//   - last_sync:        `started_at` of the most recent succeeded adoption or
//                       garden run. Read-only view commands do not move it.
//   - pending_runs:     count of ledger rows still in progress
//                       (`queued` or `running`). Transient in-flight rows are
//                       observable but do not route attention by themselves.
//   - orphan_runs:      count of running rows old enough for orphan-run
//                       recovery; this is what drives `pending_runs`
//                       attention.
//   - failed_runs:      count of processors whose latest ledger row is a
//                       terminal problem (`failed`, `timed_out`, or
//                       `cancelled`).
//   - recent_processor_runs:
//                       bounded per-processor summary from the recent run ledger.
//   - maintenance_loops:
//                       first-party V1 maintenance-loop summaries derived from
//                       processor health, diagnostics, questions, and runs.
//   - serve_status:     whether a foreground `dome serve` heartbeat is running,
//                       stale, or absent.
//   - diagnostics:      count of unresolved projection diagnostics.
//   - attention_diagnostics:
//                       unresolved warning/error/block diagnostics; info
//                       diagnostics remain visible but do not route attention.
//   - diagnostic_summary:
//                       bounded severity/code grouping for quick triage.
//   - attention_diagnostic_summary:
//                       same grouping limited to warning/error/block rows;
//                       text mode uses this when actionable diagnostics exist.
//   - diagnostic_message_summary:
//                       bounded severity/code/message grouping for repair
//                       targets that would otherwise share one diagnostic code.
//   - attention_diagnostic_message_summary:
//                       same message grouping limited to warning/error/block rows.
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

import { commitOid } from "../../core/source-ref";
import { countCommitsSince, currentSha, isAncestor } from "../../git";
import { getAdoptedRef, getCurrentBranch } from "../../adopted-ref";
import {
  readServeHeartbeatStatus,
  type ServeHeartbeatStatus,
} from "../../engine/compiler-host-heartbeat";
import { DEFAULT_ORPHAN_RUN_THRESHOLD_MS } from "../../engine/health";
import {
  openVaultRuntime,
  type VaultRuntime,
} from "../../engine/vault-runtime";
import { FIRST_PARTY_MAINTENANCE_LOOPS } from "../../extensions/maintenance-loops";
import type { LedgerDb } from "../../ledger/db";
import {
  countLatestActiveProblemRuns,
  isActiveProblemRun,
  orphanRuns as ledgerOrphanRuns,
  queryRuns,
  type RunRow,
  type RunStatus,
} from "../../ledger/runs";
import { queryOutbox } from "../../outbox/dispatch";
import { queryDiagnostics } from "../../projections/diagnostics";
import {
  projectionCacheKeysChanged,
  projectionRequiresRebuild,
} from "../../projections/db";
import { queryQuestionRecords } from "../../projections/questions";

import { resolveBundleRoots } from "./sync-shared";

import {
  countAttentionDiagnostics,
  isAttentionDiagnostic,
  isSourceBackedDiagnostic,
  RECOVERY_SOURCE_REF_FORMAT,
  summarizeDiagnosticEffects,
  summarizeDiagnosticMessages,
  type DiagnosticMessageSummary,
  type DiagnosticSummary,
} from "../diagnostic-summary";
import { formatJson } from "../format";
import {
  formatMaintenanceLoopDetailLines,
  collectMaintenanceLoopSummaries,
  formatMaintenanceLoopSummaryLine,
  type MaintenanceLoopSummary,
} from "../maintenance-loop-summary";
import {
  formatCliNextAction,
  nextActionsForStatus,
  type CliNextAction,
} from "../next-actions";
import { collectVaultAnalytics } from "../vault-analytics";

const RECENT_PROCESSOR_RUN_LIMIT = 100;
const LOOP_RECENT_RUN_LIMIT = 25;
const STATUS_DIAGNOSTIC_GROUP_LIMIT = 5;
const LAST_SYNC_PHASES = Object.freeze(["adoption", "garden"] as const);
const PENDING_RUN_STATUSES: ReadonlyArray<RunStatus> = Object.freeze([
  "queued",
  "running",
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
  readonly projection_stale: boolean;
  readonly projection_cache_drift: boolean;
  readonly attention_required: boolean;
  readonly attention: ReadonlyArray<string>;
  readonly next_actions: ReadonlyArray<CliNextAction>;
  readonly dirty_modified: number;
  readonly dirty_untracked: number;
  readonly content_pages: number;
  readonly wiki_pages: number;
  readonly notes_pages: number;
  readonly inbox_pages: number;
  readonly inbox_raw_pages: number;
  readonly wikilinks: number;
  readonly raw_files: number;
  readonly raw_bytes: number;
  readonly last_sync: string | null;
  readonly pending_runs: number;
  readonly orphan_runs: number;
  readonly failed_runs: number;
  readonly recent_processor_runs: ReadonlyArray<ProcessorRunSummary>;
  readonly maintenance_loops: ReadonlyArray<MaintenanceLoopSummary>;
  readonly serve_status: ServeHeartbeatStatus["status"];
  readonly serve_pid: number | null;
  readonly serve_branch: string | null;
  readonly serve_updated_at: string | null;
  readonly diagnostics: number;
  readonly content_diagnostics: number;
  readonly unlocated_diagnostics: number;
  readonly attention_diagnostics: number;
  readonly diagnostic_summary: DiagnosticSummary;
  readonly attention_diagnostic_summary: DiagnosticSummary;
  readonly diagnostic_message_summary: DiagnosticMessageSummary;
  readonly attention_diagnostic_message_summary: DiagnosticMessageSummary;
  readonly questions: number;
  readonly outbox_pending: number;
  readonly outbox_failed: number;
  readonly quarantined: number;
};

export type RunStatusOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
  readonly loops?: boolean | undefined;
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

  const bundleRoots = resolveBundleRoots({
    vaultPath,
    bundlesRoot: options.bundlesRoot,
  });
  const runtimeResult = await openVaultRuntime({ vaultPath, ...bundleRoots });
  if (!runtimeResult.ok) {
    console.error(
      `dome status: openVaultRuntime failed (${runtimeResult.error.kind}). Run \`dome init\` to initialize the vault.`,
    );
    return 1;
  }
  const runtime = runtimeResult.value;

  try {
    const analytics = await collectVaultAnalytics(vaultPath);

    // Most recent succeeded compiler-phase run, ordered by started_at
    // desc (the `queryRuns` default ordering). View commands are
    // ledgered for auditability, but they are read-only and should not
    // make `last_sync` look like the compiler adopted or drained work.
    const latestSyncRun = queryRuns(runtime.ledgerDb, {
      phase: LAST_SYNC_PHASES,
      status: "succeeded",
      limit: 1,
    });
    const last_sync = latestSyncRun[0]?.startedAt ?? null;

    const pending_runs = countRunsByStatus(
      runtime.ledgerDb,
      PENDING_RUN_STATUSES,
    );
    const orphan_runs = ledgerOrphanRuns(
      runtime.ledgerDb,
      DEFAULT_ORPHAN_RUN_THRESHOLD_MS,
      new Date(),
    ).length;
    const failed_runs = countLatestActiveProblemRuns(runtime.ledgerDb);
    const recent_processor_runs = summarizeRecentProcessorRuns(
      queryRuns(runtime.ledgerDb, {
        limit: RECENT_PROCESSOR_RUN_LIMIT,
      }),
    );
    const serve = await readServeHeartbeatStatus({ vaultPath });
    const projection_cache_drift = projectionCacheKeysChanged(
      runtime.projectionDb,
      {
        extensionSet: runtime.extensions,
        processorVersions: runtime.processorVersions,
        capabilityPolicyHash: runtime.capabilityPolicyHash,
      },
    );
    const projection_stale =
      adopted === null
        ? false
        : projectionRequiresRebuild(runtime.projectionDb, {
            adoptedCommit: commitOid(adopted),
            extensionSet: runtime.extensions,
            processorVersions: runtime.processorVersions,
            capabilityPolicyHash: runtime.capabilityPolicyHash,
          });
    const diagnosticRows = queryDiagnostics(runtime.projectionDb);
    const contentDiagnosticRows =
      diagnosticRows.filter(isSourceBackedDiagnostic);
    const unlocatedDiagnostics =
      diagnosticRows.length - contentDiagnosticRows.length;
    const attentionDiagnosticRows =
      contentDiagnosticRows.filter(isAttentionDiagnostic);
    const diagnostics = diagnosticRows.length;
    const attentionDiagnostics = countAttentionDiagnostics(contentDiagnosticRows);
    const diagnostic_summary = summarizeDiagnosticEffects(
      diagnosticRows,
      STATUS_DIAGNOSTIC_GROUP_LIMIT,
      { sourceRefs: RECOVERY_SOURCE_REF_FORMAT },
    );
    const attention_diagnostic_summary = summarizeDiagnosticEffects(
      attentionDiagnosticRows,
      STATUS_DIAGNOSTIC_GROUP_LIMIT,
      { sourceRefs: RECOVERY_SOURCE_REF_FORMAT },
    );
    const diagnostic_message_summary = summarizeDiagnosticMessages(
      diagnosticRows,
      STATUS_DIAGNOSTIC_GROUP_LIMIT,
      { sourceRefs: RECOVERY_SOURCE_REF_FORMAT },
    );
    const attention_diagnostic_message_summary = summarizeDiagnosticMessages(
      attentionDiagnosticRows,
      STATUS_DIAGNOSTIC_GROUP_LIMIT,
      { sourceRefs: RECOVERY_SOURCE_REF_FORMAT },
    );
    const unresolvedQuestions = queryQuestionRecords(runtime.projectionDb, {
      resolved: false,
    });
    const questions = unresolvedQuestions.length;
    const outbox_pending = queryOutbox(runtime.outboxDb, {
      status: "pending",
    }).length;
    const outbox_failed = queryOutbox(runtime.outboxDb, {
      status: "failed",
    }).length;
    const quarantined =
      runtime.processorRuntime.executionState.quarantines().length;
    const activeProcessorIds = new Set(
      runtime.registry.all().map((processor) => processor.id),
    );
    const maintenance_loops = collectMaintenanceLoopSummaries({
      loops: FIRST_PARTY_MAINTENANCE_LOOPS,
      activeProcessorIds,
      diagnosticsByProcessor: (processorId) =>
        queryDiagnostics(runtime.projectionDb, { processorId }),
      unresolvedQuestions,
      runsByProcessor: (processorId) =>
        queryRuns(runtime.ledgerDb, {
          processorId,
          limit: LOOP_RECENT_RUN_LIMIT,
        }),
    });
    const captureLoopInactive = captureLoopNeedsAttention({
      inboxRawPages: analytics.inbox_raw_pages,
      maintenanceLoops: maintenance_loops,
      intakeModelProviderMissing: intakeModelProviderMissing(runtime),
    });
    const attention = statusAttention({
      syncNeeded,
      adoptedDiverged,
      projectionStale: projection_stale,
      dirtyModified: analytics.dirty_modified,
      dirtyUntracked: analytics.dirty_untracked,
      orphanRuns: orphan_runs,
      failedRuns: failed_runs,
      serveStatus: serve.status,
      diagnostics: attentionDiagnostics,
      questions,
      outboxPending: outbox_pending,
      outboxFailed: outbox_failed,
      quarantined,
      captureLoopInactive,
    });

    const snapshot: StatusSnapshot = {
      vault: vaultPath,
      branch,
      head,
      adopted,
      sync_needed: syncNeeded,
      pending_commits: pendingCommits,
      adopted_diverged: adoptedDiverged,
      projection_stale,
      projection_cache_drift,
      attention_required: attention.length > 0,
      attention,
      next_actions: nextActionsForStatus({ attention }),
      dirty_modified: analytics.dirty_modified,
      dirty_untracked: analytics.dirty_untracked,
      content_pages: analytics.content_pages,
      wiki_pages: analytics.wiki_pages,
      notes_pages: analytics.notes_pages,
      inbox_pages: analytics.inbox_pages,
      inbox_raw_pages: analytics.inbox_raw_pages,
      wikilinks: analytics.wikilinks,
      raw_files: analytics.raw_files,
      raw_bytes: analytics.raw_bytes,
      last_sync,
      pending_runs,
      orphan_runs,
      failed_runs,
      recent_processor_runs,
      maintenance_loops,
      serve_status: serve.status,
      serve_pid: serve.pid,
      serve_branch: serve.branch,
      serve_updated_at: serve.updatedAt,
      diagnostics,
      content_diagnostics: contentDiagnosticRows.length,
      unlocated_diagnostics: unlocatedDiagnostics,
      attention_diagnostics: attentionDiagnostics,
      diagnostic_summary,
      attention_diagnostic_summary,
      diagnostic_message_summary,
      attention_diagnostic_message_summary,
      questions,
      outbox_pending,
      outbox_failed,
      quarantined,
    };

    if (options.json === true) {
      console.log(formatJson(snapshot));
    } else {
      printStatusText(snapshot, { showLoopDetails: options.loops === true });
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
function printStatusText(
  s: StatusSnapshot,
  options: { readonly showLoopDetails: boolean },
): void {
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
    `content   ${s.content_pages} pages | wiki ${s.wiki_pages} | notes ${s.notes_pages} | inbox ${formatInboxPages(s)} | links ${s.wikilinks} | raw ${s.raw_files} files (${formatBytes(s.raw_bytes)})`,
  );
  console.log(
    `engine    last sync ${s.last_sync ?? "(never)"} | pending ${formatPendingRuns(s)} | failed ${s.failed_runs} | serve ${formatServe(s)}`,
  );
  console.log(
    `health    projection ${formatProjectionFreshness(s)} | diagnostics ${formatDiagnosticCount(s)} | questions ${s.questions} | outbox ${s.outbox_pending} pending / ${s.outbox_failed} failed | quarantine ${s.quarantined}`,
  );
  console.log(
    `loops     ${formatMaintenanceLoopSummaryLine(s.maintenance_loops)}`,
  );
  if (options.showLoopDetails) {
    printLoopDetails(s.maintenance_loops);
  }
  const diagnosticTop =
    s.attention_diagnostics > 0
      ? s.attention_diagnostic_summary
      : s.diagnostic_summary;
  if (diagnosticTop.groups.length > 0) {
    console.log(`diag top  ${formatDiagnosticTopLine(diagnosticTop)}`);
  }
  const diagnosticFocus =
    s.attention_diagnostics > 0
      ? s.attention_diagnostic_message_summary
      : s.diagnostic_message_summary;
  if (diagnosticFocus.groups.length > 0) {
    console.log(`diag fix  ${formatDiagnosticFocusLine(diagnosticFocus)}`);
  }
  for (const line of formatNextActionLines(s.next_actions)) {
    console.log(line);
  }
}

function printLoopDetails(
  loops: ReadonlyArray<MaintenanceLoopSummary>,
): void {
  console.log("");
  console.log("Loops");
  for (const line of formatMaintenanceLoopDetailLines(loops)) {
    console.log(line);
  }
}

function formatServe(s: StatusSnapshot): string {
  if (s.serve_status === "off") return "off (run dome serve)";
  const branch =
    s.serve_branch !== null && s.serve_branch !== s.branch
      ? ` on ${s.serve_branch}`
      : "";
  return `${s.serve_status}${branch}`;
}

function formatProjectionFreshness(s: StatusSnapshot): string {
  if (!s.projection_stale) return "fresh";
  return s.projection_cache_drift ? "stale (cache drift)" : "stale";
}

function formatPendingRuns(s: StatusSnapshot): string {
  if (s.pending_runs === 0) return "0";
  if (s.orphan_runs === 0) return `${s.pending_runs} live`;
  if (s.orphan_runs === s.pending_runs) return `${s.pending_runs} stale`;
  return `${s.pending_runs} total (${s.orphan_runs} stale)`;
}

function formatDiagnosticCount(s: StatusSnapshot): string {
  if (s.diagnostics === 0) return "0";
  const attention = `${s.attention_diagnostics} attention`;
  const unlocated = s.unlocated_diagnostics === 0
    ? ""
    : `, ${s.unlocated_diagnostics} unlocated`;
  return `${s.diagnostics} (${attention}${unlocated})`;
}

function formatInboxPages(s: StatusSnapshot): string {
  if (s.inbox_raw_pages === 0) return String(s.inbox_pages);
  return `${s.inbox_pages} (${s.inbox_raw_pages} raw)`;
}

function statusAttention(input: {
  readonly syncNeeded: boolean;
  readonly adoptedDiverged: boolean;
  readonly projectionStale: boolean;
  readonly dirtyModified: number;
  readonly dirtyUntracked: number;
  readonly orphanRuns: number;
  readonly failedRuns: number;
  readonly serveStatus: ServeHeartbeatStatus["status"];
  readonly diagnostics: number;
  readonly questions: number;
  readonly outboxPending: number;
  readonly outboxFailed: number;
  readonly quarantined: number;
  readonly captureLoopInactive: boolean;
}): ReadonlyArray<string> {
  const out: string[] = [];
  if (input.adoptedDiverged) out.push("adopted_ref_diverged");
  if (input.syncNeeded) out.push("sync_needed");
  if (input.projectionStale) out.push("projection_stale");
  if (input.dirtyModified > 0) out.push("dirty_modified");
  if (input.dirtyUntracked > 0) out.push("dirty_untracked");
  if (input.orphanRuns > 0) out.push("pending_runs");
  if (input.failedRuns > 0) out.push("failed_runs");
  if (input.serveStatus === "stale") out.push("serve_stale");
  if (input.diagnostics > 0) out.push("diagnostics");
  if (input.questions > 0) out.push("questions");
  if (input.outboxPending > 0) out.push("outbox_pending");
  if (input.outboxFailed > 0) out.push("outbox_failed");
  if (input.quarantined > 0) out.push("quarantined");
  if (input.captureLoopInactive) out.push("capture_loop_inactive");
  return Object.freeze(out);
}

function captureLoopNeedsAttention(input: {
  readonly inboxRawPages: number;
  readonly maintenanceLoops: ReadonlyArray<MaintenanceLoopSummary>;
  readonly intakeModelProviderMissing: boolean;
}): boolean {
  if (input.inboxRawPages === 0) return false;
  const captureLoop = input.maintenanceLoops.find((loop) =>
    loop.id === "dome.capture.digest"
  );
  if (captureLoop === undefined) return false;
  return (
    captureLoop.state === "inactive" ||
    captureLoop.state === "partial" ||
    input.intakeModelProviderMissing
  );
}

function intakeModelProviderMissing(runtime: VaultRuntime): boolean {
  if (runtime.modelProvider !== undefined) return false;
  return runtime.registry.all().some((processor) =>
    processor.id.startsWith("dome.intake.") &&
    processor.capabilities.some((capability) =>
      capability.kind === "model.invoke"
    ) &&
    runtime.resolveGrants(processor.id).some((capability) =>
      capability.kind === "model.invoke"
    )
  );
}

function formatDiagnosticTopLine(summary: DiagnosticSummary): string {
  return summary.groups
    .map((group) => `${group.count} ${group.severity} ${group.code}`)
    .join(" | ");
}

function formatDiagnosticFocusLine(summary: DiagnosticMessageSummary): string {
  const maxGroups = 2;
  const groups = summary.groups.slice(0, maxGroups);
  const lines = groups.map((group) =>
    `${group.count} ${group.severity} ${group.code}: ` +
      truncateStatusMessage(group.message)
  );
  const remaining = summary.group_count - groups.length;
  if (remaining > 0) lines.push(`+${remaining} more`);
  return lines.join(" | ");
}

function truncateStatusMessage(message: string): string {
  const maxLength = 80;
  if (message.length <= maxLength) return message;
  return `${message.slice(0, maxLength - 3)}...`;
}

function formatNextActionLines(
  actions: ReadonlyArray<CliNextAction>,
): ReadonlyArray<string> {
  if (actions.length === 0) return [];
  return actions.map((action, index) => {
    const prefix = index === 0 ? "next      " : "          ";
    return `${prefix}${formatCliNextAction(action)}`;
  });
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
        recent_problem_runs: isActiveProblemRun(row) ? 1 : 0,
      });
      continue;
    }
    existing.recent_runs++;
    if (isActiveProblemRun(row)) {
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

function countRunsByStatus(
  ledger: LedgerDb,
  statuses: Iterable<RunStatus>,
): number {
  let total = 0;
  for (const status of statuses) {
    total += queryRuns(ledger, { status }).length;
  }
  return total;
}
