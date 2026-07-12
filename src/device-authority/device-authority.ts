// Durable one-owner device authority for the Product Host. Raw pairing codes,
// device credentials, and CSRF secrets exist only at this Interface boundary;
// SQLite stores fixed-width SHA-256 hashes and lifecycle/audit metadata.

import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Capability } from "../capabilities";
import type { SqliteTableShape } from "../sqlite-shape";
import { computeDdlHash } from "../sqlite/hash";
import { openSimpleStore, type StoreOpenError } from "../sqlite/open-store";
import { err, ok, type Result } from "../types";

const PAIRING_PREFIX = "dome_pair";
const CREDENTIAL_PREFIX = "dome_cred";
const CSRF_PREFIX = "dome_csrf";
const DEVICE_PREFIX = "dev";
const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_PAIRING_ATTEMPTS = 5;
const CAPABILITIES = new Set<Capability>([
  "read",
  "capture",
  "resolve",
  "converse",
  "author",
]);

const DDL: ReadonlyArray<string> = Object.freeze([
  "CREATE TABLE IF NOT EXISTS device_authority_meta ("
    + "schema_hash TEXT NOT NULL PRIMARY KEY,"
    + "built_at TEXT NOT NULL"
    + ")",
  "CREATE TABLE IF NOT EXISTS authority_state ("
    + "id INTEGER PRIMARY KEY CHECK (id = 1),"
    + "auth_epoch INTEGER NOT NULL CHECK (auth_epoch > 0),"
    + "updated_at TEXT NOT NULL"
    + ")",
  "INSERT OR IGNORE INTO authority_state (id, auth_epoch, updated_at) "
    + "VALUES (1, 1, '1970-01-01T00:00:00.000Z')",
  "CREATE TABLE IF NOT EXISTS pairing_grants ("
    + "id TEXT PRIMARY KEY,"
    + "code_hash TEXT NOT NULL,"
    + "device_name TEXT NOT NULL,"
    + "capabilities_json TEXT NOT NULL,"
    + "credential_ttl_ms INTEGER NOT NULL CHECK (credential_ttl_ms > 0),"
    + "auth_epoch INTEGER NOT NULL,"
    + "created_at TEXT NOT NULL,"
    + "expires_at TEXT NOT NULL,"
    + "max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),"
    + "failed_attempts INTEGER NOT NULL DEFAULT 0,"
    + "consumed_at TEXT"
    + ")",
  "CREATE TABLE IF NOT EXISTS devices ("
    + "id TEXT PRIMARY KEY,"
    + "name TEXT NOT NULL,"
    + "capabilities_json TEXT NOT NULL,"
    + "credential_ttl_ms INTEGER NOT NULL CHECK (credential_ttl_ms > 0),"
    + "auth_epoch INTEGER NOT NULL,"
    + "created_at TEXT NOT NULL,"
    + "last_used_at TEXT,"
    + "rotated_at TEXT,"
    + "revoked_at TEXT"
    + ")",
  "CREATE TABLE IF NOT EXISTS device_credentials ("
    + "id TEXT PRIMARY KEY,"
    + "device_id TEXT NOT NULL REFERENCES devices(id),"
    + "secret_hash TEXT NOT NULL,"
    + "csrf_hash TEXT NOT NULL,"
    + "auth_epoch INTEGER NOT NULL,"
    + "created_at TEXT NOT NULL,"
    + "expires_at TEXT NOT NULL,"
    + "last_used_at TEXT,"
    + "rotated_at TEXT,"
    + "revoked_at TEXT"
    + ")",
  "CREATE INDEX IF NOT EXISTS pairing_grants_by_expiry "
    + "ON pairing_grants(consumed_at, expires_at)",
  "CREATE INDEX IF NOT EXISTS devices_by_revoked "
    + "ON devices(revoked_at, created_at)",
  "CREATE INDEX IF NOT EXISTS device_credentials_by_device "
    + "ON device_credentials(device_id, created_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS one_active_credential_per_device "
    + "ON device_credentials(device_id) WHERE rotated_at IS NULL AND revoked_at IS NULL",
]);

