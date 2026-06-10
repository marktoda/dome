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
//   - dirty_modified:   count of working-tree paths modified/deleted/staged.
//   - dirty_untracked:  count of working-tree paths not present at HEAD.
//   - dirty_modified_paths / dirty_untracked_paths:
//                       bounded path samples for the dirty counters.
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
//   - service_status:   launchd ambient-service state for the vault:
//                       `loaded`, `installed` (plist present, service not
//                       loaded), `not-installed`, or `unsupported`
//                       (non-macOS). Probed via the injected ServiceDeps
//                       (install's helpers); `launchctl print` runs only
//                       when a plist is installed, so the common
//                       never-installed vault costs one existsSync.
//                       "not installed" is informational, never attention;
//                       installed-but-not-loaded routes `service_not_loaded`
//                       attention to `dome restart`.
//   - service_label:    the launchd label, or null on unsupported platforms.
//   - model_provider_configured:
//                       whether .dome/config.yaml carries a command model
//                       provider stanza.
//   - model_provider_probe_status / model_provider_probed_at:
//                       the last persisted provider probe outcome (written
//                       by `dome doctor` or `dome status --probe`) when it
//                       matches the currently configured command; null when
//                       never probed. Status never spawns the provider by
//                       default (the probe costs up to 8s); `--probe` forces
//                       a fresh probe and refreshes the cache. An
//                       unreachable last probe routes the
//                       `model_provider_unreachable` attention reason to
//                       `dome doctor --json`.
//   - diagnostics:      count of unresolved source-backed content diagnostics.
//                       Source-less runtime diagnostics stay visible through
//                       `unlocated_diagnostics` and `inspect diagnostics`, but
//                       they do not pollute content repair summaries.
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
//   - diagnostic_disposition_summary:
//                       bounded grouping by who/what should handle each content
//                       diagnostic: auto-fixable, agent-fixable, owner-needed,
//                       or noise.
//   - attention_diagnostic_disposition_summary:
//                       same disposition grouping limited to warning/error/block rows.
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

import { basename, resolve } from "node:path";
import { homedir } from "node:os";

import { commitOid } from "../../core/source-ref";
import { countCommitsSince, currentSha, isAncestor } from "../../git";
import { getAdoptedRef, getCurrentBranch } from "../../adopted-ref";
import {
  readServeHeartbeatStatus,
  type ServeHeartbeatStatus,
} from "../../engine/compiler-host-heartbeat";
import { probeCommandModelProvider } from "../../engine/command-model-provider";
import { DEFAULT_ORPHAN_RUN_THRESHOLD_MS } from "../../engine/health";
import {
  probeCacheMatchesCommand,
  probeResultUnreachable,
  readModelProviderProbeCache,
  writeModelProviderProbeCache,
} from "../../engine/model-provider-probe-cache";
import {
  openVaultRuntime,
  type VaultRuntime,
} from "../../engine/vault-runtime";
import { FIRST_PARTY_MAINTENANCE_LOOPS } from "../../extensions/maintenance-loops";
import type { LedgerDb } from "../../ledger/db";
import {
  countLatestActiveProblemRuns,
  countRuns,
  isActiveProblemRun,
  orphanRuns as ledgerOrphanRuns,
  queryRunSummaries,
  type RunSummaryRow,
  type RunStatus,
} from "../../ledger/runs";
import { queryOutbox } from "../../outbox/dispatch";
import { queryDiagnostics } from "../../projections/diagnostics";
import {
  projectionCacheKeysChanged,
  projectionRequiresRebuild,
} from "../../projections/db";
import { queryQuestionRecords } from "../../projections/questions";

import { probeServiceState, type ServiceDeps } from "./install";
import { resolveBundleRoots } from "./sync-shared";

