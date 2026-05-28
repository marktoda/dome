// Smoke tests for src/ledger/db.ts + src/ledger/runs.ts +
// src/ledger/capability-uses.ts: the open/close lifecycle, the run id
// generator, the full queued → running → terminal state machine, the
// query surface, orphan detection + recovery, and capability-use
// round-trip.
//
// Real integration tests against `bun:sqlite` in tmpdirs — the ledger IS
// the SQL boundary for run audit history (pinned by
// EVERY_PROCESSOR_RUN_IS_LEDGERED).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commitOid } from "../../src/core/source-ref";
import {
  capabilityUsesByRun,
  recordCapabilityUse,
} from "../../src/ledger/capability-uses";
import { openLedgerDb, type LedgerDb } from "../../src/ledger/db";
import {
  failOrphanedRuns,
  getRun,
  insertQueued,
  markCancelled,
  markFailed,
  markRunning,
  markSkipped,
  markSucceeded,
  markTimedOut,
  newRunId,
  orphanRuns,
  queryRuns,
  updateOutputCommit,
  type RunId,
} from "../../src/ledger/runs";

const INPUT_COMMIT = commitOid("abcdef0000000000000000000000000000000000");
const OUTPUT_COMMIT = commitOid("1234567890000000000000000000000000000000");

// ---------------------------------------------------------------------------
// openLedgerDb lifecycle
// ---------------------------------------------------------------------------

