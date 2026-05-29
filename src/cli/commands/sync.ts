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

import { openVaultRuntime } from "../../engine/vault-runtime";
import type { AdoptionResult } from "../../core/proposal";
import {
  detectDrift,
  runCompilerHostTick,
  type CompilerHostTickResult,
  type DriftResult,
} from "../../engine/compiler-host";
import {
  formatAdoptEvent,
  resolveShippedBundlesRoot,
} from "./sync-shared";
import { formatJson } from "../format";

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
 *   - `error`       — detached HEAD or no commits; the substrate cannot
 *                     operate. `branch` is null in this case.
 */
type SyncJsonResult = {
  readonly status: "adopted" | "blocked" | "in-sync" | "busy" | "error";
  readonly branch: string | null;
  readonly base: string | null;
  readonly head: string | null;
  readonly adoptedRef: string | null;
  readonly iterations: number;
  readonly closureCommit: string | null;
  readonly diagnostics: ReadonlyArray<{
    readonly severity: string;
    readonly code: string;
    readonly message: string;
  }>;
  readonly error?: string;
};

export type RunSyncOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
  readonly verbose?: boolean | undefined;
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

  // Default to the SDK's shipped first-party bundles. See serve.ts /
  // sync-shared.ts `resolveShippedBundlesRoot` for the shipped-bundle path.
  const bundlesRoot = options.bundlesRoot ?? resolveShippedBundlesRoot();

  const jsonMode = options.json === true;
  const verbose = options.verbose === true;

  // ----- 2. Detect drift ----------------------------------------------------
  // The shared helper short-circuits the unworkable states (detached
  // HEAD, no commits) before we open the runtime, so we surface the
  // usage error cheaply.
  const drift = await detectDrift(vaultPath);

  if (drift.kind === "detached-head") {
    const msg = `dome sync: HEAD is detached at ${vaultPath}. The adopted-ref substrate requires a branch. Check out a branch and retry.`;
    if (jsonMode) {
      emitErrorJson({ branch: null, error: "detached-head", message: msg });
    } else {
      console.error(msg);
    }
    return 64;
  }
  if (drift.kind === "no-commits") {
    const msg = `dome sync: vault at ${vaultPath} has no commits yet. Make an initial commit and retry.`;
    if (jsonMode) {
      emitErrorJson({ branch: null, error: "no-commits", message: msg });
    } else {
      console.error(msg);
    }
    return 64;
  }
  if (drift.kind === "in-sync") {
    return runInSyncOperationalWork({
      vaultPath,
      bundlesRoot,
      drift,
      jsonMode,
    });
  }

  // ----- 3. Open the runtime ------------------------------------------------
  const runtimeResult = await openVaultRuntime({ vaultPath, bundlesRoot });
  if (!runtimeResult.ok) {
    const msg = `dome sync: openVaultRuntime failed (${runtimeResult.error.kind}). Run \`dome init\` to initialize the vault.`;
    if (jsonMode) {
      emitErrorJson({
        branch: drift.info.branch,
        error: runtimeResult.error.kind,
        message: msg,
      });
    } else {
      console.error(msg);
    }
    return 1;
  }
  const runtime = runtimeResult.value;

  // ----- 4. Run one compiler-host tick --------------------------------------
  try {
    const tick = await runCompilerHostTick({
      runtime,
      drift,
      ...(verbose && !jsonMode
        ? {
            onEvent: (e) =>
              console.log(formatAdoptEvent(e, { command: "sync" })),
          }
        : {}),
    });
    if (jsonMode) {
      console.log(formatJson(tickResultJson(tick)));
    } else {
      printTickLines(tick);
    }
    if (tick.kind === "busy") return 75;
    return tick.kind === "blocked" ? 1 : 0;
  } finally {
    await runtime.close();
  }
}

// ----- Internals ------------------------------------------------------------

