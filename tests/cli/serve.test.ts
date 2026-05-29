// Phase 11b — end-to-end tests for `dome serve`.
//
// Two tests cover the load-bearing surface:
//
//   1. End-to-end smoke: start the daemon against a real tmpdir vault with
//      the shipped first-party bundle root; let it run the empty-diff init
//      (advances refs/dome/adopted/main from null → initial commit);
//      make a second commit; wait for the daemon to detect the drift and
//      advance the adopted ref to the new HEAD; cancel via AbortSignal;
//      assert the daemon exited 0 and the run-ledger is clean (no failed
//      or stuck-running rows).
//
//   2. Detached-HEAD startup error: the daemon refuses to start when HEAD
//      is detached, exiting with code 1 and a clear stderr message.
//
// The tests use the `signal: AbortSignal` cancellation hook on `runServe`
// rather than real OS-signal delivery — under `bun test` a real SIGINT
// would tear down the test runner itself. The hook is the same boundary
// the SIGINT/SIGTERM handlers register against internally; production
// callers don't pass `signal` and rely on the OS-signal handlers.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runServe } from "../../src/cli/commands/serve";
import { runStatus } from "../../src/cli/commands/status";
import { runSync } from "../../src/cli/commands/sync";

import { externalActionEffect } from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { commit, currentSha, initRepo } from "../../src/git";
import { getAdoptedRef } from "../../src/adopted-ref";
import { openLedgerDb } from "../../src/ledger/db";
import { queryRuns } from "../../src/ledger/runs";
import { openOutboxDb } from "../../src/outbox/db";
import { insertPending, queryOutbox } from "../../src/outbox/dispatch";

// ----- Paths ----------------------------------------------------------------

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(THIS_FILE), "..", "..");
const SHIPPED_BUNDLES_ROOT = join(REPO_ROOT, "assets", "extensions");
const TEST_BUNDLES_ROOT = join(REPO_ROOT, "tests", "harness", "fixtures", "bundles");
const VALID_CONCEPT_PAGE = "---\ntype: concept\n---\n\n# Page\n";

// ----- Console capture ------------------------------------------------------

type Captured = { out: string[]; err: string[] };
let captured: Captured = { out: [], err: [] };
let origLog: typeof console.log = console.log;
let origErr: typeof console.error = console.error;
let origWarn: typeof console.warn = console.warn;
let consoleSilenced = false;

