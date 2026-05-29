// Phase 11c — end-to-end tests for `dome sync`.
//
// `dome sync` is the one-shot catch-up: detect drift between working-tree
// HEAD and `refs/dome/adopted/<branch>`, run a single adoption cycle if
// drift is present, print the result, exit. It reuses the shared drift
// + adoption helpers in `src/engine/compiler-host.ts` with `dome serve`.
//
// Four tests cover the four outcome shapes:
//
//   1. Empty-diff init: fresh vault with one commit, no adopted ref →
//      first `dome sync` advances the adopted ref to HEAD (exit 0).
//
//   2. Already in sync: run sync twice → second invocation prints
//      "already in sync" without growing the ledger (exit 0).
//
//   3. Drift adoption: make a second commit → sync → adopted ref
//      advances to the new HEAD (exit 0).
//
//   4. Detached HEAD refusal: detach HEAD → sync refuses with exit 64
//      (EX_USAGE) and a clear error message.
//
// Fixture pattern mirrors `tests/cli/serve.test.ts`: a tmpdir vault with
// a valid seed commit and the shipped first-party bundle root. No mocks;
// the real git boundary, the real engine, the real sqlite handles.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runSync } from "../../src/cli/commands/sync";

import { externalActionEffect } from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { commit, currentSha, initRepo } from "../../src/git";
import { getAdoptedRef } from "../../src/adopted-ref";
import {
  compilerHostLockPath,
  withCompilerHostBranchLock,
} from "../../src/engine/compiler-host-lock";
import { openLedgerDb } from "../../src/ledger/db";
import { queryRuns } from "../../src/ledger/runs";
import { openOutboxDb } from "../../src/outbox/db";
import { insertPending, queryOutbox } from "../../src/outbox/dispatch";

// ----- Paths ----------------------------------------------------------------

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(THIS_FILE), "..", "..");
const SHIPPED_BUNDLES_ROOT = join(REPO_ROOT, "assets", "extensions");
const VALID_CONCEPT_PAGE = "---\ntype: concept\n---\n\n# Page\n";
const SYNC_JSON_KEYS = Object.freeze([
  "status",
  "branch",
  "base",
  "head",
  "adoptedRef",
  "iterations",
  "closureCommit",
  "diagnostics",
]);
const SYNC_ERROR_JSON_KEYS = Object.freeze([...SYNC_JSON_KEYS, "error"]);

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
 * The command opens the SDK's shipped first-party bundles through
 * `bundlesRoot`.
 */
