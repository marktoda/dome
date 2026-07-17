// Process-level smoke tests for the executable `bin/dome` shim.
//
// Most CLI tests call command handlers directly so they can assert on
// internals cheaply. This file covers the outer packaging boundary: shebang
// execution, real stdout/stderr/exit codes, and real foreground `serve`
// processes receiving shutdown signals.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const DOME_BIN = join(REPO_ROOT, "bin", "dome");

const fixtures: string[] = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    const path = fixtures.pop();
    if (path !== undefined) await rm(path, { recursive: true, force: true });
  }
});

describe("bin/dome process boundary", () => {
  test("top-level help exposes the consolidated V1 command surface", async () => {
    const help = await runDome(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    // Grouped display order (cohesion review 2026-07-06): headings render in
    // first-registered-command order; commands sit in registration order
    // within their group. The implicit `help` subcommand is suppressed.
    expect(topLevelCommandNames(help.stdout)).toEqual([
      // Getting started:
      "init",
      "devices",
      "home",
      "recipe",
      // Today:
      "capture",
      "today",
      // Maintain:
      "check",
      "retry",
      "audit",
      "garden",
      "backup",
      "status",
      "sync",
      // Decide:
      "resolve",
      "agent-work",
      "settle",
      "proposals",
      "apply",
      "reject",
      // Recall:
      "query",
      "views",
      "log",
      "explain",
      "export-context",
      // Adapters:
      "mcp",
    ]);
    expect(help.stdout).not.toContain("inspect");
    expect(help.stdout).not.toContain("doctor");
    expect(help.stdout).not.toContain("lint");
    expect(help.stdout).not.toContain("rebuild");
    expect(help.stdout).not.toContain("answer");
    expect(help.stdout).not.toContain(" run ");
  });

  test("init, sync, and status work through the executable shim", async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), "dome-bin-init-"));
    fixtures.push(vaultPath);

    const init = await runDome(["init", vaultPath]);
    expect(init.exitCode).toBe(0);
    expect(init.stderr).toBe("");
    expect(init.stdout).toContain("CLAUDE.md");

    const sync = await runDomeJson<{
      readonly status: string;
      readonly branch: string | null;
    }>(["sync", "--vault", vaultPath, "--json"]);
    expect(sync.status === "adopted" || sync.status === "in-sync").toBe(true);
    expect(sync.branch).toBe("main");

    const status = await runDomeJson<{
      readonly branch: string | null;
      readonly head: string | null;
      readonly adopted: string | null;
      readonly pending_commits: number | null;
      readonly serve_status: string;
    }>(["status", "--vault", vaultPath, "--json"]);
    expect(status.branch).toBe("main");
    expect(status.head).not.toBeNull();
    expect(status.adopted).toBe(status.head);
    expect(status.pending_commits).toBe(0);
    expect(status.serve_status).toBe("off");
  }, { timeout: 30_000 });

  test("home cleanup is wired host-wide without vault discovery", async () => {
    const home = mkdtempSync(join(tmpdir(), "dome-bin-home-cleanup-"));
    fixtures.push(home);
    const help = await runDome(["home", "--help"], { HOME: home });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("cleanup");
    const result = await runDome(["home", "cleanup", "--json"], { HOME: home });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: "dome.home.cleanup/v1",
      operation: "cleanup",
      status: "not-installed",
      exitCode: 0,
    });
  });

  test("guided credential cleanup is wired as a preview-first nested setup command", async () => {
    const help = await runDome(["home", "setup", "cleanup", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("Usage: dome home setup cleanup");
    expect(help.stdout).toContain("--apply");
    expect(help.stdout).toContain("--vault <path>");
  });

  test("serve reports heartbeat and exits cleanly on SIGTERM", async () => {
    await expectServeSignalClearsHeartbeat("SIGTERM");
  }, { timeout: 30_000 });

  test("serve exits cleanly and clears heartbeat on SIGHUP", async () => {
    await expectServeSignalClearsHeartbeat("SIGHUP");
  }, { timeout: 30_000 });
});

type DomeProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function runDome(
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>> = {},
): Promise<DomeProcessResult> {
  const proc = Bun.spawn({
    cmd: [DOME_BIN, ...args],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
    killSignal: "SIGKILL",
    env: { ...process.env, ...environment },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function runDomeJson<T>(args: ReadonlyArray<string>): Promise<T> {
  const result = await runDome(args);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as T;
}

type DomeJsonAttempt<T> =
  | { readonly value: T; readonly failure: null }
  | { readonly value: null; readonly failure: string };

async function tryRunDomeJson<T>(args: ReadonlyArray<string>): Promise<DomeJsonAttempt<T>> {
  const result = await runDome(args);
  if (result.exitCode !== 0) {
    return { value: null, failure: `status exited ${result.exitCode}` };
  }
  if (result.stderr !== "") {
    return { value: null, failure: "status wrote to stderr" };
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed !== "object" || parsed === null) {
      return { value: null, failure: "status returned non-object JSON" };
    }
    return { value: parsed as T, failure: null };
  } catch {
    return { value: null, failure: "status returned malformed JSON" };
  }
}

async function expectServeSignalClearsHeartbeat(
  signal: NodeJS.Signals,
): Promise<void> {
  const vaultPath = mkdtempSync(join(tmpdir(), "dome-bin-serve-"));
  fixtures.push(vaultPath);
  // --with-model-provider wires a model_provider stanza so dome.agent
  // (shipped enabled by default per product-review-3 Task 17) has a
  // provider configured — this test is about signal handling, not the
  // agent bundle, and asserts pristine (empty) stderr; without a provider
  // configured at all, `dome serve` now loudly logs `agent.no-model-
  // provider` regardless of `--quiet` (by design — silence is the bug
  // Task 17 removes), which would otherwise trip this test's assertion.
  expect(
    (await runDome(["init", vaultPath, "--with-model-provider", "anthropic"]))
      .exitCode,
  ).toBe(0);

  const serve = Bun.spawn({
    cmd: [
      DOME_BIN,
      "serve",
      "--vault",
      vaultPath,
      "--poll-interval-ms",
      "50",
      "--quiet",
    ],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 25_000,
    killSignal: "SIGKILL",
  });
  let shutdown: Promise<SettledProcess> | null = null;
  const stopServe = (shutdownSignal: NodeJS.Signals): Promise<SettledProcess> => {
    shutdown ??= stopAndDrainProcess(serve, shutdownSignal, 5_000);
    return shutdown;
  };

  try {
    type ServeStatus = {
      readonly head: string | null;
      readonly adopted: string | null;
      readonly serve_status: string;
      readonly serve_pid: number | null;
    };
    let lastStatusObservation = "status has not responded";
    const ready = await waitFor(async () => {
      // The serve process owns compiler startup concurrently. Status can
      // legitimately be nonzero or incomplete before the first adoption;
      // those observations mean "not ready yet", not a process-boundary
      // assertion failure.
      const attempt = await tryRunDomeJson<ServeStatus>([
        "status",
        "--vault",
        vaultPath,
        "--json",
      ]);
      if (attempt.value === null) {
        lastStatusObservation = attempt.failure;
        return null;
      }
      const status = attempt.value;
      const ready = (
        status.serve_status === "running" &&
        status.serve_pid === serve.pid &&
        status.head !== null &&
        status.adopted === status.head
      );
      if (!ready) {
        lastStatusObservation = [
          `running=${status.serve_status === "running"}`,
          `pidMatch=${status.serve_pid === serve.pid}`,
          `headPresent=${status.head !== null}`,
          `adoptedMatches=${status.head !== null && status.adopted === status.head}`,
        ].join(" ");
      }
      return ready ? status : null;
    }, 5_000, () => lastStatusObservation);

    // Assert the exact successful observation that established readiness.
    // tryRunDomeJson only yields a value after exit 0, empty stderr, and valid
    // object JSON; another status call could legitimately race a new HEAD.
    expect(ready.serve_status).toBe("running");
    expect(ready.serve_pid).toBe(serve.pid);
    expect(ready.head).not.toBeNull();
    expect(ready.adopted).toBe(ready.head);

    const stopped = await stopServe(signal);
    expect(stopped.forced).toBe(false);
    expect(stopped.exitCode).toBe(0);
    expect(stopped.stdout).toBe("");
    expect(stopped.stderr).toBe("");

    const after = await runDomeJson<{
      readonly serve_status: string;
      readonly serve_pid: number | null;
    }>(["status", "--vault", vaultPath, "--json"]);
    expect(after.serve_status).toBe("off");
    expect(after.serve_pid).toBeNull();
  } finally {
    // Never let cleanup replace the primary test failure. The memoized helper
    // also guarantees stdout/stderr are drained at most once when normal
    // shutdown already completed.
    await stopServe("SIGTERM").catch(() => {});
  }
}

async function waitFor<T>(
  probe: () => Promise<T | null>,
  timeoutMs: number,
  timeoutDetail?: () => string,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const observation = await probe();
    if (observation !== null) return observation;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  const detail = timeoutDetail?.().trim();
  throw new Error(
    `waitFor: predicate did not become true within ${timeoutMs}ms` +
      (detail === undefined || detail === "" ? "" : ` (${detail})`),
  );
}

type SettledProcess = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly forced: boolean;
};

async function stopAndDrainProcess(
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<SettledProcess> {
  if (proc.exitCode === null) proc.kill(signal);
  let forced = false;
  let exitCode: number;
  try {
    exitCode = await exitWithin(proc, timeoutMs);
  } catch {
    forced = true;
    if (proc.exitCode === null) proc.kill("SIGKILL");
    exitCode = await exitWithin(proc, timeoutMs);
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr, forced };
}

async function exitWithin(
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">,
  timeoutMs: number,
): Promise<number> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`process did not exit within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([proc.exited, timeoutPromise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function topLevelCommandNames(helpText: string): string[] {
  // Help renders grouped headings (no flat "Commands:" block): command rows
  // are the two-space-indented lowercase names under any heading; group
  // headings sit at column 0 and option rows start with `-`, so neither
  // matches. Display order across groups is preserved.
  return helpText
    .split(/\r?\n/)
    .map((line) => /^\s{2}([a-z][a-z-]*)(?:\s|$)/.exec(line)?.[1] ?? null)
    .filter((name): name is string => name !== null);
}