const SHAPES: ReadonlyArray<SqliteTableShape> = Object.freeze([
  { table: "device_authority_meta", columns: ["schema_hash", "built_at"] },
  { table: "authority_state", columns: ["id", "auth_epoch", "updated_at"] },
  {
    table: "pairing_grants",
    columns: [
      "id", "code_hash", "capabilities_json", "auth_epoch", "created_at",
      "device_name", "credential_ttl_ms", "expires_at", "max_attempts",
      "failed_attempts", "consumed_at",
    ],
  },
  {
    table: "devices",
    columns: [
      "id", "name", "capabilities_json", "credential_ttl_ms", "auth_epoch",
      "created_at", "last_used_at", "rotated_at", "revoked_at",
    ],
  },
  {
    table: "device_credentials",
    columns: [
      "id", "device_id", "secret_hash", "csrf_hash", "auth_epoch",
      "created_at", "expires_at", "last_used_at", "rotated_at", "revoked_at",
    ],
  },
]);

type PairingRow = {
  readonly id: string;
  readonly code_hash: string;
  readonly device_name: string;
  readonly capabilities_json: string;
  readonly credential_ttl_ms: number;
  readonly auth_epoch: number;
  readonly created_at: string;
  readonly expires_at: string;
  readonly max_attempts: number;
  readonly failed_attempts: number;
  readonly consumed_at: string | null;
};

type DeviceRow = {
  readonly id: string;
  readonly name: string;
  readonly capabilities_json: string;
  readonly credential_ttl_ms: number;
  readonly auth_epoch: number;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly rotated_at: string | null;
  readonly revoked_at: string | null;
};

type CredentialRow = {
  readonly id: string;
  readonly device_id: string;
  readonly secret_hash: string;
  readonly csrf_hash: string;
  readonly auth_epoch: number;
  readonly created_at: string;
  readonly expires_at: string;
  readonly last_used_at: string | null;
  readonly rotated_at: string | null;
  readonly revoked_at: string | null;
};

export type DeviceRecord = {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ReadonlyArray<Capability>;
  readonly credentialExpiresAt: string;
  readonly authEpoch: number;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly rotatedAt: string | null;
  readonly revokedAt: string | null;
};

export type MintPairingResult =
  | {
      readonly kind: "minted";
      readonly pairingCode: string;
      readonly expiresAt: string;
      readonly authEpoch: number;
    }
  | { readonly kind: "invalid"; readonly message: string };

export type PairingExchangeResult =
  | {
      readonly kind: "paired";
      readonly device: DeviceRecord;
      readonly credential: string;
      readonly credentialId: string;
      readonly credentialExpiresAt: string;
      readonly csrfSecret: string;
    }
  | {
      readonly kind: "invalid" | "expired" | "limited" | "consumed" | "epoch-invalid";
    };

export type AuthenticateResult =
  | {
      readonly kind: "authenticated";
      readonly actorId: "owner";
      readonly credentialId: string;
      readonly device: DeviceRecord;
    }
  | {
      readonly kind: "invalid" | "revoked" | "expired" | "epoch-invalid" | "csrf-invalid";
    };

export type RevokeDeviceResult =
  | { readonly kind: "revoked"; readonly device: DeviceRecord }
  | { readonly kind: "not-found" | "already-revoked" };

export type RotateDeviceCredentialResult =
  | {
      readonly kind: "rotated";
      readonly device: DeviceRecord;
      readonly credential: string;
      readonly credentialId: string;
      readonly credentialExpiresAt: string;
      readonly csrfSecret: string;
    }
  | { readonly kind: "not-found" | "revoked" | "expired" | "epoch-invalid" };

export type DeviceAuthority = {
  readonly schemaHash: string;
  readonly authEpoch: () => number;
  readonly mintPairingGrant: (input: {
    readonly deviceName: string;
    readonly capabilities: ReadonlyArray<Capability>;
    readonly now?: Date;
    readonly ttlMs?: number;
    readonly credentialTtlMs?: number;
    readonly maxAttempts?: number;
  }) => MintPairingResult;
  readonly exchangePairingCode: (input: {
    readonly pairingCode: string;
    readonly now?: Date;
  }) => PairingExchangeResult;
  readonly authenticate: (input: {
    readonly credential: string;
    readonly csrfSecret?: string;
    readonly requireCsrf?: boolean;
    readonly now?: Date;
  }) => AuthenticateResult;
  readonly revokeDevice: (input: { readonly deviceId: string; readonly now?: Date }) => RevokeDeviceResult;
  readonly rotateDeviceCredential: (input: { readonly deviceId: string; readonly now?: Date }) => RotateDeviceCredentialResult;
  readonly invalidateAll: (input?: { readonly now?: Date }) => { readonly authEpoch: number };
  readonly listDevices: () => ReadonlyArray<DeviceRecord>;
  readonly close: () => void;
};

