// cli/commands/serve: the `dome serve` daemon — Phase 11b of v1.0.
//
// Per docs/v1.md §4.1 ("Local eventual mode") + §13.2 ("Claude Code edits
// project notes") + docs/wiki/specs/cli.md §"dome serve" +
// docs/wiki/specs/harnesses.md §"Native write + watcher pickup", this is
// **surface 3** of the four compiler-boundary surfaces. It watches the
// current branch's HEAD for drift against `refs/dome/adopted/<branch>`
// and runs the adoption loop whenever drift appears.
//
// Watcher mechanism: **poll** (default 500ms). Poll-based watching is
// simpler than `fs.watch` on `.git/refs/heads/<branch>`, requires no
// extra dependencies (chokidar was removed in the recent cleanup), and
// 500ms latency is invisible to a user editing + committing markdown.
// The interval is configurable via `--poll-interval-ms <n>`.
//
// Drift detection + adoption-invocation live in `./sync-shared.ts`, so
// `dome serve` (Phase 11b) and `dome sync` (Phase 11c) share the same
// underlying per-tick body. The daemon wraps it in a poll loop with
// cancellation, error tolerance (one bad commit shouldn't crash a
// long-running poll), and a one-line operator-facing summary.
//
// Exit codes:
//   - 0  on graceful shutdown (SIGINT / SIGTERM / external `AbortSignal`).
//   - 1  on irrecoverable startup error (runtime open failure, detached
//        HEAD at start, malformed flags).
//
// House-style notes (matches src/cli/commands/status.ts,
// src/cli/commands/doctor.ts, src/cli/commands/init.ts):
//   - `type X = { ... }` aliases, every field `readonly`.
//   - The handler returns the exit code; the dispatcher (`src/cli/index.ts`)
//     calls `process.exit(code)`.
//   - Console output goes through `console.log` / `console.error` (matching
//     status/doctor).

import { resolve } from "node:path";

import { openVaultRuntime, type VaultRuntime } from "../../engine/vault-runtime";
import type { AdoptionResult } from "../../core/proposal";
import { getCurrentBranch } from "../../adopted-ref";

import {
  detectDrift,
  resolveShippedBundlesRoot,
  runOneAdoption,
  type DriftInfo,
} from "./sync-shared";

import type { ParsedArgs } from "../args";

// ----- Constants ------------------------------------------------------------

/**
 * Default poll interval. 500ms is imperceptible to a human committing
 * markdown and small enough that the daemon picks up a `git commit`
 * before the user reaches the next shell prompt. Reducing this below
 * 100ms risks busy-looping a quiet vault; raising it above ~2000ms makes
 * the daemon feel laggy.
 */
const DEFAULT_POLL_INTERVAL_MS = 500;

// ----- Public types ---------------------------------------------------------

/**
 * Optional knobs for `runServe`. The CLI dispatcher invokes `runServe`
 * with just `(args)`, but tests pass a `signal` so they can stop the
 * loop without depending on real OS-signal delivery.
 */
export type RunServeOpts = {
  /**
   * External cancellation source. When the signal aborts, the daemon
   * exits its poll loop cleanly (just like SIGINT). Tests use this to
   * deterministically stop the loop after asserting on the side effects;
   * production callers leave it unset and rely on the SIGINT/SIGTERM
   * handlers registered inside `runServe`.
   */
  readonly signal?: AbortSignal;
};

// ----- runServe -------------------------------------------------------------

/**
 * Execute `dome serve`. Watches `refs/heads/<branch>` for drift against
 * `refs/dome/adopted/<branch>` and runs adoption on each tick of drift.
 *
 * Returns the exit code (0 on graceful shutdown, 1 on startup failure).
 * Never throws on expected I/O paths — runtime open failures, missing
 * HEAD, detached-HEAD startup all surface as exit-1 with an explanatory
 * stderr message.
 *
 * @param args   parsed CLI args (consults `--vault`, `--bundles-root`,
 *               `--poll-interval-ms`).
 * @param opts   optional cancellation hook for tests.
 */
