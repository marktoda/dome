import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeRequestReceiptsSchemaHash,
  migrateRequestReceiptsN1,
  openRequestReceiptsDb,
  REQUEST_RECEIPTS_N1_SCHEMA_HASH,
} from "../../src/request-receipts/db";
import {
  createRequestReceipts,
  REQUEST_RECEIPT_PRUNE_CANDIDATES_SQL,
  type AdmitRequestReceiptInput,
} from "../../src/request-receipts/request-receipts";
import {
  FROZEN_N1_RELEASE,
  materializeFrozenN1Fixture,
} from "../fixtures/home-upgrade/n-1/freeze-n1";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function path(): string {
  const root = mkdtempSync(join(tmpdir(), "dome-request-receipts-"));
  roots.push(root);
  return join(root, "request-receipts.db");
}

const BASE: AdmitRequestReceiptInput = Object.freeze({
  requestId: "request-1",
  actorId: "owner",
  deviceId: "device-1",
  credentialId: "credential-1",
  transport: "cookie",
  hostInstanceId: "host-1",
  executor: "http",
  operation: "capture",
  operationClass: "workspace-mutation",
});

async function opened(dbPath = path(), options: {
  readonly times?: Date[];
  readonly ids?: string[];
} = {}) {
  const result = await openRequestReceiptsDb({ path: dbPath });
  if (!result.ok) throw new Error(`open failed: ${result.error.kind}`);
  const times = [...(options.times ?? [new Date("2026-07-12T12:00:00.000Z")])];
  const ids = [...(options.ids ?? ["operation-1"] )];
  const receipts = createRequestReceipts(result.value.db, {
    now: () => times.shift() ?? new Date("2026-07-12T13:00:00.000Z"),
    createId: () => ids.shift() ?? `operation-${Math.random().toString(16).slice(2)}`,
  });
  return { result, receipts };
}