async function makeFixture(): Promise<Fixture> {
  const vaultPath = mkdtempSync(join(tmpdir(), "sync-test-"));
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
    bundlesRoot: SHIPPED_BUNDLES_ROOT,
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

// ----- Test 1: empty-diff init ----------------------------------------------

describe("runSync empty-diff init", () => {
  test("fresh vault: first sync advances adopted ref to HEAD; exit 0", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    silenceConsole();

    // Pre-condition: adopted ref is uninitialized.
    expect(await getAdoptedRef(f.vaultPath, "main")).toBeNull();

    const options = { vault: f.vaultPath, bundlesRoot: f.bundlesRoot };
    const code = await runSync(options);
    expect(code).toBe(0);

    // Post-condition: adopted ref now equals the seed commit.
    expect(await getAdoptedRef(f.vaultPath, "main")).toBe(f.initialSha);

    // Stdout should include "adopted" (the success line).
    const outBlob = captured.out.join("\n");
    expect(outBlob).toContain("adopted");
    expect(outBlob).toContain("main");
  }, 10_000);

  test("--json adopted payload keeps the fixture schema stable", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    silenceConsole();

    const code = await runSync({
      vault: f.vaultPath,
      bundlesRoot: f.bundlesRoot,
      json: true,
    });
    expect(code).toBe(0);

    const parsed = parseSingleJsonObject();
    expect(Object.keys(parsed)).toEqual([...SYNC_JSON_KEYS]);
    expect(parsed["status"]).toBe("adopted");
    expect(parsed["branch"]).toBe("main");
    expect(parsed["base"]).toBe(f.initialSha);
    expect(parsed["head"]).toBe(f.initialSha);
    expect(parsed["adoptedRef"]).toBe(f.initialSha);
    expect(parsed["iterations"]).toBe(1);
    expect(parsed["closureCommit"]).toBeNull();
    expect(parsed["diagnostics"]).toEqual([]);
  }, 10_000);

  test("--verbose labels adoption events as sync output", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    silenceConsole();

    const code = await runSync({
      vault: f.vaultPath,
      bundlesRoot: f.bundlesRoot,
      verbose: true,
    });
    expect(code).toBe(0);

    const outBlob = captured.out.join("\n");
    expect(outBlob).toContain("dome sync:   iteration");
    expect(outBlob).not.toContain("dome serve:   iteration");
  }, 10_000);

  test("--quiet suppresses non-error text output without changing adoption", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    silenceConsole();

    const code = await runSync({
      vault: f.vaultPath,
      bundlesRoot: f.bundlesRoot,
      quiet: true,
    });
    expect(code).toBe(0);
    expect(await getAdoptedRef(f.vaultPath, "main")).toBe(f.initialSha);
    expect(captured.out.join("\n")).toBe("");
    expect(captured.err.join("\n")).toBe("");
  }, 10_000);

  test("--quiet does not suppress explicit JSON output", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    silenceConsole();

    const code = await runSync({
      vault: f.vaultPath,
      bundlesRoot: f.bundlesRoot,
      quiet: true,
      json: true,
    });
    expect(code).toBe(0);

    const parsed = parseSingleJsonObject();
    expect(parsed["status"]).toBe("adopted");
    expect(parsed["branch"]).toBe("main");
  }, 10_000);
});

// ----- Test 2: already in sync ----------------------------------------------