export type OpenDeviceAuthorityResult = {
  readonly authority: DeviceAuthority;
  readonly migration: "fresh" | "ok";
};

export type DeviceAuthorityOpenError = StoreOpenError;

export async function openDeviceAuthority(input: {
  readonly path: string;
  readonly credentialTtlMs?: number;
}): Promise<Result<OpenDeviceAuthorityResult, DeviceAuthorityOpenError>> {
  const defaultCredentialTtlMs = input.credentialTtlMs ?? DEFAULT_CREDENTIAL_TTL_MS;
  if (!validTtl(defaultCredentialTtlMs)) {
    throw new RangeError("credentialTtlMs must be a positive finite number");
  }
  const opened = openSimpleStore({
    path: input.path,
    metaTable: "device_authority_meta",
    ddl: DDL,
    currentHash: computeDeviceAuthoritySchemaHash(),
    shapes: SHAPES,
    policy: { kind: "refuse" },
    foreignKeys: true,
  });
  if (!opened.ok) return err(opened.error);
  const { raw, schemaHash, migration } = opened.value;
  const authority: DeviceAuthority = Object.freeze({
    schemaHash,
    authEpoch: () => readAuthEpoch(raw),
    mintPairingGrant: (mintInput) => mintPairingGrant(raw, mintInput, defaultCredentialTtlMs),
    exchangePairingCode: (exchangeInput) => exchangePairingCode(raw, exchangeInput),
    authenticate: (authInput) => authenticate(raw, authInput),
    revokeDevice: (revokeInput) => revokeDevice(raw, revokeInput),
    rotateDeviceCredential: (rotateInput) => rotateDeviceCredential(raw, rotateInput),
    invalidateAll: (invalidateInput = {}) => invalidateAll(raw, invalidateInput),
    listDevices: () => listDevices(raw),
    close: () => raw.close(),
  });
  return ok(Object.freeze({
    authority,
    migration: migration === "fresh" ? "fresh" : "ok",
  }));
}

export function computeDeviceAuthoritySchemaHash(): string {
  return computeDdlHash(DDL);
}

function mintPairingGrant(
  db: Database,
  input: Parameters<DeviceAuthority["mintPairingGrant"]>[0],
  defaultCredentialTtlMs: number,
): MintPairingResult {
  const deviceName = normalizeDeviceName(input.deviceName);
  if (deviceName === null) {
    return { kind: "invalid", message: "deviceName must be 1-80 single-line characters" };
  }
  const capabilities = normalizeCapabilities(input.capabilities);
  if (capabilities === null) {
    return { kind: "invalid", message: "capabilities must be a non-empty unique supported set" };
  }
  const ttlMs = input.ttlMs ?? DEFAULT_PAIRING_TTL_MS;
  const credentialTtlMs = input.credentialTtlMs ?? defaultCredentialTtlMs;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_PAIRING_ATTEMPTS;
  if (!validTtl(ttlMs)) {
    return { kind: "invalid", message: "ttlMs must be positive" };
  }
  if (!validTtl(credentialTtlMs)) {
    return { kind: "invalid", message: "credentialTtlMs must be positive" };
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    return { kind: "invalid", message: "maxAttempts must be a positive integer" };
  }
  const now = input.now ?? new Date();
  const id = randomBytes(12).toString("base64url");
  const secret = randomBytes(24).toString("base64url");
  const pairingCode = `${PAIRING_PREFIX}.${id}.${secret}`;
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  return immediateTransaction(db, () => {
    const authEpoch = readAuthEpoch(db);
    db.query(
      "INSERT INTO pairing_grants "
        + "(id, code_hash, device_name, capabilities_json, credential_ttl_ms, "
        + "auth_epoch, created_at, expires_at, max_attempts, failed_attempts) "
        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
    ).run(
      id,
      secretHash(secret),
      deviceName,
      JSON.stringify(capabilities),
      credentialTtlMs,
      authEpoch,
      now.toISOString(),
      expiresAt,
      maxAttempts,
    );
    return Object.freeze({ kind: "minted" as const, pairingCode, expiresAt, authEpoch });
  });
}