export async function runServe(
  args: ParsedArgs,
  opts: RunServeOpts = {},
): Promise<number> {
  // ----- 1. Parse flags -----------------------------------------------------
  const vaultFlag = args.flags["vault"];
  const vaultPath = resolve(
    typeof vaultFlag === "string" ? vaultFlag : process.cwd(),
  );

  // Default to the SDK's shipped first-party bundles. The vault-local
  // `.dome/extensions/` is no longer the default: per docs/v1.md §"Vault"
  // + §10.1, shipped bundles live with the SDK, not in every user's
  // vault. `--bundles-root <path>` overrides for vault-local third-party
  // installs or testing.
  const bundlesRootFlag = args.flags["bundles-root"];
  const bundlesRoot =
    typeof bundlesRootFlag === "string"
      ? bundlesRootFlag
      : resolveShippedBundlesRoot();

  const pollIntervalMs = parsePollInterval(args.flags["poll-interval-ms"]);
  if (pollIntervalMs === null) {
    console.error(
      "dome serve: --poll-interval-ms must be a positive integer.",
    );
    return 1;
  }

  // ----- 2. Resolve initial branch ------------------------------------------
  // A detached HEAD has no branch name; the adopted-ref substrate requires
  // a branch to namespace under. Refuse to start so the operator sees a
  // clear actionable error instead of a daemon that does nothing. The
  // shared `detectDrift` returns `detached-head` for this state; serve
  // checks once at startup so the operator-facing error fires before the
  // runtime is opened.
  const startupDrift = await detectDrift(vaultPath);
  if (startupDrift.kind === "detached-head") {
    console.error(
      `dome serve: HEAD is detached at ${vaultPath}. The adopted-ref substrate requires a branch. Check out a branch and retry.`,
    );
    return 1;
  }

  // ----- 3. Open the runtime ------------------------------------------------
  const runtimeResult = await openVaultRuntime({ vaultPath, bundlesRoot });
  if (!runtimeResult.ok) {
    console.error(
      `dome serve: openVaultRuntime failed (${runtimeResult.error.kind}). Run \`dome init\` to initialize the vault.`,
    );
    return 1;
  }
  const runtime = runtimeResult.value;

  // ----- 4. Print startup banner --------------------------------------------
  // The branch label is derived from the startup drift result. `in-sync`
  // / `drift` both carry the resolved branch; `no-commits` does not, so
  // we re-resolve via `getCurrentBranch` (an unborn branch has a name —
  // `main` after `git init` — even though `HEAD` resolves to null).
  const startupBranch =
    startupDrift.kind === "in-sync"
      ? startupDrift.branch
      : startupDrift.kind === "drift"
        ? startupDrift.info.branch
        : ((await getCurrentBranch(vaultPath)) ?? "(unknown)");
  console.log(
    `dome serve: watching ${startupBranch} at ${vaultPath} (poll ${pollIntervalMs}ms)`,
  );

  // ----- 5. Register cancellation handlers ----------------------------------
  // A single `AbortController` unifies three cancel paths: SIGINT, SIGTERM,
  // and the externally-supplied `opts.signal`. Anywhere we'd `await`, we
  // race the await against `controller.signal` so the loop exits promptly
  // (not on the next poll-tick) when a cancel arrives.
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) {
      controller.abort();
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  const onSigint = (): void => controller.abort();
  const onSigterm = (): void => controller.abort();
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  // ----- 6. Run the poll loop -----------------------------------------------
  try {
    await pollLoop({
      runtime,
      vaultPath,
      pollIntervalMs,
      cancel: controller.signal,
    });
  } finally {
    // Detach signal handlers BEFORE closing the runtime, so a stray
    // signal that arrives during close doesn't fire a handler against an
    // aborted controller (no-op, but avoids the listener-leak warning
    // when many serves are chained in tests).
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (opts.signal !== undefined) {
      opts.signal.removeEventListener("abort", onAbort);
    }
    await runtime.close();
  }

  console.log("dome serve: shutting down");
  return 0;
}

// ----- Internals ------------------------------------------------------------

/**
 * The poll loop. Runs until `cancel` aborts. Each iteration:
 *   1. Detect drift between HEAD and the adopted ref.
 *   2. If drift, build a manual Proposal and run `adopt()`.
 *   3. Sleep for `pollIntervalMs` (cancellable).
 *
 * Each iteration runs to completion (adoption is not interrupted mid-run)
 * — `cancel` is only honored at the sleep boundary or the start of the
 * next iteration.
 *
 * Mid-run state changes (e.g., the user `git checkout`s a detached HEAD
 * while the daemon is sleeping) surface as a non-`drift` `detectDrift`
 * result the next iteration; the loop logs and skips rather than
 * crashing.
 */
