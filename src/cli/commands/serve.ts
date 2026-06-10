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
// Drift detection + adoption-invocation live in `src/engine/host/compiler-host.ts`,
// so `dome serve` (Phase 11b) and `dome sync` (Phase 11c) share the same
// underlying per-tick body. The daemon wraps it in a poll loop with
// cancellation, error tolerance (one bad commit shouldn't crash a
// long-running poll), and a one-line operator-facing summary.
//
// Exit codes:
//   - 0  on graceful shutdown (SIGINT / SIGTERM / SIGHUP /
//        external `AbortSignal`).
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

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  openVaultRuntime,
  type OpenVaultRuntimeError,
  type OpenVaultRuntimeWithBundlesOpts,
  type VaultRuntime,
} from "../../engine/host/vault-runtime";
import type { OperationalWorkResult } from "../../engine/operational/operational-work";
import { getCurrentBranch } from "../../adopted-ref";
import { compileRange } from "../../engine/core/compile-range";
import { resolveVaultPath } from "../resolve-vault";

import {
  detectDrift,
  runCompilerHostTick,
  type CompilerHostTickResult,
  type DriftResult,
} from "../../engine/host/compiler-host";
import {
  clearServeHeartbeat,
  createServeHeartbeatHandle,
  readServeHeartbeatStatus,
  writeServeHeartbeat,
  type ServeHeartbeatHandle,
} from "../../engine/host/compiler-host-heartbeat";
import {
  resolveBundleRoots,
  formatAdoptedSummaryLine,
  formatFilteredAdoptEvent,
  printHostFollowupLines,
} from "./sync-shared";
import { parsePositiveIntegerValue } from "../parse-options";
import {
  headline,
  kv,
  resolveCaps,
  section,
  type KvRow,
  type Status,
} from "../presenter";

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
const DEFAULT_DAEMON_START_TIMEOUT_MS = 10_000;
const RUNTIME_CONFIG_PATH = ".dome/config.yaml";
const RUNTIME_MODEL_PROVIDER_PATH = ".dome/model-provider.ts";
const RUNTIME_EXTENSIONS_PREFIX = ".dome/extensions/";
const DOME_BIN = resolve(import.meta.dir, "../../../bin/dome");

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
  readonly daemon?: boolean | undefined;
  readonly daemonLog?: string | undefined;
  readonly daemonTimeoutMs?: number | undefined;
  readonly filterProcessor?: string | undefined;
};

export type RunServeRuntimeOptions = {
  /**
   * External cancellation source. When the signal aborts, the daemon
   * exits its poll loop cleanly (just like SIGINT/SIGTERM/SIGHUP).
   * Tests use this to
   * deterministically stop the loop after asserting on the side effects;
   * production callers leave it unset and rely on the process signal
   * handlers registered inside `runServe`.
   */
  readonly signal?: AbortSignal;
  /**
   * Internal/test knob for due scheduler/job/outbox work while HEAD is
   * already adopted. Production uses DEFAULT_OPERATIONAL_INTERVAL_MS.
   */
  readonly operationalIntervalMs?: number;
};

type ServeRuntimeState = {
  current: VaultRuntime | null;
  lastReloadError: string | null;
};

