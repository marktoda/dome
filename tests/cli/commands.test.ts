// Phase 9 — end-to-end tests for the four CLI commands.
//
// Each describe block sets up a fresh tmpdir vault (a real git repo
// with two commits + the shipped dome.lint bundle copied in), invokes
// the relevant `run<Command>` function with parsed args, and asserts on
// the returned exit code + the side effects on disk / DBs.
//
// Tests run the command handlers directly — they don't spawn `bun`
// subprocesses. That keeps the suite fast and lets us assert on
// internal state (filesystem layout, DB rows) without parsing stdout.
//
// Console output is captured to keep test logs quiet; the assertions
// don't depend on the captured strings (handlers' return codes are the
// load-bearing surface).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../../src/cli/args";
import { runInit } from "../../src/cli/commands/init";
import { runSubmit } from "../../src/cli/commands/submit";
import { runDoctor } from "../../src/cli/commands/doctor";
import { runStatus } from "../../src/cli/commands/status";

import { commit, initRepo } from "../../src/git";

// ----- Paths ----------------------------------------------------------------

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(THIS_FILE), "..", "..");
const SHIPPED_BUNDLES_ROOT = join(REPO_ROOT, "assets", "extensions");

// ----- Console capture ------------------------------------------------------
//
// Each test silences console.log / console.error so the suite output stays
// quiet. The captured strings are exposed via the `captured` object in
// case a test wants to inspect them.

type Captured = {
  out: string[];
  err: string[];
};

let captured: Captured;
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  captured = { out: [], err: [] };
  origLog = console.log;
  origErr = console.error;
  console.log = (...parts: unknown[]) => {
    captured.out.push(parts.map((p) => String(p)).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    captured.err.push(parts.map((p) => String(p)).join(" "));
  };
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

// ----- Fixture helpers -------------------------------------------------------

type Fixture = {
  vaultPath: string;
  bundlesRoot: string;
  baseSha: string;
  headSha: string;
  cleanup: () => Promise<void>;
};

/**
 * Build a fresh tmpdir vault with two commits + the shipped dome.lint
 * bundle copied in. The two commits give submit something to propose
 * (base = first commit, head = second commit). The bundle gives the
 * runtime something to load. The vault path is a fresh tmpdir; the
 * cleanup removes it after the test.
 */
async function makeFixture(): Promise<Fixture> {
  const vaultPath = mkdtempSync(join(tmpdir(), "cli-commands-"));
  await initRepo(vaultPath);
  await mkdir(join(vaultPath, "wiki"), { recursive: true });

  await writeFile(join(vaultPath, "wiki/seed.md"), "seed\n");
  const baseSha = await commit({
    path: vaultPath,
    message: "init\n",
    files: ["wiki/seed.md"],
  });

  await writeFile(join(vaultPath, "wiki/new.md"), "new page\n");
  const headSha = await commit({
    path: vaultPath,
    message: "add wiki/new.md\n",
    files: ["wiki/new.md"],
  });

  // Copy the shipped dome.lint bundle into .dome/extensions/ so
  // openVaultRuntime has a real bundle root to load.
  await mkdir(join(vaultPath, ".dome", "state"), { recursive: true });
  await mkdir(join(vaultPath, ".dome", "extensions"), { recursive: true });
  await copyTree(
    join(SHIPPED_BUNDLES_ROOT, "dome.lint"),
    join(vaultPath, ".dome", "extensions", "dome.lint"),
  );

  return {
    vaultPath,
    bundlesRoot: SHIPPED_BUNDLES_ROOT,
    baseSha,
    headSha,
    cleanup: async () => {
      await rm(vaultPath, { recursive: true, force: true });
    },
  };
}

/** Recursive copy helper for the fixture. Mirrors `init.ts`'s `copyTree`. */
async function copyTree(src: string, dst: string): Promise<void> {
  const s = await stat(src);
  if (!s.isDirectory()) {
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    return;
  }
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcChild = join(src, entry.name);
    const dstChild = join(dst, entry.name);
    if (entry.isDirectory()) await copyTree(srcChild, dstChild);
    else if (entry.isFile()) await copyFile(srcChild, dstChild);
  }
}

const fixtures: Fixture[] = [];
afterEach(async () => {
  while (fixtures.length > 0) {
    const f = fixtures.pop();
    if (f !== undefined) await f.cleanup();
  }
});

// ----- runInit --------------------------------------------------------------