async function runInSyncOperationalWork(opts: {
  readonly vaultPath: string;
  readonly bundlesRoot: string;
  readonly drift: Extract<DriftResult, { readonly kind: "in-sync" }>;
  readonly jsonMode: boolean;
}): Promise<number> {
  const runtimeResult = await openVaultRuntime({
    vaultPath: opts.vaultPath,
    bundlesRoot: opts.bundlesRoot,
  });
  if (!runtimeResult.ok) {
    const msg = `dome sync: openVaultRuntime failed (${runtimeResult.error.kind}). Run \`dome init\` to initialize the vault.`;
    if (opts.jsonMode) {
      emitErrorJson({
        branch: opts.drift.branch,
        error: runtimeResult.error.kind,
        message: msg,
      });
    } else {
      console.error(msg);
    }
    return 1;
  }
  const runtime = runtimeResult.value;
  let tick: CompilerHostTickResult;
  try {
    tick = await runCompilerHostTick({
      runtime,
      drift: opts.drift,
    });
  } finally {
    await runtime.close();
  }

  if (opts.jsonMode) {
    console.log(formatJson(tickResultJson(tick)));
  } else {
    printTickLines(tick);
  }
  return tick.kind === "busy" ? 75 : 0;
}

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
function printTickLines(tick: CompilerHostTickResult): void {
  if (tick.kind === "busy") {
    console.error(
      `dome sync: branch ${tick.branch} is already being processed by another Dome host.`,
    );
    return;
  }
  if (tick.kind === "in-sync") {
    console.log(
      `dome sync: already in sync (${tick.finalAdoptedRef.slice(0, 7)} on ${tick.branch})`,
    );
    return;
  }
  if (tick.kind === "detached-head" || tick.kind === "no-commits") return;

  const result = tick.adoption;
  const diagCount = result.diagnostics.length;
  const iters = result.iterations;

  if (result.adopted) {
    const range =
      tick.drift.base === tick.drift.head
        ? tick.drift.head.slice(0, 7)
        : `${tick.drift.base.slice(0, 7)}..${tick.drift.head.slice(0, 7)}`;
    console.log(
      `dome sync: adopted ${tick.branch}: ${range} ` +
        `(${diagCount} diagnostic${diagCount === 1 ? "" : "s"}, ` +
        `${iters} iteration${iters === 1 ? "" : "s"})`,
    );
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

/**
 * Build the `--json` payload for a completed adoption (adopted or
 * blocked). Diagnostics are projected to a stable, stringly-typed shape
 * — downstream tooling reads `severity` / `code` / `message` and ignores
 * the rest of the DiagnosticEffect (sourceRefs are tied to internal
 * commit/blob OIDs that aren't useful to a CLI consumer in v1.0).
 */
function tickResultJson(tick: CompilerHostTickResult): SyncJsonResult {
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
      diagnostics: [],
      error: "compiler-host-busy",
    };
  }
  if (tick.kind === "in-sync") {
    return {
      status: "in-sync",
      branch: tick.branch,
      base: tick.head,
      head: tick.head,
      adoptedRef: tick.finalAdoptedRef,
      iterations: 0,
      closureCommit: null,
      diagnostics: diagnosticsJson(tick.operational?.diagnostics ?? []),
    };
  }
  const result = tick.adoption;
  return {
    status: result.adopted ? "adopted" : "blocked",
    branch: tick.branch,
    base: tick.drift.base,
    head: tick.drift.head,
    adoptedRef: tick.finalAdoptedRef,
    iterations: result.iterations,
    closureCommit: result.closureCommitOid,
    diagnostics: diagnosticsJson([
      ...result.diagnostics,
      ...(tick.operational?.diagnostics ?? []),
    ]),
  };
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
    diagnostics: [],
    error: input.error,
  };
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
    diagnostics: [],
    error: input.error,
  };
  console.log(formatJson(payload));
  // Mirror the human-readable message on stderr too — JSON consumers
  // ignore stderr; humans grep-ing find it.
  console.error(input.message);
}
