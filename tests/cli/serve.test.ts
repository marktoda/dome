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
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runServe } from "../../src/cli/commands/serve";
import { runStatus } from "../../src/cli/commands/status";
import { runSync } from "../../src/cli/commands/sync";
import { runInspect } from "../../src/cli/commands/inspect";

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
const SERVE_REF_WAIT_MS = 5_000;

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
    readonly extraInitialFiles?: Readonly<Record<string, string>>;
  } = {},
): Promise<Fixture> {
  const vaultPath = mkdtempSync(join(tmpdir(), "serve-test-"));
  await initRepo(vaultPath);
  await mkdir(join(vaultPath, "wiki"), { recursive: true });
  await mkdir(join(vaultPath, ".dome"), { recursive: true });

  await writeFile(join(vaultPath, "wiki/seed.md"), VALID_CONCEPT_PAGE);
  await writeFile(
    join(vaultPath, ".dome", "config.yaml"),
    opts.configYaml ?? defaultServeConfig(),
  );
  for (const [path, content] of Object.entries(opts.extraInitialFiles ?? {})) {
    await mkdir(dirname(join(vaultPath, path)), { recursive: true });
    await writeFile(join(vaultPath, path), content, "utf8");
  }
  const initialSha = await commit({
    path: vaultPath,
    message: "init\n",
    files: [
      "wiki/seed.md",
      ".dome/config.yaml",
      ...Object.keys(opts.extraInitialFiles ?? {}),
    ],
  });

  await mkdir(join(vaultPath, ".dome", "state"), { recursive: true });
  return {
    vaultPath,
    bundlesRoot: opts.bundlesRoot ?? SHIPPED_BUNDLES_ROOT,
    initialSha,
    cleanup: async () => {
      await rm(vaultPath, { recursive: true, force: true });
    },
  };
}

