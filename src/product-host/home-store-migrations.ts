// Closed durable-store compatibility and migration Module for Dome Home.
// There is one predecessor, one target, and no general migration graph.

import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { computeAnswersSchemaHash } from "../answers/db";
import { computeDeviceAuthoritySchemaHash } from "../device-authority/device-authority";
import { computeLedgerSchemaHash } from "../ledger/db";
import { computeOutboxSchemaHash } from "../outbox/db";
import { computeProposalsSchemaHash } from "../proposals/db";
import {
  computeRequestReceiptsSchemaHash,
  migrateRequestReceiptsN1,
  REQUEST_RECEIPTS_N1_SCHEMA_HASH,
} from "../request-receipts/db";
import { readSqliteSchemaHash, snapshotSqliteReadonly, validateSqliteSnapshot } from "../sqlite/snapshot";

export const HOME_DURABLE_STATE_PROTOCOL = 1 as const;

export type HomeStoreMigrationEntry = Readonly<{
  name: "answers.db" | "device-authority.db" | "outbox.db" | "proposals.db" |
    "request-receipts.db" | "runs.db";
  metaTable: "answers_meta" | "device_authority_meta" | "outbox_meta" |
    "proposals_meta" | "request_receipts_meta" | "ledger_meta";
  currentSchemaHash: string;
  migratesFrom: ReadonlyArray<string>;
}>;

export const HOME_STORE_MIGRATIONS: ReadonlyArray<HomeStoreMigrationEntry> = Object.freeze([
  Object.freeze({ name: "answers.db", metaTable: "answers_meta", currentSchemaHash: computeAnswersSchemaHash(), migratesFrom: Object.freeze([]) }),
  Object.freeze({ name: "device-authority.db", metaTable: "device_authority_meta", currentSchemaHash: computeDeviceAuthoritySchemaHash(), migratesFrom: Object.freeze([]) }),
  Object.freeze({ name: "outbox.db", metaTable: "outbox_meta", currentSchemaHash: computeOutboxSchemaHash(), migratesFrom: Object.freeze([]) }),
  Object.freeze({ name: "proposals.db", metaTable: "proposals_meta", currentSchemaHash: computeProposalsSchemaHash(), migratesFrom: Object.freeze([]) }),
  Object.freeze({ name: "request-receipts.db", metaTable: "request_receipts_meta", currentSchemaHash: computeRequestReceiptsSchemaHash(), migratesFrom: Object.freeze([REQUEST_RECEIPTS_N1_SCHEMA_HASH]) }),
  Object.freeze({ name: "runs.db", metaTable: "ledger_meta", currentSchemaHash: computeLedgerSchemaHash(), migratesFrom: Object.freeze([]) }),
]);

export type HomeStoreEvidence = Readonly<{
  name: HomeStoreMigrationEntry["name"];
  schemaHash: string;
  state: "current" | "predecessor";
}>;

/** Verified durable-state inventory from the selected (old) Home artifact. */
export type HomeStoreSelectedInventory = ReadonlyArray<Pick<
  HomeStoreMigrationEntry,
  "name" | "metaTable" | "currentSchemaHash"
>>;

/** Read-only, all-six compatibility proof performed before any store mutates. */
export async function preflightHomeStoreMigrations(input: {
  readonly stateRoot: string;
  /** Empty caller-owned private directory; no scratch state is placed beside the stores. */
  readonly snapshotRoot: string;
  /** Prepare: legacy installs must be frozen N-1; modern installs must match their selected manifest. */
  readonly phase: "prepare" | "prepared-retry";
  /** Prepare-only exact source inventory from the verified selected artifact. */
  readonly selectedStores?: HomeStoreSelectedInventory | undefined;
}): Promise<ReadonlyArray<HomeStoreEvidence>> {
  await assertEmptyPrivateSnapshotRoot(input.snapshotRoot);
  // Prove the entire source file set before copying any of it. SQLite is never
  // opened here: committed WAL is resolved only inside the private copies.
  for (const entry of HOME_STORE_MIGRATIONS) {
    await assertDirectDatabase(join(input.stateRoot, entry.name), entry.name);
  }
  for (const entry of HOME_STORE_MIGRATIONS) {
    await snapshotSqliteReadonly({
      source: join(input.stateRoot, entry.name),
      destination: join(input.snapshotRoot, entry.name),
    });
  }
  return await inspectHomeStoreSnapshots({
    snapshotRoot: input.snapshotRoot,
    phase: input.phase,
    selectedStores: input.selectedStores,
  });
}

async function assertEmptyPrivateSnapshotRoot(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 ||
    await realpath(path) !== resolve(path)) {
    throw new Error("Home migration preflight root is not a direct private directory");
  }
  if ((await readdir(path)).length !== 0) {
    throw new Error("Home migration preflight root is not empty");
  }
}