function exchangePairingCode(
  db: Database,
  input: Parameters<DeviceAuthority["exchangePairingCode"]>[0],
): PairingExchangeResult {
  const parsed = parsePairingCode(input.pairingCode);
  if (parsed === null) return { kind: "invalid" };
  const now = input.now ?? new Date();

  return immediateTransaction(db, () => {
    const row = db.query<PairingRow, [string]>(
      "SELECT * FROM pairing_grants WHERE id = ?",
    ).get(parsed.id);
    if (row === null || !hashesMatch(row.code_hash, secretHash(parsed.secret))) {
      if (row !== null && row.consumed_at === null && row.failed_attempts < row.max_attempts) {
        db.query("UPDATE pairing_grants SET failed_attempts = failed_attempts + 1 WHERE id = ?")
          .run(parsed.id);
        const attempts = row.failed_attempts + 1;
        return { kind: attempts >= row.max_attempts ? "limited" : "invalid" };
      }
      return { kind: "invalid" };
    }
    if (row.consumed_at !== null) return { kind: "consumed" };
    if (row.failed_attempts >= row.max_attempts) return { kind: "limited" };
    if (now.getTime() >= Date.parse(row.expires_at)) return { kind: "expired" };
    if (row.auth_epoch !== readAuthEpoch(db)) return { kind: "epoch-invalid" };

    const deviceId = `${DEVICE_PREFIX}_${randomBytes(16).toString("base64url")}`;
    const generated = generateCredential();
    const credentialExpiresAt = new Date(
      now.getTime() + row.credential_ttl_ms,
    ).toISOString();
    const csrfSecret = `${CSRF_PREFIX}.${randomBytes(32).toString("base64url")}`;
    db.query(
      "INSERT INTO devices "
        + "(id, name, capabilities_json, credential_ttl_ms, auth_epoch, created_at) "
        + "VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      deviceId,
      row.device_name,
      row.capabilities_json,
      row.credential_ttl_ms,
      row.auth_epoch,
      now.toISOString(),
    );
    insertCredential(db, {
      id: generated.id,
      deviceId,
      secretHash: secretHash(generated.secret),
      csrfHash: secretHash(csrfSecret),
      authEpoch: row.auth_epoch,
      createdAt: now.toISOString(),
      expiresAt: credentialExpiresAt,
    });
    db.query("UPDATE pairing_grants SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL")
      .run(now.toISOString(), row.id);
    const device = getDevice(db, deviceId);
    if (device === null) throw new Error("paired device row missing after insert");
    return Object.freeze({
      kind: "paired" as const,
      device,
      credential: generated.wire,
      credentialId: generated.id,
      credentialExpiresAt,
      csrfSecret,
    });
  });
}

function authenticate(
  db: Database,
  input: Parameters<DeviceAuthority["authenticate"]>[0],
): AuthenticateResult {
  const parsed = parseCredential(input.credential);
  if (parsed === null) return { kind: "invalid" };
  const now = input.now ?? new Date();
  return immediateTransaction(db, () => {
    const credential = getCredentialRow(db, parsed.id);
    if (credential === null) return { kind: "invalid" };
    if (!hashesMatch(credential.secret_hash, secretHash(parsed.secret))) {
      return { kind: "invalid" };
    }
    const deviceRow = getDeviceRow(db, credential.device_id);
    if (deviceRow === null) return { kind: "invalid" };
    if (deviceRow.revoked_at !== null || credential.revoked_at !== null) {
      return { kind: "revoked" };
    }
    if (credential.rotated_at !== null) return { kind: "invalid" };
    const epoch = readAuthEpoch(db);
    if (deviceRow.auth_epoch !== epoch || credential.auth_epoch !== epoch) {
      return { kind: "epoch-invalid" };
    }
    if (now.getTime() >= Date.parse(credential.expires_at)) {
      return { kind: "expired" };
    }
    if (
      (input.requireCsrf === true && input.csrfSecret === undefined) ||
      (input.csrfSecret !== undefined &&
        !hashesMatch(credential.csrf_hash, secretHash(input.csrfSecret)))
    ) {
      return { kind: "csrf-invalid" };
    }
    const usedAt = now.toISOString();
    db.query("UPDATE device_credentials SET last_used_at = ? WHERE id = ?")
      .run(usedAt, credential.id);
    db.query("UPDATE devices SET last_used_at = ? WHERE id = ?")
      .run(usedAt, deviceRow.id);
    const device = getDevice(db, deviceRow.id);
    if (device === null) return { kind: "invalid" };
    return Object.freeze({
      kind: "authenticated" as const,
      actorId: "owner" as const,
      credentialId: parsed.id,
      device,
    });
  });
}