describe("runSync idempotent", () => {
  test("second sync prints 'already in sync'; exit 0; ledger unchanged", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    silenceConsole();

    const options = { vault: f.vaultPath, bundlesRoot: f.bundlesRoot };

    // First sync: empty-diff init.
    const code1 = await runSync(options);
    expect(code1).toBe(0);
    expect(await getAdoptedRef(f.vaultPath, "main")).toBe(f.initialSha);

    // Snapshot ledger row count after the first run.
    const ledgerPath = join(f.vaultPath, ".dome", "state", "runs.db");
    const ledger1 = await openLedgerDb({ path: ledgerPath });
    if (!ledger1.ok) throw new Error(`could not open ledger: ${ledger1.error.kind}`);
    const runsAfterFirst = queryRuns(ledger1.value.db, {}).length;
    ledger1.value.db.close();

    // Clear captured stdout for a clean assertion on the second call.
    captured.out = [];
    captured.err = [];

    // Second sync: should be a no-op.
    const code2 = await runSync(options);
    expect(code2).toBe(0);

    // Output asserts on "already in sync".
    const outBlob = captured.out.join("\n");
    expect(outBlob).toContain("already in sync");

    // Ledger count must not have grown (no new runs queued / executed).
    const ledger2 = await openLedgerDb({ path: ledgerPath });
    if (!ledger2.ok) throw new Error(`could not reopen ledger: ${ledger2.error.kind}`);
    try {
      const runsAfterSecond = queryRuns(ledger2.value.db, {}).length;
      expect(runsAfterSecond).toBe(runsAfterFirst);
    } finally {
      ledger2.value.db.close();
    }
  }, 10_000);

  test("--json in-sync payload keeps the fixture schema stable", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    silenceConsole();

    const options = {
      vault: f.vaultPath,
      bundlesRoot: f.bundlesRoot,
      json: true,
    };

    const code1 = await runSync(options);
    expect(code1).toBe(0);
    captured.out = [];
    captured.err = [];

    const code2 = await runSync(options);
    expect(code2).toBe(0);

    const parsed = parseSingleJsonObject();
    expect(Object.keys(parsed)).toEqual([...SYNC_JSON_KEYS]);
    expect(parsed["status"]).toBe("in-sync");
    expect(parsed["branch"]).toBe("main");
    expect(parsed["base"]).toBe(f.initialSha);
    expect(parsed["head"]).toBe(f.initialSha);
    expect(parsed["adoptedRef"]).toBe(f.initialSha);
    expect(parsed["iterations"]).toBe(0);
    expect(parsed["closureCommit"]).toBeNull();
    expect(parsed["diagnostics"]).toEqual([]);
  }, 10_000);

  test("in-sync sync still drains durable operational work", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    silenceConsole();

    const options = { vault: f.vaultPath, bundlesRoot: f.bundlesRoot };

    const code1 = await runSync(options);
    expect(code1).toBe(0);
    expect(await getAdoptedRef(f.vaultPath, "main")).toBe(f.initialSha);

    const outboxPath = join(f.vaultPath, ".dome", "state", "outbox.db");
    const outbox1 = await openOutboxDb({ path: outboxPath });
    if (!outbox1.ok) throw new Error(`could not open outbox: ${outbox1.error.kind}`);
    try {
      insertPending(outbox1.value.db, {
        effect: externalActionEffect({
          capability: "calendar.write",
          idempotencyKey: "sync-in-sync-drain",
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
      expect(queryOutbox(outbox1.value.db)[0]?.status).toBe("pending");
    } finally {
      outbox1.value.db.close();
    }

    captured.out = [];
    captured.err = [];

    const code2 = await runSync(options);
    expect(code2).toBe(0);
    expect(captured.out.join("\n")).toContain("already in sync");

    const outbox2 = await openOutboxDb({ path: outboxPath });
    if (!outbox2.ok) throw new Error(`could not reopen outbox: ${outbox2.error.kind}`);
    try {
      const rows = queryOutbox(outbox2.value.db);
      expect(rows.length).toBe(1);
      expect(rows[0]?.status).toBe("failed");
      expect(rows[0]?.lastError).toContain("No external handler registered");
    } finally {
      outbox2.value.db.close();
    }
  }, 10_000);

  test("reports busy when another compiler host holds the branch lock", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    silenceConsole();

    let releaseLock: (() => void) | undefined;
    let acquired = false;
    const heldLock = withCompilerHostBranchLock(
      {
        vaultPath: f.vaultPath,
        branch: "main",
        command: "test",
      },
      async () => {
        acquired = true;
        await new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
      },
    );
    await waitFor(() => Promise.resolve(acquired), 1000);

    const options = { vault: f.vaultPath, bundlesRoot: f.bundlesRoot };
    const textCode = await runSync(options);
    expect(textCode).toBe(75);
    expect(captured.err.join("\n")).toContain("already being processed");

    captured.out = [];
    captured.err = [];
    const jsonCode = await runSync({ ...options, json: true });
    expect(jsonCode).toBe(75);
    const parsed = parseSingleJsonObject();
    expect(Object.keys(parsed)).toEqual([...SYNC_ERROR_JSON_KEYS]);
    expect(parsed["status"]).toBe("busy");
    expect(parsed["branch"]).toBe("main");
    expect(parsed["error"]).toBe("compiler-host-busy");

    releaseLock?.();
    const lockResult = await heldLock;
    expect(lockResult.kind).toBe("acquired");
  }, 10_000);

  test("recovers from a corrupt compiler-host lock file", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    silenceConsole();

    const lockPath = compilerHostLockPath(f.vaultPath, "main");
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "{not-json", "utf8");

    const code = await runSync({
      vault: f.vaultPath,
      bundlesRoot: f.bundlesRoot,
    });
    expect(code).toBe(0);
    expect(captured.out.join("\n")).toContain("adopted main");
    expect(await getAdoptedRef(f.vaultPath, "main")).toBe(f.initialSha);
  }, 10_000);
});