describe("runInit", () => {
  test("creates .dome/state/ + copies dome.lint bundle into a fresh dir", async () => {
    // Fresh tmpdir — no git repo, no .dome/ — just a directory.
    const target = mkdtempSync(join(tmpdir(), "cli-init-"));
    try {
      const args = parseArgs(["init", target]);
      const code = await runInit(args);
      expect(code).toBe(0);

      expect(existsSync(join(target, ".dome", "state"))).toBe(true);
      expect(
        existsSync(join(target, ".dome", "extensions", "dome.lint", "manifest.yaml")),
      ).toBe(true);
      expect(
        existsSync(
          join(
            target,
            ".dome",
            "extensions",
            "dome.lint",
            "processors",
            "markdown-format.ts",
          ),
        ),
      ).toBe(true);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("is idempotent — re-running on an initialized dir is a no-op success", async () => {
    const target = mkdtempSync(join(tmpdir(), "cli-init-idem-"));
    try {
      const args = parseArgs(["init", target]);
      expect(await runInit(args)).toBe(0);
      expect(await runInit(args)).toBe(0);
      expect(existsSync(join(target, ".dome", "state"))).toBe(true);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});

// ----- runSubmit ------------------------------------------------------------

describe("runSubmit", () => {
  test("submits the current HEAD as a clientProposal and returns 0 on adoption", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const args = parseArgs(["submit", "--vault", f.vaultPath, "--bundles-root", f.bundlesRoot]);
    const code = await runSubmit(args);
    expect(code).toBe(0);
  });

  test("rejects --patch with a non-zero exit and a clear message", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const args = parseArgs([
      "submit",
      "--vault",
      f.vaultPath,
      "--patch",
      "/tmp/some.patch",
    ]);
    const code = await runSubmit(args);
    expect(code).not.toBe(0);
    // The error message mentions --patch so a user knows what failed.
    expect(captured.err.join("\n")).toContain("--patch");
  });

  test("--json mode emits a parseable JSON payload", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const args = parseArgs(["submit", "--vault", f.vaultPath, "--bundles-root", f.bundlesRoot, "--json"]);
    const code = await runSubmit(args);
    expect(code).toBe(0);

    // Find the JSON payload — it's the longest single line of stdout.
    const blob = captured.out.find((line) => line.includes("\"proposalId\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(parsed["adopted"]).toBe(true);
  });
});

// ----- runDoctor ------------------------------------------------------------

describe("runDoctor", () => {
  test("--show runs returns 0 on a fresh vault with an empty-table message", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const args = parseArgs([
      "doctor",
      "--vault",
      f.vaultPath,
      "--bundles-root",
      f.bundlesRoot,
      "--show",
      "runs",
    ]);
    const code = await runDoctor(args);
    expect(code).toBe(0);
    expect(captured.out.join("\n")).toContain("(no rows)");
  });

  test("--show diagnostics returns 0 on a fresh vault", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const args = parseArgs([
      "doctor",
      "--vault",
      f.vaultPath,
      "--bundles-root",
      f.bundlesRoot,
      "--show",
      "diagnostics",
    ]);
    expect(await runDoctor(args)).toBe(0);
  });

  test("--show questions and outbox both return 0", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(
      await runDoctor(
        parseArgs(["doctor", "--vault", f.vaultPath, "--bundles-root", f.bundlesRoot, "--show", "questions"]),
      ),
    ).toBe(0);
    expect(
      await runDoctor(
        parseArgs(["doctor", "--vault", f.vaultPath, "--bundles-root", f.bundlesRoot, "--show", "outbox"]),
      ),
    ).toBe(0);
  });

  test("missing --show returns 64 (EX_USAGE)", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const args = parseArgs(["doctor", "--vault", f.vaultPath]);
    expect(await runDoctor(args)).toBe(64);
  });

  test("unknown subject returns 64", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const args = parseArgs([
      "doctor",
      "--vault",
      f.vaultPath,
      "--show",
      "garbage",
    ]);
    expect(await runDoctor(args)).toBe(64);
  });
});

// ----- runStatus ------------------------------------------------------------

describe("runStatus", () => {
  test("prints sensible defaults on a fresh (unsubmitted) vault", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const args = parseArgs(["status", "--vault", f.vaultPath, "--bundles-root", f.bundlesRoot]);
    const code = await runStatus(args);
    expect(code).toBe(0);

    const out = captured.out.join("\n");
    expect(out).toContain("(uninitialized)"); // adopted ref
    expect(out).toContain("(never)"); // last_sync
  });

  test("--json mode emits a parseable JSON object with expected keys", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const args = parseArgs(["status", "--vault", f.vaultPath, "--bundles-root", f.bundlesRoot, "--json"]);
    expect(await runStatus(args)).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"vault\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(parsed["vault"]).toBe(f.vaultPath);
    expect(parsed["branch"]).toBeDefined();
    expect(parsed["pending_runs"]).toBe(0);
  });

  test("status after a submit reports the advanced adopted ref", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    // First submit so the adopted ref advances to head.
    const submitCode = await runSubmit(
      parseArgs(["submit", "--vault", f.vaultPath, "--bundles-root", f.bundlesRoot]),
    );
    expect(submitCode).toBe(0);

    captured.out = [];

    // Now status. dome.lint is view-phase only — no adoption-phase runs
    // fired, so `last_sync` stays null. But the adopted ref now points
    // at head, so the snapshot's `adopted` field carries the head OID
    // (not "(uninitialized)"). The load-bearing assertion is the exit
    // code (read-only command); the adopted-ref check is a smoke test.
    const code = await runStatus(
      parseArgs(["status", "--vault", f.vaultPath, "--bundles-root", f.bundlesRoot, "--json"]),
    );
    expect(code).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"adopted\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(parsed["adopted"]).toBe(f.headSha);
  });
});
