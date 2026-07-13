/**
 * One-shot N-1 fixture freezer and the much smaller read-only fixture consumer.
 *
 * Regeneration is intentionally not part of CI. `freezeN1Fixture` refuses an
 * existing release directory, proves the six schema sources still equal the
 * pinned Git commit, creates stores through their real openers, and then emits
 * readable canonical SQL. Tests call only `materializeFrozenN1Fixture`.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { computeAnswersSchemaHash, openAnswersDb } from "../../../../src/answers/db";
import { computeDeviceAuthoritySchemaHash, openDeviceAuthority } from "../../../../src/device-authority/device-authority";
import { computeLedgerSchemaHash, openLedgerDb } from "../../../../src/ledger/db";
import { computeOutboxSchemaHash, openOutboxDb } from "../../../../src/outbox/db";
import { computeProposalsSchemaHash, openProposalsDb } from "../../../../src/proposals/db";
import { computeRequestReceiptsSchemaHash, openRequestReceiptsDb } from "../../../../src/request-receipts/db";

export const FROZEN_N1_SOURCE_COMMIT = "eb644dc29b37cbc0c964f8cffc5329a95cad49ba";
export const FROZEN_N1_RELEASE = "0.1.0-eb644dc2";
export const FROZEN_N1_SCHEMA = "dome.home-upgrade-n1-fixture/v1";

const FIXED_AT = "2026-07-13T12:00:00.000Z";
const SOURCE_FILES = Object.freeze([
  "src/answers/db.ts",
  "src/proposals/db.ts",
  "src/outbox/db.ts",
  "src/ledger/db.ts",
  "src/request-receipts/db.ts",
  "src/device-authority/device-authority.ts",
] as const);
const SOURCE_SHA256 = Object.freeze([
  "25c4bf6ba34200dc52f6009e81e4a33ce92fae60c251b14e12722521823e548f",
  "feae08a13feaa353079e17a3af955109b7ce759fb5063c306b6a72e1440750b8",
  "b6ffd047947efc0707e829b479ab3e72eed1c589b608272bf80f6fa8c13065a8",
  "4c7a7b8a63a0000124b2c240b754abd1f80afdcb482d53bb3015bb7e130ca662",
  "21a076dbc8daaf47cfee12f5fe7a928b9048737efbe3d5adf1d190fd970f4cc6",
  "a9e5b47c87690bc21ee7925d902506622c817b75c00fa82201455dcf0ac14c89",
] as const);

const STORES = Object.freeze([
  { name: "answers", file: "answers.sql", db: "answers.db", metaTable: "answers_meta", hash: computeAnswersSchemaHash },
  { name: "proposals", file: "proposals.sql", db: "proposals.db", metaTable: "proposals_meta", hash: computeProposalsSchemaHash },
  { name: "outbox", file: "outbox.sql", db: "outbox.db", metaTable: "outbox_meta", hash: computeOutboxSchemaHash },
  { name: "runs", file: "runs.sql", db: "runs.db", metaTable: "ledger_meta", hash: computeLedgerSchemaHash },
  { name: "request-receipts", file: "request-receipts.sql", db: "request-receipts.db", metaTable: "request_receipts_meta", hash: computeRequestReceiptsSchemaHash },
  { name: "device-authority", file: "device-authority.sql", db: "device-authority.db", metaTable: "device_authority_meta", hash: computeDeviceAuthoritySchemaHash },
] as const);

const BASELINE_HASHES = Object.freeze({
  answers: "0f7cdd246ffd6808d0b11ee32a5e9db4bd43b0993e649da9e470bf668249f846",
  proposals: "fb6a917d7b417aaa5a8d0cee444408feb42c73b407b24844cc94f3d570fdb795",
  outbox: "124240475db9210aefeff676c93fe17ac38476bcc4824ca4f42b65f473e682ca",
  runs: "ae374b71e876fec8aa01ad0bb5b83d9931c6e8d0f1d90615571182dec6cde243",
  "request-receipts": "286a2bebc2214df1c383b952dcc2b3f12699a5874c169952c16a074c56c55a9d",
  "device-authority": "1df75738feaf4dfdb74e36c2158018fdbeedff17305f17f6b5fe97f4c0855523",
} as const);

export type FrozenN1Manifest = Readonly<{
  schema: typeof FROZEN_N1_SCHEMA;
  releaseId: string;
  sourceCommit: string;
  productVersion: string;
  runtime: Readonly<{ bun: string; sqlite: string }>;
  sourceFiles: ReadonlyArray<Readonly<{ path: string; sha256: string }>>;
  stores: ReadonlyArray<Readonly<{
    name: typeof STORES[number]["name"];
    sql: string;
    sqlSha256: string;
    metaTable: string;
    schemaHash: string;
    schemaInventorySha256: string;
    canarySha256: string;
  }>>;
  closedSchemaInventorySha256: string;
  canaryDigest: string;
  authorityCanary: Readonly<{
    activeDeviceId: string;
    activeCredential: string;
    activeCsrf: string;
    revokedDeviceId: string;
    revokedCredential: string;
    revokedCsrf: string;
  }>;
}>;

/** Create a new immutable release fixture. Existing output is never replaced. */
export async function freezeN1Fixture(input: {
  readonly repoRoot: string;
  readonly outputRoot: string;
}): Promise<FrozenN1Manifest> {
  const repoRoot = resolve(input.repoRoot);
  const output = resolve(input.outputRoot, FROZEN_N1_RELEASE);
  await assertAbsent(output);
  await assertFrozenSources(repoRoot);
  assertCompiledHashes();

  const scratch = await mkdtemp(join(tmpdir(), "dome-n1-freeze-"));
  try {
    const authorityCanary = await createAndSeedStores(scratch);
    const staged = join(scratch, "fixture");
    await mkdir(staged, { mode: 0o755 });
    const stores: Array<FrozenN1Manifest["stores"][number]> = [];
    const observations: Array<unknown> = [];
    for (const store of STORES) {
      const source = join(scratch, store.db);
      const sql = dumpCanonicalSql(source);
      const schemaInventorySha256 = sha(canonicalSchemaInventory(source));
      const canary = logicalCanary(source, store.name);
      const canarySha256 = sha(stableJson(canary));
      await writeFile(join(staged, store.file), sql, { flag: "wx", mode: 0o644 });
      await roundTripAndAssert(source, join(scratch, `roundtrip-${store.db}`), sql, store.name);
      stores.push(Object.freeze({
        name: store.name,
        sql: store.file,
        sqlSha256: sha(sql),
        metaTable: store.metaTable,
        schemaHash: store.hash(),
        schemaInventorySha256,
        canarySha256,
      }));
      observations.push(canary);
    }
    const manifest: FrozenN1Manifest = Object.freeze({
      schema: FROZEN_N1_SCHEMA,
      releaseId: FROZEN_N1_RELEASE,
      sourceCommit: FROZEN_N1_SOURCE_COMMIT,
      productVersion: "0.1.0",
      runtime: Object.freeze({ bun: Bun.version, sqlite: sqliteVersion() }),
      sourceFiles: Object.freeze(await Promise.all(SOURCE_FILES.map(async (path) => Object.freeze({
        path,
        sha256: sha(await readFile(join(repoRoot, path))),
      })))),
      stores: Object.freeze(stores),
      closedSchemaInventorySha256: sha(stableJson(stores.map((store) => ({
        name: store.name,
        metaTable: store.metaTable,
        schemaHash: store.schemaHash,
        schemaInventorySha256: store.schemaInventorySha256,
      })))),
      canaryDigest: sha(stableJson(observations)),
      authorityCanary,
    });
    await writeFile(join(staged, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    await mkdir(dirname(output), { recursive: true });
    await copyDirectoryExclusive(staged, output);
    return manifest;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Materialize the six databases exclusively from frozen readable SQL. */
export async function materializeFrozenN1Fixture(input: {
  readonly fixtureRoot: string;
  readonly destination: string;
}): Promise<FrozenN1Manifest> {
  const root = resolve(input.fixtureRoot);
  const manifest = await readFrozenN1Manifest(root);
  await mkdir(input.destination, { recursive: true });
  const existing = await readdir(input.destination);
  if (existing.length !== 0) throw new Error("N-1 materialization destination must be empty");
  for (const store of manifest.stores) {
    const sql = await readFile(join(root, store.sql), "utf8");
    if (sha(sql) !== store.sqlSha256) throw new Error(`frozen N-1 SQL checksum changed: ${store.name}`);
    const target = join(input.destination, `${store.name}.db`);
    const db = new Database(target, { create: true, strict: true });
    try { db.exec(sql); } finally { db.close(); }
    assertMaterializedStore(target, store);
  }
  const observations = manifest.stores.map((store) => logicalCanary(
    join(input.destination, `${store.name}.db`), store.name,
  ));
  if (sha(stableJson(observations)) !== manifest.canaryDigest) {
    throw new Error("frozen N-1 logical canaries changed after materialization");
  }
  return manifest;
}

export async function readFrozenN1Manifest(root: string): Promise<FrozenN1Manifest> {
  const parsed: unknown = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const value = record(parsed, "frozen N-1 manifest");
  exactKeys(value, [
    "schema", "releaseId", "sourceCommit", "productVersion", "runtime",
    "sourceFiles", "stores", "closedSchemaInventorySha256", "canaryDigest", "authorityCanary",
  ], "frozen N-1 manifest");
  if (value["schema"] !== FROZEN_N1_SCHEMA || value["sourceCommit"] !== FROZEN_N1_SOURCE_COMMIT ||
    value["releaseId"] !== FROZEN_N1_RELEASE || value["productVersion"] !== "0.1.0") {
    throw new Error("frozen N-1 manifest identity is invalid");
  }
  hex(value["closedSchemaInventorySha256"], "closed inventory hash");
  hex(value["canaryDigest"], "canary digest");
  const runtime = record(value["runtime"], "frozen N-1 runtime");
  exactKeys(runtime, ["bun", "sqlite"], "frozen N-1 runtime");
  if (runtime["bun"] !== "1.2.13" || runtime["sqlite"] !== "3.51.0") {
    throw new Error("frozen N-1 runtime provenance is invalid");
  }

  const sourceFiles = array(value["sourceFiles"], "frozen N-1 source files");
  if (sourceFiles.length !== SOURCE_FILES.length) throw new Error("frozen N-1 source inventory is not closed");
  sourceFiles.forEach((candidate, index) => {
    const entry = record(candidate, "frozen N-1 source entry");
    exactKeys(entry, ["path", "sha256"], "frozen N-1 source entry");
    if (entry["path"] !== SOURCE_FILES[index]) throw new Error("frozen N-1 source inventory is not closed and sorted");
    if (entry["sha256"] !== SOURCE_SHA256[index]) throw new Error(`frozen N-1 source hash changed: ${SOURCE_FILES[index]}`);
  });

  const stores = array(value["stores"], "frozen N-1 stores");
  if (stores.length !== STORES.length) throw new Error("frozen N-1 manifest store inventory is not closed and sorted");
  stores.forEach((candidate, index) => {
    const entry = record(candidate, "frozen N-1 store entry");
    exactKeys(entry, [
      "name", "sql", "sqlSha256", "metaTable", "schemaHash", "schemaInventorySha256", "canarySha256",
    ], "frozen N-1 store entry");
    const expected = STORES[index];
    if (expected === undefined || entry["name"] !== expected.name || entry["metaTable"] !== expected.metaTable ||
      entry["sql"] !== expected.file) {
      throw new Error("frozen N-1 manifest store inventory is not closed and sorted");
    }
    if (entry["schemaHash"] !== BASELINE_HASHES[expected.name]) throw new Error(`frozen N-1 baseline hash changed: ${expected.name}`);
    hex(entry["sqlSha256"], "SQL hash");
    hex(entry["schemaInventorySha256"], "schema inventory hash");
    hex(entry["canarySha256"], "canary hash");
  });

  const authority = record(value["authorityCanary"], "frozen N-1 authority canary");
  exactKeys(authority, [
    "activeDeviceId", "activeCredential", "activeCsrf",
    "revokedDeviceId", "revokedCredential", "revokedCsrf",
  ], "frozen N-1 authority canary");
  for (const key of ["activeDeviceId", "activeCredential", "activeCsrf", "revokedDeviceId", "revokedCredential", "revokedCsrf"] as const) {
    if (typeof authority[key] !== "string" || !/^[A-Za-z0-9._-]{8,160}$/.test(authority[key])) {
      throw new Error(`frozen N-1 authority canary ${key} is invalid`);
    }
  }

  const typed = value as FrozenN1Manifest;
  if (typed.stores.length !== STORES.length || typed.stores.some((entry, index) =>
    entry.name !== STORES[index]?.name || entry.metaTable !== STORES[index]?.metaTable)) {
    throw new Error("frozen N-1 manifest store inventory is not closed and sorted");
  }
  const closed = sha(stableJson(typed.stores.map((store) => ({
    name: store.name,
    metaTable: store.metaTable,
    schemaHash: store.schemaHash,
    schemaInventorySha256: store.schemaInventorySha256,
  }))));
  if (closed !== typed.closedSchemaInventorySha256) throw new Error("frozen N-1 closed inventory changed");
  return Object.freeze(typed);
}

async function assertFrozenSources(repoRoot: string): Promise<void> {
  for (const path of SOURCE_FILES) {
    const expected = await gitShow(repoRoot, FROZEN_N1_SOURCE_COMMIT, path);
    const actual = await readFile(join(repoRoot, path));
    if (!actual.equals(expected)) throw new Error(`schema source differs from ${FROZEN_N1_SOURCE_COMMIT}: ${path}`);
  }
}

function assertCompiledHashes(): void {
  for (const store of STORES) {
    if (store.hash() !== BASELINE_HASHES[store.name]) {
      throw new Error(`compiled N-1 schema hash changed: ${store.name}`);
    }
  }
}

async function createAndSeedStores(root: string): Promise<FrozenN1Manifest["authorityCanary"]> {
  const answers = await openAnswersDb({ path: join(root, "answers.db") });
  if (!answers.ok) throw new Error(JSON.stringify(answers.error));
  answers.value.db.raw.exec("BEGIN; INSERT INTO question_answers VALUES "
    + "('answer-owner','Keep the launch window','2026-07-13T12:01:00.000Z',1,'Ship?','dome.fixture','1111111111111111111111111111111111111111','owner',NULL,'pending',0,NULL,NULL,NULL),"
    + "('answer-agent','Use the rollback rehearsal','2026-07-13T12:02:00.000Z',2,'How?','dome.fixture','2222222222222222222222222222222222222222','agent','{\"kind\":\"agent\",\"reason\":\"fixture evidence\",\"evidence\":[]}','handled',1,'2026-07-13T12:03:00.000Z','2026-07-13T12:04:00.000Z',NULL); COMMIT;");
  normalizeMeta(answers.value.db.raw, "answers_meta"); answers.value.db.close();

  const proposals = await openProposalsDb({ path: join(root, "proposals.db") });
  if (!proposals.ok) throw new Error(JSON.stringify(proposals.error));
  proposals.value.db.raw.exec("BEGIN; INSERT INTO pending_proposals "
    + "(dedupe_key,processor_id,extension_id,run_id,reason,changes_json,source_refs_json,base_commit,base_contents_json,created_at,status,decided_at,decided_by,applied_commit,note) VALUES "
    + "('proposal-pending','dome.fixture','dome.fixture','run_fixture','pending fixture','[]','[]','3333333333333333333333333333333333333333','{}','2026-07-13T12:05:00.000Z','pending',NULL,NULL,NULL,NULL),"
    + "('proposal-decided','dome.fixture','dome.fixture',NULL,'decided fixture','[]','[]','4444444444444444444444444444444444444444','{}','2026-07-13T12:06:00.000Z','rejected','2026-07-13T12:07:00.000Z','owner',NULL,'not now'); COMMIT;");
  normalizeMeta(proposals.value.db.raw, "proposals_meta"); proposals.value.db.close();

  const outbox = await openOutboxDb({ path: join(root, "outbox.db") });
  if (!outbox.ok) throw new Error(JSON.stringify(outbox.error));
  outbox.value.db.raw.exec("BEGIN; INSERT INTO outbox "
    + "(capability,idempotency_key,payload_json,source_refs,status,external_id,attempts,max_attempts,enqueued_at,next_attempt_at,sent_at,last_error,run_id) VALUES "
    + "('notify.send','outbox-pending','{\"message\":\"pending\"}','[]','pending',NULL,0,3,'2026-07-13T12:08:00.000Z','2026-07-13T12:08:00.000Z',NULL,NULL,'run_fixture'),"
    + "('notify.send','outbox-failed','{\"message\":\"failed\"}','[]','failed',NULL,3,3,'2026-07-13T12:09:00.000Z','2026-07-13T12:10:00.000Z',NULL,'fixture failure','run_fixture'); COMMIT;");
  normalizeMeta(outbox.value.db.raw, "outbox_meta"); outbox.value.db.close();

  const ledger = await openLedgerDb({ path: join(root, "runs.db") });
  if (!ledger.ok) throw new Error(JSON.stringify(ledger.error));
  ledger.value.db.raw.exec("BEGIN; INSERT INTO runs VALUES "
    + "('run_fixture','proposal-pending','dome.fixture','1','garden','5555555555555555555555555555555555555555','6666666666666666666666666666666666666666','succeeded','[\"effect-fixture\"]',0.125,17,NULL,'signal','{\"name\":\"fixture\"}','2026-07-13T12:11:00.000Z','2026-07-13T12:11:01.000Z');"
    + "INSERT INTO capability_uses (run_id,capability,resource,outcome,recorded_at) VALUES "
    + "('run_fixture','vault.read','wiki/fixture.md','allowed','2026-07-13T12:11:00.500Z'); COMMIT;");
  normalizeMeta(ledger.value.db.raw, "ledger_meta"); ledger.value.db.close();

  const receipts = await openRequestReceiptsDb({ path: join(root, "request-receipts.db") });
  if (!receipts.ok) throw new Error(JSON.stringify(receipts.error));
  receipts.value.db.raw.exec("BEGIN; INSERT INTO request_receipts VALUES "
    + "('receipt-admitted','request-a','owner','device-active','credential-active','cookie','host-old','http','capture','workspace-mutation','admitted',NULL,NULL,'none',0,'2026-07-13T12:12:00.000Z',NULL),"
    + "('receipt-succeeded','request-b','owner','device-active','credential-active','cookie','host-old','http','capture','workspace-mutation','succeeded','captured','7777777777777777777777777777777777777777','pending',0,'2026-07-13T12:13:00.000Z','2026-07-13T12:13:01.000Z'),"
    + "('receipt-interrupted','request-c','owner','device-active','credential-active','bearer','host-old','assistant','edit-document','workspace-mutation','interrupted','host-restarted',NULL,'unknown',1,'2026-07-13T12:14:00.000Z','2026-07-13T12:14:01.000Z'); COMMIT;");
  normalizeMeta(receipts.value.db.raw, "request_receipts_meta"); receipts.value.db.close();

  const authority = await openDeviceAuthority({ path: join(root, "device-authority.db") });
  if (!authority.ok) throw new Error(JSON.stringify(authority.error));
  const activeGrant = authority.value.authority.mintPairingGrant({ deviceName: "Active Fixture", capabilities: ["read", "capture"], now: new Date(FIXED_AT) });
  const revokedGrant = authority.value.authority.mintPairingGrant({ deviceName: "Revoked Fixture", capabilities: ["read"], now: new Date(FIXED_AT) });
  const unused = authority.value.authority.mintPairingGrant({ deviceName: "Unused Fixture", capabilities: ["read"], now: new Date(FIXED_AT) });
  if (activeGrant.kind !== "minted" || revokedGrant.kind !== "minted" || unused.kind !== "minted") throw new Error("fixture grant mint failed");
  const active = authority.value.authority.exchangePairingCode({ pairingCode: activeGrant.pairingCode, now: new Date(FIXED_AT) });
  const revoked = authority.value.authority.exchangePairingCode({ pairingCode: revokedGrant.pairingCode, now: new Date(FIXED_AT) });
  if (active.kind !== "paired" || revoked.kind !== "paired") throw new Error("fixture pairing failed");
  if (authority.value.authority.revokeDevice({ deviceId: revoked.device.id, now: new Date("2026-07-13T12:15:00.000Z") }).kind !== "revoked") throw new Error("fixture revoke failed");
  // Public APIs created every authority row; this fixture-only update only
  // makes otherwise wall-clock metadata byte-stable before canonical dumping.
  const authorityRaw = authorityRawDatabase(join(root, "device-authority.db"));
  normalizeMeta(authorityRaw, "device_authority_meta"); authorityRaw.close();
  authority.value.authority.close();
  return Object.freeze({
    activeDeviceId: active.device.id,
    activeCredential: active.credential,
    activeCsrf: active.csrfSecret,
    revokedDeviceId: revoked.device.id,
    revokedCredential: revoked.credential,
    revokedCsrf: revoked.csrfSecret,
  });
}

function authorityRawDatabase(path: string): Database {
  return new Database(path);
}

function normalizeMeta(db: Database, table: string): void {
  db.query(`UPDATE ${table} SET built_at = ?`).run(FIXED_AT);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
}

function dumpCanonicalSql(path: string): string {
  const db = new Database(path, { readonly: true, create: false });
  try {
    const schema = schemaRows(db);
    const tables = schema.filter((row) => row.type === "table");
    const later = schema.filter((row) => row.type !== "table");
    const lines = ["PRAGMA foreign_keys = OFF;", "BEGIN IMMEDIATE;"];
    for (const row of tables) lines.push(`${row.sql};`);
    for (const table of tables) {
      const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${quoteIdentifier(table.name)})`).all().map((row) => row.name);
      const rows = db.query<Record<string, SqlValue>, []>(`SELECT * FROM ${quoteIdentifier(table.name)}`).all()
        .map((row) => columns.map((column) => row[column] ?? null))
        .sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
      for (const row of rows) lines.push(`INSERT INTO ${quoteIdentifier(table.name)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${row.map(sqlLiteral).join(", ")});`);
    }
    for (const row of later) lines.push(`${row.sql};`);
    lines.push("COMMIT;", "");
    return lines.join("\n");
  } finally { db.close(); }
}

function canonicalSchemaInventory(path: string): string {
  const db = new Database(path, { readonly: true, create: false });
  try { return stableJson(schemaRows(db)); } finally { db.close(); }
}

function schemaRows(db: Database): ReadonlyArray<{ type: string; name: string; table: string; sql: string }> {
  return db.query<{ type: string; name: string; tbl_name: string; sql: string }, []>(
    "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' "
      + "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END,name",
  ).all().map((row) => ({ type: row.type, name: row.name, table: row.tbl_name, sql: row.sql }));
}

function logicalCanary(path: string, name: typeof STORES[number]["name"]): unknown {
  const db = new Database(path, { readonly: true, create: false });
  try {
    switch (name) {
      case "answers": return rows(db, "SELECT idempotency_key,answered_by,handler_status FROM question_answers ORDER BY idempotency_key");
      case "proposals": return rows(db, "SELECT dedupe_key,status,decided_by,note FROM pending_proposals ORDER BY dedupe_key");
      case "outbox": return rows(db, "SELECT idempotency_key,status,attempts,last_error FROM outbox ORDER BY idempotency_key");
      case "runs": return { runs: rows(db, "SELECT id,status,effect_hashes_json,cost_usd FROM runs ORDER BY id"), uses: rows(db, "SELECT run_id,capability,resource,outcome FROM capability_uses ORDER BY id") };
      case "request-receipts": return rows(db, "SELECT operation_id,state,result_code,commit_oid,adoption_state,recovery_required FROM request_receipts ORDER BY operation_id");
      case "device-authority": return {
        epoch: rows(db, "SELECT auth_epoch FROM authority_state"),
        devices: rows(db, "SELECT name,revoked_at IS NOT NULL AS revoked FROM devices ORDER BY name"),
        credentials: rows(db, "SELECT d.name,c.revoked_at IS NOT NULL AS revoked,c.rotated_at IS NOT NULL AS rotated FROM device_credentials c JOIN devices d ON d.id=c.device_id ORDER BY d.name,c.created_at,c.id"),
        grants: rows(db, "SELECT device_name,consumed_at IS NOT NULL AS consumed FROM pairing_grants ORDER BY device_name"),
      };
    }
  } finally { db.close(); }
}

function rows(db: Database, sql: string): ReadonlyArray<Record<string, SqlValue>> {
  return db.query<Record<string, SqlValue>, []>(sql).all().map((row) => Object.fromEntries(
    Object.entries(row).sort(([a], [b]) => a.localeCompare(b)),
  ));
}

async function roundTripAndAssert(source: string, target: string, sql: string, name: typeof STORES[number]["name"]): Promise<void> {
  const db = new Database(target, { create: true, strict: true });
  try { db.exec(sql); } finally { db.close(); }
  if (canonicalSchemaInventory(source) !== canonicalSchemaInventory(target)) throw new Error(`N-1 schema round-trip changed: ${name}`);
  if (stableJson(logicalCanary(source, name)) !== stableJson(logicalCanary(target, name))) throw new Error(`N-1 canary round-trip changed: ${name}`);
  assertQuickCheck(target);
}

function assertMaterializedStore(path: string, store: FrozenN1Manifest["stores"][number]): void {
  assertQuickCheck(path);
  if (sha(canonicalSchemaInventory(path)) !== store.schemaInventorySha256) throw new Error(`frozen N-1 schema inventory changed: ${store.name}`);
  const db = new Database(path, { readonly: true, create: false });
  try {
    const values = db.query<{ schema_hash: string }, []>(`SELECT schema_hash FROM ${store.metaTable}`).all();
    if (values.length !== 1 || values[0]?.schema_hash !== store.schemaHash) throw new Error(`frozen N-1 meta hash changed: ${store.name}`);
  } finally { db.close(); }
  if (sha(stableJson(logicalCanary(path, store.name))) !== store.canarySha256) throw new Error(`frozen N-1 canary changed: ${store.name}`);
}

function assertQuickCheck(path: string): void {
  const db = new Database(path, { readonly: true, create: false });
  try {
    const row = db.query<{ quick_check: string }, []>("PRAGMA quick_check").get();
    if (row?.quick_check !== "ok") throw new Error(`SQLite quick_check failed: ${path}`);
  } finally { db.close(); }
}

type SqlValue = string | number | bigint | Uint8Array | null;

function sqlLiteral(value: SqlValue): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("fixture SQL cannot encode non-finite numbers");
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  return `X'${Buffer.from(value).toString("hex")}'`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function array(value: unknown, label: string): ReadonlyArray<unknown> {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}
function exactKeys(value: Record<string, unknown>, expected: ReadonlyArray<string>, label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} has unknown or missing fields`);
}
function hex(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function stableJson(value: unknown): string { return JSON.stringify(sortValue(value)); }
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortValue(child)]),
  );
  if (value instanceof Uint8Array) return { $blob: Buffer.from(value).toString("hex") };
  return value;
}
function sha(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function sqliteVersion(): string {
  const db = new Database(":memory:");
  try { return db.query<{ version: string }, []>("SELECT sqlite_version() AS version").get()?.version ?? "unknown"; } finally { db.close(); }
}

async function gitShow(root: string, commit: string, path: string): Promise<Buffer> {
  const child = Bun.spawn(["git", "show", `${commit}:${path}`], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(stderr.trim() || `git show failed: ${path}`);
  return Buffer.from(stdout);
}

async function assertAbsent(path: string): Promise<void> {
  try { await lstat(path); throw new Error(`frozen release fixture already exists: ${path}`); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
}

async function copyDirectoryExclusive(source: string, target: string): Promise<void> {
  await mkdir(target, { mode: 0o755 });
  try {
    for (const name of await readdir(source)) await copyFile(join(source, name), join(target, name), constants.COPYFILE_EXCL);
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, "../../../..");
  const outputRoot = resolve(import.meta.dir);
  await freezeN1Fixture({ repoRoot, outputRoot });
}