async function pollLoop(input: {
  readonly runtime: VaultRuntime;
  readonly vaultPath: string;
  readonly pollIntervalMs: number;
  readonly cancel: AbortSignal;
}): Promise<void> {
  const { runtime, vaultPath, pollIntervalMs, cancel } = input;

  // `lastKind` suppresses repeated log lines when the daemon enters an
  // unworkable state mid-run (detached HEAD, no-commits). The operator
  // gets one notification on transition, not one per poll tick.
  let lastKind: string | null = null;

  while (!cancel.aborted) {
    const drift = await detectDrift(vaultPath);
    if (drift.kind === "drift") {
      await runOneAdoptionWithErrorHandling({
        runtime,
        drift: drift.info,
      });
    } else if (drift.kind === "detached-head" && lastKind !== "detached-head") {
      // Operator detached HEAD mid-run. Log once on transition and keep
      // polling — they can re-attach and the loop picks back up.
      console.error(
        "dome serve: HEAD became detached; pausing adoption until a branch is checked out again.",
      );
    }
    // `in-sync` and `no-commits` are quiet steady states; no log spam.
    lastKind = drift.kind;

    if (cancel.aborted) break;
    await sleep(pollIntervalMs, cancel);
  }
}

/**
 * One adoption cycle wrapper: call the shared `runOneAdoption`, print
 * the one-line summary, swallow throws.
 *
 * Errors from `adopt()` (an unhandled throw from the engine, processor
 * runtime, or projection sink) are caught here so a single bad commit
 * does not crash the daemon. The error surfaces on stderr; the loop
 * continues to the next iteration.
 */
async function runOneAdoptionWithErrorHandling(input: {
  readonly runtime: VaultRuntime;
  readonly drift: DriftInfo;
}): Promise<void> {
  const { runtime, drift } = input;

  try {
    const result = await runOneAdoption({ runtime, drift });
    printAdoptionLine(drift.branch, result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`dome serve: adoption threw: ${msg}`);
  }
}

/**
 * Render the adoption result as a single line on stdout. The format
 * mirrors the operator-facing summary the serve banner sets up:
 *
 *   dome serve: adopted main 41a98c2 (0 diagnostics, 1 iteration)
 *   dome serve: blocked main: 3 diagnostics — first: <message>
 *
 * Diagnostics counts are total; the first blocking diagnostic's message
 * is appended for the blocked case so the operator sees what to fix
 * without reaching for `dome doctor`.
 */
function printAdoptionLine(branch: string, result: AdoptionResult): void {
  const diagCount = result.diagnostics.length;
  const iters = result.iterations;
  if (result.adopted) {
    console.log(
      `dome serve: adopted ${branch} ${result.adoptedRef.slice(0, 7)} ` +
        `(${diagCount} diagnostic${diagCount === 1 ? "" : "s"}, ` +
        `${iters} iteration${iters === 1 ? "" : "s"})`,
    );
    return;
  }

  const blocker = result.diagnostics.find((d) => d.severity === "block");
  const blockerMsg = blocker !== undefined ? ` — ${blocker.message}` : "";
  console.error(
    `dome serve: blocked ${branch}: ${diagCount} diagnostic${diagCount === 1 ? "" : "s"}${blockerMsg}`,
  );
}

/**
 * Sleep for `ms` milliseconds, returning early when `signal` aborts.
 * The promise resolves either way (no rejection on cancel) — the caller's
 * loop body checks `signal.aborted` after the await.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolveSleep) => {
    if (signal.aborted) {
      resolveSleep();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbortSleep = (): void => {
      if (timer !== null) clearTimeout(timer);
      resolveSleep();
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbortSleep);
      resolveSleep();
    }, ms);
    signal.addEventListener("abort", onAbortSleep, { once: true });
  });
}

/**
 * Parse `--poll-interval-ms`. Defaults when absent; rejects malformed
 * values (the caller surfaces a usage error). Boolean `true` (the flag
 * was supplied without a value) falls through to the default; boolean
 * `false` is not a value any parser emits but is treated as malformed
 * for symmetry with `doctor`'s `parseLimit`.
 */
function parsePollInterval(raw: string | boolean | undefined): number | null {
  if (raw === undefined || raw === true) return DEFAULT_POLL_INTERVAL_MS;
  if (raw === false) return null;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) return null;
  return n;
}
