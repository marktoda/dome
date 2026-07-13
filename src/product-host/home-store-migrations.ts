// Closed durable-store compatibility and migration Module for Dome Home.
// There is one predecessor, one target, and no general migration graph.

import { lstat } from "node:fs/promises";
import { join } from "node:path";

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
import { readSqliteSchemaHash, validateSqliteSnapshot } from "../sqlite/snapshot";

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

/** Read-only, all-six compatibility proof performed before any store mutates. */
export async function preflightHomeStoreMigrations(input: {
  readonly stateRoot: string;
  /** Prepare is stricter: every store must still be the frozen N-1 release. */
  readonly phase: "prepare" | "prepared-retry";
}): Promise<ReadonlyArray<HomeStoreEvidence>> {
  const evidence: HomeStoreEvidence[] = [];
  for (const entry of HOME_STORE_MIGRATIONS) {
    const path = join(input.stateRoot, entry.name);
    await assertDirectDatabase(path, entry.name);
    await validateSqliteSnapshot(path);
    const schemaHash = await readSqliteSchemaHash(path, entry.metaTable);
    const predecessor = entry.migratesFrom.includes(schemaHash);
    const current = schemaHash === entry.currentSchemaHash;
    if (input.phase === "prepare") {
      // Unchanged stores are simultaneously N-1 and current. Changed stores
      // must be the one named predecessor before the journal is published.
      if (!(predecessor || (entry.migratesFrom.length === 0 && current))) {
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

/** Migrate remaining predecessor stores after the prepared journal exists. */
export async function migratePreparedHomeStores(input: {
  readonly stateRoot: string;
  readonly afterStore?: ((name: HomeStoreMigrationEntry["name"]) => Promise<void>) | undefined;
}): Promise<ReadonlyArray<HomeStoreEvidence>> {
  const before = await preflightHomeStoreMigrations({ stateRoot: input.stateRoot, phase: "prepared-retry" });
  for (const evidence of before) {
    if (evidence.state === "current") continue;
    if (evidence.name !== "request-receipts.db") {
      throw new Error(`Home upgrade migration implementation is missing: ${evidence.name}`);
    }
    const migrated = await migrateRequestReceiptsN1({ path: join(input.stateRoot, evidence.name) });
    if (!migrated.ok) throw new Error(`Home upgrade store migration failed: ${evidence.name}: ${migrationError(migrated.error)}`);
    await input.afterStore?.(evidence.name);
  }
  const after = await preflightHomeStoreMigrations({ stateRoot: input.stateRoot, phase: "prepared-retry" });
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
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Home durable store is not a direct regular file: ${name}`);
}