function defaultServeConfig(): string {
  return `
extensions:
  dome.markdown:
    enabled: true
    grant:
      read:
        - "**/*.md"
        - ".dome/page-types.yaml"
      patch.auto:
        - "**/*.md"
`;
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

    captured.out = [];
    captured.err = [];
    const runningStatusCode = await runStatus({
      vault: f.vaultPath,
      bundlesRoot: f.bundlesRoot,
      json: true,
    });
    expect(runningStatusCode).toBe(0);
    const runningStatusBlob = captured.out.find((line) =>
      line.includes("\"vault\"")
    );
    expect(runningStatusBlob).toBeDefined();
    if (runningStatusBlob === undefined) return;
    const runningStatus = JSON.parse(runningStatusBlob) as {
      readonly serve_status: string;
      readonly serve_pid: number | null;
      readonly serve_branch: string | null;
    };
    expect(runningStatus.serve_status).toBe("running");
    expect(runningStatus.serve_pid).toBe(process.pid);
    expect(runningStatus.serve_branch).toBe("main");
    captured.out = [];
    captured.err = [];

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
      readonly serve_status: string;
    };
    expect(status.branch).toBe("main");
    expect(status.head).toBe(newSha);
    expect(status.adopted).toBe(newSha);
    expect(status.pending_runs).toBe(0);
    expect(status.failed_runs).toBe(0);
    // The two committed wiki pages carry no `description:` frontmatter, so
    // the only durable diagnostics are the missing-description info nudges
    // (one per page). Anything else is adoption noise — pin it exactly.
    expect(status.diagnostics).toBe(2);
    captured.out = [];
    captured.err = [];
    await runInspect({
      subject: "diagnostics",
      vault: f.vaultPath,
      bundlesRoot: f.bundlesRoot,
      json: true,
    });
    const diagnosticRows = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly severity: string;
      readonly code: string;
    }>;
    expect(diagnosticRows).toHaveLength(2);
    for (const row of diagnosticRows) {
      expect(row.severity).toBe("info");
      expect(row.code).toBe("dome.markdown.missing-description");
    }
    expect(status.questions).toBe(0);
    expect(status.outbox_pending).toBe(0);
    expect(status.outbox_failed).toBe(0);
    expect(status.quarantined).toBe(0);
    expect(status.serve_status).toBe("off");

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

  test("discovers a newly-created vault-local bundle root while serving", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    silenceConsole();

    const initCode = await runSync({
      vault: f.vaultPath,
      quiet: true,
    });
    expect(initCode).toBe(0);
    expect(await getAdoptedRef(f.vaultPath, "main")).toBe(f.initialSha);
    captured.out = [];
    captured.err = [];

    const controller = new AbortController();
    const servePromise = runServe(
      {
        vault: f.vaultPath,
        pollIntervalMs: 20,
        quiet: true,
      },
      {
        signal: controller.signal,
        operationalIntervalMs: 20,
      },
    );

    try {
      await writeLocalDiagnosticBundle(f.vaultPath);
      await appendLocalBundleConfig(f.vaultPath);
      const enableBundleSha = await commit({
        path: f.vaultPath,
        message: "enable local bundle while serving\n",
        files: [
          ".dome/config.yaml",
          ".dome/extensions/custom.local/manifest.json",
          ".dome/extensions/custom.local/processors/audit.ts",
        ],
      });
      await waitFor(
        async () =>
          (await getAdoptedRef(f.vaultPath, "main")) === enableBundleSha,
        3000,
      );

      await writeFile(
        join(f.vaultPath, "wiki", "local.md"),
        "# Local bundle proof\n",
        "utf8",
      );
      const localPageSha = await commit({
        path: f.vaultPath,
        message: "add local bundle proof page\n",
        files: ["wiki/local.md"],
      });
      await waitFor(
        async () => (await getAdoptedRef(f.vaultPath, "main")) === localPageSha,
        3000,
      );
    } finally {
      controller.abort();
    }

    const code = await servePromise;
    expect(code).toBe(0);
    expect(captured.err.join("\n")).toBe("");

    captured.out = [];
    captured.err = [];
    const inspectCode = await runInspect({
      subject: "diagnostics",
      vault: f.vaultPath,
      code: "custom.local.seen",
      json: true,
    });
    expect(inspectCode).toBe(0);
    const diagnostics = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly code: string;
      readonly message: string;
    }>;
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "custom.local.seen",
        message: "Vault-local bundle ran through the default composed root.",
      }),
    );
  }, 25_000);

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

  test("--filter-processor narrows verbose adoption events", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    silenceConsole();

    const initCode = await runSync({
      vault: f.vaultPath,
      bundlesRoot: f.bundlesRoot,
    });
    expect(initCode).toBe(0);
    expect(await getAdoptedRef(f.vaultPath, "main")).toBe(f.initialSha);
    captured.out = [];
    captured.err = [];

    await writeFile(join(f.vaultPath, "wiki/filter.md"), VALID_CONCEPT_PAGE);
    const newSha = await commit({
      path: f.vaultPath,
      message: "add filtered page\n",
      files: ["wiki/filter.md"],
    });

    const controller = new AbortController();
    const servePromise = runServe(
      {
        vault: f.vaultPath,
        bundlesRoot: f.bundlesRoot,
        pollIntervalMs: 20,
        verbose: true,
        filterProcessor: "dome.markdown.normalize-*",
      },
      {
        signal: controller.signal,
        operationalIntervalMs: 20,
      },
    );

    let code: number | null = null;
    try {
      await waitFor(
        async () => (await getAdoptedRef(f.vaultPath, "main")) === newSha,
        SERVE_REF_WAIT_MS,
      );
    } finally {
      controller.abort();
      code = await servePromise;
    }
    expect(code).toBe(0);
    // Verbose progress events go to stderr; stdout carries the human summary.
    const errBlob = captured.err.join("\n");
    expect(errBlob).toContain("dome.markdown.normalize-frontmatter");
    expect(errBlob).not.toContain("dome.markdown.validate-wikilinks");
    expect(errBlob).not.toContain("dome serve:   iteration");
  }, 15_000);

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

  test("daemon mode starts a detached host and clears heartbeat on SIGTERM", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    silenceConsole();

    let daemonPid: number | null = null;
    try {
      const code = await runServe({
        vault: f.vaultPath,
        bundlesRoot: f.bundlesRoot,
        pollIntervalMs: 20,
        quiet: true,
        daemon: true,
        // Generous under full-suite parallelism: child startup (bun boot +
        // runtime open + first heartbeat) regularly exceeded 5s under load
        // and flaked this test all night on 2026-06-10.
        daemonTimeoutMs: 15_000,
      });
      expect(code).toBe(0);

      const runningStatus = await readStatusJson(f);
      daemonPid = runningStatus.serve_pid;
      expect(runningStatus.serve_status).toBe("running");
      expect(typeof daemonPid).toBe("number");
      expect(runningStatus.serve_branch).toBe("main");
      if (daemonPid === null) return;
      const pid = daemonPid;
      expect(pid).not.toBe(process.pid);
      expect(() => process.kill(pid, 0)).not.toThrow();

      process.kill(pid, "SIGTERM");
      await waitFor(async () => {
        const status = await readStatusJson(f);
        return status.serve_status === "off";
      }, 15_000);
      daemonPid = null;
    } finally {
      // Orphan-proofing: if an assertion threw before the pid was learned
      // (e.g. the status read itself failed), recover it from the heartbeat
      // file so a real polling daemon never outlives the test — an orphan
      // at pollIntervalMs=20 burns CPU indefinitely and can wedge the
      // suite (suspected cause of the 54-minute hang on 2026-06-10).
      if (daemonPid === null) {
        try {
          const heartbeat = JSON.parse(
            await readFile(
              join(f.vaultPath, ".dome", "state", "serve-heartbeat.json"),
              "utf8",
            ),
          ) as { readonly pid?: number };
          if (typeof heartbeat.pid === "number") daemonPid = heartbeat.pid;
        } catch {
          // No heartbeat — nothing to clean up.
        }
      }
      if (daemonPid !== null && daemonPid !== process.pid) {
        try {
          process.kill(daemonPid, "SIGKILL");
        } catch {
          // The daemon already exited.
        }
      }
    }
  }, 40_000);
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

