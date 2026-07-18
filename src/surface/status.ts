// surface/status: the `dome status [--json]` command.
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
//   - service_status:   ambient-service state (launchd/systemd) for the vault:
//                       `loaded`, `installed` (service file present, service
//                       not loaded), `not-installed`, or `unsupported`
//                       (no launchd/systemd). Probed via the injected
//                       ServiceDeps (install's helpers); the live probe
//                       (`launchctl print` / `systemctl is-active`) runs only
//                       when a service file is installed, so the common
//                       never-installed vault costs one existsSync.
//                       "not installed" is informational, never attention;
//                       installed-but-not-loaded routes `service_not_loaded`
//                       attention to `dome restart`.
//   - service_label:    the service label (launchd label / systemd unit
//                       name), or null on unsupported platforms.
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

import { commitOid } from "../core/source-ref";
import {
  attentionProposal,
  attentionQuestion,
  compileAttention,
  type AttentionSnapshot,
} from "../attention/attention";
import type { StatusReason } from "./attention-reasons";
import { currentSha } from "../git";
import { getAdoptedRef, getCurrentBranch } from "../adopted-ref";
import {
  countPendingCommits,
  isAdoptedDiverged,
} from "../engine/core/adoption-status";
import {
  readServeHeartbeatStatus,
  type ServeHeartbeatStatus,
} from "../engine/host/compiler-host-heartbeat";
import { probeCommandModelProvider } from "../engine/host/command-model-provider";
import { DEFAULT_ORPHAN_RUN_THRESHOLD_MS } from "../engine/host/health";
import {
  probeCacheMatchesCommand,
  probeResultUnreachable,
  readModelProviderProbeCache,
  writeModelProviderProbeCache,
} from "../engine/host/model-provider-probe-cache";
import {
  openVaultRuntime,
  type VaultRuntime,
} from "../engine/host/vault-runtime";
import { resolveBundleRoots } from "../extensions/bundle-roots";
import type { LedgerDb } from "../ledger/db";
import {
  countRuns,
  latestActiveProblemRuns,
  isActiveProblemRun,
  orphanRuns as ledgerOrphanRuns,
  queryRunSummaries,
  type RunStatus,
  type RunSummaryRow,
} from "../ledger/runs";
import { queryOutbox } from "../outbox/dispatch";
import { queryDiagnostics } from "../projections/diagnostics";
import {
  projectionCacheKeysChanged,
  projectionRequiresRebuild,
} from "../projections/db";
import { queryQuestionRecords } from "../projections/questions";
import {
  countAttentionDiagnostics,
  isAttentionDiagnostic,
  isSourceBackedDiagnostic,
  summarizeDiagnosticDispositions,
  summarizeDiagnosticEffects,
  summarizeDiagnosticMessages,
  RECOVERY_SOURCE_REF_FORMAT,
  type DiagnosticDispositionSummary,
  type DiagnosticMessageSummary,
  type DiagnosticSummary,
} from "./diagnostic-summary";
import {
  collectMaintenanceLoopSummaries,
  type MaintenanceLoopSummary,
} from "./maintenance-loop-summary";
import {
  nextActionsForStatus,
  type CliNextAction,
} from "./next-actions";
import { collectProposals } from "./proposals";
import { probeServiceState, type ServiceDeps } from "./service-probe";
import { resolveVaultPath } from "./resolve-vault";
import {
  runtimeOpenFailureInfo,
  type RuntimeOpenFailureInfo,
} from "./adapter";
import { collectVaultAnalytics } from "./vault-analytics";

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
export type StatusSnapshot = {
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
  readonly attention: ReadonlyArray<StatusReason>;
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
  /** Ranked owner decisions/reviews. System diagnostics remain separate. */
  readonly owner_attention: AttentionSnapshot;
  readonly outbox_pending: number;
  readonly outbox_failed: number;
  readonly quarantined: number;
  readonly pending_proposals: number;
};

