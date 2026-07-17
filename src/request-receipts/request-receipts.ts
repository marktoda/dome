// Deep request-receipt Module. Callers learn one lease-based Interface; SQL,
// CAS/idempotency, safe terminal fields, bounded listing, pruning, and startup
// interruption remain local.

import { randomUUID } from "node:crypto";

import type { RequestReceiptsDb } from "./db";

export const REQUEST_RECEIPT_EXECUTORS = ["http", "assistant", "agent-work"] as const;
export type RequestReceiptExecutor = typeof REQUEST_RECEIPT_EXECUTORS[number];

export const REQUEST_RECEIPT_OPERATIONS = [
  "capture", "settle", "resolve", "agent-work-complete", "agent-work-drain",
  "apply-proposal", "reject-proposal", "create-document", "edit-document",
] as const;
export type RequestReceiptOperation = typeof REQUEST_RECEIPT_OPERATIONS[number];

export const REQUEST_RECEIPT_OPERATION_CLASSES = [
  "operational-transaction", "workspace-mutation",
] as const;
export type RequestReceiptOperationClass = typeof REQUEST_RECEIPT_OPERATION_CLASSES[number];

export const REQUEST_RECEIPT_TERMINAL_STATES = [
  "succeeded", "rejected", "failed", "cancelled", "interrupted",
] as const;
export type RequestReceiptTerminalState = typeof REQUEST_RECEIPT_TERMINAL_STATES[number];
export type RequestReceiptState = "admitted" | RequestReceiptTerminalState;

export const REQUEST_RECEIPT_ADOPTION_STATES = [
  "none", "pending", "unknown",
] as const;
export type RequestReceiptAdoptionState = typeof REQUEST_RECEIPT_ADOPTION_STATES[number];

export type RequestReceipt = Readonly<{
  operationId: string;
  requestId: string;
  actorId: "owner";
  deviceId: string;
  credentialId: string;
  transport: "cookie" | "bearer";
  hostInstanceId: string;
  executor: RequestReceiptExecutor;
  operation: RequestReceiptOperation;
  operationClass: RequestReceiptOperationClass;
  state: RequestReceiptState;
  resultCode: string | null;
  commitOid: string | null;
  adoptionState: RequestReceiptAdoptionState;
  recoveryRequired: boolean;
  admittedAt: string;
  finishedAt: string | null;
}>;

export type AdmitRequestReceiptInput = Readonly<{
  requestId: string;
  actorId: "owner";
  deviceId: string;
  credentialId: string;
  transport: "cookie" | "bearer";
  hostInstanceId: string;
  executor: RequestReceiptExecutor;
  operation: RequestReceiptOperation;
  operationClass: RequestReceiptOperationClass;
}>;

export type FinishRequestReceiptInput = Readonly<{
  state: RequestReceiptTerminalState;
  resultCode: string;
  commitOid?: string | undefined;
  adoptionState?: RequestReceiptAdoptionState | undefined;
  recoveryRequired?: boolean | undefined;
}>;

export type FinishRequestReceiptResult =
  | { readonly kind: "finished" | "already-finished"; readonly receipt: RequestReceipt }
  | { readonly kind: "terminal-conflict"; readonly receipt: RequestReceipt };

export type RequestReceiptLease = Readonly<{
  operationId: string;
  finish: (input: FinishRequestReceiptInput) => FinishRequestReceiptResult;
}>;

/** Host-bound recorder seam consumed by authenticated HTTP mutation routes. */
export type HttpRequestReceiptRecorder = Readonly<{
  admit: (input: Omit<AdmitRequestReceiptInput, "hostInstanceId" | "executor">) => RequestReceiptLease;
}>;

