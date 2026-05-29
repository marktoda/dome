// Process-level smoke tests for the executable `bin/dome` shim.
//
// Most CLI tests call command handlers directly so they can assert on
// internals cheaply. This file covers the outer packaging boundary: shebang
// execution, real stdout/stderr/exit codes, and a real foreground `serve`
// process receiving SIGTERM.

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
  test("init, sync, and status work through the executable shim", async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), "dome-bin-init-"));
    fixtures.push(vaultPath);

    const init = await runDome(["init", vaultPath]);
    expect(init.exitCode).toBe(0);
    expect(init.stderr).toBe("");
    expect(init.stdout).toContain("CLAUDE.md:");

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
  });

  test("serve reports heartbeat and exits cleanly on SIGTERM", async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), "dome-bin-serve-"));
    fixtures.push(vaultPath);
    expect((await runDome(["init", vaultPath])).exitCode).toBe(0);

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
    });

    try {
      await waitFor(async () => {
        const status = await runDomeJson<{
          readonly head: string | null;
          readonly adopted: string | null;
          readonly serve_status: string;
          readonly serve_pid: number | null;
        }>(["status", "--vault", vaultPath, "--json"]);
        return (
          status.serve_status === "running" &&
          status.serve_pid === serve.pid &&
          status.head !== null &&
          status.adopted === status.head
        );
      }, 5_000);

      serve.kill("SIGTERM");
      const exitCode = await exitWithin(serve, 5_000);
      const [stdout, stderr] = await Promise.all([
        new Response(serve.stdout).text(),
        new Response(serve.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toBe("");

      const after = await runDomeJson<{
        readonly serve_status: string;
        readonly serve_pid: number | null;
      }>(["status", "--vault", vaultPath, "--json"]);
      expect(after.serve_status).toBe("off");
      expect(after.serve_pid).toBeNull();
    } finally {
      if (!serve.killed) serve.kill("SIGTERM");
    }
  });
});

type DomeProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function runDome(args: ReadonlyArray<string>): Promise<DomeProcessResult> {
  const proc = Bun.spawn({
    cmd: [DOME_BIN, ...args],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
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

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
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
