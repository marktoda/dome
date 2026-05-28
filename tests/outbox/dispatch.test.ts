// Smoke tests for src/outbox/db.ts + src/outbox/dispatch.ts: the open/close
// lifecycle, idempotent insertPending, and the full pending → sent / failed /
// replay / abandoned state machine.
//
// Real integration tests against `bun:sqlite` in tmpdirs — the outbox IS the
// SQL boundary for ExternalActionEffects (pinned by
// EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { externalActionEffect } from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { openOutboxDb, type OutboxDb } from "../../src/outbox/db";
import {
  dispatchExternalEffect,
  dispatchPendingOutbox,
  incrementAttempts,
  insertPending,
  markAbandoned,
  markFailed,
  markSent,
  queryOutbox,
  replayFailed,
} from "../../src/outbox/dispatch";

const REF = sourceRef({ commit: commitOid("abc"), path: "wiki/x.md" });

const RUN_ID = "run-1";

function makeEffect(idempotencyKey: string) {
  return externalActionEffect({
    capability: "calendar.write",
    idempotencyKey,
    payload: { event: "x" },
    sourceRefs: [REF],
  });
}

describe("openOutboxDb", () => {
  let root: string;
  let dbPath: string;
  let handles: OutboxDb[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dome-outbox-open-"));
    dbPath = join(root, ".dome", "state", "outbox.db");
    handles = [];
  });

  afterEach(() => {
    for (const h of handles) {
      try {
        h.close();
      } catch {
        // already closed
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("returns migration: 'fresh' on a never-before-opened path", async () => {
    const r = await openOutboxDb({ path: dbPath });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    handles.push(r.value.db);
    expect(r.value.migration).toBe("fresh");
  });
});

describe("outbox lifecycle", () => {
  let root: string;
  let db: OutboxDb;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "dome-outbox-life-"));
    const path = join(root, ".dome", "state", "outbox.db");
    const r = await openOutboxDb({ path });
    if (!r.ok) throw new Error(`openOutboxDb failed: ${JSON.stringify(r.error)}`);
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

  it("insertPending is idempotent on idempotencyKey", () => {
    const effect = makeEffect("key-1");
    insertPending(db, { effect, runId: RUN_ID });
    insertPending(db, { effect, runId: RUN_ID });

    // INSERT OR IGNORE on the UNIQUE (idempotency_key) means exactly one row
    // survives the second insert.
    const rows = queryOutbox(db);
    expect(rows.length).toBe(1);
    expect(rows[0]?.idempotencyKey).toBe("key-1");
  });

  it("pending → markSent transitions to status='sent' and populates external_id", () => {
    insertPending(db, { effect: makeEffect("key-1"), runId: RUN_ID });
    markSent(db, "key-1", "external-abc", new Date());

    const rows = queryOutbox(db);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.status).toBe("sent");
    expect(row.externalId).toBe("external-abc");
    expect(row.sentAt).not.toBeNull();
  });

  it("pending → incrementAttempts × 2 → markFailed populates attempts + last_error", () => {
    insertPending(db, { effect: makeEffect("key-1"), runId: RUN_ID });

    incrementAttempts(db, "key-1", "transient: 502 bad gateway");
    incrementAttempts(db, "key-1", "transient: 503 service unavailable");
    markFailed(db, "key-1", "exhausted retries: last 503");

    const rows = queryOutbox(db);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(2);
    expect(row.lastError).toBe("exhausted retries: last 503");
  });

  it("replayFailed resets a failed row to pending with attempts=0 and last_error=null", () => {
    insertPending(db, { effect: makeEffect("key-1"), runId: RUN_ID });
    incrementAttempts(db, "key-1", "transient");
    markFailed(db, "key-1", "exhausted");

    replayFailed(db, "key-1");

    const rows = queryOutbox(db);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
  });

  it("markAbandoned transitions a failed row to status='abandoned'", () => {
    insertPending(db, { effect: makeEffect("key-1"), runId: RUN_ID });
    markFailed(db, "key-1", "user gave up");

    markAbandoned(db, "key-1");

    const rows = queryOutbox(db);
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("abandoned");
  });

  it("queryOutbox({status: 'pending'}) filters by status", () => {
    insertPending(db, { effect: makeEffect("key-pending"), runId: RUN_ID });
    insertPending(db, { effect: makeEffect("key-sent"), runId: RUN_ID });
    markSent(db, "key-sent", "ext-1", new Date());

    const got = queryOutbox(db, { status: "pending" });
    expect(got.length).toBe(1);
    expect(got[0]?.idempotencyKey).toBe("key-pending");
    expect(got[0]?.status).toBe("pending");
  });

  it("dispatchExternalEffect inserts before handler and marks the row sent", async () => {
    const calls: string[] = [];

    const result = await dispatchExternalEffect(db, {
      effect: makeEffect("key-1"),
      runId: RUN_ID,
      handlers: {
        "calendar.write": async ({ idempotencyKey, attempt }) => {
          calls.push(`${idempotencyKey}:${attempt}`);
          expect(queryOutbox(db)[0]?.status).toBe("pending");
          return { externalId: "external-abc" };
        },
      },
    });

    expect(result.kind).toBe("sent");
    expect(calls).toEqual(["key-1:1"]);
    const rows = queryOutbox(db);
    expect(rows[0]?.status).toBe("sent");
    expect(rows[0]?.externalId).toBe("external-abc");
  });

  it("dispatchExternalEffect does not re-call the handler for an already-sent key", async () => {
    let calls = 0;
    const handlers = {
      "calendar.write": async () => {
        calls += 1;
        return { externalId: "external-abc" };
      },
    };

    await dispatchExternalEffect(db, {
      effect: makeEffect("key-1"),
      runId: RUN_ID,
      handlers,
    });
    const second = await dispatchExternalEffect(db, {
      effect: makeEffect("key-1"),
      runId: RUN_ID,
      handlers,
    });

    expect(calls).toBe(1);
    expect(second.kind).toBe("already-sent");
    const rows = queryOutbox(db);
    expect(rows.length).toBe(1);
  });

  it("handler failures stay pending until max attempts, then fail terminally", async () => {
    const handlers = {
      "calendar.write": async () => {
        throw new Error("remote 503");
      },
    };

    const first = await dispatchExternalEffect(db, {
      effect: makeEffect("key-1"),
      runId: RUN_ID,
      handlers,
    });
    const second = await dispatchExternalEffect(db, {
      effect: makeEffect("key-1"),
      runId: RUN_ID,
      handlers,
    });
    const third = await dispatchExternalEffect(db, {
      effect: makeEffect("key-1"),
      runId: RUN_ID,
      handlers,
    });

    expect(first.kind).toBe("pending");
    expect(second.kind).toBe("pending");
    expect(third.kind).toBe("failed");
    const row = queryOutbox(db)[0];
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(3);
    expect(row?.lastError).toBe("remote 503");
  });

  it("missing handler marks the row failed instead of leaving it pending forever", async () => {
    const result = await dispatchExternalEffect(db, {
      effect: makeEffect("key-1"),
      runId: RUN_ID,
      handlers: {},
    });

    expect(result.kind).toBe("failed");
    const row = queryOutbox(db)[0];
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain("No external handler registered");
  });

  it("dispatchPendingOutbox retries pending rows from a prior process", async () => {
    insertPending(db, { effect: makeEffect("key-1"), runId: RUN_ID });

    const results = await dispatchPendingOutbox(db, {
      handlers: {
        "calendar.write": async ({ attempt }) => ({
          externalId: `external-${attempt}`,
        }),
      },
    });

    expect(results.length).toBe(1);
    expect(results[0]?.kind).toBe("sent");
    const row = queryOutbox(db)[0];
    expect(row?.status).toBe("sent");
    expect(row?.externalId).toBe("external-1");
  });

  it("dispatchPendingOutbox can skip rows enqueued after the drain cutoff", async () => {
    const cutoff = new Date();
    insertPending(db, { effect: makeEffect("key-1"), runId: RUN_ID });

    let calls = 0;
    const results = await dispatchPendingOutbox(db, {
      enqueuedBefore: cutoff,
      handlers: {
        "calendar.write": async () => {
          calls += 1;
          return { externalId: "external-1" };
        },
      },
    });

    expect(results.length).toBe(0);
    expect(calls).toBe(0);
    expect(queryOutbox(db)[0]?.status).toBe("pending");
  });
});