function revokeDevice(
  db: Database,
  input: Parameters<DeviceAuthority["revokeDevice"]>[0],
): RevokeDeviceResult {
  const revokedAt = (input.now ?? new Date()).toISOString();
  return immediateTransaction(db, () => {
    const row = getDeviceRow(db, input.deviceId);
    if (row === null) return { kind: "not-found" };
    if (row.revoked_at !== null) return { kind: "already-revoked" };
    db.query("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(revokedAt, input.deviceId);
    db.query(
      "UPDATE device_credentials SET revoked_at = ? "
        + "WHERE device_id = ? AND revoked_at IS NULL",
    ).run(revokedAt, input.deviceId);
    const device = getDevice(db, input.deviceId);
    if (device === null) return { kind: "not-found" };
    return Object.freeze({ kind: "revoked" as const, device });
  });
}

function rotateDeviceCredential(
  db: Database,
  input: Parameters<DeviceAuthority["rotateDeviceCredential"]>[0],
): RotateDeviceCredentialResult {
  const now = input.now ?? new Date();
  return immediateTransaction(db, () => {
    const row = getDeviceRow(db, input.deviceId);
    if (row === null) return { kind: "not-found" };
    if (row.revoked_at !== null) return { kind: "revoked" };
    if (row.auth_epoch !== readAuthEpoch(db)) return { kind: "epoch-invalid" };
    const active = getActiveCredential(db, input.deviceId);
    if (active === null) return { kind: "not-found" };
    if (now.getTime() >= Date.parse(active.expires_at)) return { kind: "expired" };

    const generated = generateCredential();
    const csrfSecret = `${CSRF_PREFIX}.${randomBytes(32).toString("base64url")}`;
    const rotatedAt = now.toISOString();
    const credentialExpiresAt = new Date(
      now.getTime() + row.credential_ttl_ms,
    ).toISOString();
    db.query(
      "UPDATE device_credentials SET rotated_at = ? "
        + "WHERE id = ? AND rotated_at IS NULL AND revoked_at IS NULL",
    ).run(rotatedAt, active.id);
    insertCredential(db, {
      id: generated.id,
      deviceId: row.id,
      secretHash: secretHash(generated.secret),
      csrfHash: secretHash(csrfSecret),
      authEpoch: row.auth_epoch,
      createdAt: rotatedAt,
      expiresAt: credentialExpiresAt,
    });
    db.query("UPDATE devices SET rotated_at = ? WHERE id = ?")
      .run(rotatedAt, row.id);
    const device = getDevice(db, input.deviceId);
    if (device === null) return { kind: "not-found" };
    return Object.freeze({
      kind: "rotated" as const,
      device,
      credential: generated.wire,
      credentialId: generated.id,
      credentialExpiresAt,
      csrfSecret,
    });
  });
}

function invalidateAll(
  db: Database,
  input: Parameters<DeviceAuthority["invalidateAll"]>[0] = {},
): { readonly authEpoch: number } {
  const now = input.now ?? new Date();
  return immediateTransaction(db, () => {
    db.query("UPDATE authority_state SET auth_epoch = auth_epoch + 1, updated_at = ? WHERE id = 1")
      .run(now.toISOString());
    return Object.freeze({ authEpoch: readAuthEpoch(db) });
  });
}

function listDevices(db: Database): ReadonlyArray<DeviceRecord> {
  return Object.freeze(db.query<DeviceRow, []>(
    "SELECT * FROM devices ORDER BY created_at, id",
  ).all().map((row) => toDeviceRecord(db, row)));
}

function getDevice(db: Database, id: string): DeviceRecord | null {
  const row = getDeviceRow(db, id);
  return row === null ? null : toDeviceRecord(db, row);
}

function getDeviceRow(db: Database, id: string): DeviceRow | null {
  return db.query<DeviceRow, [string]>("SELECT * FROM devices WHERE id = ?").get(id);
}

function toDeviceRecord(db: Database, row: DeviceRow): DeviceRecord {
  const credential = getActiveCredential(db, row.id) ?? getLatestCredential(db, row.id);
  if (credential === null) throw new Error(`device ${row.id} has no credential history`);
  return Object.freeze({
    id: row.id,
    name: row.name,
    capabilities: Object.freeze(parseCapabilities(row.capabilities_json)),
    credentialExpiresAt: credential.expires_at,
    authEpoch: row.auth_epoch,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    rotatedAt: row.rotated_at,
    revokedAt: row.revoked_at,
  });
}

function getCredentialRow(db: Database, id: string): CredentialRow | null {
  return db.query<CredentialRow, [string]>(
    "SELECT * FROM device_credentials WHERE id = ?",
  ).get(id);
}

function getActiveCredential(db: Database, deviceId: string): CredentialRow | null {
  return db.query<CredentialRow, [string]>(
    "SELECT * FROM device_credentials "
      + "WHERE device_id = ? AND rotated_at IS NULL AND revoked_at IS NULL LIMIT 1",
  ).get(deviceId);
}

function getLatestCredential(db: Database, deviceId: string): CredentialRow | null {
  return db.query<CredentialRow, [string]>(
    "SELECT * FROM device_credentials WHERE device_id = ? ORDER BY rowid DESC LIMIT 1",
  ).get(deviceId);
}

function insertCredential(db: Database, input: {
  readonly id: string;
  readonly deviceId: string;
  readonly secretHash: string;
  readonly csrfHash: string;
  readonly authEpoch: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}): void {
  db.query(
    "INSERT INTO device_credentials "
      + "(id, device_id, secret_hash, csrf_hash, auth_epoch, created_at, expires_at) "
      + "VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    input.id,
    input.deviceId,
    input.secretHash,
    input.csrfHash,
    input.authEpoch,
    input.createdAt,
    input.expiresAt,
  );
}

function immediateTransaction<T>(db: Database, operation: () => T): T {
  db.run("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.run("COMMIT");
    return result;
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

function readAuthEpoch(db: Database): number {
  const row = db.query<{ auth_epoch: number }, []>(
    "SELECT auth_epoch FROM authority_state WHERE id = 1",
  ).get();
  if (row === null) throw new Error("device authority state is missing");
  return row.auth_epoch;
}

function normalizeCapabilities(input: ReadonlyArray<Capability>): Capability[] | null {
  if (input.length === 0 || new Set(input).size !== input.length) return null;
  if (!input.every((capability) => CAPABILITIES.has(capability))) return null;
  return [...input].sort();
}

function parseCapabilities(json: string): Capability[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("invalid stored device capabilities");
  const normalized = normalizeCapabilities(parsed as Capability[]);
  if (normalized === null) throw new Error("invalid stored device capabilities");
  return normalized;
}

function normalizeDeviceName(input: string): string | null {
  const name = input.trim();
  return name.length > 0 && name.length <= 80 && !/[\r\n\0]/.test(name) ? name : null;
}

function parsePairingCode(code: string): { readonly id: string; readonly secret: string } | null {
  const match = /^dome_pair\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{32})$/.exec(code);
  return match === null || match[1] === undefined || match[2] === undefined
    ? null
    : { id: match[1], secret: match[2] };
}

function generateCredential(): {
  readonly id: string;
  readonly secret: string;
  readonly wire: string;
} {
  const id = randomBytes(16).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  return { id, secret, wire: `${CREDENTIAL_PREFIX}.${id}.${secret}` };
}

function parseCredential(
  credential: string,
): { readonly id: string; readonly secret: string } | null {
  const match = /^dome_cred\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(
    credential,
  );
  return match === null || match[1] === undefined || match[2] === undefined
    ? null
    : { id: match[1], secret: match[2] };
}

function validTtl(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= 100 * 365 * 24 * 60 * 60 * 1_000;
}

function secretHash(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function hashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