export type RequestReceipts = Readonly<{
  admit: (input: AdmitRequestReceiptInput) => RequestReceiptLease;
  list: (input?: {
    readonly requestId?: string | undefined;
    readonly deviceId?: string | undefined;
    readonly state?: RequestReceiptState | undefined;
    readonly limit?: number | undefined;
  }) => ReadonlyArray<RequestReceipt>;
  interruptAdmitted: (input: {
    readonly exceptHostInstanceId: string;
    readonly interruptedAt?: Date | undefined;
    readonly resultCode?: string | undefined;
  }) => number;
  prune: (input: {
    readonly finishedBefore: Date;
    readonly limit?: number | undefined;
  }) => number;
  close: () => void;
}>;

export function bindHttpRequestReceiptRecorder(
  receipts: Pick<RequestReceipts, "admit">,
  hostInstanceId: string,
): HttpRequestReceiptRecorder {
  return Object.freeze({
    admit: (input) => receipts.admit({ ...input, hostInstanceId, executor: "http" }),
  });
}

type ReceiptRow = {
  operation_id: string;
  request_id: string;
  actor_id: string;
  device_id: string;
  credential_id: string;
  transport: string;
  host_instance_id: string;
  executor: string;
  operation: string;
  operation_class: string;
  state: string;
  result_code: string | null;
  commit_oid: string | null;
  adoption_state: string;
  recovery_required: number;
  admitted_at: string;
  finished_at: string | null;
};

const SELECT_COLUMNS = "operation_id, request_id, actor_id, "
  + "device_id, credential_id, transport, host_instance_id, executor, operation, operation_class, state, "
  + "result_code, commit_oid, adoption_state, recovery_required, admitted_at, finished_at";
const OPAQUE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/;
const SEMANTIC_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OID = /^[0-9a-f]{40}$/;
const MAX_LIST = 100;
const MAX_PRUNE = 10_000;

/** Exact production subquery matched by the partial prune index. */
export const REQUEST_RECEIPT_PRUNE_CANDIDATES_SQL =
  "SELECT operation_id FROM request_receipts "
    + "WHERE state IN ('succeeded','rejected') AND finished_at < ? "
    + "ORDER BY finished_at ASC, operation_id ASC LIMIT ?";