describe("openLedgerDb", () => {
  let root: string;
  let dbPath: string;
  let handles: LedgerDb[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dome-ledger-open-"));
    dbPath = join(root, ".dome", "state", "runs.db");
    handles = [];
  });

  afterEach(() => {
    for (const h of handles) {
      try {
        h.close();
      } catch {
        // already closed — best-effort cleanup
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("returns migration: 'fresh' on a never-before-opened path", async () => {
    const r = await openLedgerDb({ path: dbPath });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    handles.push(r.value.db);
    expect(r.value.migration).toBe("fresh");
  });

  it("returns migration: 'ok' on re-open with identical schema", async () => {
    const first = await openLedgerDb({ path: dbPath });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.migration).toBe("fresh");
    first.value.db.close();

    const second = await openLedgerDb({ path: dbPath });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    handles.push(second.value.db);
    expect(second.value.migration).toBe("ok");
    expect(second.value.db.schemaHash).toBe(first.value.db.schemaHash);
  });
});

// ---------------------------------------------------------------------------
// newRunId shape
// ---------------------------------------------------------------------------

describe("newRunId", () => {
  it("produces a string in the canonical 'run_<unix-ms>_<6-char-rand>' shape", () => {
    const now = new Date("2026-05-27T12:00:00.000Z");
    const id = newRunId(now, () => "abcdef");
    expect(id as string).toBe(`run_${now.getTime()}_abcdef`);
    // Shape: starts with "run_", contains exactly two underscores, the
    // trailing 6 chars are the random suffix.
    expect(id.startsWith("run_")).toBe(true);
    expect(id.split("_").length).toBe(3);
  });

  it("produces 6-hex-char suffixes from the default random source", () => {
    const id = newRunId(new Date());
    const suffix = id.split("_")[2];
    expect(suffix).toBeDefined();
    if (suffix === undefined) return;
    expect(suffix.length).toBe(6);
    expect(/^[0-9a-f]{6}$/.test(suffix)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: insertQueued → markRunning → markSucceeded
// ---------------------------------------------------------------------------

describe("runs lifecycle", () => {
  let root: string;
  let db: LedgerDb;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "dome-ledger-life-"));
    const path = join(root, ".dome", "state", "runs.db");
    const r = await openLedgerDb({ path });
    if (!r.ok) throw new Error(`openLedgerDb failed: ${JSON.stringify(r.error)}`);
    db = r.value.db;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(root, { recursive: true, force: true });
  });

  function freshId(): RunId {
    return newRunId(new Date(), () => "aaaaaa");
  }

  function queue(id: RunId, overrides: Partial<{ proposalId: string | null }> = {}) {
    insertQueued(db, {
      id,
      proposalId: overrides.proposalId === undefined ? null : overrides.proposalId,
      processorId: "dome.intake.extract",
      processorVersion: "1.0.0",
      phase: "adoption",
      inputCommit: INPUT_COMMIT,
      triggerKind: "signal",
      triggerPayload: { name: "file.created", path: "wiki/a.md" },
      startedAt: new Date("2026-05-27T12:00:00.000Z"),
    });
  }

  it("insertQueued + getRun round-trips a freshly-queued row", () => {
    const id = freshId();
    queue(id);

    const row = getRun(db, id);
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.id).toBe(id);
    expect(row.status).toBe("queued");
    expect(row.processorId).toBe("dome.intake.extract");
    expect(row.processorVersion).toBe("1.0.0");
    expect(row.phase).toBe("adoption");
    expect(row.inputCommit).toBe(INPUT_COMMIT);
    expect(row.outputCommit).toBeNull();
    expect(row.proposalId).toBeNull();
    expect(row.effectHashes).toEqual([]);
    expect(row.costUsd).toBeNull();
    expect(row.durationMs).toBeNull();
    expect(row.error).toBeNull();
    expect(row.triggerKind).toBe("signal");
    expect(row.triggerPayload).toEqual({
      name: "file.created",
      path: "wiki/a.md",
    });
    expect(row.startedAt).toBe("2026-05-27T12:00:00.000Z");
    expect(row.finishedAt).toBeNull();
  });

  it("queued → running → succeeded captures all terminal fields", () => {
    const id = freshId();
    queue(id);

    markRunning(db, id, new Date());
    const running = getRun(db, id);
    expect(running?.status).toBe("running");

    const finishedAt = new Date("2026-05-27T12:00:05.000Z");
    markSucceeded(db, {
      id,
      effectHashes: ["sha-a", "sha-b"],
      costUsd: 0.0123,
      durationMs: 5000,
      outputCommit: OUTPUT_COMMIT,
      finishedAt,
    });

    const done = getRun(db, id);
    expect(done).not.toBeNull();
    if (done === null) return;
    expect(done.status).toBe("succeeded");
    expect(done.effectHashes).toEqual(["sha-a", "sha-b"]);
    expect(done.costUsd).toBe(0.0123);
    expect(done.durationMs).toBe(5000);
    expect(done.outputCommit).toBe(OUTPUT_COMMIT);
    expect(done.finishedAt).toBe(finishedAt.toISOString());
    expect(done.error).toBeNull();
  });

  it("queued → running → failed captures error + duration", () => {
    const id = freshId();
    queue(id);

    markRunning(db, id, new Date());
    const finishedAt = new Date("2026-05-27T12:00:02.000Z");
    markFailed(db, {
      id,
      error: "boom: divide by zero",
      durationMs: 2000,
      finishedAt,
    });

    const done = getRun(db, id);
    expect(done).not.toBeNull();
    if (done === null) return;
    expect(done.status).toBe("failed");
    expect(done.error).toBe("boom: divide by zero");
    expect(done.durationMs).toBe(2000);
    expect(done.finishedAt).toBe(finishedAt.toISOString());
    expect(done.outputCommit).toBeNull();
    expect(done.effectHashes).toEqual([]);
  });

  it("queued → running → timed_out captures structured error JSON", () => {
    const id = freshId();
    queue(id);
    markRunning(db, id, new Date());

    const finishedAt = new Date("2026-05-27T12:00:03.000Z");
    markTimedOut(db, {
      id,
      error: {
        code: "processor.timeout",
        message: "processor exceeded timeout of 2000ms",
        retryable: false,
        phase: "adoption",
        processorId: "dome.intake.extract",
      },
      durationMs: 2000,
      finishedAt,
    });

    const done = getRun(db, id);
    expect(done?.status).toBe("timed_out");
    expect(done?.durationMs).toBe(2000);
    expect(done?.finishedAt).toBe(finishedAt.toISOString());
    expect(JSON.parse(done?.error ?? "{}")).toEqual({
      code: "processor.timeout",
      message: "processor exceeded timeout of 2000ms",
      retryable: false,
      phase: "adoption",
      processorId: "dome.intake.extract",
    });
  });

  it("queued → running → cancelled captures structured error JSON", () => {
    const id = freshId();
    queue(id);
    markRunning(db, id, new Date());

    const finishedAt = new Date("2026-05-27T12:00:04.000Z");
    markCancelled(db, {
      id,
      error: {
        code: "processor.cancelled",
        message: "processor cancelled during shutdown",
        retryable: false,
        phase: "garden",
        processorId: "dome.intake.extract",
      },
      durationMs: 100,
      finishedAt,
    });

    const done = getRun(db, id);
    expect(done?.status).toBe("cancelled");
    expect(done?.durationMs).toBe(100);
    expect(JSON.parse(done?.error ?? "{}").code).toBe("processor.cancelled");
  });

  it("new terminal statuses are queryable", () => {
    const timedOut = newRunId(new Date(), () => "tooooo");
    const cancelled = newRunId(new Date(Date.now() + 1), () => "canccl");
    const succeeded = newRunId(new Date(Date.now() + 2), () => "okokok");
    queue(timedOut);
    queue(cancelled);
    queue(succeeded);

    markRunning(db, timedOut, new Date());
    markTimedOut(db, {
      id: timedOut,
      error: {
        code: "processor.timeout",
        message: "processor exceeded timeout of 2000ms",
        retryable: false,
        phase: "adoption",
        processorId: "dome.intake.extract",
      },
      durationMs: 2000,
      finishedAt: new Date(),
    });

    markRunning(db, cancelled, new Date());
    markCancelled(db, {
      id: cancelled,
      error: {
        code: "processor.cancelled",
        message: "processor cancelled during shutdown",
        retryable: false,
        phase: "garden",
        processorId: "dome.intake.extract",
      },
      durationMs: 100,
      finishedAt: new Date(),
    });

    markRunning(db, succeeded, new Date());
    markSucceeded(db, {
      id: succeeded,
      effectHashes: [],
      costUsd: null,
      durationMs: 50,
      outputCommit: null,
      finishedAt: new Date(),
    });

    const timedOutRows = queryRuns(db, { status: "timed_out" });
    expect(timedOutRows.length).toBe(1);
    expect(timedOutRows[0]?.id).toBe(timedOut);

    const cancelledRows = queryRuns(db, { status: "cancelled" });
    expect(cancelledRows.length).toBe(1);
    expect(cancelledRows[0]?.id).toBe(cancelled);
  });

  it("new terminal transitions only apply from running", () => {
    const queued = newRunId(new Date(), () => "queued");
    const timedOut = newRunId(new Date(Date.now() + 1), () => "timout");
    queue(queued);
    queue(timedOut);

    markTimedOut(db, {
      id: queued,
      error: {
        code: "processor.timeout",
        message: "processor exceeded timeout of 2000ms",
        retryable: false,
        phase: "adoption",
        processorId: "dome.intake.extract",
      },
      durationMs: 2000,
      finishedAt: new Date(),
    });

    const stillQueued = getRun(db, queued);
    expect(stillQueued?.status).toBe("queued");
    expect(stillQueued?.error).toBeNull();
    expect(stillQueued?.durationMs).toBeNull();
    expect(stillQueued?.finishedAt).toBeNull();

    markRunning(db, timedOut, new Date());
    markTimedOut(db, {
      id: timedOut,
      error: {
        code: "processor.timeout",
        message: "processor exceeded timeout of 2000ms",
        retryable: false,
        phase: "adoption",
        processorId: "dome.intake.extract",
      },
      durationMs: 2000,
      finishedAt: new Date("2026-05-27T12:00:03.000Z"),
    });
    markCancelled(db, {
      id: timedOut,
      error: {
        code: "processor.cancelled",
        message: "processor cancelled during shutdown",
        retryable: false,
        phase: "garden",
        processorId: "dome.intake.extract",
      },
      durationMs: 100,
      finishedAt: new Date("2026-05-27T12:00:04.000Z"),
    });

    const terminal = getRun(db, timedOut);
    expect(terminal?.status).toBe("timed_out");
    expect(terminal?.durationMs).toBe(2000);
    expect(JSON.parse(terminal?.error ?? "{}").code).toBe("processor.timeout");
  });

  it("queued → skipped transitions a dedup-cached run", () => {
    const id = freshId();
    queue(id);

    const finishedAt = new Date("2026-05-27T12:00:01.000Z");
    markSkipped(db, { id, finishedAt });

    const done = getRun(db, id);
    expect(done).not.toBeNull();
    if (done === null) return;
    expect(done.status).toBe("skipped");
    expect(done.finishedAt).toBe(finishedAt.toISOString());
    // skipped runs don't populate duration/error/effects.
    expect(done.durationMs).toBeNull();
    expect(done.error).toBeNull();
    expect(done.effectHashes).toEqual([]);
  });

  it("markRunning on an already-running row is a no-op (status unchanged)", () => {
    const id = freshId();
    queue(id);

    markRunning(db, id, new Date());
    // Second call must not double-transition (the UPDATE filters by
    // status='queued' — the row is already 'running').
    markRunning(db, id, new Date());

    // Confirm via raw row count: exactly one row, status='running'. We
    // can't observe a "did the UPDATE affect a row?" through getRun
    // alone, so reach into raw and count rows in 'running' state.
    const countRows = db.raw
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM runs WHERE status = ?",
      )
      .all("running");
    expect(countRows[0]?.n).toBe(1);
  });

  it("queryRuns({status: 'failed'}) filters out non-failed rows", () => {
    const a = newRunId(new Date(), () => "aaaaaa");
    const b = newRunId(new Date(Date.now() + 1), () => "bbbbbb");
    queue(a);
    queue(b);

    markRunning(db, a, new Date());
    markFailed(db, {
      id: a,
      error: "boom",
      durationMs: 100,
      finishedAt: new Date(),
    });
    markRunning(db, b, new Date());
    markSucceeded(db, {
      id: b,
      effectHashes: [],
      costUsd: null,
      durationMs: 50,
      outputCommit: null,
      finishedAt: new Date(),
    });

    const failed = queryRuns(db, { status: "failed" });
    expect(failed.length).toBe(1);
    expect(failed[0]?.id).toBe(a);
    expect(failed[0]?.status).toBe("failed");
  });

  it("orphanRuns + failOrphanedRuns recover a stuck-running row", () => {
    // Insert a run with a synthetic-old started_at so the orphan window
    // catches it. We bypass queue() for the timestamp control.
    const id = newRunId(new Date(), () => "cccccc");
    insertQueued(db, {
      id,
      proposalId: null,
      processorId: "dome.stuck",
      processorVersion: "1.0.0",
      phase: "adoption",
      inputCommit: INPUT_COMMIT,
      triggerKind: "signal",
      triggerPayload: null,
      startedAt: new Date("2026-05-27T00:00:00.000Z"),
    });
    markRunning(db, id, new Date());

    // Pretend "now" is 5 minutes after the started_at; orphan window 60s.
    const now = new Date("2026-05-27T00:05:00.000Z");

    const orphans = orphanRuns(db, 60_000, now);
    expect(orphans.length).toBe(1);
    expect(orphans[0]?.id).toBe(id);

    const failedCount = failOrphanedRuns(db, 60_000, now);
    expect(failedCount).toBe(1);

    const after = getRun(db, id);
    expect(after?.status).toBe("failed");
    expect(after?.error).not.toBeNull();
    expect(after?.finishedAt).toBe(now.toISOString());

    // Now that the row is transitioned, a second sweep finds nothing.
    expect(orphanRuns(db, 60_000, now).length).toBe(0);
    expect(failOrphanedRuns(db, 60_000, now)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// updateOutputCommit — the post-closure-commit back-fill
// ---------------------------------------------------------------------------

describe("updateOutputCommit", () => {
  let root: string;
  let db: LedgerDb;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "dome-ledger-output-"));
    const path = join(root, ".dome", "state", "runs.db");
    const r = await openLedgerDb({ path });
    if (!r.ok) throw new Error(`openLedgerDb failed: ${JSON.stringify(r.error)}`);
    db = r.value.db;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(root, { recursive: true, force: true });
  });

  function makeSucceededRun(id: RunId, suffix: string): void {
    insertQueued(db, {
      id,
      proposalId: null,
      processorId: `dome.proc.${suffix}`,
      processorVersion: "1.0.0",
      phase: "adoption",
      inputCommit: INPUT_COMMIT,
      triggerKind: "signal",
      triggerPayload: null,
      startedAt: new Date(),
    });
    markRunning(db, id, new Date());
    markSucceeded(db, {
      id,
      effectHashes: [],
      costUsd: null,
      durationMs: 10,
      outputCommit: null,
      finishedAt: new Date(),
    });
  }

  it("lands the closure-commit OID on each named succeeded run", () => {
    const a = newRunId(new Date(), () => "a11111");
    const b = newRunId(new Date(Date.now() + 1), () => "b22222");
    makeSucceededRun(a, "a");
    makeSucceededRun(b, "b");

    // Pre-condition: both rows have null output_commit.
    expect(getRun(db, a)?.outputCommit).toBeNull();
    expect(getRun(db, b)?.outputCommit).toBeNull();

    const updated = updateOutputCommit(db, {
      runIds: [a, b],
      outputCommit: OUTPUT_COMMIT,
    });
    expect(updated).toBe(2);

    expect(getRun(db, a)?.outputCommit).toBe(OUTPUT_COMMIT);
    expect(getRun(db, b)?.outputCommit).toBe(OUTPUT_COMMIT);
  });

  it("skips rows whose output_commit is already set (defense against re-drive)", () => {
    const a = newRunId(new Date(), () => "c33333");
    makeSucceededRun(a, "c");

    const first = updateOutputCommit(db, {
      runIds: [a],
      outputCommit: OUTPUT_COMMIT,
    });
    expect(first).toBe(1);

    // Second call against a different OID is a no-op (the row is already
    // set, so the IS-NULL filter excludes it).
    const otherOid = commitOid("9999999999999999999999999999999999999999");
    const second = updateOutputCommit(db, {
      runIds: [a],
      outputCommit: otherOid,
    });
    expect(second).toBe(0);

    // The first-write OID survives.
    expect(getRun(db, a)?.outputCommit).toBe(OUTPUT_COMMIT);
  });

  it("skips rows that aren't yet succeeded (running / failed runs untouched)", () => {
    const succeeded = newRunId(new Date(), () => "d44444");
    const failed = newRunId(new Date(Date.now() + 1), () => "e55555");
    const running = newRunId(new Date(Date.now() + 2), () => "f66666");

    makeSucceededRun(succeeded, "ok");

    insertQueued(db, {
      id: failed,
      proposalId: null,
      processorId: "dome.proc.failed",
      processorVersion: "1.0.0",
      phase: "adoption",
      inputCommit: INPUT_COMMIT,
      triggerKind: "signal",
      triggerPayload: null,
      startedAt: new Date(),
    });
    markRunning(db, failed, new Date());
    markFailed(db, {
      id: failed,
      error: "boom",
      durationMs: 5,
      finishedAt: new Date(),
    });

    insertQueued(db, {
      id: running,
      proposalId: null,
      processorId: "dome.proc.running",
      processorVersion: "1.0.0",
      phase: "adoption",
      inputCommit: INPUT_COMMIT,
      triggerKind: "signal",
      triggerPayload: null,
      startedAt: new Date(),
    });
    markRunning(db, running, new Date());

    const updated = updateOutputCommit(db, {
      runIds: [succeeded, failed, running],
      outputCommit: OUTPUT_COMMIT,
    });
    // Only the succeeded row updates.
    expect(updated).toBe(1);
    expect(getRun(db, succeeded)?.outputCommit).toBe(OUTPUT_COMMIT);
    expect(getRun(db, failed)?.outputCommit).toBeNull();
    expect(getRun(db, running)?.outputCommit).toBeNull();
  });

  it("empty runIds is a no-op (returns 0 without issuing SQL)", () => {
    const updated = updateOutputCommit(db, {
      runIds: [],
      outputCommit: OUTPUT_COMMIT,
    });
    expect(updated).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// capability_uses
// ---------------------------------------------------------------------------

describe("capability_uses accessor", () => {
  let root: string;
  let db: LedgerDb;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "dome-ledger-caps-"));
    const path = join(root, ".dome", "state", "runs.db");
    const r = await openLedgerDb({ path });
    if (!r.ok) throw new Error(`openLedgerDb failed: ${JSON.stringify(r.error)}`);
    db = r.value.db;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("recordCapabilityUse + capabilityUsesByRun round-trips multiple rows per run", () => {
    const runId = newRunId(new Date(), () => "dddddd");
    insertQueued(db, {
      id: runId,
      proposalId: null,
      processorId: "dome.proc",
      processorVersion: "1.0.0",
      phase: "garden",
      inputCommit: INPUT_COMMIT,
      triggerKind: "command",
      triggerPayload: { name: "dome.proc.run" },
      startedAt: new Date(),
    });

    const t = new Date("2026-05-27T12:00:00.000Z");
    recordCapabilityUse(db, {
      runId,
      capability: "patch.auto:wiki/**",
      resource: "wiki/a.md",
      outcome: "allowed",
      recordedAt: t,
    });
    recordCapabilityUse(db, {
      runId,
      capability: "patch.auto:wiki/**",
      resource: "wiki/b.md",
      outcome: "downgraded",
      recordedAt: t,
    });
    recordCapabilityUse(db, {
      runId,
      capability: "graph.write:dome.tasks",
      resource: null,
      outcome: "denied",
      recordedAt: t,
    });

    const got = capabilityUsesByRun(db, runId);
    expect(got.length).toBe(3);
    expect(got[0]?.outcome).toBe("allowed");
    expect(got[0]?.resource).toBe("wiki/a.md");
    expect(got[1]?.outcome).toBe("downgraded");
    expect(got[1]?.resource).toBe("wiki/b.md");
    expect(got[2]?.outcome).toBe("denied");
    expect(got[2]?.resource).toBeNull();
    expect(got[2]?.capability).toBe("graph.write:dome.tasks");
    expect(got[0]?.runId).toBe(runId);
  });

  it("capabilityUsesByRun returns empty array when no rows exist for the run", () => {
    const runId = newRunId(new Date(), () => "eeeeee");
    const got = capabilityUsesByRun(db, runId);
    expect(got.length).toBe(0);
  });
});
