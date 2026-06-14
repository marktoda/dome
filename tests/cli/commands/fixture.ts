// Shared fixture helpers for the per-command CLI test files in this
// directory (split out of the original tests/cli/commands.test.ts).
//
// Each describe block sets up a fresh tmpdir vault (a real git repo
// with two commits), invokes the relevant `run<Command>` function, and
// asserts on the returned exit code + the side effects on disk / DBs.
//
// Phase 11f: the CLI commands default `--bundles-root` to the SDK's
// shipped `assets/extensions/`. Tests no longer need to copy bundles
// into the tmpdir vault — they just rely on the default resolver. The
// fixture is correspondingly thinner.
//
// Tests run the command handlers directly — they don't spawn `bun`
// subprocesses. That keeps the suite fast and lets us assert on
// internal state (filesystem layout, DB rows) without parsing stdout.
//
// Console output is captured to keep test logs quiet; the assertions
// don't depend on the captured strings (handlers' return codes are the
// load-bearing surface).
//
// NOTE: the lifecycle hooks (console capture, fixture cleanup) are
// exposed as `install*()` functions rather than registered at module
// top level — bun caches modules across test files in one process, so
// top-level hooks here would only attach to the first importing file.
// Each test file calls the installers it needs at its own top level.

import { afterEach, beforeEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { externalActionEffect } from "../../../src/core/effect";
import { commitOid, sourceRef } from "../../../src/core/source-ref";
import { commit, initRepo } from "../../../src/git";
import { openQuarantineStore } from "../../../src/engine/operational/quarantine-store";
import { openLedgerDb } from "../../../src/ledger/db";
import {
  insertQueued,
  markRunning,
  markTimedOut,
  newRunId,
} from "../../../src/ledger/runs";
import { DEFAULT_RECURRING_TIMEOUT_THRESHOLD } from "../../../src/engine/host/health";
import { openOutboxDb } from "../../../src/outbox/db";
import {
  insertPending,
  markFailed as markOutboxFailed,
} from "../../../src/outbox/dispatch";

// ----- Console capture ------------------------------------------------------
//
// Each test silences console.log / console.error so the suite output stays
// quiet. The captured strings are exposed via the `captured` object in
// case a test wants to inspect them.

export type Captured = {
  out: string[];
  err: string[];
};

export let captured: Captured = { out: [], err: [] };

/** Register per-test console capture hooks for the calling test file. */
export function installConsoleCapture(): void {
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
}

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}

// ----- Fixture helpers -------------------------------------------------------

export type Fixture = {
  vaultPath: string;
  baseSha: string;
  headSha: string;
  cleanup: () => Promise<void>;
};

/**
 * Build a fresh tmpdir vault with two commits. The two commits give
 * submit something to propose (base = first commit, head = second
 * commit). Phase 11f: no bundle copy — the CLI defaults `bundlesRoot`
 * to the SDK's shipped first-party bundles via
 * `resolveShippedBundlesRoot`. The vault path is a fresh tmpdir; the
 * cleanup removes it after the test.
 */
export async function makeFixture(): Promise<Fixture> {
  const vaultPath = mkdtempSync(join(tmpdir(), "cli-commands-"));
  await initRepo(vaultPath);
  // Env insulation: a dev machine with global commit.gpgsign=true would
  // otherwise leak doctor's git.commit-signing info finding (and gpg
  // failures on shelled commits) into every fixture vault. Tests that
  // exercise the signing probe flip the LOCAL key back to true themselves.
  execFileSync("git", ["-C", vaultPath, "config", "commit.gpgsign", "false"]);
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

  // `.dome/state/` is where the engine writes sqlite handles; the runtime
  // creates it on open, but pre-creating mirrors what `dome init` does
  // and keeps the test's setup explicit.
  await mkdir(join(vaultPath, ".dome", "state"), { recursive: true });

  return {
    vaultPath,
    baseSha,
    headSha,
    cleanup: async () => {
      await rm(vaultPath, { recursive: true, force: true });
    },
  };
}

export const fixtures: Fixture[] = [];

/** Register the per-test fixture cleanup hook for the calling test file. */
export function installFixtureCleanup(): void {
  afterEach(async () => {
    while (fixtures.length > 0) {
      const f = fixtures.pop();
      if (f !== undefined) await f.cleanup();
    }
  });
}

export async function seedUnhealthyOperationalState(f: Fixture): Promise<void> {
  const adoptedCommit = commitOid(f.headSha);
  const ref = sourceRef({
    commit: adoptedCommit,
    path: "wiki/seed.md",
  });

  const outbox = await openOutboxDb({
    path: join(f.vaultPath, ".dome", "state", "outbox.db"),
  });
  if (!outbox.ok) {
    throw new Error(`outbox open failed: ${outbox.error.kind}`);
  }
  try {
    insertPending(outbox.value.db, {
      effect: externalActionEffect({
        capability: "calendar.write",
        idempotencyKey: "doctor-failed",
        payload: { event: "failed" },
        sourceRefs: [ref],
      }),
      runId: "run-doctor-outbox",
    });
    markOutboxFailed(outbox.value.db, "doctor-failed", "terminal failure");
  } finally {
    outbox.value.db.close();
  }

  const ledger = await openLedgerDb({
    path: join(f.vaultPath, ".dome", "state", "runs.db"),
  });
  if (!ledger.ok) {
    throw new Error(`ledger open failed: ${ledger.error.kind}`);
  }
  try {
    const runId = newRunId(new Date(0), () => "doctor");
    insertQueued(ledger.value.db, {
      id: runId,
      proposalId: null,
      processorId: "test.doctor",
      processorVersion: "0.0.1",
      phase: "garden",
      inputCommit: adoptedCommit,
      triggerKind: "schedule",
      triggerPayload: { test: true },
      startedAt: new Date(0),
    });
    markRunning(ledger.value.db, runId, new Date(1));
  } finally {
    ledger.value.db.close();
  }

  const quarantine = openQuarantineStore({
    path: join(f.vaultPath, ".dome", "state", "quarantined.json"),
    quarantineThreshold: 2,
  });
  if (!quarantine.ok) {
    throw new Error(`quarantine open failed: ${quarantine.error.kind}`);
  }
  const key = Object.freeze({
    phase: "garden" as const,
    processorId: "test.doctor",
    processorVersion: "0.0.1",
    triggerHash: "doctor-trigger",
  });
  quarantine.value.recordRetryableTerminalFailure(key, "first");
  quarantine.value.recordRetryableTerminalFailure(key, "second");
}

