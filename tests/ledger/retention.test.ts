// Tests for src/ledger/retention.ts — the automatic run-ledger retention
// policy (docs/wiki/specs/run-ledger.md §"Retention").
//
// Real bun:sqlite fixture (not mocked): a fresh runs.db per test, rows
// inserted with hand-chosen `started_at`/`status` values via raw SQL so each
// test controls exactly which rows should and shouldn't survive.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openLedgerDb, type LedgerDb } from "../../src/ledger/db";
import { countRuns } from "../../src/ledger/runs";
import {
  pruneRunLedgerRetention,
  RUN_LEDGER_RETENTION_VACUUM_THRESHOLD,
} from "../../src/ledger/retention";

const NOW = new Date("2026-07-02T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

let root: string;
let db: LedgerDb;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "dome-ledger-retention-"));
  const path = join(root, ".dome", "state", "runs.db");
  const opened = await openLedgerDb({ path });
  if (!opened.ok) throw new Error(`openLedgerDb failed: ${opened.error.kind}`);
  db = opened.value.db;
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/**
 * Insert a `runs` row directly via SQL — bypasses the queued/running/
 * terminal state machine so each test can plant an exact
 * (status, started_at, finished_at) combination, including ones the normal
 * lifecycle functions never produce mid-transition (e.g. an old succeeded
 * row alongside an old failed one in the same fixture).
 */
function insertRawRun(opts: {
  readonly id: string;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly error?: string | null;
}): void {
  db.raw
    .query(
      `INSERT INTO runs (
        id, proposal_id, processor_id, processor_version, phase,
        input_commit, output_commit, status, effect_hashes_json,
        cost_usd, duration_ms, error, trigger_kind, trigger_payload_json,
        started_at, finished_at
      ) VALUES (?, NULL, 'test.processor', '0.1.0', 'view', 'deadbeef', NULL, ?, '[]', NULL, 5, ?, 'command', '{}', ?, ?)`,
    )
    .run(
      opts.id,
      opts.status,
      opts.error ?? null,
      opts.startedAt,
      opts.finishedAt,
    );
}

function runExists(id: string): boolean {
  return (
    db.raw.query<{ id: string }, [string]>("SELECT id FROM runs WHERE id = ?").get(id) !==
    null
  );
}

describe("pruneRunLedgerRetention", () => {
  it("prunes succeeded rows older than the retention window", () => {
    insertRawRun({
      id: "old-succeeded",
      status: "succeeded",
      startedAt: daysAgo(40),
      finishedAt: daysAgo(40),
    });

    const result = pruneRunLedgerRetention(db, { retentionDays: 30, now: NOW });

    expect(result.deleted).toBe(1);
    expect(runExists("old-succeeded")).toBe(false);
  });

  it("keeps fresh rows inside the retention window", () => {
    insertRawRun({
      id: "fresh-succeeded",
      status: "succeeded",
      startedAt: daysAgo(1),
      finishedAt: daysAgo(1),
    });

    const result = pruneRunLedgerRetention(db, { retentionDays: 30, now: NOW });

    expect(result.deleted).toBe(0);
    expect(runExists("fresh-succeeded")).toBe(true);
  });

  it("keeps old failed rows — the quarantine-referenced-failure exception, generalized", () => {
    // The quarantine store (src/engine/operational/quarantine-store.ts) has
    // no run_id back-reference, so there is no per-row join from "open
    // quarantine state" to a specific runs row. Instead every `failed` row
    // is categorically preserved regardless of age — a strict superset of
    // "rows referenced by open quarantine state survive" (see
    // src/ledger/retention.ts file banner). This test is the load-bearing
    // proof: an old failed row must never be pruned automatically.
    insertRawRun({
      id: "old-failed",
      status: "failed",
      startedAt: daysAgo(400),
      finishedAt: daysAgo(400),
      error: "some processor failure",
    });

    const result = pruneRunLedgerRetention(db, { retentionDays: 30, now: NOW });

    expect(result.deleted).toBe(0);
    expect(runExists("old-failed")).toBe(true);
  });

  it("keeps old timed_out and cancelled rows too", () => {
    insertRawRun({
      id: "old-timed-out",
      status: "timed_out",
      startedAt: daysAgo(400),
      finishedAt: daysAgo(400),
      error: "timeout",
    });
    insertRawRun({
      id: "old-cancelled",
      status: "cancelled",
      startedAt: daysAgo(400),
      finishedAt: daysAgo(400),
      error: "cancelled",
    });

    const result = pruneRunLedgerRetention(db, { retentionDays: 30, now: NOW });

    expect(result.deleted).toBe(0);
    expect(runExists("old-timed-out")).toBe(true);
    expect(runExists("old-cancelled")).toBe(true);
  });

  it("retentionDays: 0 disables pruning entirely", () => {
    insertRawRun({
      id: "ancient-succeeded",
      status: "succeeded",
      startedAt: daysAgo(10_000),
      finishedAt: daysAgo(10_000),
    });

    const result = pruneRunLedgerRetention(db, { retentionDays: 0, now: NOW });

    expect(result).toEqual({ deleted: 0, reclaimedPages: 0 });
    expect(runExists("ancient-succeeded")).toBe(true);
  });

  it("does not vacuum when the deleted count stays at or under the threshold", () => {
    for (let i = 0; i < 5; i++) {
      insertRawRun({
        id: `old-${i}`,
        status: "succeeded",
        startedAt: daysAgo(40),
        finishedAt: daysAgo(40),
      });
    }

    const result = pruneRunLedgerRetention(db, { retentionDays: 30, now: NOW });

    expect(result.deleted).toBe(5);
    expect(result.reclaimedPages).toBe(0);
  });

  it("vacuums once the deleted count exceeds the threshold, reclaiming pages", () => {
    const total = RUN_LEDGER_RETENTION_VACUUM_THRESHOLD + 1;
    db.raw.exec("BEGIN");
    for (let i = 0; i < total; i++) {
      insertRawRun({
        id: `bulk-${i}`,
        status: "succeeded",
        startedAt: daysAgo(40),
        finishedAt: daysAgo(40),
      });
    }
    db.raw.exec("COMMIT");
    expect(countRuns(db)).toBe(total);

    const result = pruneRunLedgerRetention(db, { retentionDays: 30, now: NOW });

    expect(result.deleted).toBe(total);
    expect(result.reclaimedPages).toBeGreaterThan(0);
    expect(countRuns(db)).toBe(0);
  });
});
