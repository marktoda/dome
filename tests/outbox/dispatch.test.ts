// Smoke tests for src/outbox/db.ts + src/outbox/dispatch.ts: the open/close
// lifecycle, idempotent insertPending, and the full pending → sent / failed /
// replay / abandoned state machine.
//
// Real integration tests against `bun:sqlite` in tmpdirs — the outbox IS the
// SQL boundary for ExternalActionEffects (pinned by
// EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  recoverFailedOutboxRow,
  replayFailed,
} from "../../src/outbox/dispatch";

const REF = sourceRef({ commit: commitOid("abc"), path: "wiki/x.md" });

const RUN_ID = "run-1";
const OLD_OUTBOX_SCHEMA_HASH =
  "82000d3d8dd8578f9c34d23fcca621c085aaf78d5d228ee62df824b739f19a68";
const T0 = new Date("2026-05-28T12:00:00.000Z");

function makeEffect(idempotencyKey: string) {
  return externalActionEffect({
    capability: "calendar.write",
    idempotencyKey,
    payload: { event: "x" },
    sourceRefs: [REF],
  });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
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

  it("configures a busy timeout for concurrent readers", async () => {
    const r = await openOutboxDb({ path: dbPath });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    handles.push(r.value.db);
    const row = r.value.db.raw
      .query<{ timeout: number }, []>("PRAGMA busy_timeout")
      .get();
    expect(row?.timeout).toBe(5000);
  });

  it("migrates old outbox rows without wiping pending external actions", async () => {
    mkdirSync(join(root, ".dome", "state"), { recursive: true });
    const old = new Database(dbPath);
    old.run(
      "CREATE TABLE outbox_meta (schema_hash TEXT NOT NULL, built_at TEXT NOT NULL, PRIMARY KEY (schema_hash))",
    );
    old.run(
      "CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, capability TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, source_refs TEXT NOT NULL, status TEXT NOT NULL, external_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, enqueued_at TEXT NOT NULL, sent_at TEXT, last_error TEXT, run_id TEXT NOT NULL)",
    );
    old.run(
      "CREATE INDEX outbox_by_status ON outbox(status, enqueued_at)",
    );
    old.run(
      "INSERT INTO outbox_meta (schema_hash, built_at) VALUES (?, ?)",
      [OLD_OUTBOX_SCHEMA_HASH, T0.toISOString()],
    );
    old.run(
      "INSERT INTO outbox (capability, idempotency_key, payload_json, source_refs, status, attempts, max_attempts, enqueued_at, run_id) VALUES (?, ?, ?, ?, 'pending', 1, 3, ?, ?)",
      [
        "calendar.write",
        "old-key",
        JSON.stringify({ event: "x" }),
        JSON.stringify([REF]),
        T0.toISOString(),
        RUN_ID,
      ],
    );
    old.close();

    const r = await openOutboxDb({ path: dbPath });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    handles.push(r.value.db);
    expect(r.value.migration).toBe("migrated");

    const rows = queryOutbox(r.value.db);
    expect(rows.length).toBe(1);
    expect(rows[0]?.idempotencyKey).toBe("old-key");
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.nextAttemptAt).toBe(T0.toISOString());

    r.value.db.close();
    handles.pop();
    const reopened = await openOutboxDb({ path: dbPath });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    handles.push(reopened.value.db);
    expect(reopened.value.migration).toBe("ok");
    expect(queryOutbox(reopened.value.db)[0]?.idempotencyKey).toBe("old-key");
  });

  it("refuses unknown schema mismatches without wiping outbox rows", async () => {
    mkdirSync(join(root, ".dome", "state"), { recursive: true });
    const old = new Database(dbPath);
    old.run(
      "CREATE TABLE outbox_meta (schema_hash TEXT NOT NULL, built_at TEXT NOT NULL, PRIMARY KEY (schema_hash))",
    );
    old.run(
      "CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL)",
    );
    old.run(
      "INSERT INTO outbox_meta (schema_hash, built_at) VALUES (?, ?)",
      ["unknown-outbox-schema", T0.toISOString()],
    );
    old.run("INSERT INTO outbox (idempotency_key) VALUES (?)", [
      "outbox-preserved",
    ]);
    old.close();

    const r = await openOutboxDb({ path: dbPath });
    expect(r.ok).toBe(false);
    if (r.ok) {
      handles.push(r.value.db);
      return;
    }
    expect(r.error.kind).toBe("schema-mismatch");

    const check = new Database(dbPath);
    try {
      const row = check
        .query<{ idempotency_key: string }, []>(
          "SELECT idempotency_key FROM outbox LIMIT 1",
        )
        .get();
      expect(row?.idempotency_key).toBe("outbox-preserved");
      const meta = check
        .query<{ schema_hash: string }, []>(
          "SELECT schema_hash FROM outbox_meta LIMIT 1",
        )
        .get();
      expect(meta?.schema_hash).toBe("unknown-outbox-schema");
    } finally {
      check.close();
    }
  });

  it("can finish an interrupted next_attempt_at migration", async () => {
    mkdirSync(join(root, ".dome", "state"), { recursive: true });
    const old = new Database(dbPath);
    old.run(
      "CREATE TABLE outbox_meta (schema_hash TEXT NOT NULL, built_at TEXT NOT NULL, PRIMARY KEY (schema_hash))",
    );
    old.run(
      "CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, capability TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, source_refs TEXT NOT NULL, status TEXT NOT NULL, external_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, enqueued_at TEXT NOT NULL, next_attempt_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z', sent_at TEXT, last_error TEXT, run_id TEXT NOT NULL)",
    );
    old.run(
      "INSERT INTO outbox_meta (schema_hash, built_at) VALUES (?, ?)",
      [OLD_OUTBOX_SCHEMA_HASH, T0.toISOString()],
    );
    old.run(
      "INSERT INTO outbox (capability, idempotency_key, payload_json, source_refs, status, attempts, max_attempts, enqueued_at, run_id) VALUES (?, ?, ?, ?, 'pending', 0, 3, ?, ?)",
      [
        "calendar.write",
        "old-key",
        JSON.stringify({ event: "x" }),
        JSON.stringify([REF]),
        T0.toISOString(),
        RUN_ID,
      ],
    );
    old.close();

    const r = await openOutboxDb({ path: dbPath });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    handles.push(r.value.db);
    expect(r.value.migration).toBe("migrated");
    expect(queryOutbox(r.value.db)[0]?.nextAttemptAt).toBe(T0.toISOString());
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
    insertPending(db, { effect, runId: RUN_ID, now: T0 });
    insertPending(db, { effect, runId: RUN_ID, now: new Date(T0.getTime() + 1) });

    // INSERT OR IGNORE on the UNIQUE (idempotency_key) means exactly one row
    // survives the second insert.
    const rows = queryOutbox(db);
    expect(rows.length).toBe(1);
    expect(rows[0]?.idempotencyKey).toBe("key-1");
    expect(rows[0]?.enqueuedAt).toBe(T0.toISOString());
    expect(rows[0]?.nextAttemptAt).toBe(T0.toISOString());
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

    const replayAt = new Date(T0.getTime() + 10_000);
    replayFailed(db, "key-1", replayAt);

    const rows = queryOutbox(db);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
    expect(row.nextAttemptAt).toBe(replayAt.toISOString());
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

  it("queryOutbox validates payload and source refs instead of casting", () => {
    insertPending(db, {
      effect: makeEffect("key-invalid-row"),
      runId: RUN_ID,
      now: T0,
    });
    db.raw
      .query("UPDATE outbox SET payload_json = ? WHERE idempotency_key = ?")
      .run("{not-json", "key-invalid-row");

    expect(() => queryOutbox(db)).toThrow(
      "outbox.payload_json contains invalid JSON",
    );

    db.raw
      .query(
        "UPDATE outbox SET payload_json = ?, source_refs = ? WHERE idempotency_key = ?",
      )
      .run(
        JSON.stringify({ ok: true }),
        JSON.stringify([{ commit: "", path: "wiki/x.md" }]),
        "key-invalid-row",
      );

    expect(() => queryOutbox(db)).toThrow(
      "outbox.source_refs failed validation",
    );
  });

  it("dispatchExternalEffect inserts before handler and marks the row sent", async () => {
    const calls: string[] = [];

    const result = await dispatchExternalEffect(db, {
      effect: makeEffect("key-1"),
      runId: RUN_ID,
      handlers: {
        "calendar.write": async ({ idempotencyKey, attempt }) => {
          calls.push(`${idempotencyKey}:${attempt}`);
          expect(queryOutbox(db)[0]?.status).toBe("dispatching");
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
      now: T0,
    });
    const immediate = await dispatchExternalEffect(db, {
      effect: makeEffect("key-1"),
      runId: RUN_ID,
      handlers,
      now: new Date(T0.getTime() + 999),
    });
    const second = await dispatchExternalEffect(db, {
      effect: makeEffect("key-1"),
      runId: RUN_ID,
      handlers,
      now: new Date(T0.getTime() + 1000),
    });
    const third = await dispatchExternalEffect(db, {
      effect: makeEffect("key-1"),
      runId: RUN_ID,
      handlers,
      now: new Date(T0.getTime() + 3000),
    });

    expect(first.kind).toBe("pending");
    if (first.kind !== "pending") throw new Error("expected pending");
    expect(first.nextAttemptAt).toBe(
      new Date(T0.getTime() + 1000).toISOString(),
    );
    expect(immediate.kind).toBe("pending");
    if (immediate.kind !== "pending") throw new Error("expected pending");
    expect(immediate.attempts).toBe(1);
    expect(second.kind).toBe("pending");
    if (second.kind !== "pending") throw new Error("expected pending");
    expect(second.nextAttemptAt).toBe(
      new Date(T0.getTime() + 3000).toISOString(),
    );
    expect(third.kind).toBe("failed");
    const row = queryOutbox(db)[0];
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(3);
    expect(row?.lastError).toBe("remote 503");
  });

  it("handler timeout aborts the attempt signal and records a retryable failure", async () => {
    let handlerSignal: AbortSignal | undefined;
    let aborts = 0;

    const result = await dispatchExternalEffect(db, {
      effect: makeEffect("key-timeout"),
      runId: RUN_ID,
      handlers: {
        "calendar.write": async ({ signal }) => {
          handlerSignal = signal;
          await waitForAbort(signal);
          aborts += 1;
          return { externalId: "late-external-id" };
        },
      },
      now: T0,
      handlerTimeoutMs: 5,
    });

    expect(result.kind).toBe("pending");
    if (result.kind !== "pending") throw new Error("expected pending");
    expect(result.attempts).toBe(1);
    expect(result.lastError).toContain("External handler exceeded timeout");
    expect(handlerSignal?.aborted).toBe(true);
    expect(aborts).toBe(1);

    const row = queryOutbox(db)[0];
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain("External handler exceeded timeout");
  });

  it("dispatch cancellation aborts the handler without burning an attempt", async () => {
    const controller = new AbortController();
    let handlerSignal: AbortSignal | undefined;
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });

    const run = dispatchExternalEffect(db, {
      effect: makeEffect("key-cancelled"),
      runId: RUN_ID,
      handlers: {
        "calendar.write": async ({ signal }) => {
          handlerSignal = signal;
          started?.();
          await waitForAbort(signal);
          return { externalId: "should-not-mark-sent" };
        },
      },
      signal: controller.signal,
    });

    await startedPromise;
    expect(handlerSignal?.aborted).toBe(false);
    controller.abort();
    const result = await run;

    expect(result.kind).toBe("cancelled");
    if (result.kind !== "cancelled") throw new Error("expected cancelled");
    expect(result.attempts).toBe(0);
    expect(result.lastError).toContain("cancelled");
    expect(handlerSignal?.aborted).toBe(true);

    const row = queryOutbox(db)[0];
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(0);
    expect(row?.lastError).toBeNull();
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

  it("recoverFailedOutboxRow rejects stale failure tokens", () => {
    insertPending(db, {
      effect: makeEffect("key-stale-recovery"),
      runId: RUN_ID,
      now: T0,
    });
    markFailed(db, "key-stale-recovery", "terminal failure");
    const failed = queryOutbox(db)[0];
    if (failed === undefined) throw new Error("missing failed row");
    const token = encodeURIComponent(
      JSON.stringify({
        attempts: failed.attempts,
        nextAttemptAt: failed.nextAttemptAt,
        lastError: failed.lastError,
      }),
    );

    expect(
      recoverFailedOutboxRow(db, {
        idempotencyKey: "key-stale-recovery",
        action: "retry",
        failureToken: `${token}-old`,
        now: T0,
      }),
    ).toBe(false);
    expect(queryOutbox(db)[0]?.status).toBe("failed");

    expect(
      recoverFailedOutboxRow(db, {
        idempotencyKey: "key-stale-recovery",
        action: "retry",
        failureToken: token,
        now: T0,
      }),
    ).toBe(true);
    expect(queryOutbox(db)[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      lastError: null,
    });
  });

  it("dispatchPendingOutbox retries pending rows from a prior process", async () => {
    insertPending(db, { effect: makeEffect("key-1"), runId: RUN_ID, now: T0 });

    const results = await dispatchPendingOutbox(db, {
      now: T0,
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

  it("dispatchPendingOutbox claims a row before calling the external handler", async () => {
    insertPending(db, { effect: makeEffect("key-1"), runId: RUN_ID, now: T0 });

    const handlerEntered = deferred<void>();
    const releaseHandler = deferred<void>();
    let calls = 0;
    const first = dispatchPendingOutbox(db, {
      now: T0,
      handlers: {
        "calendar.write": async () => {
          calls += 1;
          handlerEntered.resolve();
          await releaseHandler.promise;
          return { externalId: "external-1" };
        },
      },
    });
    await handlerEntered.promise;

    const duringFirst = queryOutbox(db)[0];
    expect(duringFirst?.status).toBe("dispatching");

    const second = await dispatchPendingOutbox(db, {
      now: T0,
      handlers: {
        "calendar.write": async () => {
          calls += 1;
          return { externalId: "external-duplicate" };
        },
      },
    });
    expect(second.length).toBe(0);
    expect(calls).toBe(1);

    releaseHandler.resolve();
    const firstResults = await first;
    expect(firstResults[0]?.kind).toBe("sent");
    expect(queryOutbox(db)[0]?.externalId).toBe("external-1");
    expect(calls).toBe(1);
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

  it("dispatchPendingOutbox skips pending rows whose retry cursor is not due", async () => {
    let calls = 0;
    await dispatchExternalEffect(db, {
      effect: makeEffect("key-1"),
      runId: RUN_ID,
      now: T0,
      handlers: {
        "calendar.write": async () => {
          calls += 1;
          throw new Error("remote 503");
        },
      },
    });

    const results = await dispatchPendingOutbox(db, {
      now: new Date(T0.getTime() + 999),
      handlers: {
        "calendar.write": async () => {
          calls += 1;
          return { externalId: "external-2" };
        },
      },
    });

    expect(results.length).toBe(0);
    expect(calls).toBe(1);
    expect(queryOutbox(db)[0]?.attempts).toBe(1);
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T | PromiseLike<T>) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = (value) => innerResolve(value as T | PromiseLike<T>);
  });
  return Object.freeze({ promise, resolve });
}