async function readStatusJson(fixture: Fixture): Promise<{
  readonly serve_status: string;
  readonly serve_pid: number | null;
  readonly serve_branch: string | null;
}> {
  captured.out = [];
  captured.err = [];
  const statusCode = await runStatus({
    vault: fixture.vaultPath,
    bundlesRoot: fixture.bundlesRoot,
    json: true,
  });
  expect(statusCode).toBe(0);
  const blob = captured.out.find((line) => line.includes("\"vault\""));
  expect(blob).toBeDefined();
  if (blob === undefined) {
    throw new Error("expected status JSON");
  }
  return JSON.parse(blob) as {
    readonly serve_status: string;
    readonly serve_pid: number | null;
    readonly serve_branch: string | null;
  };
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

async function appendLocalBundleConfig(target: string): Promise<void> {
  const configPath = join(target, ".dome", "config.yaml");
  const config = await readFile(configPath, "utf8");
  const localBundleStanza = `  custom.local:
    enabled: true
    grant:
      read: ["wiki/**/*.md"]
`;
  if (!config.includes("\nengine:\n")) {
    await writeFile(
      configPath,
      config.replace("extensions:\n", `extensions:\n${localBundleStanza}`),
      "utf8",
    );
    return;
  }
  await writeFile(
    configPath,
    config.replace("\nengine:\n", `\n${localBundleStanza}\nengine:\n`),
    "utf8",
  );
}

async function writeLocalDiagnosticBundle(target: string): Promise<void> {
  const bundleDir = join(target, ".dome", "extensions", "custom.local");
  const processorsDir = join(bundleDir, "processors");
  await mkdir(processorsDir, { recursive: true });
  await writeFile(
    join(bundleDir, "manifest.json"),
    JSON.stringify({
      id: "custom.local",
      version: "0.1.0",
      processors: [
        {
          id: "custom.local.audit",
          version: "0.1.0",
          phase: "adoption",
          triggers: [
            {
              kind: "signal",
              name: "file.created",
              pathPattern: "wiki/**/*.md",
            },
          ],
          capabilities: [{ kind: "read", paths: ["wiki/**/*.md"] }],
          module: "processors/audit.ts",
        },
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(processorsDir, "audit.ts"),
    `
      export default {
        async run(ctx) {
          return [{
            kind: "diagnostic",
            severity: "info",
            code: "custom.local.seen",
            message: "Vault-local bundle ran through the default composed root.",
            sourceRefs: [ctx.sourceRef("wiki/local.md")],
          }];
        },
      };
    `,
    "utf8",
  );
}
