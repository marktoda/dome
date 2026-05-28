// cli/commands/sync: the `dome sync` command — Phase 11c of v1.0.
//
// Runs adoption exactly once for the current HEAD vs the adopted ref,
// prints the AdoptionResult, exits. This is the manual trigger for users
// who don't want a `dome serve` daemon running continuously.
//
// Per docs/wiki/specs/cli.md §"dome sync" + docs/wiki/specs/adoption.md
// §"dome sync":
//
//   - Construct a Proposal from `adopted..HEAD` (or the empty-diff init
//     when the adopted ref is uninitialized).
//   - Run it through the engine's adoption loop.
//   - Print a one-line summary (or a `--json` structured object).
//   - Exit.
//
// Drift detection + adoption-invocation are shared with `dome serve` via
// `./sync-shared.ts`; this command is the daemon's per-tick body invoked
// exactly once and surfaced with a CLI-shaped output / exit code.
//
// Exit codes:
//   - 0   on successful adoption (or no-drift no-op).
//   - 1   on blocked adoption (the engine reported `adopted: false` with
//         block-severity diagnostics; the operator addresses the blocks
//         and re-runs sync).
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
  formatAdoptEvent,
  resolveShippedBundlesRoot,
  runOneAdoption,
} from "./sync-shared";
import { formatJson } from "../format";

import type { ParsedArgs } from "../args";

// ----- Public types ---------------------------------------------------------

/**
 * The shape `dome sync --json` emits on stdout. Stable across runs;
 * downstream tooling reads it. `status` discriminates the four outcomes
 * the command can report.
 *
 *   - `adopted`     — adoption succeeded; the adopted ref advanced (or
 *                     was initialized) to `head`.
 *   - `blocked`     — adoption ran but block-severity diagnostics
 *                     prevented the adopted ref from advancing. `head`
 *                     reflects the working-tree HEAD that was attempted.
 *   - `in-sync`     — HEAD already equals the adopted ref; no work done.
 *   - `error`       — detached HEAD or no commits; the substrate cannot
 *                     operate. `branch` is null in this case.
 */
type SyncJsonResult = {
  readonly status: "adopted" | "blocked" | "in-sync" | "error";
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

// ----- runSync --------------------------------------------------------------

/**
 * Execute `dome sync`. Returns the exit code.
 *
 * Read flags:
 *   - `--vault <path>`         override vault path (default: cwd).
 *   - `--bundles-root <path>`  override extensions root.
 *   - `--json`                 emit a single JSON object on stdout.
 */
export async function runSync(args: ParsedArgs): Promise<number> {
  // ----- 1. Parse flags -----------------------------------------------------
  const vaultFlag = args.flags["vault"];
  const vaultPath = resolve(
    typeof vaultFlag === "string" ? vaultFlag : process.cwd(),
  );

  // Default to the SDK's shipped first-party bundles. See serve.ts /
  // sync-shared.ts `resolveShippedBundlesRoot` for the rationale.
  const bundlesRootFlag = args.flags["bundles-root"];
  const bundlesRoot =
    typeof bundlesRootFlag === "string"
      ? bundlesRootFlag
      : resolveShippedBundlesRoot();

  const jsonMode = args.flags["json"] === true;
  const verbose =
    args.flags["verbose"] === true || args.flags["v"] === true;

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
    if (jsonMode) {
      const payload: SyncJsonResult = {
        status: "in-sync",
        branch: drift.branch,
        base: drift.head,
        head: drift.head,
        adoptedRef: drift.head,
        iterations: 0,
        closureCommit: null,
        diagnostics: [],
      };
      console.log(formatJson(payload));
    } else {
      console.log(
        `dome sync: already in sync (${drift.head.slice(0, 7)} on ${drift.branch})`,
      );
    }
    return 0;
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

  // ----- 4. Run one adoption cycle ------------------------------------------
  try {
    const result = await runOneAdoption({
      runtime,
      drift: drift.info,
      ...(verbose && !jsonMode
        ? { onEvent: (e) => console.log(formatAdoptEvent(e)) }
        : {}),
    });
    if (jsonMode) {
      console.log(formatJson(adoptionResultJson(drift.info.branch, drift.info, result)));
    } else {
      printAdoptionLines(drift.info.branch, drift.info, result);
    }
    return result.adopted ? 0 : 1;
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
function printAdoptionLines(
  branch: string,
  drift: { readonly base: string; readonly head: string },
  result: AdoptionResult,
): void {
  const diagCount = result.diagnostics.length;
  const iters = result.iterations;

  if (result.adopted) {
    const range =
      drift.base === drift.head
        ? drift.head.slice(0, 7)
        : `${drift.base.slice(0, 7)}..${drift.head.slice(0, 7)}`;
    console.log(
      `dome sync: adopted ${branch}: ${range} ` +
        `(${diagCount} diagnostic${diagCount === 1 ? "" : "s"}, ` +
        `${iters} iteration${iters === 1 ? "" : "s"})`,
    );
    return;
  }

  console.error(
    `dome sync: blocked ${branch}: ${diagCount} diagnostic${diagCount === 1 ? "" : "s"} ` +
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
function adoptionResultJson(
  branch: string,
  drift: { readonly base: string; readonly head: string },
  result: AdoptionResult,
): SyncJsonResult {
  return {
    status: result.adopted ? "adopted" : "blocked",
    branch,
    base: drift.base,
    head: drift.head,
    adoptedRef: result.adoptedRef,
    iterations: result.iterations,
    closureCommit: result.closureCommitOid,
    diagnostics: result.diagnostics.map((d) => ({
      severity: d.severity,
      code: d.code,
      message: d.message,
    })),
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
