// cli/commands/serve: the `dome serve` daemon — Phase 11b of v1.0.
//
// Per docs/v1.md §4.1 ("Local eventual mode") + §13.2 ("Claude Code edits
// project notes") + docs/wiki/specs/cli.md §"dome serve" +
// docs/wiki/specs/harnesses.md §"Native write + compiler-host pickup", this is
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
// Drift detection + adoption-invocation live in `src/engine/compiler-host.ts`,
// so `dome serve` (Phase 11b) and `dome sync` (Phase 11c) share the same
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
import type { OperationalWorkResult } from "../../engine/operational-work";
import { getCurrentBranch } from "../../adopted-ref";

import {
  detectDrift,
  runCompilerHostTick,
  type CompilerHostTickResult,
  type DriftResult,
} from "../../engine/compiler-host";
import {
  clearServeHeartbeat,
  createServeHeartbeatHandle,
  writeServeHeartbeat,
  type ServeHeartbeatHandle,
} from "../../engine/compiler-host-heartbeat";
import {
  resolveBundleRoots,
  formatFilteredAdoptEvent,
  printHostFollowupLines,
} from "./sync-shared";
import { parsePositiveIntegerValue } from "../parse-options";

// ----- Constants ------------------------------------------------------------

/**
 * Default poll interval. 500ms is imperceptible to a human committing
 * markdown and small enough that the daemon picks up a `git commit`
 * before the user reaches the next shell prompt. Reducing this below
 * 100ms risks busy-looping a quiet vault; raising it above ~2000ms makes
 * the daemon feel laggy.
 */
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_OPERATIONAL_INTERVAL_MS = 1000;

// ----- Public types ---------------------------------------------------------

/**
 * Optional CLI knobs for `runServe`. Runtime-only controls, such as test
 * cancellation, live in `RunServeRuntimeOptions`.
 */
export type RunServeOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly pollIntervalMs?: string | number | boolean | undefined;
  readonly verbose?: boolean | undefined;
  readonly quiet?: boolean | undefined;
  readonly filterProcessor?: string | undefined;
};

export type RunServeRuntimeOptions = {
  /**
   * External cancellation source. When the signal aborts, the daemon
   * exits its poll loop cleanly (just like SIGINT). Tests use this to
   * deterministically stop the loop after asserting on the side effects;
   * production callers leave it unset and rely on the SIGINT/SIGTERM
   * handlers registered inside `runServe`.
   */
  readonly signal?: AbortSignal;
  /**
   * Internal/test knob for due scheduler/job/outbox work while HEAD is
   * already adopted. Production uses DEFAULT_OPERATIONAL_INTERVAL_MS.
   */
  readonly operationalIntervalMs?: number;
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
 * @param options CLI options from Commander or direct tests.
 * @param opts    optional cancellation hook for tests.
 */
export async function runServe(
  options: RunServeOptions = {},
  opts: RunServeRuntimeOptions = {},
): Promise<number> {
  // ----- 1. Parse flags -----------------------------------------------------
  const vaultPath = resolve(options.vault ?? process.cwd());

  const bundleRoots = resolveBundleRoots({
    vaultPath,
    bundlesRoot: options.bundlesRoot,
  });

  const pollIntervalMs = parsePollInterval(options.pollIntervalMs);
  if (pollIntervalMs === null) {
    console.error(
      "dome serve: --poll-interval-ms must be a positive integer.",
    );
    return 1;
  }

  // Verbose mode: emit per-iteration + per-processor structured lines via
  // the shared `formatAdoptEvent` formatter. Default mode keeps the
  // one-line-per-commit summary; verbose adds 1-3 indented lines per
  // adoption cycle (iteration-start, processor-result(s), iteration-end).
  const verbose = options.verbose === true;
  const quiet = options.quiet === true;

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
  const runtimeResult = await openVaultRuntime({ vaultPath, ...bundleRoots });
  if (!runtimeResult.ok) {
    console.error(
      `dome serve: openVaultRuntime failed (${runtimeResult.error.kind}). Run \`dome init\` to initialize the vault.`,
    );
    return 1;
  }
  const runtime = runtimeResult.value;

  // ----- 4. Print startup banner --------------------------------------------
  // The branch label is derived from the startup drift result. `in-sync`,
  // `drift`, and `diverged` carry the resolved branch; `no-commits` does not, so
  // we re-resolve via `getCurrentBranch` (an unborn branch has a name —
  // `main` after `git init` — even though `HEAD` resolves to null).
  const startupBranch =
    startupDrift.kind === "in-sync"
      ? startupDrift.branch
      : startupDrift.kind === "drift"
        ? startupDrift.info.branch
        : startupDrift.kind === "diverged"
          ? startupDrift.branch
        : ((await getCurrentBranch(vaultPath)) ?? "(unknown)");
  if (!quiet) {
    console.log(
      `dome serve: watching ${startupBranch} at ${vaultPath} (poll ${pollIntervalMs}ms${verbose ? ", verbose" : ""})`,
    );
  }
  const heartbeat = createServeHeartbeatHandle();
  await writeServeHeartbeat({
    vaultPath,
    handle: heartbeat,
    branch: startupBranch,
    pollIntervalMs,
    operationalIntervalMs:
      opts.operationalIntervalMs ?? DEFAULT_OPERATIONAL_INTERVAL_MS,
  });

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
      operationalIntervalMs:
        opts.operationalIntervalMs ?? DEFAULT_OPERATIONAL_INTERVAL_MS,
      cancel: controller.signal,
      heartbeat,
      initialBranch: startupBranch,
      verbose,
      quiet,
      ...(options.filterProcessor !== undefined
        ? { filterProcessor: options.filterProcessor }
        : {}),
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
    try {
      await runtime.close();
    } finally {
      await clearServeHeartbeat({ vaultPath, handle: heartbeat });
    }
  }

  if (!quiet) {
    console.log("dome serve: shutting down");
  }
  return 0;
}