// ----- Test 3: drift adoption -----------------------------------------------

describe("runSync drift adoption", () => {
  test("new commit: sync advances adopted ref to new HEAD; exit 0", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    silenceConsole();

    const options = { vault: f.vaultPath, bundlesRoot: f.bundlesRoot };

    // First sync: empty-diff init advances adopted to initial commit.
    const code1 = await runSync(options);
    expect(code1).toBe(0);
    expect(await getAdoptedRef(f.vaultPath, "main")).toBe(f.initialSha);

    // Make a second commit. The adopted ref is now behind HEAD.
    await writeFile(join(f.vaultPath, "wiki/new.md"), VALID_CONCEPT_PAGE);
    const newSha = await commit({
      path: f.vaultPath,
      message: "add wiki/new.md\n",
      files: ["wiki/new.md"],
    });
    expect(newSha).not.toBe(f.initialSha);
    expect(await getAdoptedRef(f.vaultPath, "main")).toBe(f.initialSha);

    captured.out = [];
    captured.err = [];

    // Second sync: should detect drift and advance the adopted ref.
    const code2 = await runSync(options);
    expect(code2).toBe(0);
    expect(await getAdoptedRef(f.vaultPath, "main")).toBe(newSha);

    // Output should include "adopted" + the new sha prefix.
    const outBlob = captured.out.join("\n");
    expect(outBlob).toContain("adopted");
    expect(outBlob).toContain(newSha.slice(0, 7));

    // Ledger must be clean: no failed or running rows leftover.
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
});

// ----- Test 4: detached HEAD refusal ----------------------------------------

describe("runSync detached HEAD", () => {
  test("refuses with exit 64 (EX_USAGE) and a clear error message", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    silenceConsole();

    // Detach HEAD by writing the seed OID directly into `.git/HEAD`
    // (instead of `ref: refs/heads/main`). isomorphic-git treats raw-OID
    // HEAD as detached; the git boundary's `currentBranch` returns null.
    const sha = await currentSha(f.vaultPath);
    if (sha === null) throw new Error("expected initial sha");
    await writeFile(join(f.vaultPath, ".git", "HEAD"), `${sha}\n`);

    const code = await runSync({
      vault: f.vaultPath,
      bundlesRoot: f.bundlesRoot,
    });
    expect(code).toBe(64);

    // Stderr should explain the detached-HEAD condition.
    const errBlob = captured.err.join("\n");
    expect(errBlob).toContain("detached");
  }, 5_000);

  test("--json detached-head payload keeps the fixture schema stable", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    silenceConsole();

    const sha = await currentSha(f.vaultPath);
    if (sha === null) throw new Error("expected initial sha");
    await writeFile(join(f.vaultPath, ".git", "HEAD"), `${sha}\n`);

    const code = await runSync({
      vault: f.vaultPath,
      bundlesRoot: f.bundlesRoot,
      json: true,
    });
    expect(code).toBe(64);

    const parsed = parseSingleJsonObject({ allowStderr: true });
    expect(Object.keys(parsed)).toEqual([...SYNC_ERROR_JSON_KEYS]);
    expect(parsed["status"]).toBe("error");
    expect(parsed["branch"]).toBeNull();
    expect(parsed["base"]).toBeNull();
    expect(parsed["head"]).toBeNull();
    expect(parsed["adoptedRef"]).toBeNull();
    expect(parsed["iterations"]).toBe(0);
    expect(parsed["closureCommit"]).toBeNull();
    expect(parsed["diagnostics"]).toEqual([]);
    expect(parsed["error"]).toBe("detached-head");
  }, 5_000);
});

function parseSingleJsonObject(opts: {
  readonly allowStderr?: boolean;
} = {}): Record<string, unknown> {
  if (opts.allowStderr !== true) {
    expect(captured.err.join("\n")).toBe("");
  }
  expect(captured.out.length).toBe(1);
  return JSON.parse(captured.out[0] ?? "{}") as Record<string, unknown>;
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