/** Inspect rollback snapshots that the prepare transaction already made private and standalone. */
export async function preflightHomeStoreSnapshots(input: {
  readonly snapshotRoot: string;
  readonly phase: "prepare" | "prepared-retry";
  readonly selectedStores?: HomeStoreSelectedInventory | undefined;
}): Promise<ReadonlyArray<HomeStoreEvidence>> {
  return await inspectHomeStoreSnapshots(input);
}

async function inspectHomeStoreSnapshots(input: {
  readonly snapshotRoot: string;
  readonly phase: "prepare" | "prepared-retry";
  readonly selectedStores?: HomeStoreSelectedInventory | undefined;
}): Promise<ReadonlyArray<HomeStoreEvidence>> {
  const selectedStores = input.phase === "prepare" && input.selectedStores !== undefined
    ? validateSelectedInventory(input.selectedStores)
    : null;
  const evidence: HomeStoreEvidence[] = [];
  for (const [index, entry] of HOME_STORE_MIGRATIONS.entries()) {
    const path = join(input.snapshotRoot, entry.name);
    await assertDirectDatabase(path, entry.name);
    await validateSqliteSnapshot(path);
    const schemaHash = await readSqliteSchemaHash(path, entry.metaTable);
    const predecessor = entry.migratesFrom.includes(schemaHash);
    const current = schemaHash === entry.currentSchemaHash;
    if (input.phase === "prepare") {
      if (selectedStores !== null) {
        // A modern sequential upgrade is safe only when all six snapshots
        // exactly match the verified selected release. Candidate compatibility
        // remains a separate proof after this source-state proof.
        if (schemaHash !== selectedStores[index]!.currentSchemaHash) {
          throw new Error(`Home upgrade snapshot differs from selected release schema: ${entry.name}`);
        }
        if (!predecessor && !current) {
          throw new Error(`Home upgrade has no durable-state route for ${entry.name}: ${schemaHash}`);
        }
      // Legacy selected artifacts have no durable-state inventory. Preserve
      // the frozen N-1 rule so an unjournaled partial migration stays closed.
      } else if (!(predecessor || (entry.migratesFrom.length === 0 && current))) {
        throw new Error(`Home upgrade prepare requires exact N-1 schema: ${entry.name}`);
      }
    } else if (!predecessor && !current) {
      throw new Error(`Home upgrade has no durable-state route for ${entry.name}: ${schemaHash}`);
    }
    evidence.push(Object.freeze({
      name: entry.name,
      schemaHash,
      state: predecessor ? "predecessor" as const : "current" as const,
    }));
  }
  return Object.freeze(evidence);
}

function validateSelectedInventory(
  stores: HomeStoreSelectedInventory,
): HomeStoreSelectedInventory {
  if (stores.length !== HOME_STORE_MIGRATIONS.length ||
    !HOME_STORE_MIGRATIONS.every((expected, index) => {
      const actual = stores[index];
      return actual?.name === expected.name && actual.metaTable === expected.metaTable &&
        /^[0-9a-f]{64}$/.test(actual.currentSchemaHash);
    })) {
    throw new Error("selected Home durable-state inventory is invalid");
  }
  return stores;
}

/** Migrate remaining predecessor stores after the prepared journal exists. */
export async function migratePreparedHomeStores(input: {
  readonly stateRoot: string;
  /** Empty deterministic private directory owned and cleaned by the upgrade transaction. */
  readonly preflightRoot: string;
  readonly afterStore?: ((name: HomeStoreMigrationEntry["name"]) => Promise<void>) | undefined;
}): Promise<ReadonlyArray<HomeStoreEvidence>> {
  const beforeRoot = join(input.preflightRoot, "before");
  await mkdir(beforeRoot, { mode: 0o700 });
  const before = await preflightHomeStoreMigrations({
    stateRoot: input.stateRoot,
    snapshotRoot: beforeRoot,
    phase: "prepared-retry",
  });
  for (const evidence of before) {
    if (evidence.state === "current") continue;
    if (evidence.name !== "request-receipts.db") {
      throw new Error(`Home upgrade migration implementation is missing: ${evidence.name}`);
    }
    const migrated = await migrateRequestReceiptsN1({ path: join(input.stateRoot, evidence.name) });
    if (!migrated.ok) throw new Error(`Home upgrade store migration failed: ${evidence.name}: ${migrationError(migrated.error)}`);
    await input.afterStore?.(evidence.name);
  }
  const afterRoot = join(input.preflightRoot, "after");
  await mkdir(afterRoot, { mode: 0o700 });
  const after = await preflightHomeStoreMigrations({
    stateRoot: input.stateRoot,
    snapshotRoot: afterRoot,
    phase: "prepared-retry",
  });
  for (const evidence of after) {
    if (evidence.state !== "current") throw new Error(`Home upgrade store did not reach its target schema: ${evidence.name}`);
  }
  return after;
}

function migrationError(error: { readonly kind: string; readonly cause?: string }): string {
  return error.cause === undefined ? error.kind : `${error.kind}: ${error.cause}`;
}

async function assertDirectDatabase(path: string, name: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`Home durable store is not a direct regular file: ${name}`);
  }
}