export function createRequestReceipts(
  db: RequestReceiptsDb,
  dependencies: {
    readonly now?: (() => Date) | undefined;
    readonly createId?: (() => string) | undefined;
  } = {},
): RequestReceipts {
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;
  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new Error("request receipts store is closed");
  };

  const finish = (
    operationId: string,
    input: FinishRequestReceiptInput,
  ): FinishRequestReceiptResult => {
    assertOpen();
    requireSemanticCode(input.resultCode, "resultCode");
    if (input.state === "interrupted" && input.commitOid !== undefined) {
      throw new Error("interrupted receipt cannot claim a commit");
    }
    const commitOid = input.commitOid?.toLowerCase() ?? null;
    if (commitOid !== null && !OID.test(commitOid)) {
      throw new Error("commitOid must be a full lowercase hexadecimal Git object id");
    }
    const adoptionState = input.adoptionState ?? (
      input.state === "interrupted" ? "unknown" : commitOid === null ? "none" : "pending"
    );
    requireCommitAdoptionMatrix(input.state, commitOid, adoptionState);
    const recoveryRequired = input.recoveryRequired ?? input.state === "interrupted";
    if (input.state === "interrupted" && !recoveryRequired) {
      throw new Error("interrupted receipt requires recovery");
    }
    const finishedAt = iso(now(), "finishedAt");
    const transition = db.raw.transaction(() => {
      const changed = db.raw.query(
        "UPDATE request_receipts SET state = ?, result_code = ?, commit_oid = ?, "
          + "adoption_state = ?, recovery_required = ?, finished_at = ? "
          + "WHERE operation_id = ? AND state = 'admitted'",
      ).run(input.state, input.resultCode, commitOid, adoptionState, recoveryRequired ? 1 : 0, finishedAt, operationId);
      return { changed: changed.changes, receipt: readOne(db, operationId) };
    })();
    const receipt = transition.receipt;
    if (receipt === null) throw new Error(`request receipt operation '${operationId}' was not found`);
    if (transition.changed > 0) return Object.freeze({ kind: "finished" as const, receipt });
    const same = receipt.state === input.state &&
      receipt.resultCode === input.resultCode && receipt.commitOid === commitOid &&
      receipt.adoptionState === adoptionState && receipt.recoveryRequired === recoveryRequired;
    return Object.freeze({
      kind: same ? "already-finished" as const : "terminal-conflict" as const,
      receipt,
    });
  };

  const receipts: RequestReceipts = Object.freeze({
    admit(input) {
      assertOpen();
      requireOpaqueId(input.requestId, "requestId");
      requireOpaqueId(input.deviceId, "deviceId");
      requireOpaqueId(input.credentialId, "credentialId");
      requireOpaqueId(input.hostInstanceId, "hostInstanceId");
      const operationId = createId();
      requireOpaqueId(operationId, "operationId");
      const admittedAt = iso(now(), "admittedAt");
      db.raw.query(
        "INSERT INTO request_receipts (operation_id, request_id, "
          + "actor_id, device_id, credential_id, transport, host_instance_id, executor, operation, operation_class, "
          + "state, result_code, commit_oid, adoption_state, recovery_required, admitted_at, finished_at) "
          + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted', NULL, NULL, 'none', 0, ?, NULL)",
      ).run(
        operationId, input.requestId, input.actorId, input.deviceId, input.credentialId, input.transport,
        input.hostInstanceId, input.executor,
        input.operation, input.operationClass, admittedAt,
      );
      return Object.freeze({
        operationId,
        finish: (terminal) => finish(operationId, terminal),
      });
    },

    list(input = {}) {
      assertOpen();
      const limit = boundedLimit(input.limit, 50, MAX_LIST, "list limit");
      const where: string[] = [];
      const values: string[] = [];
      if (input.requestId !== undefined) {
        requireOpaqueId(input.requestId, "requestId");
        where.push("request_id = ?"); values.push(input.requestId);
      }
      if (input.deviceId !== undefined) {
        requireOpaqueId(input.deviceId, "deviceId");
        where.push("device_id = ?"); values.push(input.deviceId);
      }
      if (input.state !== undefined) {
        where.push("state = ?"); values.push(input.state);
      }
      const sql = `SELECT ${SELECT_COLUMNS} FROM request_receipts `
        + `${where.length === 0 ? "" : `WHERE ${where.join(" AND ")} `}`
        + "ORDER BY admitted_at DESC, operation_id DESC LIMIT ?";
      return Object.freeze(
        db.raw.query<ReceiptRow, [...string[], number]>(sql).all(...values, limit).map(rowToReceipt),
      );
    },

    interruptAdmitted(input) {
      assertOpen();
      requireOpaqueId(input.exceptHostInstanceId, "exceptHostInstanceId");
      const at = iso(input.interruptedAt ?? now(), "interruptedAt");
      const code = input.resultCode ?? "host-restarted";
      requireSemanticCode(code, "resultCode");
      const result = db.raw.query(
        "UPDATE request_receipts SET state = 'interrupted', result_code = ?, "
          + "adoption_state = 'unknown', recovery_required = 1, finished_at = ? "
          + "WHERE state = 'admitted' AND host_instance_id <> ?",
      ).run(code, at, input.exceptHostInstanceId);
      return result.changes;
    },

    prune(input) {
      assertOpen();
      const before = iso(input.finishedBefore, "finishedBefore");
      const limit = boundedLimit(input.limit, 1_000, MAX_PRUNE, "prune limit");
      const result = db.raw.query(
        "DELETE FROM request_receipts WHERE operation_id IN ("
          + REQUEST_RECEIPT_PRUNE_CANDIDATES_SQL
          + ")",
      ).run(before, limit);
      return result.changes;
    },

    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  });
  return receipts;
}