import {
  countAttentionDiagnostics,
  isAttentionDiagnostic,
  isSourceBackedDiagnostic,
  RECOVERY_SOURCE_REF_FORMAT,
  summarizeDiagnosticDispositions,
  summarizeDiagnosticEffects,
  summarizeDiagnosticMessages,
  type DiagnosticDispositionSummary,
  type DiagnosticMessageSummary,
  type DiagnosticSummary,
} from "../diagnostic-summary";
import { formatJson } from "../format";
import { formatSeverity } from "../human-output";
import {
  bullets,
  footer,
  headline,
  kv,
  nextActions,
  resolveCaps,
  section,
  statusValue,
  type Caps,
  type KvRow,
  type Status,
} from "../presenter";
import { freshnessTone, syncTone } from "./status-tone";
import {
  formatMaintenanceLoopDetailLines,
  collectMaintenanceLoopSummaries,
  formatMaintenanceLoopSummaryLine,
  type MaintenanceLoopSummary,
} from "../maintenance-loop-summary";
import {
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
  readonly phase: RunSummaryRow["phase"];
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
  readonly dirty_modified_paths: ReadonlyArray<string>;
  readonly dirty_untracked_paths: ReadonlyArray<string>;
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
  readonly service_status: ServiceStatusValue;
  readonly service_label: string | null;
  readonly model_provider_configured: boolean;
  readonly model_provider_probe_status: string | null;
  readonly model_provider_probed_at: string | null;
  readonly diagnostics: number;
  readonly content_diagnostics: number;
  readonly unlocated_diagnostics: number;
  readonly attention_diagnostics: number;
  readonly diagnostic_summary: DiagnosticSummary;
  readonly attention_diagnostic_summary: DiagnosticSummary;
  readonly diagnostic_message_summary: DiagnosticMessageSummary;
  readonly attention_diagnostic_message_summary: DiagnosticMessageSummary;
  readonly diagnostic_disposition_summary: DiagnosticDispositionSummary;
  readonly attention_diagnostic_disposition_summary: DiagnosticDispositionSummary;
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
  /** Run a fresh model-provider probe (up to 8s) instead of reading the cached last-probe result. */
  readonly probe?: boolean | undefined;
};

/** The launchd ambient-service state rendered by `dome status`. */
type ServiceStatusValue = "loaded" | "installed" | "not-installed" | "unsupported";

// ----- runStatus ------------------------------------------------------------

/**
 * Execute `dome status`. Returns the exit code. `deps` injects the launchd
 * probe boundaries (platform, LaunchAgents dir, launchctl runner) exactly
 * like `runInstall`; tests pass the recording fake.
 */
