// Canonical root-suite runner. Every current tests/**/*.test.ts file is
// classified once, then every file runs in a fresh Bun process so scheduler,
// SQLite, server, and lifecycle state cannot leak into another test file.

import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ROOT_TEST_GLOB = "tests/**/*.test.ts";

export const ROOT_TEST_AREA_ORDER = Object.freeze([
  "scripts",
  "harness",
  "product",
  "runtime",
] as const);

export type RootTestAreaName = typeof ROOT_TEST_AREA_ORDER[number];

export type RootTestAreaPlan = Readonly<{
  name: RootTestAreaName;
  files: ReadonlyArray<string>;
}>;

export type RootTestSignal = "SIGINT" | "SIGTERM";

// Bun 1.2.13 does not apply bunfig.toml's test timeout. Keep the supported
// repository default on the child command line, where focused CLI overrides
// and explicit longer per-test deadlines retain Bun's normal precedence.
export const ROOT_TEST_CASE_TIMEOUT_MS = 10_000;
export const ROOT_TEST_FILE_TIMEOUT_MS = 5 * 60_000;
export const ROOT_TEST_SHUTDOWN_GRACE_MS = 5_000;
export const ROOT_TEST_TIMEOUT_EXIT_CODE = 124;

export type RootTestChild = Readonly<{
  exited: Promise<number>;
  kill: (signal?: number) => void;
  unref: () => void;
}>;

export type RootTestSpawnOptions = Readonly<{
  cwd?: string;
  stdin: "ignore" | "inherit";
  stdout: "ignore" | "inherit" | "pipe";
  stderr: "ignore" | "inherit" | "pipe";
}>;

export type SpawnedRootTestChild = RootTestChild & Readonly<{ pid: number }>;

export type PipedRootTestChild = SpawnedRootTestChild & Readonly<{
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
}>;

export type RootTestTermination = "sigint" | "sigterm" | "sigkill" | "unobserved";

export type RootTestChildOutcome =
  | Readonly<{ kind: "exited"; exitCode: number }>
  | Readonly<{
      kind: "timed-out";
      termination: RootTestTermination;
      observedExitCode: number | null;
    }>
  | Readonly<{
      kind: "interrupted";
      signal: RootTestSignal;
      termination: RootTestTermination;
      observedExitCode: number | null;
    }>;

export type RootTestWaitResult<T> =
  | Readonly<{ kind: "settled"; value: T }>
  | Readonly<{ kind: "timeout" }>;

export type RootTestWaitWithin = <T>(
  promise: Promise<T>,
  milliseconds: number,
) => Promise<RootTestWaitResult<T>>;

type PrivateRootTestProcessGroup = {
  readonly pgid: number;
  retired: boolean;
};

const privateRootTestProcessGroups = new WeakMap<RootTestChild, PrivateRootTestProcessGroup>();

/**
 * Spawn one test command with process-group ownership hidden behind RootTestChild.
 * Bun's detached POSIX spawn creates a new session whose group id is the child
 * pid. The supervisor can therefore retire descendants that remain in that
 * group without making callers or unit-test fakes coordinate pid/group
 * signaling themselves. A fixture that deliberately creates a new detached
 * session owns that escaped process and must clean it itself.
 */
export function spawnRootTestProcess(
  command: ReadonlyArray<string>,
  options: RootTestSpawnOptions & Readonly<{ stdout: "pipe"; stderr: "pipe" }>,
): PipedRootTestChild;
export function spawnRootTestProcess(
  command: ReadonlyArray<string>,
  options: RootTestSpawnOptions,
): SpawnedRootTestChild;
export function spawnRootTestProcess(
  command: ReadonlyArray<string>,
  options: RootTestSpawnOptions,
): SpawnedRootTestChild {
  assertRootTestProcessGroupsSupported();
  const child = Bun.spawn([...command], {
    ...options,
    detached: true,
  });
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
    try { child.kill(9); } catch {}
    throw new Error("root test process did not receive a valid private process-group id");
  }
  privateRootTestProcessGroups.set(child, { pgid: child.pid, retired: false });
  return child as SpawnedRootTestChild;
}

export function rootTestSignalExitCode(signal: RootTestSignal): 130 | 143 {
  return signal === "SIGINT" ? 130 : 143;
}

export function rootTestRequiresForcedExit(exitCode: number): boolean {
  return exitCode === ROOT_TEST_TIMEOUT_EXIT_CODE || exitCode === 130 || exitCode === 143;
}

