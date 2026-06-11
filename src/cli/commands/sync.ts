// cli/commands/sync: the `dome sync` command — Phase 11c of v1.0.
//
// Runs one compiler-host tick for the current HEAD vs the adopted ref,
// prints the result, exits. This is the manual trigger for users who
// don't want a `dome serve` compiler host running continuously.
//
// Per docs/wiki/specs/cli.md §"dome sync" + docs/wiki/specs/adoption.md
// §"dome sync":
//
//   - Construct a Proposal from `adopted..HEAD` (or the empty-diff init
//     when the adopted ref is uninitialized).
//   - Run it through the engine's compiler-host tick.
//   - Print a one-line summary (or a `--json` structured object).
//   - Exit.
//
// Drift detection + adoption-invocation are shared with `dome serve` via
// `src/engine/host/compiler-host.ts`; this command is the host's per-tick body invoked
// exactly once and surfaced with a CLI-shaped output / exit code.
//
// Exit codes:
//   - 0   on successful adoption (or no-drift no-op).
//   - 1   on blocked adoption (the engine reported `adopted: false` with
//         block-severity diagnostics; the operator addresses the blocks
//         and re-runs sync).
//   - 75  when another Dome compiler host already holds the branch lock.
//   - 64  (EX_USAGE) on detached HEAD or no commits — the adopted-ref
//         substrate cannot operate in either state. Clear error message
//         to stderr.
//
// House-style notes (matches src/cli/commands/serve.ts, status.ts,
// doctor.ts):
//   - `type X = { ... }` aliases, every field `readonly`.
//   - The handler returns the exit code; the dispatcher
//     (`src/cli/index.ts`) calls `process.exit(code)`.
//   - Console output goes through `console.log` / `console.error`.

import { basename } from "node:path";

import { openVault, type Vault } from "../../vault";
import {
  openVaultErrorKind,
  vaultOpenFailureMessage,
} from "../../surface/adapter";
import type { AdoptionResult } from "../../core/proposal";
import type { CompilerHostTickResult } from "../../engine/host/compiler-host";
import type { GardenPhaseResult } from "../../engine/garden/garden";
import type { OperationalWorkResult } from "../../engine/operational/operational-work";
import {
  formatFilteredAdoptEvent,
  printHostFollowupLines,
} from "./sync-shared";
import { formatJson } from "../../surface/format";
import {
  nextActionsForSync,
  type CliNextAction,
} from "../../surface/next-actions";
import { formatSeverity } from "../human-output";
import {
  footer,
  headline,
  kv,
  nextActions,
  resolveCaps,
  section,
  type KvRow,
  type Status,
} from "../presenter";

import { resolveVaultPath } from "../../surface/resolve-vault";
// ----- Public types ---------------------------------------------------------

/**
 * The shape `dome sync --json` emits on stdout. Stable across runs;
 * downstream tooling reads it. `status` discriminates the five outcomes
 * the command can report.
 *
 *   - `adopted`     — adoption succeeded; the adopted ref advanced (or
 *                     was initialized) to `head`.
 *   - `blocked`     — adoption ran but block-severity diagnostics
 *                     prevented the adopted ref from advancing. `head`
 *                     reflects the working-tree HEAD that was attempted.
 *   - `in-sync`     — HEAD already equals the adopted ref; no adoption
 *                     work ran. Due operational queues may still drain.
 *   - `busy`        — another Dome compiler host already holds the branch
 *                     lock; retry after that host finishes.
 *   - `error`       — detached HEAD, no commits, or adopted-ref divergence;
 *                     the substrate cannot operate.
 */
type SyncJsonResult = {
  readonly status: "adopted" | "blocked" | "in-sync" | "busy" | "error";
  readonly branch: string | null;
  readonly base: string | null;
  readonly head: string | null;
  readonly adoptedRef: string | null;
  readonly iterations: number;
  readonly closureCommit: string | null;
  readonly garden: SyncGardenSummary;
  readonly operational: SyncOperationalSummary;
  readonly health: SyncHealthSummary;
  readonly attention_required: boolean;
  readonly attention: ReadonlyArray<string>;
  readonly next_actions: ReadonlyArray<CliNextAction>;
  readonly diagnostics: ReadonlyArray<{
    readonly severity: string;
    readonly code: string;
    readonly message: string;
  }>;
  readonly error?: string;
};

type SyncGardenSummary = {
  readonly subProposalCount: number;
  readonly rejectedPatchCount: number;
  readonly diagnosticCount: number;
};

type SyncOperationalSummary = {
  readonly scheduledCount: number;
  readonly jobCount: number;
  readonly outboxCount: number;
  readonly autoResolvedQuestions: number;
  readonly diagnosticCount: number;
};