function readOne(db: RequestReceiptsDb, operationId: string): RequestReceipt | null {
  const row = db.raw.query<ReceiptRow, [string]>(
    `SELECT ${SELECT_COLUMNS} FROM request_receipts WHERE operation_id = ?`,
  ).get(operationId);
  return row === null ? null : rowToReceipt(row);
}

function rowToReceipt(row: ReceiptRow): RequestReceipt {
  for (const [label, value] of [
    ["operationId", row.operation_id],
    ["requestId", row.request_id],
    ["deviceId", row.device_id],
    ["credentialId", row.credential_id],
    ["hostInstanceId", row.host_instance_id],
  ] as const) requireOpaqueId(value, label);
  if (row.actor_id !== "owner") throw new Error("stored request receipt has invalid actorId");
  if (row.recovery_required !== 0 && row.recovery_required !== 1) {
    throw new Error("stored request receipt has invalid recoveryRequired");
  }
  if (row.result_code !== null) requireSemanticCode(row.result_code, "resultCode");
  if (row.commit_oid !== null && !OID.test(row.commit_oid)) {
    throw new Error("stored request receipt has invalid commitOid");
  }
  storedIso(row.admitted_at, "admittedAt");
  if (row.finished_at !== null) storedIso(row.finished_at, "finishedAt");
  const state: RequestReceiptState = row.state === "admitted"
    ? "admitted"
    : oneOf(row.state, REQUEST_RECEIPT_TERMINAL_STATES, "state");
  const adoptionState = oneOf(row.adoption_state, REQUEST_RECEIPT_ADOPTION_STATES, "adoptionState");
  requireCommitAdoptionMatrix(state, row.commit_oid, adoptionState, "stored request receipt");
  return Object.freeze({
    operationId: row.operation_id,
    requestId: row.request_id,
    actorId: "owner",
    deviceId: row.device_id,
    credentialId: row.credential_id,
    transport: oneOf(row.transport, ["cookie", "bearer"] as const, "transport"),
    hostInstanceId: row.host_instance_id,
    executor: oneOf(row.executor, REQUEST_RECEIPT_EXECUTORS, "executor"),
    operation: oneOf(row.operation, REQUEST_RECEIPT_OPERATIONS, "operation"),
    operationClass: oneOf(row.operation_class, REQUEST_RECEIPT_OPERATION_CLASSES, "operationClass"),
    state,
    resultCode: row.result_code,
    commitOid: row.commit_oid,
    adoptionState,
    recoveryRequired: row.recovery_required === 1,
    admittedAt: row.admitted_at,
    finishedAt: row.finished_at,
  });
}

function oneOf<const T extends readonly string[]>(value: string, allowed: T, label: string): T[number] {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`stored request receipt has invalid ${label}`);
  }
  return value as T[number];
}

function requireCommitAdoptionMatrix(
  state: RequestReceiptState,
  commitOid: string | null,
  adoptionState: RequestReceiptAdoptionState,
  prefix = "request receipt",
): void {
  const valid = state === "admitted"
    ? commitOid === null && adoptionState === "none"
    : state === "interrupted"
      ? commitOid === null && adoptionState === "unknown"
      : commitOid === null
        ? adoptionState === "none"
        : adoptionState === "pending";
  if (!valid) throw new Error(`${prefix} has an invalid commit/adoption state`);
}

function requireSemanticCode(value: string, label: string): void {
  if (!SEMANTIC_CODE.test(value)) throw new Error(`${label} must be a safe semantic code`);
}

function requireOpaqueId(value: string, label: string): void {
  if (!OPAQUE_ID.test(value)) throw new Error(`${label} must be a safe opaque identifier`);
}

function iso(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} must be a valid Date`);
  }
  return value.toISOString();
}

function storedIso(value: string, label: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`stored request receipt has invalid ${label}`);
  }
}

function boundedLimit(value: number | undefined, fallback: number, max: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > max) {
    throw new Error(`${label} must be an integer from 1 to ${max}`);
  }
  return resolved;
}