describe("request receipts store", () => {
  test("ordinary open refuses frozen N-1 while the exact upgrade route adds the prune index", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-request-receipts-n1-"));
    roots.push(root);
    await materializeFrozenN1Fixture({
      fixtureRoot: join(import.meta.dir, "..", "fixtures", "home-upgrade", "n-1", FROZEN_N1_RELEASE),
      destination: root,
    });
    const dbPath = join(root, "request-receipts.db");
    expect(REQUEST_RECEIPTS_N1_SCHEMA_HASH).not.toBe(computeRequestReceiptsSchemaHash());
    const refused = await openRequestReceiptsDb({ path: dbPath });
    expect(refused).toMatchObject({
      ok: false,
      error: { kind: "schema-mismatch", stored: REQUEST_RECEIPTS_N1_SCHEMA_HASH },
    });
    const migrated = await migrateRequestReceiptsN1({ path: dbPath });
    expect(migrated).toEqual({ ok: true, value: { schemaHash: computeRequestReceiptsSchemaHash() } });
    const current = await openRequestReceiptsDb({ path: dbPath });
    if (!current.ok) throw new Error(JSON.stringify(current.error));
    try {
      expect(current.value.db.raw.query<{ operation_id: string; state: string }, []>(
        "SELECT operation_id,state FROM request_receipts ORDER BY operation_id",
      ).all()).toEqual([
        { operation_id: "receipt-admitted", state: "admitted" },
        { operation_id: "receipt-interrupted", state: "interrupted" },
        { operation_id: "receipt-succeeded", state: "succeeded" },
      ]);
      expect(current.value.db.raw.query<{ name: string }, []>(
        "SELECT name FROM sqlite_schema WHERE type='index' AND name='request_receipts_prunable'",
      ).all()).toEqual([{ name: "request_receipts_prunable" }]);
      expect(current.value.db.raw.query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_schema WHERE name='request_receipts_prunable'",
      ).get()?.sql).toBe("CREATE INDEX request_receipts_prunable ON request_receipts(finished_at, operation_id) WHERE state IN ('succeeded','rejected')");
      const forcedPruneSql = REQUEST_RECEIPT_PRUNE_CANDIDATES_SQL.replace(
        "FROM request_receipts ",
        "FROM request_receipts INDEXED BY request_receipts_prunable ",
      );
      const plan = current.value.db.raw.query<{ detail: string }, [string, number]>(
        `EXPLAIN QUERY PLAN ${forcedPruneSql}`,
      ).all("2027-01-01T00:00:00.000Z", 100);
      expect(plan.some((row) => row.detail.includes("request_receipts_prunable"))).toBe(true);
    } finally { current.value.db.close(); }
  });

  test("exact N-1 migration refuses meta-hash-only structural drift", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-request-receipts-drift-"));
    roots.push(root);
    await materializeFrozenN1Fixture({
      fixtureRoot: join(import.meta.dir, "..", "fixtures", "home-upgrade", "n-1", FROZEN_N1_RELEASE),
      destination: root,
    });
    const dbPath = join(root, "request-receipts.db");
    const drift = new Database(dbPath);
    drift.run("CREATE INDEX forged_receipt_index ON request_receipts(result_code)");
    drift.run("PRAGMA wal_checkpoint(TRUNCATE)");
    drift.close();
    const result = await migrateRequestReceiptsN1({ path: dbPath });
    expect(result).toMatchObject({ ok: false, error: { kind: "schema-init-failed" } });
    const verify = new Database(dbPath, { readonly: true, create: false });
    try {
      expect(verify.query<{ schema_hash: string }, []>("SELECT schema_hash FROM request_receipts_meta").get()?.schema_hash)
        .toBe(REQUEST_RECEIPTS_N1_SCHEMA_HASH);
      expect(verify.query("SELECT name FROM sqlite_schema WHERE name='request_receipts_prunable'").all()).toEqual([]);
    } finally { verify.close(); }
  });

  test("opens fresh, persists safe attribution, and reopens without migration", async () => {
    const dbPath = path();
    const first = await opened(dbPath, { ids: ["operation-1"] });
    expect(first.result.value.migration).toBe("fresh");
    expect(first.result.value.db.schemaHash).toBe(computeRequestReceiptsSchemaHash());
    expect(first.result.value.db.raw.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous)
      .toBe(2); // FULL: audit is not rebuildable from Git.
    expect(first.result.value.db.raw.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode)
      .toBe("wal");
    const lease = first.receipts.admit(BASE);
    expect(lease.operationId).toBe("operation-1");
    first.receipts.close();

    const second = await opened(dbPath);
    expect(second.result.value.migration).toBe("ok");
    expect(second.receipts.list()).toEqual([expect.objectContaining({
      operationId: "operation-1",
      requestId: "request-1",
      actorId: "owner",
      deviceId: "device-1",
      credentialId: "credential-1",
      transport: "cookie",
      hostInstanceId: "host-1",
      state: "admitted",
    })]);
    const columns = second.result.value.db.raw
      .query<{ name: string }, []>("PRAGMA table_info(request_receipts)").all()
      .map((column) => column.name);
    expect(columns).not.toContain("payload_json");
    expect(columns).not.toContain("result_json");
    expect(columns).not.toContain("path");
    second.receipts.close();
  });

  test("terminal transition is CAS-protected and exactly idempotent", async () => {
    const { receipts } = await opened(path(), {
      ids: ["operation-1"],
      times: [new Date("2026-07-12T12:00:00Z"), new Date("2026-07-12T12:01:00Z")],
    });
    const lease = receipts.admit(BASE);
    const terminal = {
      state: "succeeded" as const,
      resultCode: "captured",
      commitOid: "a".repeat(40),
    };
    const finished = lease.finish(terminal);
    expect(finished).toMatchObject({
      kind: "finished",
      receipt: { state: "succeeded", resultCode: "captured", adoptionState: "pending" },
    });
    expect(lease.finish(terminal).kind).toBe("already-finished");
    const conflict = lease.finish({ state: "failed", resultCode: "write-failed" });
    expect(conflict).toMatchObject({ kind: "terminal-conflict", receipt: { state: "succeeded" } });
    receipts.close();
  });

  test("validates safe fields and commit/adoption combinations before persistence", async () => {
    const { receipts } = await opened(path(), { ids: ["operation-1", "operation-2"] });
    expect(() => receipts.admit({ ...BASE, requestId: "request with prose" })).toThrow("safe token");
    const lease = receipts.admit(BASE);
    expect(() => lease.finish({
      state: "succeeded",
      resultCode: "ok",
      adoptionState: "pending",
    })).toThrow("invalid commit/adoption");
    expect(() => lease.finish({
      state: "succeeded",
      resultCode: "ok",
      adoptionState: "unknown",
    })).toThrow("invalid commit/adoption");
    expect(() => lease.finish({
      state: "succeeded",
      resultCode: "ok",
      commitOid: "not-an-oid",
    })).toThrow("commitOid");
    expect(receipts.list()).toHaveLength(1);
    receipts.close();
  });

  test("accepts representative uppercase base64url authority identifiers", async () => {
    const { receipts } = await opened(path(), { ids: ["Operation_AZ-19"] });
    const lease = receipts.admit({
      ...BASE,
      requestId: "Request_QwE-19",
      deviceId: "Device_QwE-19",
      credentialId: "Credential_ZXc-42",
      hostInstanceId: "Host_ASD-7",
    });
    expect(lease.operationId).toBe("Operation_AZ-19");
    expect(receipts.list()[0]).toMatchObject({
      deviceId: "Device_QwE-19",
      credentialId: "Credential_ZXc-42",
    });
    receipts.close();
  });

  test("bounded list filters by request, device, and state newest-first", async () => {
    const { receipts } = await opened(path(), {
      ids: ["operation-1", "operation-2", "operation-3"],
      times: [
        new Date("2026-07-12T12:00:00Z"),
        new Date("2026-07-12T12:01:00Z"),
        new Date("2026-07-12T12:02:00Z"),
        new Date("2026-07-12T12:03:00Z"),
      ],
    });
    receipts.admit(BASE).finish({ state: "succeeded", resultCode: "duplicate" });
    receipts.admit({ ...BASE, requestId: "request-2", deviceId: "device-2" });
    receipts.admit({ ...BASE, requestId: "request-1", operation: "settle" });
    expect(receipts.list({ requestId: "request-1" }).map((row) => row.operationId))
      .toEqual(["operation-3", "operation-1"]);
    expect(receipts.list({ deviceId: "device-2" }).map((row) => row.operationId))
      .toEqual(["operation-2"]);
    expect(receipts.list({ state: "succeeded" })).toHaveLength(1);
    expect(receipts.list({ limit: 1 })).toHaveLength(1);
    expect(() => receipts.list({ limit: 101 })).toThrow("1 to 100");
    receipts.close();
  });

  test("startup interruption touches only prior admitted rows", async () => {
    const { receipts } = await opened(path(), {
      ids: ["operation-old", "operation-terminal", "operation-current"],
      times: [
        new Date("2026-07-12T10:00:00Z"),
        new Date("2026-07-12T10:01:00Z"),
        new Date("2026-07-12T10:02:00Z"),
        new Date("2026-07-12T12:00:00Z"),
      ],
    });
    receipts.admit(BASE);
    receipts.admit({ ...BASE, requestId: "request-2" })
      .finish({ state: "failed", resultCode: "known-failure" });
    receipts.admit({ ...BASE, requestId: "request-3", hostInstanceId: "host-2" });
    expect(receipts.interruptAdmitted({
      exceptHostInstanceId: "host-2",
      interruptedAt: new Date("2026-07-12T12:30:00Z"),
    })).toBe(1);
    expect(receipts.list({ requestId: "request-1" })[0]).toMatchObject({
      state: "interrupted", resultCode: "host-restarted", adoptionState: "unknown",
      recoveryRequired: true,
    });
    expect(receipts.list({ requestId: "request-2" })[0]?.state).toBe("failed");
    expect(receipts.list({ requestId: "request-3" })[0]).toMatchObject({ state: "admitted", hostInstanceId: "host-2" });
    receipts.close();
  });

  test("prune deletes only safe success/rejection rows and preserves failure evidence", async () => {
    const { receipts } = await opened(path(), {
      ids: [
        "operation-admitted", "operation-succeeded", "operation-rejected",
        "operation-failed", "operation-cancelled", "operation-interrupted",
      ],
    });
    receipts.admit(BASE);
    receipts.admit({ ...BASE, requestId: "request-2" })
      .finish({ state: "succeeded", resultCode: "ok" });
    receipts.admit({ ...BASE, requestId: "request-3" })
      .finish({ state: "rejected", resultCode: "not-allowed" });
    receipts.admit({ ...BASE, requestId: "request-4" })
      .finish({ state: "failed", resultCode: "failed" });
    receipts.admit({ ...BASE, requestId: "request-5" })
      .finish({ state: "cancelled", resultCode: "owner-cancelled" });
    receipts.admit({ ...BASE, requestId: "request-6" })
      .finish({ state: "interrupted", resultCode: "host-restarted" });
    expect(receipts.prune({
      finishedBefore: new Date("2026-07-13T00:00:00Z"),
      limit: 10,
    })).toBe(2);
    expect(receipts.list().map((row) => row.operationId).sort())
      .toEqual([
        "operation-admitted", "operation-cancelled", "operation-failed", "operation-interrupted",
      ]);
    expect(() => receipts.prune({ finishedBefore: new Date(), limit: 0 })).toThrow("1 to 10000");
    receipts.close();
  });

  test("SQLite CHECK constraints reject invalid lifecycle and attribution bytes", async () => {
    const { result, receipts } = await opened(path(), { ids: ["operation-1"] });
    receipts.admit(BASE);
    expect(() => result.value.db.raw.run(
      "UPDATE request_receipts SET transport = 'query-token' WHERE operation_id = 'operation-1'",
    )).toThrow();
    expect(() => result.value.db.raw.run(
      "UPDATE request_receipts SET state = 'interrupted', result_code = 'restart', "
        + `commit_oid = '${"a".repeat(40)}', adoption_state = 'pending', `
        + "finished_at = '2026-07-12T12:00:00.000Z', recovery_required = 1 "
        + "WHERE operation_id = 'operation-1'",
    )).toThrow();
    expect(() => result.value.db.raw.run(
      "UPDATE request_receipts SET state = 'succeeded', result_code = 'ok', "
        + "adoption_state = 'unknown', finished_at = '2026-07-12T12:00:00.000Z' "
        + "WHERE operation_id = 'operation-1'",
    )).toThrow();
    expect(() => result.value.db.raw.run(
      "UPDATE request_receipts SET state = 'interrupted', result_code = 'restart', "
        + "finished_at = '2026-07-12T12:00:00.000Z', recovery_required = 0 "
        + "WHERE operation_id = 'operation-1'",
    )).toThrow();
    expect(receipts.list()[0]).toMatchObject({
      state: "admitted", transport: "cookie", recoveryRequired: false,
    });
    receipts.close();
  });

  test("read boundary refuses corrupt safe fields even if CHECKs were bypassed", async () => {
    const { result, receipts } = await opened(path(), { ids: ["operation-1"] });
    receipts.admit(BASE);
    result.value.db.raw.run("PRAGMA ignore_check_constraints = ON");
    result.value.db.raw.run(
      "UPDATE request_receipts SET admitted_at = 'not-a-time' WHERE operation_id = 'operation-1'",
    );
    expect(() => receipts.list()).toThrow("invalid admittedAt");
    result.value.db.raw.run(
      "UPDATE request_receipts SET admitted_at = '2026-07-12T12:00:00.000Z', "
        + "result_code = 'unsafe prose' WHERE operation_id = 'operation-1'",
    );
    expect(() => receipts.list()).toThrow("resultCode must be an opaque safe token");
    result.value.db.raw.run(
      "UPDATE request_receipts SET result_code = NULL, commit_oid = 'bad-oid' "
        + "WHERE operation_id = 'operation-1'",
    );
    expect(() => receipts.list()).toThrow("invalid commitOid");
    result.value.db.raw.run(
      "UPDATE request_receipts SET commit_oid = NULL, adoption_state = 'unknown' "
        + "WHERE operation_id = 'operation-1'",
    );
    expect(() => receipts.list()).toThrow("invalid commit/adoption state");
    receipts.close();
  });

  test("unknown schema hash refuses without wiping receipts", async () => {
    const dbPath = path();
    const first = await opened(dbPath, { ids: ["operation-1"] });
    first.receipts.admit(BASE);
    first.receipts.close();
    const raw = new Database(dbPath);
    raw.run("UPDATE request_receipts_meta SET schema_hash = 'unknown'");
    raw.close();
    const refused = await openRequestReceiptsDb({ path: dbPath });
    expect(refused).toMatchObject({ ok: false, error: { kind: "schema-mismatch" } });
    const verify = new Database(dbPath, { readonly: true });
    expect(verify.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM request_receipts").get()?.count)
      .toBe(1);
    verify.close();
  });

  test("close is idempotent and rejects later operations", async () => {
    const { receipts } = await opened();
    receipts.close();
    receipts.close();
    expect(() => receipts.list()).toThrow("closed");
  });
});