function silenceConsole(): void {
  captured = { out: [], err: [] };
  if (consoleSilenced) return;
  origLog = console.log;
  origErr = console.error;
  origWarn = console.warn;
  console.log = (...parts: unknown[]) => {
    captured.out.push(parts.map((p) => String(p)).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    captured.err.push(parts.map((p) => String(p)).join(" "));
  };
  console.warn = (...parts: unknown[]) => {
    captured.err.push(parts.map((p) => String(p)).join(" "));
  };
  consoleSilenced = true;
}

function restoreConsole(): void {
  if (!consoleSilenced) return;
  console.log = origLog;
  console.error = origErr;
  console.warn = origWarn;
  consoleSilenced = false;
}

// ----- Fixture --------------------------------------------------------------

type Fixture = {
  vaultPath: string;
  bundlesRoot: string;
  initialSha: string;
  cleanup: () => Promise<void>;
};

/**
 * Build a fresh tmpdir vault: a real git repo with one valid seed commit.
 * The daemon opens the SDK's shipped first-party bundles through
 * `bundlesRoot`; the test makes additional commits during the run.
 */
async function makeFixture(
  opts: {
    readonly bundlesRoot?: string;
    readonly configYaml?: string;
  } = {},
): Promise<Fixture> {
  const vaultPath = mkdtempSync(join(tmpdir(), "serve-test-"));
  await initRepo(vaultPath);
  await mkdir(join(vaultPath, "wiki"), { recursive: true });

  await writeFile(join(vaultPath, "wiki/seed.md"), VALID_CONCEPT_PAGE);
  const initialSha = await commit({
    path: vaultPath,
    message: "init\n",
    files: ["wiki/seed.md"],
  });

  await mkdir(join(vaultPath, ".dome", "state"), { recursive: true });
  await writeFile(
    join(vaultPath, ".dome", "config.yaml"),
    opts.configYaml ??
      `
extensions:
  dome.markdown:
    enabled: true
    grant:
      read:
        - "**/*.md"
        - ".dome/page-types.yaml"
      patch.auto:
        - "**/*.md"
`,
  );

  return {
    vaultPath,
    bundlesRoot: opts.bundlesRoot ?? SHIPPED_BUNDLES_ROOT,
    initialSha,
    cleanup: async () => {
      await rm(vaultPath, { recursive: true, force: true });
    },
  };
}

const fixtures: Fixture[] = [];
afterEach(async () => {
  restoreConsole();
  while (fixtures.length > 0) {
    const f = fixtures.pop();
    if (f !== undefined) await f.cleanup();
  }
});

// ----- Test 1: smoke --------------------------------------------------------

describe("runServe smoke", () => {
  test("watches for drift, runs adoption on new commit, exits 0 on abort", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    silenceConsole();

    const controller = new AbortController();
    const options = {
      vault: f.vaultPath,
      bundlesRoot: f.bundlesRoot,
      pollIntervalMs: 20,
    };

    // Start the daemon. Don't await — it loops until the abort fires.
    const servePromise = runServe(options, {
      signal: controller.signal,
      operationalIntervalMs: 20,
    });

    // Give the daemon a few polls to:
    //   (a) advance the adopted ref from null → initialSha (empty-diff init);
    //   (b) settle into a quiet steady state.
    await waitFor(
      async () => (await getAdoptedRef(f.vaultPath, "main")) === f.initialSha,
      2000,
    );

    // Make a second commit. The daemon should detect drift on the next
    // poll and run adoption against `(initialSha, newSha)`.
    await writeFile(join(f.vaultPath, "wiki/new.md"), VALID_CONCEPT_PAGE);
    const newSha = await commit({
      path: f.vaultPath,
      message: "add wiki/new.md\n",
      files: ["wiki/new.md"],
    });

    // Wait for the adopted ref to advance past initialSha to newSha.
    await waitFor(
      async () => (await getAdoptedRef(f.vaultPath, "main")) === newSha,
      2000,
    );

    // Cancel and let the daemon shut down.
    controller.abort();
    const code = await servePromise;
    expect(code).toBe(0);

    captured.out = [];
    captured.err = [];
    const statusCode = await runStatus({
      vault: f.vaultPath,
      bundlesRoot: f.bundlesRoot,
      json: true,
    });
    expect(statusCode).toBe(0);
    expect(captured.err.join("\n")).toBe("");
    const status = JSON.parse(captured.out.join("\n")) as {
      readonly branch: string | null;
      readonly head: string | null;
      readonly adopted: string | null;
      readonly pending_runs: number;
      readonly failed_runs: number;
      readonly diagnostics: number;
      readonly questions: number;
      readonly outbox_pending: number;
      readonly outbox_failed: number;
      readonly quarantined: number;
    };
    expect(status.branch).toBe("main");
    expect(status.head).toBe(newSha);
    expect(status.adopted).toBe(newSha);
    expect(status.pending_runs).toBe(0);
    expect(status.failed_runs).toBe(0);
    expect(status.diagnostics).toBe(0);
    expect(status.questions).toBe(0);
    expect(status.outbox_pending).toBe(0);
    expect(status.outbox_failed).toBe(0);
    expect(status.quarantined).toBe(0);

    // Open the ledger READ-ONLY through a separate handle after the host's
    // runtime closes. The load-bearing assertions above cover the host and
    // status surfaces; this final check ensures no failed or stuck-running
    // rows leaked from the two adoption cycles.
    const ledgerPath = join(f.vaultPath, ".dome", "state", "runs.db");
    const ledger = await openLedgerDb({ path: ledgerPath });
    if (!ledger.ok) throw new Error(`could not reopen ledger: ${ledger.error.kind}`);
    try {
      const failed = queryRuns(ledger.value.db, { status: "failed" });
      expect(failed.length).toBe(0);
      const running = queryRuns(ledger.value.db, { status: "running" });
      expect(running.length).toBe(0);
    } finally {
      ledger.value.db.close();
    }
  }, 10_000);

  test("drains due operational work while HEAD is already in sync", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    silenceConsole();

    const controller = new AbortController();
    const servePromise = runServe(
      {
        vault: f.vaultPath,
        bundlesRoot: f.bundlesRoot,
        pollIntervalMs: 20,
      },
      {
        signal: controller.signal,
        operationalIntervalMs: 20,
      },
    );

    await waitFor(
      async () => (await getAdoptedRef(f.vaultPath, "main")) === f.initialSha,
      2000,
    );

    const outboxPath = join(f.vaultPath, ".dome", "state", "outbox.db");
    const outbox = await openOutboxDb({ path: outboxPath });
    if (!outbox.ok) throw new Error(`could not open outbox: ${outbox.error.kind}`);
    try {
      insertPending(outbox.value.db, {
        effect: externalActionEffect({
          capability: "calendar.write",
          idempotencyKey: "serve-in-sync-drain",
          payload: { event: "x" },
          sourceRefs: [
            sourceRef({
              commit: commitOid(f.initialSha),
              path: "wiki/seed.md",
            }),
          ],
        }),
        runId: "run-test",
      });
    } finally {
      outbox.value.db.close();
    }

    await waitFor(async () => {
      const check = await openOutboxDb({ path: outboxPath });
      if (!check.ok) return false;
      try {
        return queryOutbox(check.value.db)[0]?.status === "failed";
      } finally {
        check.value.db.close();
      }
    }, 2000);

    controller.abort();
    const code = await servePromise;
    expect(code).toBe(0);
  }, 10_000);

  test("--quiet suppresses banner, adoption, and shutdown chatter", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    silenceConsole();

    const controller = new AbortController();
    const servePromise = runServe(
      {
        vault: f.vaultPath,
        bundlesRoot: f.bundlesRoot,
        pollIntervalMs: 20,
        quiet: true,
      },
      {
        signal: controller.signal,
        operationalIntervalMs: 20,
      },
    );

    await waitFor(
      async () => (await getAdoptedRef(f.vaultPath, "main")) === f.initialSha,
      2000,
    );

    controller.abort();
    const code = await servePromise;
    expect(code).toBe(0);
    expect(captured.out.join("\n")).toBe("");
    expect(captured.err.join("\n")).toBe("");
  }, 10_000);

  test("coalesces HEAD movement that happens while adoption is active", async () => {
    const f = await makeFixture({
      bundlesRoot: TEST_BUNDLES_ROOT,
      configYaml: `
extensions:
  test.slow-adoption:
    enabled: true
    grant:
      read: ["wiki/**"]
`,
    });
    fixtures.push(f);
    silenceConsole();

    const initCode = await runSync({
      vault: f.vaultPath,
      bundlesRoot: f.bundlesRoot,
    });
    expect(initCode).toBe(0);
    expect(await getAdoptedRef(f.vaultPath, "main")).toBe(f.initialSha);

    await writeFile(join(f.vaultPath, "wiki/slow.md"), "# Slow\n");
    await commit({
      path: f.vaultPath,
      message: "slow adoption trigger\n",
      files: ["wiki/slow.md"],
    });

    const controller = new AbortController();
    const servePromise = runServe(
      {
        vault: f.vaultPath,
        bundlesRoot: f.bundlesRoot,
        pollIntervalMs: 5000,
      },
      {
        signal: controller.signal,
        operationalIntervalMs: 5000,
      },
    );

    await waitForRunningProcessor(
      f,
      "test.slow-adoption.sleep",
      2000,
    );

    await writeFile(join(f.vaultPath, "wiki/after.md"), "# After\n");
    const finalSha = await commit({
      path: f.vaultPath,
      message: "commit while adoption runs\n",
      files: ["wiki/after.md"],
    });

    await waitFor(
      async () => (await getAdoptedRef(f.vaultPath, "main")) === finalSha,
      2500,
    );

    controller.abort();
    const code = await servePromise;
    expect(code).toBe(0);
  }, 10_000);
});