export function rootTestTimeoutDiagnostic(input: Readonly<{
  area: RootTestAreaName;
  file: string;
  completedFiles: number;
  totalFiles: number;
  timeoutMs?: number;
  termination: RootTestTermination;
}>): string {
  return `root tests · ${input.area} timed out · ${canonicalTestPath(input.file)} · exceeded `
    + `${input.timeoutMs ?? ROOT_TEST_FILE_TIMEOUT_MS}ms · cleanup ${input.termination} · `
    + `${input.completedFiles}/${input.totalFiles} files completed`;
}

export function rootTestCommand(
  path: string,
  bunExecutable: string = process.execPath,
): [string, "test", "--timeout", string, string] {
  return [
    bunExecutable,
    "test",
    "--timeout",
    String(ROOT_TEST_CASE_TIMEOUT_MS),
    canonicalTestPath(path),
  ];
}

/**
 * Bound one fresh test process without changing its assertions or exit code.
 * A deadline or owner interruption first requests graceful shutdown, then
 * escalates to SIGKILL after one bounded grace period. The caller retains the
 * exact current-file context needed for a useful diagnostic.
 */
export async function superviseRootTestChild(
  child: RootTestChild,
  options: Readonly<{
    timeoutMs?: number;
    shutdownGraceMs?: number;
    interrupted?: Promise<RootTestSignal>;
    waitWithin?: RootTestWaitWithin;
  }> = {},
): Promise<RootTestChildOutcome> {
  const timeoutMs = positiveInteger(
    options.timeoutMs,
    ROOT_TEST_FILE_TIMEOUT_MS,
    "timeoutMs",
  );
  const shutdownGraceMs = positiveInteger(
    options.shutdownGraceMs,
    ROOT_TEST_SHUTDOWN_GRACE_MS,
    "shutdownGraceMs",
  );
  const waitWithin = options.waitWithin ?? waitWithinDeadline;
  const exitObservation = child.exited.then((exitCode) => ({
    kind: "exited" as const,
    exitCode,
  }));
  const firstObservation = options.interrupted === undefined
    ? exitObservation
    : Promise.race([
        exitObservation,
        options.interrupted.then((signal) => ({ kind: "interrupted" as const, signal })),
      ]);
  const first = await waitWithin(firstObservation, timeoutMs);
  if (first.kind === "settled") {
    if (first.value.kind === "exited") {
      if (privateRootTestProcessGroups.has(child)) {
        const retirement = await terminateRootTestChild(
          child,
          exitObservation,
          shutdownGraceMs,
          waitWithin,
          15,
        );
        if (retirement.termination === "unobserved") {
          throw new Error("root test process group remained live after its direct child exited");
        }
      }
      return first.value;
    }
    const termination = await terminateRootTestChild(
      child,
      exitObservation,
      shutdownGraceMs,
      waitWithin,
      first.value.signal === "SIGINT" ? 2 : 15,
    );
    return Object.freeze({
      kind: "interrupted" as const,
      signal: first.value.signal,
      ...termination,
    });
  }
  const termination = await terminateRootTestChild(
    child,
    exitObservation,
    shutdownGraceMs,
    waitWithin,
    15,
  );
  return Object.freeze({ kind: "timed-out" as const, ...termination });
}

/** Discover the complete current root test inventory without crossing into nested packages. */
export async function discoverRootTestFiles(repoRoot: string = REPO_ROOT): Promise<string[]> {
  const files: string[] = [];
  const glob = new Bun.Glob(ROOT_TEST_GLOB);
  for await (const path of glob.scan({ cwd: repoRoot, onlyFiles: true })) {
    files.push(canonicalTestPath(path));
  }
  files.sort(compareStrings);
  return files;
}

/**
 * Build one total, deterministic plan. The areas organize progress only; each
 * file gets its own process when the plan is executed.
 */
export function createRootTestPlan(paths: ReadonlyArray<string>): ReadonlyArray<RootTestAreaPlan> {
  const filesByArea: Record<RootTestAreaName, string[]> = {
    scripts: [],
    harness: [],
    product: [],
    runtime: [],
  };
  const seen = new Set<string>();

  for (const rawPath of paths) {
    const path = canonicalTestPath(rawPath);
    if (seen.has(path)) throw new Error(`duplicate root test path: ${path}`);
    seen.add(path);
    filesByArea[areaFor(path)].push(path);
  }

  return Object.freeze(ROOT_TEST_AREA_ORDER.map((name) => {
    const files = Object.freeze([...filesByArea[name]].sort(compareStrings));
    return Object.freeze({
      name,
      files,
    });
  }));
}