type SyncHealthSummary = {
  readonly pendingRuns: number;
  readonly orphanRuns: number;
  readonly failedRuns: number;
  readonly diagnostics: number;
  readonly contentDiagnostics: number;
  readonly unlocatedDiagnostics: number;
  readonly attentionDiagnostics: number;
  readonly questions: number;
  readonly outboxPending: number;
  readonly outboxFailed: number;
  readonly quarantined: number;
};

export type RunSyncOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
  readonly verbose?: boolean | undefined;
  readonly quiet?: boolean | undefined;
  readonly filterProcessor?: string | undefined;
};

// ----- runSync --------------------------------------------------------------

/**
 * Execute `dome sync`. Returns the exit code.
 *
 * Read flags:
 *   - `--vault <path>`         override vault path (default: cwd).
 *   - `--bundles-root <path>`  override extensions root.
 *   - `--json`                 emit a single JSON object on stdout.
 */
export async function runSync(options: RunSyncOptions = {}): Promise<number> {
  // ----- 1. Parse flags -----------------------------------------------------
  const vaultPath = resolveVaultPath(options.vault);

  const jsonMode = options.json === true;
  const verbose = options.verbose === true;
  const quiet = options.quiet === true && !jsonMode;

  // ----- 2. Open the vault ----------------------------------------------------
  const opened = await openVault({
    path: vaultPath,
    bundlesRoot: options.bundlesRoot,
  });
  if (!opened.ok) {
    const errorKind = openVaultErrorKind(opened.error);
    const msg = vaultOpenFailureMessage("dome sync", opened.error);
    if (jsonMode) {
      emitErrorJson({ branch: null, error: errorKind, message: msg });
    } else {
      console.error(msg);
    }
    return 1;
  }
  const vault = opened.value;

  // ----- 3. Run one compiler-host tick --------------------------------------
  try {
    const tick = await vault.sync({
      ...(verbose && !quiet && !jsonMode
        ? {
            onEvent: (e) => {
              const line = formatFilteredAdoptEvent(e, {
                command: "sync",
                ...(options.filterProcessor !== undefined
                  ? { processorFilter: options.filterProcessor }
                  : {}),
              });
              if (line !== null) console.error(line);
            },
          }
        : {}),
      ...(!quiet
        ? {
            onGardenProcessorStart: (info) => {
              if (info.executionClass === "llm" || verbose) {
                console.error(
                  `dome sync: ▶ running ${info.processorId}${info.executionClass === "llm" ? " (agent)" : ""}…`,
                );
              }
            },
          }
        : {}),
    });
    const result = tickResultJson(tick, await collectSyncHealth(vault));
    if (jsonMode) {
      console.log(formatJson(result));
    } else {
      printTickLines(tick, { quiet, result, vaultPath });
    }
    return exitCodeForTick(tick);
  } finally {
    await vault.close();
  }
}


// ----- Internals ------------------------------------------------------------

/**
 * Render the adoption result as a block of presenter-styled lines on stdout.
 * Uses the same presenter primitives as `dome status` — headline, section,
 * kv, footer — so the output is visually consistent.
 */