/**
 * Seed a single failed outbox row whose `enqueued_at` is backdated well past
 * the recurring-failure window — a fetcher/command that keeps re-failing, the
 * `outbox.recurring-failure` (root-cause) finding's trigger. Distinct from
 * `seedUnhealthyOperationalState`'s fresh failed row (which stays the per-row
 * `outbox.failed` transient retry path).
 */
export async function seedRecurringOutboxFailure(f: Fixture): Promise<void> {
  const adoptedCommit = commitOid(f.headSha);
  const ref = sourceRef({ commit: adoptedCommit, path: "wiki/seed.md" });
  const outbox = await openOutboxDb({
    path: join(f.vaultPath, ".dome", "state", "outbox.db"),
  });
  if (!outbox.ok) {
    throw new Error(`outbox open failed: ${outbox.error.kind}`);
  }
  try {
    // Enqueued two hours ago — past the 1h recurrence window.
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    insertPending(outbox.value.db, {
      effect: externalActionEffect({
        capability: "sources.fetch",
        idempotencyKey: "dome.sources.fetch:calendar:recurring",
        payload: { kind: "calendar" },
        sourceRefs: [ref],
      }),
      runId: "run-recurring-fetch",
      now: longAgo,
    });
    markOutboxFailed(
      outbox.value.db,
      "dome.sources.fetch:calendar:recurring",
      "fetch command exited 1",
    );
  } finally {
    outbox.value.db.close();
  }
}

/**
 * Seed `DEFAULT_RECURRING_TIMEOUT_THRESHOLD` timed_out runs for one processor,
 * enough to trigger the `run.recurring-timeout` finding. The runs have no
 * failed or orphan state so `orphanRuns` and `failedRuns` remain 0 — only
 * `recurringTimeouts` will be nonzero. This proves the "runs" category must
 * not land in the clean rollup when recurring-timeout fires.
 */
export async function seedRecurringTimeouts(f: Fixture): Promise<void> {
  const adoptedCommit = commitOid(f.headSha);
  const ledger = await openLedgerDb({
    path: join(f.vaultPath, ".dome", "state", "runs.db"),
  });
  if (!ledger.ok) {
    throw new Error(`ledger open failed: ${ledger.error.kind}`);
  }
  try {
    for (let i = 0; i < DEFAULT_RECURRING_TIMEOUT_THRESHOLD; i++) {
      const runId = newRunId(new Date(i + 1), () => `timeout-seed-${i}`);
      insertQueued(ledger.value.db, {
        id: runId,
        proposalId: null,
        processorId: "test.recurring-timeout-processor",
        processorVersion: "0.0.1",
        phase: "garden",
        inputCommit: adoptedCommit,
        triggerKind: "schedule",
        triggerPayload: { test: true },
        startedAt: new Date(i + 1),
      });
      markRunning(ledger.value.db, runId, new Date(i + 2));
      markTimedOut(ledger.value.db, {
        id: runId,
        error: {
          code: "processor.timeout",
          message: "Processor exceeded timeout of 30000ms.",
          retryable: false,
          phase: "garden",
          processorId: "test.recurring-timeout-processor",
        },
        durationMs: 30_000,
        finishedAt: new Date(i + 3),
      });
    }
  } finally {
    ledger.value.db.close();
  }
}

// ----- Doctor-style vault config writers (shared by check/doctor/status) -----

export async function writeDoctorConfigBody(
  f: Fixture,
  body: string,
): Promise<void> {
  await writeFile(join(f.vaultPath, ".dome", "config.yaml"), body, "utf8");
  await writeFile(
    join(f.vaultPath, "AGENTS.md"),
    [
      "# This is a Dome vault.",
      "",
      "<!-- BEGIN user-prose -->",
      "<!-- END user-prose -->",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(f.vaultPath, "CLAUDE.md"), "@AGENTS.md\n", "utf8");
}

export async function writeDoctorConfig(f: Fixture): Promise<void> {
  await writeFile(
    join(f.vaultPath, ".dome", "config.yaml"),
    "extensions: {}\n",
    "utf8",
  );
  await writeFile(
    join(f.vaultPath, "AGENTS.md"),
    [
      "# This is a Dome vault.",
      "",
      "<!-- BEGIN user-prose -->",
      "<!-- END user-prose -->",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(f.vaultPath, "CLAUDE.md"), "@AGENTS.md\n", "utf8");
}