// ----- Test 2: detached HEAD ------------------------------------------------

describe("runServe detached HEAD", () => {
  test("malformed --poll-interval-ms exits 1 before opening runtime", async () => {
    silenceConsole();

    const code = await runServe({ pollIntervalMs: "500x" });
    expect(code).toBe(1);
    expect(captured.err.join("\n")).toContain(
      "--poll-interval-ms must be a positive integer",
    );
  });

  test("refuses to start when HEAD is detached; exit code 1", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    silenceConsole();

    // Detach HEAD by writing the seed commit OID directly into
    // `.git/HEAD` (instead of the symbolic ref `ref: refs/heads/main`).
    // isomorphic-git interprets a raw-OID `HEAD` as detached, and the
    // git boundary's `currentBranch` returns `null` in this state.
    const sha = await currentSha(f.vaultPath);
    if (sha === null) throw new Error("expected initial sha");
    await writeFile(join(f.vaultPath, ".git", "HEAD"), `${sha}\n`);

    const controller = new AbortController();
    const code = await runServe(
      { vault: f.vaultPath, bundlesRoot: f.bundlesRoot },
      { signal: controller.signal },
    );
    expect(code).toBe(1);

    // Stderr should explain the detached-HEAD condition. The exact
    // wording is load-bearing for operator UX; assert on the keyword.
    const errBlob = captured.err.join("\n");
    expect(errBlob).toContain("detached");
  }, 5_000);
});

// ----- Internals ------------------------------------------------------------

/**
 * Spin-wait until `predicate` returns true, polling every 25ms, capped
 * at `timeoutMs`. Throws on timeout — the daemon was supposed to
 * advance state and didn't, which is a real test failure (not a flake).
 */
async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise<void>((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
}

async function waitForRunningProcessor(
  fixture: Fixture,
  processorId: string,
  timeoutMs: number,
): Promise<void> {
  await waitFor(async () => {
    const ledgerPath = join(fixture.vaultPath, ".dome", "state", "runs.db");
    const ledger = await openLedgerDb({ path: ledgerPath });
    if (!ledger.ok) return false;
    try {
      return queryRuns(ledger.value.db, { status: "running" }).some(
        (row) => row.processorId === processorId,
      );
    } finally {
      ledger.value.db.close();
    }
  }, timeoutMs);
}