function printTickLines(
  tick: CompilerHostTickResult,
  opts: {
    readonly quiet: boolean;
    readonly result: SyncJsonResult;
    readonly vaultPath: string;
  },
): void {
  const caps = resolveCaps();

  if (tick.kind === "busy") {
    console.error(
      `dome sync: branch ${tick.branch} is already being processed by another Dome host.`,
    );
    return;
  }
  if (tick.kind === "diverged") {
    console.error(
      `dome sync: refused ${tick.branch}: adopted ref ${tick.adopted.slice(0, 7)} is not an ancestor of HEAD ${tick.head.slice(0, 7)}.`,
    );
    console.error(
      "  Inspect git history before syncing; this usually means the branch was rebased, reset, or force-updated.",
    );
    console.error(
      "  Run `dome reanchor` to accept the rewritten HEAD (the old adopted SHA is backed up under refs/dome/backup/), or restore the prior history via `git reflog`.",
    );
    return;
  }
  if (tick.kind === "detached-head") {
    console.error(
      "dome sync: HEAD is detached. The adopted-ref substrate requires a branch. Check out a branch and retry.",
    );
    return;
  }
  if (tick.kind === "no-commits") {
    console.error(
      "dome sync: vault has no commits yet. Make an initial commit and retry.",
    );
    return;
  }

  if (tick.kind === "in-sync") {
    if (opts.quiet) return;
    const outcomeStatus: Status = { tone: "ok", label: "in sync" };
    const compiledRows: KvRow[] = [
      { label: "branch", value: tick.branch },
      { label: "adopted", value: tick.finalAdoptedRef.slice(0, 7), tone: "ident" },
    ];
    const lines: string[] = [
      headline({ cmd: "sync", context: basename(opts.vaultPath) }, outcomeStatus, caps),
      ...section("Compiled", kv(compiledRows, caps), caps),
    ];
    if (opts.result.attention_required) {
      lines.push(...buildAttentionFooter(opts.result, caps));
    }
    console.log(lines.join("\n"));
    return;
  }

  const result = tick.adoption;
  const diagCount = result.diagnostics.length;
  const iters = result.iterations;

  if (result.adopted) {
    if (opts.quiet) return;
    const range =
      tick.drift.base === tick.drift.head
        ? tick.drift.head.slice(0, 7)
        : `${tick.drift.base.slice(0, 7)}..${tick.drift.head.slice(0, 7)}`;
    const outcomeStatus: Status = { tone: "ok", label: `adopted ${tick.branch}` };
    const compiledRows: KvRow[] = [
      { label: "range", value: range, tone: "ident" },
      { label: "diagnostics", value: `${diagCount}` },
      { label: "iterations", value: `${iters}` },
    ];
    // Build the operational section inline when there is operational work to show
    const hasOperational =
      tick.operational !== null &&
      (tick.operational.scheduler.fired.length > 0 ||
        tick.operational.jobs.drained.length > 0 ||
        tick.operational.outbox.length > 0 ||
        tick.operational.questionAutoResolution.answered > 0 ||
        tick.operational.diagnostics.length > 0);
    const lines: string[] = [
      headline({ cmd: "sync", context: basename(opts.vaultPath) }, outcomeStatus, caps),
      ...section("Compiled", kv(compiledRows, caps), caps),
    ];
    if (hasOperational && tick.operational !== null) {
      const op = tick.operational;
      const opRows: KvRow[] = [
        { label: "scheduled", value: `${op.scheduler.fired.length}` },
        { label: "jobs", value: `${op.jobs.drained.length}` },
        { label: "outbox", value: `${op.outbox.length}` },
        { label: "auto-resolved", value: `${op.questionAutoResolution.answered}` },
        { label: "diagnostics", value: `${op.diagnostics.length}` },
      ];
      lines.push(...section("Operational", kv(opRows, caps), caps));
    }
    if (opts.result.attention_required) {
      lines.push(...buildAttentionFooter(opts.result, caps));
    }
    console.log(lines.join("\n"));
    // Garden follow-up (sub-proposals / rejected patches) is handled by the
    // shared helper; operational is already shown above inline.
    printHostFollowupLines("dome sync", tick.garden, null, basename(opts.vaultPath));
    return;
  }

  // blocked
  const blockers = result.diagnostics.filter((d) => d.severity === "block");
  const outcomeStatus: Status = { tone: "err", label: `blocked · ${tick.branch}` };
  const blockedRows: KvRow[] = [
    { label: "diagnostics", value: `${diagCount}` },
    { label: "adopted", value: result.adoptedRef.slice(0, 7), tone: "ident" },
  ];
  const blockerBullets: string[] = [];
  for (const d of blockers.slice(0, 5)) {
    blockerBullets.push(
      `[${formatSeverity(d.severity)}] ${d.code}: ${d.message}`,
    );
  }
  if (blockers.length > 5) {
    blockerBullets.push(
      `+${blockers.length - 5} more (see \`dome check --json\`).`,
    );
  }
  const lines: string[] = [
    headline({ cmd: "sync", context: basename(opts.vaultPath) }, outcomeStatus, caps),
    ...section("Compiled", kv(blockedRows, caps), caps),
    ...section("Blockers", blockerBullets.map((l) => `  - ${l}`), caps),
  ];
  console.error(lines.join("\n"));
}

function buildAttentionFooter(
  result: SyncJsonResult,
  caps: ReturnType<typeof resolveCaps>,
): string[] {
  const lines: string[] = [];
  lines.push(
    ...footer({ tone: "warn", label: `needs attention · ${result.attention.join(", ")}` }, caps),
  );
  if (result.next_actions.length > 0) {
    lines.push(...section("Next", nextActions(result.next_actions, caps), caps));
  }
  return lines;
}

function exitCodeForTick(tick: CompilerHostTickResult): number {
  if (tick.kind === "detached-head" || tick.kind === "no-commits") return 64;
  if (tick.kind === "busy") return 75;
  if (tick.kind === "diverged") return 1;
  return tick.kind === "blocked" ? 1 : 0;
}