// ----- Internals ------------------------------------------------------------

/**
 * The poll loop. Runs until `cancel` aborts. Each iteration:
 *   1. Detect drift between HEAD and the adopted ref.
 *   2. If drift, build a manual Proposal and run `adopt()`.
 *   3. If in-sync and the operational cadence is due, drain scheduler/jobs/outbox.
 *   4. Sleep for `pollIntervalMs` (cancellable).
 *
 * Adoption still runs to completion once started. Operational outbox handler
 * attempts receive `cancel` so shutdown can abort retryable external work
 * instead of waiting for the full handler timeout; the next host run will
 * retry any pending row from durable state.
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
  readonly operationalIntervalMs: number;
  readonly cancel: AbortSignal;
  readonly heartbeat: ServeHeartbeatHandle;
  readonly initialBranch: string;
  readonly verbose: boolean;
  readonly quiet: boolean;
  readonly filterProcessor?: string | undefined;
}): Promise<void> {
  const {
    runtime,
    vaultPath,
    pollIntervalMs,
    operationalIntervalMs,
    cancel,
    heartbeat,
    initialBranch,
    verbose,
    quiet,
    filterProcessor,
  } = input;

  // `lastKind` suppresses repeated log lines when the daemon enters an
  // unworkable state mid-run (detached HEAD, no-commits). The operator
  // gets one notification on transition, not one per poll tick.
  let lastKind: string | null = null;
  let nextOperationalAtMs = 0;
  let heartbeatBranch = initialBranch;

  while (!cancel.aborted) {
    const drift = await detectDrift(vaultPath);
    heartbeatBranch = branchForHeartbeat(drift, heartbeatBranch);
    await writeServeHeartbeat({
      vaultPath,
      handle: heartbeat,
      branch: heartbeatBranch,
      pollIntervalMs,
      operationalIntervalMs,
    });
    if (drift.kind === "drift" || drift.kind === "in-sync") {
      if (verbose && !quiet) {
        if (drift.kind === "drift") {
          console.log(
            `dome serve: drift detected — adopting ${drift.info.base.slice(0, 7)}..${drift.info.head.slice(0, 7)}`,
          );
        }
      }
      const nowMs = Date.now();
      const tick = await runCompilerHostTickWithErrorHandling({
        runtime,
        drift,
        runOperationalWhenInSync:
          drift.kind === "drift" || nowMs >= nextOperationalAtMs,
        cancel,
        verbose,
        quiet,
        ...(filterProcessor !== undefined ? { filterProcessor } : {}),
        suppressBusyLine: lastKind === "busy",
      });
      if (drift.kind === "drift" || nowMs >= nextOperationalAtMs) {
        nextOperationalAtMs = nowMs + operationalIntervalMs;
      }
      lastKind = tick?.kind ?? "tick-error";
      if (tick?.kind === "adopted" && !cancel.aborted) {
        const nextDrift = await detectDrift(vaultPath);
        if (nextDrift.kind === "drift") continue;
      }
    } else if (drift.kind === "detached-head" && lastKind !== "detached-head") {
      // Operator detached HEAD mid-run. Log once on transition and keep
      // polling — they can re-attach and the loop picks back up.
      console.error(
        "dome serve: HEAD became detached; pausing adoption until a branch is checked out again.",
      );
    } else if (drift.kind === "diverged" && lastKind !== "diverged") {
      console.error(
        `dome serve: adopted ref for ${drift.branch} (${drift.adopted.slice(0, 7)}) is not an ancestor of HEAD ${drift.head.slice(0, 7)}; pausing adoption until git history is repaired.`,
      );
    }
    // `in-sync` and `no-commits` are quiet steady states; no log spam.
    if (drift.kind !== "drift" && drift.kind !== "in-sync") {
      lastKind = drift.kind;
    }

    if (cancel.aborted) break;
    await sleep(pollIntervalMs, cancel);
  }
}

function branchForHeartbeat(drift: DriftResult, fallback: string): string {
  if (drift.kind === "drift") return drift.info.branch;
  if (drift.kind === "in-sync" || drift.kind === "diverged") {
    return drift.branch;
  }
  return fallback;
}

/**
 * One compiler host tick wrapper: call the shared engine tick, print
 * summaries, swallow throws.
 *
 * Errors from the tick (an unhandled throw from the engine, processor
 * runtime, or projection sink) are caught here so a single bad commit
 * does not crash the daemon. The error surfaces on stderr; the loop
 * continues to the next iteration.
 */