export type RunStatusOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
  readonly loops?: boolean | undefined;
  readonly verbose?: boolean | undefined;
  /** Run a fresh model-provider probe (up to 8s) instead of reading the cached last-probe result. */
  readonly probe?: boolean | undefined;
};

/** The ambient-service state (launchd/systemd) rendered by `dome status`. */
type ServiceStatusValue = "loaded" | "installed" | "not-installed" | "unsupported";

// ----- runStatus ------------------------------------------------------------

/** The data-returning outcome of one status collection. */
export type StatusSnapshotOutcome =
  | { readonly kind: "ok"; readonly snapshot: StatusSnapshot }
  | ({ readonly kind: "runtime-open-failed" } & RuntimeOpenFailureInfo);

/**
 * Collect the full `dome status` snapshot without printing. Opens and
 * closes its own runtime. `runStatus` renders the outcome for the
 * terminal; the MCP `status` tool renders it as the same JSON document.
 */
export async function buildStatusSnapshot(
  options: Pick<RunStatusOptions, "vault" | "bundlesRoot" | "probe"> = {},
  deps: ServiceDeps = {},
): Promise<StatusSnapshotOutcome> {
  const vaultPath = resolveVaultPath(options.vault);

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
    return Object.freeze({
      kind: "runtime-open-failed" as const,
      ...runtimeOpenFailureInfo(runtimeResult.error),
    });
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
    // Mirror dome check: failures of processors no longer registered
    // (retired/disabled bundles) can never be superseded by a newer run,
    // so they must not hold attention_required hostage forever.
    const failed_runs = latestActiveProblemRuns(runtime.ledgerDb).filter(
      (row) => runtime.registry.get(row.processorId) !== undefined,
    ).length;
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
    // Best-effort: an uninitialized (or schema-refused) proposals store
    // yields an empty list rather than throwing — see collectProposals's
    // header. Status is a cheap pulse, not a write path.
    const proposalViews = (await collectProposals(vaultPath)).proposals;
    const pending_proposals = proposalViews.length;
    const owner_attention = compileAttention({
      questions: unresolvedQuestions.map(attentionQuestion),
      proposals: proposalViews.map(attentionProposal),
      now: new Date(),
    });
    const activeProcessorIds = new Set(
      runtime.registry.all().map((processor) => processor.id),
    );
    const maintenance_loops = collectMaintenanceLoopSummaries({
      loops: runtime.maintenanceLoops,
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
      questions: owner_attention.counts.decisions,
      outboxPending: outbox_pending,
      outboxFailed: outbox_failed,
      quarantined,
      captureLoopInactive,
      pendingProposals: owner_attention.counts.reviews,
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
        pendingProposals: pending_proposals,
        firstOwnerAction: attentionAction(
          owner_attention.primary[0] ?? owner_attention.backlog[0] ?? null,
        ),
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
      owner_attention,
      outbox_pending,
      outbox_failed,
      quarantined,
      pending_proposals,
    };

    return Object.freeze({ kind: "ok" as const, snapshot });
  } finally {
    await runtime.close();
  }
}

/**
 * Execute `dome status`. Returns the exit code. `deps` injects the
 * service-probe boundaries (platform, service dirs, launchctl/systemctl
 * runners) exactly like `runInstall`; tests pass the recording fake.
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
  readonly pendingProposals: number;
}): ReadonlyArray<StatusReason> {
  const out: StatusReason[] = [];
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
  if (input.pendingProposals > 0) out.push("pending_proposals");
  return Object.freeze(out);
}

function attentionAction(
  item: import("../attention/attention").OwnerAttentionItem | null,
):
  | { readonly kind: "decision"; readonly id: number; readonly options: ReadonlyArray<string> }
  | { readonly kind: "review"; readonly id: number }
  | null {
  if (item === null) return null;
  return item.kind === "decision"
    ? Object.freeze({
        kind: "decision" as const,
        id: item.action.questionId,
        options: item.action.options,
      })
    : Object.freeze({
        kind: "review" as const,
        id: item.action.proposalId,
      });
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