/**
 * Build the `--json` payload for a completed adoption (adopted or
 * blocked). Diagnostics are projected to a stable, stringly-typed shape
 * — downstream tooling reads `severity` / `code` / `message` and ignores
 * the rest of the DiagnosticEffect (sourceRefs are tied to internal
 * commit/blob OIDs that aren't useful to a CLI consumer in v1.0).
 */
function tickResultJson(
  tick: CompilerHostTickResult,
  health: SyncHealthSummary,
): SyncJsonResult {
  if (tick.kind === "detached-head") {
    return errorPayload({ branch: null, error: "detached-head" });
  }
  if (tick.kind === "no-commits") {
    return errorPayload({ branch: null, error: "no-commits" });
  }
  if (tick.kind === "busy") {
    return {
      status: "busy",
      branch: tick.branch,
      base: null,
      head: null,
      adoptedRef: null,
      iterations: 0,
      closureCommit: null,
      garden: emptyGardenSummary(),
      operational: emptyOperationalSummary(),
      health,
      attention_required: true,
      attention: ["compiler_host_busy"],
      next_actions: nextActionsForSync({
        attention: ["compiler_host_busy"],
      }),
      diagnostics: [],
      error: "compiler-host-busy",
    };
  }
  if (tick.kind === "diverged") {
    return {
      status: "error",
      branch: tick.branch,
      base: tick.adopted,
      head: tick.head,
      adoptedRef: tick.adopted,
      iterations: 0,
      closureCommit: null,
      garden: emptyGardenSummary(),
      operational: emptyOperationalSummary(),
      health,
      attention_required: true,
      attention: ["adopted_ref_diverged"],
      next_actions: nextActionsForSync({
        attention: ["adopted_ref_diverged"],
      }),
      diagnostics: [
        {
          severity: "error",
          code: "adopted-ref.diverged",
          message:
            `Adopted ref for ${tick.branch} (${tick.adopted.slice(0, 7)}) is not an ` +
            `ancestor of HEAD (${tick.head.slice(0, 7)}).`,
        },
      ],
      error: "adopted-ref-diverged",
    };
  }
  if (tick.kind === "in-sync") {
    const operational = summarizeOperational(tick.operational);
    const attention = syncAttention({
      status: "in-sync",
      garden: emptyGardenSummary(),
      operational,
      health,
    });
    return {
      status: "in-sync",
      branch: tick.branch,
      base: tick.head,
      head: tick.head,
      adoptedRef: tick.finalAdoptedRef,
      iterations: 0,
      closureCommit: null,
      garden: emptyGardenSummary(),
      operational,
      health,
      attention_required: attention.length > 0,
      attention,
      next_actions: nextActionsForSync({ attention }),
      diagnostics: diagnosticsJson(tick.operational?.diagnostics ?? []),
    };
  }
  const result = tick.adoption;
  const garden = summarizeGarden(tick.garden);
  const operational = summarizeOperational(tick.operational);
  const attention = syncAttention({
    status: result.adopted ? "adopted" : "blocked",
    garden,
    operational,
    health,
  });
  return {
    status: result.adopted ? "adopted" : "blocked",
    branch: tick.branch,
    base: tick.drift.base,
    head: tick.drift.head,
    adoptedRef: tick.finalAdoptedRef,
    iterations: result.iterations,
    closureCommit: result.closureCommitOid,
    garden,
    operational,
    health,
    attention_required: attention.length > 0,
    attention,
    next_actions: nextActionsForSync({ attention }),
    diagnostics: diagnosticsJson([
      ...result.diagnostics,
      ...(tick.garden?.diagnostics ?? []),
      ...(tick.operational?.diagnostics ?? []),
    ]),
  };
}

function syncAttention(input: {
  readonly status: SyncJsonResult["status"];
  readonly garden: SyncGardenSummary;
  readonly operational: SyncOperationalSummary;
  readonly health: SyncHealthSummary;
}): ReadonlyArray<string> {
  const out: string[] = [];
  if (input.status === "blocked") out.push("adoption_blocked");
  if (input.garden.rejectedPatchCount > 0) out.push("garden_rejected_patches");
  if (input.garden.diagnosticCount > 0) out.push("garden_diagnostics");
  if (input.operational.diagnosticCount > 0) {
    out.push("operational_diagnostics");
  }
  if (input.health.orphanRuns > 0) out.push("pending_runs");
  if (input.health.failedRuns > 0) out.push("failed_runs");
  if (input.health.attentionDiagnostics > 0) out.push("diagnostics");
  if (input.health.questions > 0) out.push("questions");
  if (input.health.outboxPending > 0) out.push("outbox_pending");
  if (input.health.outboxFailed > 0) out.push("outbox_failed");
  if (input.health.quarantined > 0) out.push("quarantined");
  return Object.freeze(out);
}