async function runCompilerHostTickWithErrorHandling(input: {
  readonly runtime: VaultRuntime;
  readonly drift: DriftResult;
  readonly runOperationalWhenInSync: boolean;
  readonly cancel: AbortSignal;
  readonly verbose: boolean;
  readonly quiet: boolean;
  readonly filterProcessor?: string | undefined;
  readonly suppressBusyLine: boolean;
}): Promise<CompilerHostTickResult | null> {
  const {
    runtime,
    drift,
    runOperationalWhenInSync,
    cancel,
    verbose,
    quiet,
    filterProcessor,
    suppressBusyLine,
  } = input;

  try {
    const tick = await runCompilerHostTick({
      runtime,
      drift,
      runOperationalWhenInSync,
      signal: cancel,
      ...(verbose && !quiet
        ? {
            onEvent: (e) => {
              const line = formatFilteredAdoptEvent(e, {
                command: "serve",
                ...(filterProcessor !== undefined
                  ? { processorFilter: filterProcessor }
                  : {}),
              });
              if (line !== null) console.log(line);
            },
          }
        : {}),
    });
    if (tick.kind === "busy" && suppressBusyLine) return tick;
    printTickLine(tick, { verbose, quiet });
    return tick;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`dome serve: tick threw: ${msg}`);
    return null;
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
 * without reaching for `dome inspect diagnostics`.
 */
function printTickLine(
  tick: CompilerHostTickResult,
  opts: { readonly verbose: boolean; readonly quiet: boolean },
): void {
  if (tick.kind === "busy") {
    if (opts.quiet) return;
    console.error(
      `dome serve: branch ${tick.branch} is already being processed by another Dome host; waiting.`,
    );
    return;
  }
  if (tick.kind === "in-sync") {
    if (opts.verbose && !opts.quiet && tick.operational !== null) {
      printOperationalLine(tick.operational);
    }
    return;
  }
  if (tick.kind === "diverged") {
    if (opts.quiet) return;
    console.error(
      `dome serve: refused ${tick.branch}: adopted ref ${tick.adopted.slice(0, 7)} is not an ancestor of HEAD ${tick.head.slice(0, 7)}.`,
    );
    return;
  }
  if (tick.kind === "detached-head" || tick.kind === "no-commits") return;

  const result = tick.adoption;
  const diagCount = result.diagnostics.length;
  const iters = result.iterations;
  if (result.adopted) {
    if (!opts.quiet) {
      console.log(
        `dome serve: adopted ${tick.branch} ${tick.finalAdoptedRef.slice(0, 7)} ` +
          `(${diagCount} diagnostic${diagCount === 1 ? "" : "s"}, ` +
          `${iters} iteration${iters === 1 ? "" : "s"})`,
      );
      if (opts.verbose && tick.projectionRebuild !== null) {
        console.log(
          `dome serve: rebuilt projection cache (${tick.projectionRebuild.fileCount} files, ${tick.projectionRebuild.effectCount} effects)`,
        );
      }
      printHostFollowupLines("dome serve", tick.garden, tick.operational);
    }
    return;
  }

  const blocker = result.diagnostics.find((d) => d.severity === "block");
  const blockerMsg = blocker !== undefined ? ` — ${blocker.message}` : "";
  console.error(
    `dome serve: blocked ${tick.branch}: ${diagCount} diagnostic${diagCount === 1 ? "" : "s"}${blockerMsg}`,
  );
}

function printOperationalLine(result: OperationalWorkResult): void {
  const scheduled = result.scheduler.fired.length;
  const jobs = result.jobs.drained.length;
  const outbox = result.outbox.length;
  const diagnostics = result.diagnostics.length;
  if (scheduled + jobs + outbox + diagnostics > 0) {
    console.log(
      `dome serve: operational work (${scheduled} scheduled, ${jobs} jobs, ${outbox} outbox, ${diagnostics} diagnostics)`,
    );
  }
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
function parsePollInterval(
  raw: string | number | boolean | undefined,
): number | null {
  return parsePositiveIntegerValue(raw, DEFAULT_POLL_INTERVAL_MS);
}