export async function runStatus(
  options: RunStatusOptions = {},
  deps: ServiceDeps = {},
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
    const latestSyncRun = queryRunSummaries(runtime.ledgerDb, {
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
      queryRunSummaries(runtime.ledgerDb, {
        limit: RECENT_PROCESSOR_RUN_LIMIT,
      }),
    );
    const serve = await readServeHeartbeatStatus({ vaultPath });
    const service = await collectServiceStatus(vaultPath, deps);
    const modelProbe = await collectModelProviderProbe({
      vaultPath,
      runtime,
      probe: options.probe === true,
    });
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
    const diagnostics = contentDiagnosticRows.length;
    const attentionDiagnostics = countAttentionDiagnostics(contentDiagnosticRows);
    const diagnostic_summary = summarizeDiagnosticEffects(
      contentDiagnosticRows,
      STATUS_DIAGNOSTIC_GROUP_LIMIT,
      { sourceRefs: RECOVERY_SOURCE_REF_FORMAT },
    );
    const attention_diagnostic_summary = summarizeDiagnosticEffects(
      attentionDiagnosticRows,
      STATUS_DIAGNOSTIC_GROUP_LIMIT,
      { sourceRefs: RECOVERY_SOURCE_REF_FORMAT },
    );
    const diagnostic_message_summary = summarizeDiagnosticMessages(
      contentDiagnosticRows,
      STATUS_DIAGNOSTIC_GROUP_LIMIT,
      { sourceRefs: RECOVERY_SOURCE_REF_FORMAT },
    );
    const attention_diagnostic_message_summary = summarizeDiagnosticMessages(
      attentionDiagnosticRows,
      STATUS_DIAGNOSTIC_GROUP_LIMIT,
      { sourceRefs: RECOVERY_SOURCE_REF_FORMAT },
    );
    const diagnostic_disposition_summary = summarizeDiagnosticDispositions(
      contentDiagnosticRows,
      STATUS_DIAGNOSTIC_GROUP_LIMIT,
      { sourceRefs: RECOVERY_SOURCE_REF_FORMAT },
    );
    const attention_diagnostic_disposition_summary =
      summarizeDiagnosticDispositions(
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
        queryRunSummaries(runtime.ledgerDb, {
          processorId,
          limit: LOOP_RECENT_RUN_LIMIT,
        }),
    });
    const captureLoopInactive = captureLoopNeedsAttention({
      inboxRawPages: analytics.inbox_raw_pages,
      maintenanceLoops: maintenance_loops,
      captureModelProviderMissing: captureModelProviderMissing(runtime),
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
      serviceNotLoaded: service.notLoaded,
      modelProviderUnreachable: modelProbe.unreachable,
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
      next_actions: nextActionsForStatus({
        attention,
        dirtyModified: analytics.dirty_modified,
        dirtyUntracked: analytics.dirty_untracked,
        dirtyModifiedPaths: analytics.dirty_modified_paths,
        dirtyUntrackedPaths: analytics.dirty_untracked_paths,
      }),
      dirty_modified: analytics.dirty_modified,
      dirty_untracked: analytics.dirty_untracked,
      dirty_modified_paths: analytics.dirty_modified_paths,
      dirty_untracked_paths: analytics.dirty_untracked_paths,
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
      service_status: service.status,
      service_label: service.label,
      model_provider_configured: modelProbe.configured,
      model_provider_probe_status: modelProbe.status,
      model_provider_probed_at: modelProbe.probedAt,
      diagnostics,
      content_diagnostics: contentDiagnosticRows.length,
      unlocated_diagnostics: unlocatedDiagnostics,
      attention_diagnostics: attentionDiagnostics,
      diagnostic_summary,
      attention_diagnostic_summary,
      diagnostic_message_summary,
      attention_diagnostic_message_summary,
      diagnostic_disposition_summary,
      attention_diagnostic_disposition_summary,
      questions,
      outbox_pending,
      outbox_failed,
      quarantined,
    };

    if (options.json === true) {
      console.log(formatJson(snapshot));
    } else {
      printStatusText(snapshot, { showLoopDetails: options.loops === true, caps: resolveCaps() });
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
  options: { readonly showLoopDetails: boolean; readonly caps: Caps },
): void {
  const caps = options.caps;
  const glance = (label: string, st: Status): KvRow => ({
    label,
    value: statusValue(st, caps),
    tone: "plain",
  });

  const head: Status = s.attention_required
    ? { tone: "warn", label: "needs attention" }
    : { tone: "ok", label: "ok" };

  const lines: string[] = [
    headline({ cmd: "status", context: basename(s.vault) }, head, caps),
  ];

  lines.push(...section("Next", nextActions(s.next_actions, caps), caps));

  lines.push(
    ...section(
      "At a glance",
      kv(
        [
          glance("sync", syncTone(s)),
          glance("projection", freshnessTone(s)),
          glance("draft", draftStatus(s)),
          glance("diagnostics", diagnosticStatus(s)),
          glance("questions", countStatus(s.questions)),
          glance("serve", serveStatus(s)),
        ],
        caps,
      ),
      caps,
    ),
  );

  lines.push(
    ...section(
      "Vault",
      kv(
        [
          { label: "path", value: tildify(s.vault), tone: "muted" },
          { label: "branch", value: s.branch ?? "(detached)" },
          { label: "head", value: shortOid(s.head, "(none)"), tone: "ident" },
          { label: "adopted", value: shortOid(s.adopted, "(uninitialized)"), tone: "ident" },
          { label: "pending", value: formatPendingCommits(s.pending_commits) },
          { label: "content", value: formatContentSummary(s), tone: "muted" },
        ],
        caps,
      ),
      caps,
    ),
  );

  lines.push(
    ...section(
      "Engine",
      kv(
        [
          { label: "last sync", value: s.last_sync ?? "(never)", tone: "muted" },
          { label: "runs", value: `${formatPendingRuns(s)} pending · ${s.failed_runs} failed` },
          { label: "outbox", value: `${s.outbox_pending} pending · ${s.outbox_failed} failed` },
          { label: "quarantine", value: String(s.quarantined) },
          { label: "loops", value: formatMaintenanceLoopSummaryLine(s.maintenance_loops) },
          ...(s.service_status === "unsupported"
            ? []
            : [{ label: "service", value: formatServiceLine(s) } satisfies KvRow]),
          ...(s.model_provider_configured
            ? [{ label: "model", value: formatModelProviderLine(s) } satisfies KvRow]
            : []),
        ],
        caps,
      ),
      caps,
    ),
  );

  if (options.showLoopDetails) {
    lines.push(
      ...section("Loops", formatMaintenanceLoopDetailLines(s.maintenance_loops, caps), caps),
    );
  }

  const diagnosticTop =
    s.attention_diagnostics > 0 ? s.attention_diagnostic_summary : s.diagnostic_summary;
  const diagnosticFocus =
    s.attention_diagnostics > 0
      ? s.attention_diagnostic_message_summary
      : s.diagnostic_message_summary;
  const diagnosticDisposition =
    s.attention_diagnostics > 0
      ? s.attention_diagnostic_disposition_summary
      : s.diagnostic_disposition_summary;
  const diagnosticLines = [
    ...(diagnosticTop.groups.length > 0 ? [`top: ${formatDiagnosticTopLine(diagnosticTop)}`] : []),
    ...(diagnosticFocus.groups.length > 0 ? [`fix: ${formatDiagnosticFocusLine(diagnosticFocus)}`] : []),
    ...(diagnosticDisposition.groups.length > 0
      ? [`plan: ${formatDiagnosticDispositionLine(diagnosticDisposition)}`]
      : []),
  ];
  lines.push(...section("Diagnostics", bullets(diagnosticLines, caps), caps));

  const footerStatus: Status = s.attention_required
    ? { tone: "warn", label: `${s.attention.length} ${s.attention.length === 1 ? "item needs" : "items need"} attention` }
    : { tone: "ok", label: "all clear" };
  lines.push(...footer(footerStatus, caps));

  console.log(lines.join("\n"));
}

function formatServiceLine(s: StatusSnapshot): string {
  if (s.service_status === "loaded") return "loaded";
  if (s.service_status === "installed") {
    return "installed, not loaded (run dome restart)";
  }
  return "not installed";
}

function formatModelProviderLine(s: StatusSnapshot): string {
  if (s.model_provider_probe_status === null) {
    return "configured, unprobed (dome doctor or dome status --probe)";
  }
  return `probe ${s.model_provider_probe_status} at ${s.model_provider_probed_at ?? "(unknown)"}`;
}

function formatServe(s: StatusSnapshot): string {
  const branch =
    s.serve_branch !== null && s.serve_branch !== s.branch
      ? ` on ${s.serve_branch}`
      : "";
  return `${s.serve_status}${branch}`;
}

function draftStatus(s: StatusSnapshot): Status {
  if (s.dirty_modified === 0 && s.dirty_untracked === 0) return { tone: "ok", label: "clean" };
  return { tone: "warn", label: formatDraftSummary(s) };
}

function diagnosticStatus(s: StatusSnapshot): Status {
  return { tone: s.diagnostics > 0 ? "warn" : "ok", label: formatDiagnosticCount(s) };
}

function countStatus(n: number): Status {
  return { tone: n > 0 ? "warn" : "ok", label: String(n) };
}

function serveStatus(s: StatusSnapshot): Status {
  if (s.serve_status === "off") return { tone: "muted", label: "off" };
  if (s.serve_status === "stale") return { tone: "warn", label: formatServe(s) };
  return { tone: "ok", label: formatServe(s) };
}

function tildify(path: string): string {
  const home = homedir();
  if (path === home || path.startsWith(`${home}/`)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

function formatPendingRuns(s: StatusSnapshot): string {
  if (s.pending_runs === 0) return "0";
  if (s.orphan_runs === 0) return `${s.pending_runs} live`;
  if (s.orphan_runs === s.pending_runs) return `${s.pending_runs} stale`;
  return `${s.pending_runs} total (${s.orphan_runs} stale)`;
}

function formatDraftSummary(s: StatusSnapshot): string {
  if (s.dirty_modified === 0 && s.dirty_untracked === 0) return "clean";
  return `${s.dirty_modified} modified · ${s.dirty_untracked} untracked`;
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

function formatContentSummary(s: StatusSnapshot): string {
  return `${s.content_pages} pages · wiki ${s.wiki_pages} · notes ${s.notes_pages} · inbox ${formatInboxPages(s)} · links ${s.wikilinks} · raw ${s.raw_files} files (${formatBytes(s.raw_bytes)})`;
}

/**
 * The launchd service line, derived through install's probe helper with the
 * injected deps. `not-installed` and `unsupported` are informational only;
 * `notLoaded` (plist present, `launchctl print` says the service is gone)
 * is the attention-worthy state — a KeepAlive agent that is not loaded
 * means the ambient compiler silently stopped.
 */
async function collectServiceStatus(
  vaultPath: string,
  deps: ServiceDeps,
): Promise<{
  readonly status: ServiceStatusValue;
  readonly label: string | null;
  readonly notLoaded: boolean;
}> {
  const state = await probeServiceState(vaultPath, deps);
  if (!state.supported) {
    return { status: "unsupported", label: null, notLoaded: false };
  }
  if (!state.installed) {
    return { status: "not-installed", label: state.label, notLoaded: false };
  }
  return {
    status: state.loaded === true ? "loaded" : "installed",
    label: state.label,
    notLoaded: state.loaded === false,
  };
}

/**
 * Last-known model-provider reachability. Default mode reads only the
 * persisted probe cache (one small JSON read; written by `dome doctor` or a
 * prior `--probe`) and ignores it when the configured command changed.
 * `--probe` spawns the provider live (up to 8s) and refreshes the cache —
 * that cost is why it is opt-in; see wiki/specs/cli.md §"dome status".
 */
async function collectModelProviderProbe(opts: {
  readonly vaultPath: string;
  readonly runtime: VaultRuntime;
  readonly probe: boolean;
}): Promise<{
  readonly configured: boolean;
  readonly status: string | null;
  readonly probedAt: string | null;
  readonly unreachable: boolean;
}> {
  const config = opts.runtime.config.modelProvider;
  if (config === undefined) {
    return { configured: false, status: null, probedAt: null, unreachable: false };
  }
  if (opts.probe) {
    const result = await probeCommandModelProvider(config, {
      cwd: opts.vaultPath,
    });
    const now = new Date();
    writeModelProviderProbeCache(opts.vaultPath, {
      command: config.command,
      probedAt: now,
      result,
    });
    return {
      configured: true,
      status: result.status,
      probedAt: now.toISOString(),
      unreachable: probeResultUnreachable(result),
    };
  }
  const cache = readModelProviderProbeCache(opts.vaultPath);
  if (cache === null || !probeCacheMatchesCommand(cache, config.command)) {
    return { configured: true, status: null, probedAt: null, unreachable: false };
  }
  return {
    configured: true,
    status: cache.result.status,
    probedAt: cache.probedAt,
    unreachable: probeResultUnreachable(cache.result),
  };
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
  readonly serviceNotLoaded: boolean;
  readonly modelProviderUnreachable: boolean;
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
  if (input.serviceNotLoaded) out.push("service_not_loaded");
  if (input.modelProviderUnreachable) out.push("model_provider_unreachable");
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
  readonly captureModelProviderMissing: boolean;
}): boolean {
  if (input.inboxRawPages === 0) return false;
  const captureLoop = input.maintenanceLoops.find((loop) =>
    loop.id === "dome.capture.digest"
  );
  if (captureLoop === undefined) return false;
  return (
    captureLoop.state === "inactive" ||
    captureLoop.state === "partial" ||
    input.captureModelProviderMissing
  );
}

function captureModelProviderMissing(runtime: VaultRuntime): boolean {
  if (runtime.modelProvider !== undefined) return false;
  return runtime.registry.all().some((processor) =>
    processor.id.startsWith("dome.agent.") &&
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
    .map((group) => `${group.count} ${formatSeverity(group.severity)} ${group.code}`)
    .join(" · ");
}

function formatDiagnosticFocusLine(summary: DiagnosticMessageSummary): string {
  const maxGroups = 2;
  const groups = summary.groups.slice(0, maxGroups);
  const lines = groups.map((group) =>
    `${group.count} ${formatSeverity(group.severity)} ${group.code}: ` +
      truncateStatusMessage(group.message)
  );
  const remaining = summary.group_count - groups.length;
  if (remaining > 0) lines.push(`+${remaining} more`);
  return lines.join(" · ");
}

function formatDiagnosticDispositionLine(
  summary: DiagnosticDispositionSummary,
): string {
  const counts = new Map<string, number>();
  for (const group of summary.groups) {
    counts.set(
      group.disposition,
      (counts.get(group.disposition) ?? 0) + group.count,
    );
  }
  return [...counts]
    .map(([disposition, count]) => `${count} ${disposition}`)
    .join(" · ");
}

function truncateStatusMessage(message: string): string {
  const maxLength = 80;
  if (message.length <= maxLength) return message;
  return `${message.slice(0, maxLength - 3)}...`;
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
  rows: ReadonlyArray<RunSummaryRow>,
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
    total += countRuns(ledger, { status });
  }
  return total;
}