type RuntimeOptsFactory = () => OpenVaultRuntimeWithBundlesOpts;

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
  const vaultPath = resolveVaultPath(options.vault);

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

  if (options.daemon === true) {
    return startServeDaemon({
      vaultPath,
      bundlesRoot: options.bundlesRoot,
      pollIntervalMs,
      verbose,
      quiet,
      daemonLog: options.daemonLog,
      daemonTimeoutMs:
        options.daemonTimeoutMs ?? DEFAULT_DAEMON_START_TIMEOUT_MS,
      filterProcessor: options.filterProcessor,
    });
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
  const makeRuntimeOpts: RuntimeOptsFactory = () => ({
    vaultPath,
    ...resolveBundleRoots({
      vaultPath,
      bundlesRoot: options.bundlesRoot,
    }),
  });
  const runtimeOpts = makeRuntimeOpts();
  const runtimeResult = await openVaultRuntime(runtimeOpts);
  if (!runtimeResult.ok) {
    console.error(
      `dome serve: openVaultRuntime failed (${runtimeResult.error.kind}). Run \`dome init\` to initialize the vault.`,
    );
    return 1;
  }
  const runtimeState: ServeRuntimeState = {
    current: runtimeResult.value,
    lastReloadError: null,
  };

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
    const caps = resolveCaps();
    const watchStatus: Status = { tone: "ok", label: "watching" };
    const startupRows: KvRow[] = [
      { label: "branch", value: startupBranch },
      { label: "poll", value: `${pollIntervalMs}ms${verbose ? " · verbose" : ""}`, tone: "muted" },
    ];
    const startupLines: string[] = [
      headline({ cmd: "serve", context: basename(vaultPath) }, watchStatus, caps),
      ...section("Config", kv(startupRows, caps), caps),
    ];
    console.log(startupLines.join("\n"));
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
  // A single `AbortController` unifies process signals and the
  // externally-supplied `opts.signal`. Anywhere we'd `await`, we
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
  const onSighup = (): void => controller.abort();
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);

  // ----- 6. Run the poll loop -----------------------------------------------
  try {
    await pollLoop({
      runtimeState,
      makeRuntimeOpts,
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
    process.off("SIGHUP", onSighup);
    if (opts.signal !== undefined) {
      opts.signal.removeEventListener("abort", onAbort);
    }
    try {
      if (runtimeState.current !== null) {
        await runtimeState.current.close();
        runtimeState.current = null;
      }
    } finally {
      await clearServeHeartbeat({ vaultPath, handle: heartbeat });
    }
  }

  if (!quiet) {
    const caps = resolveCaps();
    const shutdownStatus: Status = { tone: "muted", label: "shutting down" };
    console.log(headline({ cmd: "serve", context: basename(vaultPath) }, shutdownStatus, caps));
  }
  return 0;
}

// ----- Internals ------------------------------------------------------------

async function startServeDaemon(input: {
  readonly vaultPath: string;
  readonly bundlesRoot?: string | undefined;
  readonly pollIntervalMs: number;
  readonly verbose: boolean;
  readonly quiet: boolean;
  readonly daemonLog?: string | undefined;
  readonly daemonTimeoutMs: number;
  readonly filterProcessor?: string | undefined;
}): Promise<number> {
  const currentBranch = await getCurrentBranch(input.vaultPath);
  const existing = await readServeHeartbeatStatus({
    vaultPath: input.vaultPath,
  });
  if (
    existing.status === "running" &&
    (currentBranch === null ||
      existing.branch === null ||
      existing.branch === currentBranch)
  ) {
    if (!input.quiet) {
      console.log(
        `dome serve: daemon already running pid ${existing.pid}`,
      );
    }
    return 0;
  }
  if (
    existing.status === "running" &&
    currentBranch !== null &&
    existing.branch !== null &&
    existing.branch !== currentBranch
  ) {
    console.error(
      `dome serve: daemon already running on branch ${existing.branch}; current branch is ${currentBranch}.`,
    );
    return 1;
  }

  const logPath = resolve(
    input.daemonLog ?? join(input.vaultPath, ".dome", "state", "serve-daemon.log"),
  );
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");
  const args = serveDaemonArgs(input);
  const child = spawn(process.execPath, args, {
    cwd: resolve(import.meta.dir, "../../.."),
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);

  if (child.pid === undefined) {
    console.error(`dome serve: failed to start daemon process (log: ${logPath})`);
    return 1;
  }

  let childExited = false;
  let childExitReason = "unknown exit";
  child.once("exit", (code, signal) => {
    childExited = true;
    childExitReason = signal !== null
      ? `signal ${signal}`
      : `exit ${code ?? "unknown"}`;
  });
  child.unref();

  const started = await waitForDaemonHeartbeat({
    vaultPath: input.vaultPath,
    pid: child.pid,
    timeoutMs: input.daemonTimeoutMs,
    childExited: () => childExited,
  });

  if (started === "running") {
    if (!input.quiet) {
      console.log(
        `dome serve: daemon started pid ${child.pid} (log: ${logPath})`,
      );
    }
    return 0;
  }

  if (started === "exited") {
    console.error(
      `dome serve: daemon exited before heartbeat (${childExitReason}; log: ${logPath})`,
    );
    return 1;
  }

  try {
    process.kill(child.pid, "SIGTERM");
  } catch {
    // If the child exited between the timeout and kill attempt, the log path is
    // still the useful operator artifact.
  }
  console.error(
    `dome serve: daemon did not write a running heartbeat within ${input.daemonTimeoutMs}ms (log: ${logPath})`,
  );
  return 1;
}

function serveDaemonArgs(input: {
  readonly vaultPath: string;
  readonly bundlesRoot?: string | undefined;
  readonly pollIntervalMs: number;
  readonly verbose: boolean;
  readonly quiet: boolean;
  readonly filterProcessor?: string | undefined;
}): string[] {
  const args = [
    DOME_BIN,
    "serve",
    "--vault",
    input.vaultPath,
    "--poll-interval-ms",
    String(input.pollIntervalMs),
  ];
  if (input.bundlesRoot !== undefined) {
    args.push("--bundles-root", input.bundlesRoot);
  }
  if (input.verbose) args.push("--verbose");
  if (input.quiet) args.push("--quiet");
  if (input.filterProcessor !== undefined) {
    args.push("--filter-processor", input.filterProcessor);
  }
  return args;
}

async function waitForDaemonHeartbeat(input: {
  readonly vaultPath: string;
  readonly pid: number;
  readonly timeoutMs: number;
  readonly childExited: () => boolean;
}): Promise<"running" | "exited" | "timeout"> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (input.childExited()) return "exited";
    const heartbeat = await readServeHeartbeatStatus({
      vaultPath: input.vaultPath,
    });
    if (heartbeat.status === "running" && heartbeat.pid === input.pid) {
      return "running";
    }
    await delay(100);
  }
  return input.childExited() ? "exited" : "timeout";
}

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
  readonly runtimeState: ServeRuntimeState;
  readonly makeRuntimeOpts: RuntimeOptsFactory;
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
    runtimeState,
    makeRuntimeOpts,
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
          console.error(
            `dome serve: drift detected — adopting ${drift.info.base.slice(0, 7)}..${drift.info.head.slice(0, 7)}`,
          );
        }
      }
      if (
        drift.kind === "drift" &&
        await driftTouchesRuntimeInputs({ vaultPath, drift })
      ) {
        const reloaded = await reloadServeRuntime({
          state: runtimeState,
          makeRuntimeOpts,
          quiet,
        });
        if (!reloaded) {
          lastKind = "runtime-reload-failed";
          await sleep(pollIntervalMs, cancel);
          continue;
        }
      }
      if (runtimeState.current === null) {
        const reloaded = await reloadServeRuntime({
          state: runtimeState,
          makeRuntimeOpts,
          quiet,
        });
        if (!reloaded) {
          lastKind = "runtime-reload-failed";
          await sleep(pollIntervalMs, cancel);
          continue;
        }
      }
      const runtime = runtimeState.current;
      if (runtime === null) {
        lastKind = "runtime-reload-failed";
        await sleep(pollIntervalMs, cancel);
        continue;
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
      // Log once on the transition into divergence (no per-poll spam) and
      // pause adoption — never silently follow a rewritten history. The
      // loop keeps re-checking each tick so recovery resumes immediately.
      console.error(
        `dome serve: adopted ref for ${drift.branch} (${drift.adopted.slice(0, 7)}) is not an ancestor of HEAD ${drift.head.slice(0, 7)}; pausing adoption until git history is repaired or \`dome reanchor\` accepts the rewritten HEAD.`,
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

async function driftTouchesRuntimeInputs(input: {
  readonly vaultPath: string;
  readonly drift: Extract<DriftResult, { readonly kind: "drift" }>;
}): Promise<boolean> {
  try {
    const range = await compileRange({
      vaultPath: input.vaultPath,
      base: input.drift.info.base,
      head: input.drift.info.head,
    });
    return range.changedPaths.some(isRuntimeInputPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`dome serve: runtime reload check threw: ${msg}`);
    return true;
  }
}

function isRuntimeInputPath(path: string): boolean {
  return (
    path === RUNTIME_CONFIG_PATH ||
    path === RUNTIME_MODEL_PROVIDER_PATH ||
    path.startsWith(RUNTIME_EXTENSIONS_PREFIX)
  );
}

async function reloadServeRuntime(input: {
  readonly state: ServeRuntimeState;
  readonly makeRuntimeOpts: RuntimeOptsFactory;
  readonly quiet: boolean;
}): Promise<boolean> {
  if (input.state.current !== null) {
    const previous = input.state.current;
    input.state.current = null;
    await previous.close();
  }

  const next = await openVaultRuntime(input.makeRuntimeOpts());
  if (!next.ok) {
    const error = formatOpenRuntimeError(next.error);
    if (input.state.lastReloadError !== error) {
      console.error(
        `dome serve: runtime reload failed (${error}); pausing adoption until config is repaired.`,
      );
      input.state.lastReloadError = error;
    }
    return false;
  }

  input.state.current = next.value;
  input.state.lastReloadError = null;
  if (!input.quiet) {
    console.log("dome serve: reloaded runtime configuration");
  }
  return true;
}

function formatOpenRuntimeError(error: OpenVaultRuntimeError): string {
  switch (error.kind) {
    case "bundle-load-failed":
      if (error.cause.kind === "bundle-not-found") {
        return `${error.kind}:${error.cause.kind}:${
          error.cause.bundleIds.join(",")
        }`;
      }
      return `${error.kind}:${error.cause.kind}`;
    case "registry-build-failed":
      return `${error.kind}:${error.cause.kind}`;
    default:
      return error.kind;
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

  // Accumulate the adoption-phase processors that emitted effects this tick
  // (regardless of verbosity) so the adopted summary line can name *which*
  // processors did work. Verbose mode additionally streams each event to
  // stderr; both observers share the one `onEvent` callback.
  const activeProcessorIds = new Set<string>();
  try {
    const tick = await runCompilerHostTick({
      runtime,
      drift,
      runOperationalWhenInSync,
      signal: cancel,
      onEvent: (e) => {
        if (e.kind === "processor-result" && e.effectCount > 0) {
          activeProcessorIds.add(e.processorId);
        }
        if (verbose && !quiet) {
          const line = formatFilteredAdoptEvent(e, {
            command: "serve",
            ...(filterProcessor !== undefined
              ? { processorFilter: filterProcessor }
              : {}),
          });
          if (line !== null) console.error(line);
        }
      },
      onGardenProcessorStart: (info) => {
        if (quiet) return;
        if (info.executionClass === "llm" || verbose) {
          console.error(
            `dome serve: ▶ running ${info.processorId}${info.executionClass === "llm" ? " (agent)" : ""}…`,
          );
        }
      },
    });
    if (tick.kind === "busy" && suppressBusyLine) return tick;
    printTickLine(tick, { verbose, quiet, activeProcessorIds });
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
 *   dome serve: adopted main 41a98c2 · 1 iteration · 3 diagnostics (1 warning, 2 info) · ran dome.markdown
 *   dome serve: blocked main: 3 diagnostics — first: <message>
 *
 * The adopted line carries a severity breakdown and the adoption-phase
 * processors that emitted effects (`activeProcessorIds`), so the operator
 * sees what kind of findings surfaced and which processors did the work.
 * Diagnostics counts are total; the first blocking diagnostic's message
 * is appended for the blocked case so the operator sees what to fix
 * without reaching for `dome inspect diagnostics`.
 */
function printTickLine(
  tick: CompilerHostTickResult,
  opts: {
    readonly verbose: boolean;
    readonly quiet: boolean;
    readonly activeProcessorIds: ReadonlySet<string>;
  },
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
      `dome serve: refused ${tick.branch}: adopted ref ${tick.adopted.slice(0, 7)} is not an ancestor of HEAD ${tick.head.slice(0, 7)}; repair git history or run \`dome reanchor\`.`,
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
        formatAdoptedSummaryLine(
          {
            command: "serve",
            branch: tick.branch,
            adoptedRef: tick.finalAdoptedRef,
            iterations: iters,
            diagnostics: result.diagnostics,
            activeProcessorIds: [...opts.activeProcessorIds],
          },
          resolveCaps(),
        ),
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
  const autoResolved = result.questionAutoResolution.answered;
  const diagnostics = result.diagnostics.length;
  if (scheduled + jobs + outbox + autoResolved + diagnostics > 0) {
    console.log(
      `dome serve: operational work (${scheduled} scheduled, ${jobs} jobs, ${outbox} outbox, ${autoResolved} auto-resolved questions, ${diagnostics} diagnostics)`,
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

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
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
