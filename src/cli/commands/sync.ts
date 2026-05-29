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
// `src/engine/compiler-host.ts`; this command is the host's per-tick body invoked
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

import { resolve } from "node:path";

import { openVaultRuntime, type VaultRuntime } from "../../engine/vault-runtime";
import type { AdoptionResult } from "../../core/proposal";
import {
  runCompilerHostTick,
  type CompilerHostTickResult,
} from "../../engine/compiler-host";
import type { GardenPhaseResult } from "../../engine/garden";
import type { OperationalWorkResult } from "../../engine/operational-work";
import {
  resolveBundleRoots,
  formatFilteredAdoptEvent,
  printHostFollowupLines,
} from "./sync-shared";
import { formatJson } from "../format";
import { queryRuns, type RunStatus } from "../../ledger/runs";
import { queryOutbox } from "../../outbox/dispatch";
import { queryQuestions } from "../../projections/questions";

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
  readonly diagnosticCount: number;
};

type SyncHealthSummary = {
  readonly pendingRuns: number;
  readonly failedRuns: number;
  readonly questions: number;
  readonly outboxPending: number;
  readonly outboxFailed: number;
  readonly quarantined: number;
};

const SYNC_PROBLEM_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "failed",
  "timed_out",
  "cancelled",
]);

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
  const vaultPath = resolve(options.vault ?? process.cwd());

  const bundleRoots = resolveBundleRoots({
    vaultPath,
    bundlesRoot: options.bundlesRoot,
  });

  const jsonMode = options.json === true;
  const verbose = options.verbose === true;
  const quiet = options.quiet === true && !jsonMode;

  // ----- 2. Open the runtime ------------------------------------------------
  const runtimeResult = await openVaultRuntime({ vaultPath, ...bundleRoots });
  if (!runtimeResult.ok) {
    const msg = `dome sync: openVaultRuntime failed (${runtimeResult.error.kind}). Run \`dome init\` to initialize the vault.`;
    if (jsonMode) {
      emitErrorJson({
        branch: null,
        error: runtimeResult.error.kind,
        message: msg,
      });
    } else {
      console.error(msg);
    }
    return 1;
  }
  const runtime = runtimeResult.value;

  // ----- 3. Run one compiler-host tick --------------------------------------
  try {
    const tick = await runCompilerHostTick({
      runtime,
      ...(verbose && !quiet && !jsonMode
        ? {
            onEvent: (e) => {
              const line = formatFilteredAdoptEvent(e, {
                command: "sync",
                ...(options.filterProcessor !== undefined
                  ? { processorFilter: options.filterProcessor }
                  : {}),
              });
              if (line !== null) console.log(line);
            },
          }
        : {}),
    });
    if (jsonMode) {
      console.log(formatJson(tickResultJson(tick, collectSyncHealth(runtime))));
    } else {
      printTickLines(tick, { quiet });
    }
    return exitCodeForTick(tick);
  } finally {
    await runtime.close();
  }
}

// ----- Internals ------------------------------------------------------------

/**
 * Render the adoption result as a small block of lines on stdout. The
 * shape mirrors `dome status`'s key-aligned summary — one fact per line
 * — rather than a single dense line; `dome sync` runs interactively and
 * the operator wants the result legible.
 *
 *   dome sync: adopted main: abc1234..def5678 (0 diagnostics, 1 iteration)
 *
 * On block: lists the first blocking diagnostic's code + message and
 * notes the total count.
 */
function printTickLines(
  tick: CompilerHostTickResult,
  opts: { readonly quiet: boolean },
): void {
  if (tick.kind === "busy") {
    console.error(
      `dome sync: branch ${tick.branch} is already being processed by another Dome host.`,
    );
    return;
  }
  if (tick.kind === "in-sync") {
    if (opts.quiet) return;
    console.log(
      `dome sync: already in sync (${tick.finalAdoptedRef.slice(0, 7)} on ${tick.branch})`,
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

  const result = tick.adoption;
  const diagCount = result.diagnostics.length;
  const iters = result.iterations;

  if (result.adopted) {
    if (opts.quiet) return;
    const range =
      tick.drift.base === tick.drift.head
        ? tick.drift.head.slice(0, 7)
        : `${tick.drift.base.slice(0, 7)}..${tick.drift.head.slice(0, 7)}`;
    console.log(
      `dome sync: adopted ${tick.branch}: ${range} ` +
        `(${diagCount} diagnostic${diagCount === 1 ? "" : "s"}, ` +
        `${iters} iteration${iters === 1 ? "" : "s"})`,
    );
    printHostFollowupLines("dome sync", tick.garden, tick.operational);
    return;
  }

  console.error(
    `dome sync: blocked ${tick.branch}: ${diagCount} diagnostic${diagCount === 1 ? "" : "s"} ` +
      `(adopted ref unchanged at ${result.adoptedRef.slice(0, 7)})`,
  );
  const blockers = result.diagnostics.filter((d) => d.severity === "block");
  for (const d of blockers.slice(0, 5)) {
    console.error(`  [${d.code}] ${d.message}`);
  }
  if (blockers.length > 5) {
    console.error(`  ... and ${blockers.length - 5} more (see \`dome inspect diagnostics\`).`);
  }
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
  if (input.health.pendingRuns > 0) out.push("pending_runs");
  if (input.health.failedRuns > 0) out.push("failed_runs");
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
    diagnosticCount: 0,
  });
}

function emptyHealthSummary(): SyncHealthSummary {
  return Object.freeze({
    pendingRuns: 0,
    failedRuns: 0,
    questions: 0,
    outboxPending: 0,
    outboxFailed: 0,
    quarantined: 0,
  });
}

function collectSyncHealth(runtime: VaultRuntime): SyncHealthSummary {
  return Object.freeze({
    pendingRuns: countRunsByStatus(runtime, ["queued", "running"]),
    failedRuns: countLatestProblemRuns(runtime),
    questions: queryQuestions(runtime.projectionDb, { resolved: false }).length,
    outboxPending: queryOutbox(runtime.outboxDb, { status: "pending" }).length,
    outboxFailed: queryOutbox(runtime.outboxDb, { status: "failed" }).length,
    quarantined: runtime.processorRuntime.executionState.quarantines().length,
  });
}

function countLatestProblemRuns(runtime: VaultRuntime): number {
  const seen = new Set<string>();
  let total = 0;
  for (const row of queryRuns(runtime.ledgerDb)) {
    if (seen.has(row.processorId)) continue;
    seen.add(row.processorId);
    if (SYNC_PROBLEM_RUN_STATUSES.has(row.status)) total++;
  }
  return total;
}

function countRunsByStatus(
  runtime: VaultRuntime,
  statuses: ReadonlyArray<RunStatus>,
): number {
  let total = 0;
  for (const status of statuses) {
    total += queryRuns(runtime.ledgerDb, { status }).length;
  }
  return total;
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
    diagnostics: [],
    error: input.error,
  };
  console.log(formatJson(payload));
  // Mirror the human-readable message on stderr too — JSON consumers
  // ignore stderr; humans grep-ing find it.
  console.error(input.message);
}