function diagnosticsJson(
  diagnostics: ReadonlyArray<AdoptionResult["diagnostics"][number]>,
): SyncJsonResult["diagnostics"] {
  return diagnostics.map((d) => ({
    severity: d.severity,
    code: d.code,
    message: d.message,
  }));
}

function errorPayload(input: {
  readonly branch: string | null;
  readonly error: string;
}): SyncJsonResult {
  return {
    status: "error",
    branch: input.branch,
    base: null,
    head: null,
    adoptedRef: null,
    iterations: 0,
    closureCommit: null,
    garden: emptyGardenSummary(),
    operational: emptyOperationalSummary(),
    health: emptyHealthSummary(),
    attention_required: true,
    attention: [input.error.replace(/-/g, "_")],
    next_actions: nextActionsForSync({
      attention: [input.error.replace(/-/g, "_")],
    }),
    diagnostics: [],
    error: input.error,
  };
}

function summarizeGarden(
  garden: GardenPhaseResult | null,
): SyncGardenSummary {
  if (garden === null) return emptyGardenSummary();
  return Object.freeze({
    subProposalCount: garden.subProposalCount,
    rejectedPatchCount: garden.rejectedPatchCount,
    diagnosticCount: garden.diagnostics.length,
  });
}

function summarizeOperational(
  operational: OperationalWorkResult | null,
): SyncOperationalSummary {
  if (operational === null) return emptyOperationalSummary();
  return Object.freeze({
    scheduledCount: operational.scheduler.fired.length,
    jobCount: operational.jobs.drained.length,
    outboxCount: operational.outbox.length,
    autoResolvedQuestions: operational.questionAutoResolution.answered,
    diagnosticCount: operational.diagnostics.length,
  });
}

function emptyGardenSummary(): SyncGardenSummary {
  return Object.freeze({
    subProposalCount: 0,
    rejectedPatchCount: 0,
    diagnosticCount: 0,
  });
}

function emptyOperationalSummary(): SyncOperationalSummary {
  return Object.freeze({
    scheduledCount: 0,
    jobCount: 0,
    outboxCount: 0,
    autoResolvedQuestions: 0,
    diagnosticCount: 0,
  });
}

function emptyHealthSummary(): SyncHealthSummary {
  return Object.freeze({
    pendingRuns: 0,
    orphanRuns: 0,
    failedRuns: 0,
    diagnostics: 0,
    contentDiagnostics: 0,
    unlocatedDiagnostics: 0,
    attentionDiagnostics: 0,
    questions: 0,
    outboxPending: 0,
    outboxFailed: 0,
    quarantined: 0,
  });
}

async function collectSyncHealth(vault: Vault): Promise<SyncHealthSummary> {
  const summary = await vault.operationalSummary();
  return Object.freeze({
    pendingRuns: summary.pendingRuns,
    orphanRuns: summary.orphanRuns,
    failedRuns: summary.failedRuns,
    diagnostics: summary.contentDiagnostics,
    contentDiagnostics: summary.contentDiagnostics,
    unlocatedDiagnostics: summary.unlocatedDiagnostics,
    attentionDiagnostics: summary.attentionDiagnostics,
    questions: summary.openQuestions,
    outboxPending: summary.outboxPending,
    outboxFailed: summary.outboxFailed,
    quarantined: summary.quarantined,
  });
}

/**
 * Emit a one-line `--json` error payload for the usage-error / runtime-
 * open-failure paths. The structure mirrors `SyncJsonResult` so a
 * downstream consumer can parse a single shape regardless of outcome.
 */
function emitErrorJson(input: {
  readonly branch: string | null;
  readonly error: string;
  readonly message: string;
}): void {
  const payload: SyncJsonResult = {
    status: "error",
    branch: input.branch,
    base: null,
    head: null,
    adoptedRef: null,
    iterations: 0,
    closureCommit: null,
    garden: emptyGardenSummary(),
    operational: emptyOperationalSummary(),
    health: emptyHealthSummary(),
    attention_required: true,
    attention: [input.error.replace(/-/g, "_")],
    next_actions: nextActionsForSync({
      attention: [input.error.replace(/-/g, "_")],
    }),
    diagnostics: [],
    error: input.error,
  };
  console.log(formatJson(payload));
  // Mirror the human-readable message on stderr too — JSON consumers
  // ignore stderr; humans grep-ing find it.
  console.error(input.message);
}