export async function runRootTests(repoRoot: string = REPO_ROOT): Promise<number> {
  const files = await discoverRootTestFiles(repoRoot);
  if (files.length === 0) throw new Error(`no root tests matched ${ROOT_TEST_GLOB}`);
  const plan = createRootTestPlan(files);
  const nonempty = plan.filter((area) => area.files.length > 0);

  console.log(
    `root tests · ${files.length} files · ${nonempty.length} areas · one fresh process per file`,
  );
  let activeChild: RootTestChild | null = null;
  let interruptActive: ((signal: RootTestSignal) => void) | null = null;
  let requestedSignal: RootTestSignal | null = null;
  const forwardSignal = (signal: RootTestSignal): void => {
    requestedSignal ??= signal;
    interruptActive?.(requestedSignal);
  };
  const onSigint = (): void => forwardSignal("SIGINT");
  const onSigterm = (): void => forwardSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  let completedFiles = 0;
  try {
    for (const area of nonempty) {
      if (requestedSignal !== null) return rootTestSignalExitCode(requestedSignal);
      console.log(`\nroot tests · ${area.name} · ${area.files.length} files`);
      for (const file of area.files) {
        if (requestedSignal !== null) return rootTestSignalExitCode(requestedSignal);
        console.log(`root tests · ${completedFiles + 1}/${files.length} · ${file}`);
        let interrupt!: (signal: RootTestSignal) => void;
        const interrupted = new Promise<RootTestSignal>((resolveInterrupt) => {
          interrupt = resolveInterrupt;
        });
        interruptActive = interrupt;
        const child = spawnRootTestProcess(rootTestCommand(file), {
          cwd: repoRoot,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        activeChild = child;
        if (requestedSignal !== null) interrupt(requestedSignal);
        const outcome = await superviseRootTestChild(child, { interrupted });
        activeChild = null;
        interruptActive = null;
        if (outcome.kind === "interrupted") {
          return rootTestSignalExitCode(outcome.signal);
        }
        if (outcome.kind === "timed-out") {
          console.error(rootTestTimeoutDiagnostic({
            area: area.name,
            file,
            completedFiles,
            totalFiles: files.length,
            termination: outcome.termination,
          }));
          return ROOT_TEST_TIMEOUT_EXIT_CODE;
        }
        if (outcome.exitCode !== 0) {
          console.error(
            `root tests · ${area.name} failed · ${file} · exit ${outcome.exitCode} · `
              + `${completedFiles}/${files.length} files completed`,
          );
          return outcome.exitCode;
        }
        completedFiles += 1;
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    interruptActive = null;
    if (activeChild !== null) {
      const exitObservation = activeChild.exited.then((exitCode) => ({
        kind: "exited" as const,
        exitCode,
      }));
      await terminateRootTestChild(
        activeChild,
        exitObservation,
        ROOT_TEST_SHUTDOWN_GRACE_MS,
        waitWithinDeadline,
        15,
      );
    }
  }

  console.log(`\nroot tests · complete · ${completedFiles}/${files.length} files`);
  return 0;
}

async function terminateRootTestChild(
  child: RootTestChild,
  exitObservation: Promise<Readonly<{ kind: "exited"; exitCode: number }>>,
  shutdownGraceMs: number,
  waitWithin: RootTestWaitWithin,
  initialSignal: 2 | 15,
): Promise<Readonly<{
  termination: RootTestTermination;
  observedExitCode: number | null;
}>> {
  const signals: ReadonlyArray<Readonly<{
    number: 2 | 9 | 15;
    termination: Exclude<RootTestTermination, "unobserved">;
  }>> = initialSignal === 2
    ? [
        { number: 2, termination: "sigint" },
        { number: 15, termination: "sigterm" },
        { number: 9, termination: "sigkill" },
      ]
    : [
        { number: 15, termination: "sigterm" },
        { number: 9, termination: "sigkill" },
      ];
  try {
    const ownership = rootTestProcessOwnership(child);
    for (const signal of signals) {
      ownership.signal(signal.number);
      const retirement = ownership.retirement(exitObservation);
      let observed: RootTestWaitResult<Readonly<{ kind: "exited"; exitCode: number }>>;
      try {
        observed = await waitWithin(retirement.promise, shutdownGraceMs);
      } finally {
        retirement.cancel();
      }
      if (observed.kind === "settled") {
        return Object.freeze({
          termination: signal.termination,
          observedExitCode: observed.value.exitCode,
        });
      }
    }
  } catch (error) {
    // A platform signaling/probing failure is fatal, but must not make the
    // detached child an event-loop owner while that failure is reported.
    try { child.unref(); } catch {}
    throw error;
  }
  // A broken exit observer must not retain the runner's event loop after the
  // owned TERM/KILL sequence. The main entrypoint force-exits timeout/signal
  // outcomes; unref covers imported callers and a kill implementation throw.
  try { child.unref(); } catch {}
  return Object.freeze({ termination: "unobserved" as const, observedExitCode: null });
}

type RootTestProcessOwnership = Readonly<{
  signal: (signal: 2 | 9 | 15) => void;
  retirement: (
    exitObservation: Promise<Readonly<{ kind: "exited"; exitCode: number }>>,
  ) => Readonly<{
    promise: Promise<Readonly<{ kind: "exited"; exitCode: number }>>;
    cancel: () => void;
  }>;
}>;

function rootTestProcessOwnership(child: RootTestChild): RootTestProcessOwnership {
  const group = privateRootTestProcessGroups.get(child);
  if (group === undefined) {
    return Object.freeze({
      signal: (signal: 2 | 9 | 15): void => {
        try { child.kill(signal); } catch {}
      },
      retirement: (exitObservation: Promise<Readonly<{ kind: "exited"; exitCode: number }>>) =>
        Object.freeze({ promise: exitObservation, cancel: () => {} }),
    });
  }
  return Object.freeze({
    signal: (signal: 2 | 9 | 15): void => signalPrivateRootTestProcessGroup(group, signal),
    retirement: (exitObservation: Promise<Readonly<{ kind: "exited"; exitCode: number }>>) => {
      let cancelled = false;
      return Object.freeze({
        promise: waitForPrivateRootTestProcessGroupRetirement(
          group,
          exitObservation,
          () => cancelled,
        ),
        cancel: () => { cancelled = true; },
      });
    },
  });
}

function signalPrivateRootTestProcessGroup(
  group: PrivateRootTestProcessGroup,
  signal: 2 | 9 | 15,
): void {
  if (group.retired) return;
  // POSIX offers no handle-bound whole-group signal. Signal immediately at
  // the ownership boundary; the ESRCH latch below prevents every later reuse
  // of the numeric id after retirement has actually been observed.
  try {
    process.kill(-group.pgid, signal);
  } catch (error) {
    if (isNoSuchProcess(error)) {
      // ESRCH is the one terminal observation. Once seen, never signal this
      // numeric group id again: the kernel may eventually reuse it.
      group.retired = true;
      return;
    }
    throw new Error(
      `root test process-group signal failed for ${group.pgid}: ${errorMessage(error)}`,
    );
  }
}

async function waitForPrivateRootTestProcessGroupRetirement(
  group: PrivateRootTestProcessGroup,
  exitObservation: Promise<Readonly<{ kind: "exited"; exitCode: number }>>,
  cancelled: () => boolean,
): Promise<Readonly<{ kind: "exited"; exitCode: number }>> {
  while (!cancelled()) {
    if (probePrivateRootTestProcessGroup(group) === "retired") {
      return await exitObservation;
    }
    await Bun.sleep(5);
  }
  return await new Promise<never>(() => {});
}

function probePrivateRootTestProcessGroup(
  group: PrivateRootTestProcessGroup,
): "live" | "retired" {
  if (group.retired) return "retired";
  try {
    process.kill(-group.pgid, 0);
    return "live";
  } catch (error) {
    if (isNoSuchProcess(error)) {
      group.retired = true;
      return "retired";
    }
    if ((error as NodeJS.ErrnoException).code === "EPERM") return "live";
    throw new Error(
      `root test process-group probe failed for ${group.pgid}: ${errorMessage(error)}`,
    );
  }
}

function assertRootTestProcessGroupsSupported(): void {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`root test process ownership is unsupported on ${process.platform}`);
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ESRCH";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitWithinDeadline<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<RootTestWaitResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => Object.freeze({ kind: "settled" as const, value })),
      new Promise<Readonly<{ kind: "timeout" }>>((resolveTimeout) => {
        timer = setTimeout(
          () => resolveTimeout(Object.freeze({ kind: "timeout" as const })),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return resolved;
}

function areaFor(path: string): RootTestAreaName {
  if (path.startsWith("tests/scripts/")) return "scripts";
  if (path.startsWith("tests/harness/")) return "harness";
  if (path.startsWith("tests/product/")) return "product";
  return "runtime";
}

function canonicalTestPath(path: string): string {
  const canonical = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !canonical.startsWith("tests/") ||
    !canonical.endsWith(".test.ts") ||
    canonical.includes("/../") ||
    canonical.includes("/./")
  ) {
    throw new Error(`invalid root test path: ${path}`);
  }
  return canonical;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (import.meta.main) {
  runRootTests().then(
    (exitCode) => {
      if (rootTestRequiresForcedExit(exitCode)) process.exit(exitCode);
      process.exitCode = exitCode;
    },
    (error) => {
      console.error(`root tests: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
