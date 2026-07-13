// product-host/home-upgrade-transaction: durable pre-commit upgrade recovery.
// This Module owns the prepare/read/restore lifecycle plus normal-host
// admission inspection. It does not migrate stores, launch candidates, switch
// launchd, or commit an installation selection.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

import { compareStrings } from "../core/compare";
import { inspectExclusiveFileLock } from "../engine/host/file-lock";
import { publishDirectoryExclusive } from "../platform/exclusive-rename";
import {
  readSqliteSchemaHash,
  snapshotSqliteReadonly,
  validateSqliteSnapshot,
} from "../sqlite/snapshot";
import {
  homeInstallationPaths,
  readHomeInstallation,
  releaseRoot,
  type HomeInstallationDeps,
  type HomeInstallationPaths,
} from "./home-installation";
import { verifyHomeArtifact, type HomeArtifactVerifier } from "./home-artifact";
import {
  engageHomeUpgradeBarrier,
  readHomeUpgradeBarrier,
  type HomeUpgradeBarrierOwner,
  withHomeUpgradeBarrierOwnership,
} from "./home-upgrade-barrier";
import { inspectOperationalWriterBarrier } from "../operational-state/writer-barrier";
import { withProductHostOwnership } from "./host-ownership";
import { homeServiceLabelForVault } from "./home-lifecycle";

export const HOME_UPGRADE_TRANSACTION_SCHEMA = "dome.home-upgrade-transaction/v1" as const;

const DATABASES = Object.freeze([
  { name: "answers.db", metaTable: "answers_meta" },
  { name: "proposals.db", metaTable: "proposals_meta" },
  { name: "outbox.db", metaTable: "outbox_meta" },
  { name: "runs.db", metaTable: "ledger_meta" },
  { name: "request-receipts.db", metaTable: "request_receipts_meta" },
  { name: "device-authority.db", metaTable: "device_authority_meta" },
] as const);
const DURABLE_FILES = Object.freeze(["quarantined.json", "product-host-id"] as const);
const SNAPSHOT_NAMES = Object.freeze([
  ...DATABASES.map((entry) => entry.name),
  ...DURABLE_FILES,
] as const);

type UpgradePhase = "prepared" | "restored";

export type HomeUpgradeArtifactEvidence = {
  readonly artifactId: string;
  readonly version: string;
  readonly releasePath: string;
  readonly manifestSha256: string;
};

export type HomeUpgradeSnapshotEntry = {
  readonly name: typeof SNAPSHOT_NAMES[number];
  readonly kind: "sqlite" | "file";
  /** Mode of the original operational-state file, restored with its bytes. */
  readonly present: boolean;
  readonly mode: number | null;
  readonly size: number | null;
  readonly sha256: string | null;
  readonly schemaHash: string | null;
};

export type HomeUpgradeFileEvidence = {
  readonly path: string;
  readonly mode: number;
  readonly size: number;
  readonly sha256: string;
};

export type HomeUpgradeTransaction = {
  readonly schema: typeof HOME_UPGRADE_TRANSACTION_SCHEMA;
  readonly vault: string;
  readonly transactionId: string;
  readonly phase: UpgradePhase;
  readonly old: HomeUpgradeArtifactEvidence;
  readonly candidate: HomeUpgradeArtifactEvidence;
  readonly selectors: {
    readonly installation: HomeUpgradeFileEvidence;
    readonly plist: HomeUpgradeFileEvidence;
  };
  readonly snapshot: {
    readonly root: "snapshot";
    readonly inventory: ReadonlyArray<HomeUpgradeSnapshotEntry>;
  };
  readonly timestamps: {
    readonly preparedAt: string;
    readonly restoredAt: string | null;
  };
};

export type HomeUpgradeTransactionDeps = HomeInstallationDeps & {
  readonly platform?: NodeJS.Platform | undefined;
  readonly now?: (() => Date) | undefined;
  readonly publishTransaction?: ((source: string, target: string) => Promise<void>) | undefined;
  readonly launchAgentsDir?: string | undefined;
  readonly afterRestoreEntry?: ((name: typeof SNAPSHOT_NAMES[number]) => Promise<void>) | undefined;
};

/**
 * Snapshot the exact durable rollback inventory while owning both host locks.
 * `transactionId` is caller-stable so a crash before publication can be
 * retried against (and only against) its own private staging directory.
 */
export async function prepareHomeUpgrade(input: {
  readonly vaultPath: string;
  readonly transactionId: string;
  readonly candidateArtifactId: string;
}, deps: HomeUpgradeTransactionDeps = {}): Promise<HomeUpgradeTransaction> {
  assertTransactionId(input.transactionId);
  assertSha(input.candidateArtifactId, "candidate artifact id");
  const vault = await canonicalVault(input.vaultPath);
  const existing = await readHomeUpgrade(vault, deps);
  validateMatchingPrepare(existing, input);
  if (existing?.phase === "restored") return existing;
  await engageForTransaction(vault, input.transactionId, deps);
  return runPreparedOwnership(input, vault, deps);
}

async function runPreparedOwnership(
  input: {
    readonly transactionId: string;
    readonly candidateArtifactId: string;
  },
  vault: string,
  deps: HomeUpgradeTransactionDeps,
): Promise<HomeUpgradeTransaction> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ownership = await withHomeUpgradeBarrierOwnership({
      vaultPath: vault,
      transactionId: input.transactionId,
    }, deps, async (owner) => {
      const current = await readHomeUpgrade(vault, deps);
      validateMatchingPrepare(current, input);
      if (current !== null) return Object.freeze({ kind: "prepared" as const, value: current });
      try {
        const prepared = await withQuiescedOwnership(
          vault,
          async () => prepareHomeUpgradeWhileQuiesced(input, vault, deps),
        );
        return Object.freeze({ kind: "prepared" as const, value: prepared });
      } catch (prepareError) {
        try {
          await owner.release(async () => {
            if (await readHomeUpgrade(vault, deps) !== null) {
              throw new Error("an upgrade transaction was published before prepare failed");
            }
          });
        } catch (releaseError) {
          throw new AggregateError(
            [prepareError, releaseError],
            "Dome Home upgrade preparation failed and write admission remains closed for recovery",
          );
        }
        return Object.freeze({ kind: "aborted" as const, error: prepareError });
      }
    });
    if (ownership.kind === "owned") {
      if (ownership.value.kind === "aborted") throw ownership.value.error;
      return ownership.value.value;
    }

    const current = await readHomeUpgrade(vault, deps);
    validateMatchingPrepare(current, input);
    if (current?.phase === "restored") return current;
    if (ownership.transactionId !== null) {
      throw new Error(`another Dome Home upgrade transaction is active: ${ownership.transactionId}`);
    }
    await engageForTransaction(vault, input.transactionId, deps);
  }
  throw new Error("Dome Home upgrade writer ownership could not be recovered");
}

function validateMatchingPrepare(
  current: HomeUpgradeTransaction | null,
  input: { readonly transactionId: string; readonly candidateArtifactId: string },
): void {
  if (
    current !== null &&
    (current.transactionId !== input.transactionId ||
      current.candidate.artifactId !== input.candidateArtifactId)
  ) {
    throw new Error(`another Dome Home upgrade transaction is active: ${current.transactionId}`);
  }
}

async function engageForTransaction(
  vault: string,
  transactionId: string,
  deps: HomeUpgradeTransactionDeps,
): Promise<void> {
  await engageHomeUpgradeBarrier({
    vaultPath: vault,
    transactionId,
    now: deps.now?.() ?? new Date(),
  }, deps);
}

async function prepareHomeUpgradeWhileQuiesced(
  input: {
    readonly transactionId: string;
    readonly candidateArtifactId: string;
  },
  vault: string,
  deps: HomeUpgradeTransactionDeps,
): Promise<HomeUpgradeTransaction> {
  const paths = homeInstallationPaths(vault, deps);
  const layout = await ensureUpgradeLayout(paths);
  const staging = join(layout.upgrade, `.staging-${input.transactionId}`);
  await clearOwnedStaging(staging);
  await mkdir(staging, { mode: 0o700 });
  await chmod(staging, 0o700);
  const snapshotRoot = join(staging, "snapshot");
  await mkdir(snapshotRoot, { mode: 0o700 });

  try {
    const installation = await readHomeInstallation(vault, deps);
    if (installation === null) throw new Error("Dome Home upgrade requires an installed release");
    const selectors = Object.freeze({
      installation: await fileEvidence(paths.record, "installation.json"),
      plist: await fileEvidence(homePlistPath(vault, deps), "Dome Home launchd plist"),
    });
    const verify = deps.verifyArtifact ?? verifyHomeArtifact;
    const old = await artifactEvidence(paths, installation.artifact.id, verify);
    if (old.version !== installation.artifact.version) {
      throw new Error("installed release version disagrees with installation.json");
    }
    const candidate = await artifactEvidence(paths, input.candidateArtifactId, verify);
    if (candidate.artifactId === old.artifactId) {
      throw new Error("Dome Home upgrade candidate must differ from the selected release");
    }

    const inventory = await snapshotDurableState(vault, snapshotRoot);
    const preparedAt = (deps.now?.() ?? new Date()).toISOString();
    assertTimestamp(preparedAt, "prepared timestamp");
    const journal: HomeUpgradeTransaction = Object.freeze({
      schema: HOME_UPGRADE_TRANSACTION_SCHEMA,
      vault,
      transactionId: input.transactionId,
      phase: "prepared" as const,
      old,
      candidate,
      selectors,
      snapshot: Object.freeze({ root: "snapshot" as const, inventory }),
      timestamps: Object.freeze({ preparedAt, restoredAt: null }),
    });
    await writePrivateJson(join(staging, "journal.json"), journal, true);
    await fsyncTree(staging);
    const publish = deps.publishTransaction ?? ((source: string, target: string) =>
      publishDirectoryExclusive({
        source,
        target,
        ...(deps.platform === undefined ? {} : { platform: deps.platform }),
      }));
    await publish(staging, layout.active);
    await fsyncDirectory(layout.upgrade);
    return await readRequiredHomeUpgrade(vault, deps);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Strict, non-mutating read of the one active transaction and its inventory. */
export async function readHomeUpgrade(
  vaultPath: string,
  deps: HomeUpgradeTransactionDeps = {},
): Promise<HomeUpgradeTransaction | null> {
  const vault = await canonicalVault(vaultPath);
  const paths = homeInstallationPaths(vault, deps);
  const upgrade = await inspectUpgradeAncestors(paths);
  if (upgrade === null) return null;
  const active = join(upgrade, "active");
  if (!await present(active)) return null;
  const journal = await readBoundedJournal(active, vault);
  await validateJournalReferences(journal, paths, deps);
  await validateSnapshotInventory(active, journal.snapshot.inventory);
  return journal;
}

/**
 * Restore only a transaction still before installation selection. Every
 * durable store/file is replaced from the retained snapshot; Git and Markdown
 * are never inspected or written. Recovery evidence remains in `active`.
 */
export async function restoreHomeUpgrade(
  vaultPath: string,
  deps: HomeUpgradeTransactionDeps = {},
): Promise<HomeUpgradeTransaction> {
  const vault = await canonicalVault(vaultPath);
  const initial = await readRequiredRestoreHomeUpgrade(vault, deps);
  if (initial.phase === "restored") {
    await finishTerminalRestore(vault, initial, deps);
    return initial;
  }
  await engageForTransaction(vault, initial.transactionId, deps);
  return runRestoreOwnership(vault, initial, deps);
}

async function runRestoreOwnership(
  vault: string,
  initial: HomeUpgradeTransaction,
  deps: HomeUpgradeTransactionDeps,
): Promise<HomeUpgradeTransaction> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ownership = await withHomeUpgradeBarrierOwnership({
      vaultPath: vault,
      transactionId: initial.transactionId,
    }, deps, async (owner) => {
      await assertActiveHomeBarrier(vault, owner, deps);
      const restored = await withQuiescedOwnership(vault, async () => {
        const journal = await readRequiredRestoreHomeUpgrade(vault, deps);
        // Terminal rollback is non-replayable. A later legitimate N-1 write must
        // never be erased by an idempotence retry or stale operator invocation.
        if (journal.phase === "restored") return journal;
        const installation = await readHomeInstallation(vault, deps);
        if (installation === null || installation.artifact.id !== journal.old.artifactId ||
          installation.artifact.version !== journal.old.version) {
          throw new Error("restore is refused after installation selection changed");
        }
        const paths = homeInstallationPaths(vault, deps);
        await assertFileEvidence(journal.selectors.installation, paths.record, "installation.json");
        await assertFileEvidence(journal.selectors.plist, homePlistPath(vault, deps), "Dome Home launchd plist");
        const old = await artifactEvidence(paths, journal.old.artifactId, deps.verifyArtifact ?? verifyHomeArtifact);
        if (JSON.stringify(old) !== JSON.stringify(journal.old)) {
          throw new Error("selected N-1 release evidence changed before restore");
        }
        const state = join(vault, ".dome", "state");
        await assertDirectDirectory(state, "vault operational-state root");
        const snapshotRoot = join(paths.installations, "upgrade", "active", journal.snapshot.root);

        // Corrupt or absent candidate databases are recoverable. Redirected or
        // special target objects are not: reject all of them before the first
        // replacement so rollback cannot traverse attacker-controlled paths.
        for (const entry of journal.snapshot.inventory) {
          const target = join(state, entry.name);
          await rejectRedirectedIfPresent(target, `current ${entry.name}`);
          if (entry.kind === "sqlite") {
            await rejectRedirectedIfPresent(`${target}-wal`, `current ${entry.name}-wal`);
            await rejectRedirectedIfPresent(`${target}-shm`, `current ${entry.name}-shm`);
          }
        }
        for (const entry of journal.snapshot.inventory) {
          const source = join(snapshotRoot, entry.name);
          const target = join(state, entry.name);
          if (!entry.present) {
            await rm(target, { force: true });
            await fsyncDirectory(state);
            await deps.afterRestoreEntry?.(entry.name);
            continue;
          }
          const temporary = join(state, `.${entry.name}.restore-${journal.transactionId}`);
          await clearOwnedRestoreTemporary(temporary);
          await copyFile(source, temporary, constants.COPYFILE_EXCL);
          await chmod(temporary, entry.mode ?? 0o600);
          await fsyncFile(temporary);
          await rename(temporary, target);
          if (entry.kind === "sqlite") {
            await rm(`${target}-wal`, { force: true });
            await rm(`${target}-shm`, { force: true });
          }
          await fsyncFile(target);
          await fsyncDirectory(state);
          await deps.afterRestoreEntry?.(entry.name);
        }
        await fsyncDirectory(state);

        for (const database of DATABASES) {
          const entry = journal.snapshot.inventory.find((candidate) => candidate.name === database.name)!;
          const target = join(state, database.name);
          await validateSqliteSnapshot(target);
          if (await readSqliteSchemaHash(target, database.metaTable) !== entry.schemaHash) {
            throw new Error(`restored SQLite schema evidence changed: ${database.name}`);
          }
          if (await hashFile(target) !== entry.sha256) throw new Error(`restored SQLite bytes changed: ${database.name}`);
        }
        for (const name of DURABLE_FILES) {
          const entry = journal.snapshot.inventory.find((candidate) => candidate.name === name)!;
          if (!entry.present) {
            if (await present(join(state, name))) throw new Error(`absent N-1 file survived restore: ${name}`);
          } else if (await hashFile(join(state, name)) !== entry.sha256) throw new Error(`restored file bytes changed: ${name}`);
        }

        const restoredAt = journal.timestamps.restoredAt ?? (deps.now?.() ?? new Date()).toISOString();
        assertTimestamp(restoredAt, "restored timestamp");
        const restored: HomeUpgradeTransaction = Object.freeze({
          ...journal,
          phase: "restored" as const,
          timestamps: Object.freeze({ ...journal.timestamps, restoredAt }),
        });
        await replaceJournal(join(paths.installations, "upgrade", "active", "journal.json"), restored);
        return await readRequiredRestoreHomeUpgrade(vault, deps);
      });
      await owner.release(async () => {
        const terminal = await readRequiredRestoreHomeUpgrade(vault, deps);
        if (terminal.phase !== "restored" || terminal.transactionId !== restored.transactionId) {
          throw new Error("Dome Home upgrade is not durably restored");
        }
      });
      return restored;
    });
    if (ownership.kind === "owned") return ownership.value;

    const current = await readRequiredRestoreHomeUpgrade(vault, deps);
    if (current.phase === "restored") {
      await finishTerminalRestore(vault, current, deps);
      return current;
    }
    if (current.transactionId !== initial.transactionId || ownership.transactionId !== null) {
      throw new Error("another Dome Home upgrade transaction owns write admission");
    }
    await engageForTransaction(vault, initial.transactionId, deps);
  }
  throw new Error("Dome Home restore writer ownership could not be recovered");
}

async function finishTerminalRestore(
  vault: string,
  terminal: HomeUpgradeTransaction,
  deps: HomeUpgradeTransactionDeps,
): Promise<void> {
  const inspection = await inspectOperationalWriterBarrier(vault);
  const marker = await readHomeUpgradeBarrier(vault, deps);
  if (!inspection.blocked) {
    if (marker !== null) {
      throw new Error("terminal Dome Home upgrade has an orphaned external writer marker");
    }
    return;
  }
  if (
    inspection.transactionId !== terminal.transactionId ||
    inspection.blockedAt === null ||
    (marker !== null &&
      (marker.transactionId !== terminal.transactionId || marker.engagedAt !== inspection.blockedAt))
  ) {
    throw new Error("terminal Dome Home upgrade writer evidence does not match");
  }

  const ownership = await withHomeUpgradeBarrierOwnership({
    vaultPath: vault,
    transactionId: terminal.transactionId,
  }, deps, async (owner) => {
    const current = await readRequiredRestoreHomeUpgrade(vault, deps);
    if (current.phase !== "restored" || current.transactionId !== terminal.transactionId) {
      throw new Error("Dome Home upgrade is not durably restored");
    }
    const currentMarker = await readHomeUpgradeBarrier(vault, deps);
    if (
      currentMarker !== null &&
      (currentMarker.transactionId !== owner.transactionId ||
        currentMarker.engagedAt !== owner.engagedAt)
    ) {
      throw new Error("terminal Dome Home upgrade writer evidence changed");
    }
    await owner.release(async () => {
      const validated = await readRequiredRestoreHomeUpgrade(vault, deps);
      if (validated.phase !== "restored" || validated.transactionId !== terminal.transactionId) {
        throw new Error("Dome Home upgrade is not durably restored");
      }
    });
  });
  if (ownership.kind === "not-owned") {
    const after = await inspectOperationalWriterBarrier(vault);
    const afterMarker = await readHomeUpgradeBarrier(vault, deps);
    if (after.blocked || afterMarker !== null) {
      throw new Error("terminal Dome Home upgrade writer release raced with another owner");
    }
  }
}

async function assertActiveHomeBarrier(
  vault: string,
  owner: HomeUpgradeBarrierOwner,
  deps: HomeUpgradeTransactionDeps,
): Promise<void> {
  const marker = await readHomeUpgradeBarrier(vault, deps);
  if (
    marker === null || marker.transactionId !== owner.transactionId ||
    marker.engagedAt !== owner.engagedAt
  ) {
    throw new Error("active Dome Home upgrade writer evidence does not match");
  }
}

/**
 * Normal Home calls this after ownership but before any mutable opener. A
 * valid completed rollback may start N-1; every pre-commit, unknown, corrupt,
 * or selector-diverged state remains write-admission closed.
 */
export async function inspectHomeUpgradeAdmission(
  vaultPath: string,
  deps: HomeUpgradeTransactionDeps = {},
): Promise<{ readonly admitted: true } | { readonly admitted: false; readonly reason: string }> {
  const vault = await canonicalVault(vaultPath);
  const paths = homeInstallationPaths(vault, deps);
  try {
    const upgrade = await inspectUpgradeAncestors(paths);
    if (upgrade === null) return Object.freeze({ admitted: true as const });
    const active = join(upgrade, "active");
    if (!await present(active)) return Object.freeze({ admitted: true as const });
    const journal = await readBoundedJournal(active, vault);
    if (journal.phase !== "restored") {
      return Object.freeze({ admitted: false as const, reason: `upgrade transaction is ${journal.phase}` });
    }
    const installation = await readHomeInstallation(vault, deps);
    if (installation === null || installation.artifact.id !== journal.old.artifactId ||
      installation.artifact.version !== journal.old.version) {
      return Object.freeze({ admitted: false as const, reason: "restored upgrade selector is not N-1" });
    }
    if (journal.old.releasePath !== releaseRoot(paths, journal.old.artifactId)) throw new Error("N-1 release path is not canonical");
    await assertDirectDirectory(journal.old.releasePath, "N-1 managed release");
    const oldManifest = join(journal.old.releasePath, "manifest.json");
    await assertRegular(oldManifest, "N-1 managed release manifest");
    if (await hashFile(oldManifest) !== journal.old.manifestSha256) throw new Error("N-1 release manifest changed");
    await assertFileEvidence(journal.selectors.installation, paths.record, "installation.json");
    await assertFileEvidence(journal.selectors.plist, homePlistPath(vault, deps), "Dome Home launchd plist");
    return Object.freeze({ admitted: true as const });
  } catch (error) {
    return Object.freeze({
      admitted: false as const,
      reason: `upgrade recovery evidence is invalid: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function readBoundedJournal(active: string, vault: string): Promise<HomeUpgradeTransaction> {
  await assertDirectDirectory(active, "upgrade transaction root");
  const rootNames = (await readdir(active)).sort(compareStrings);
  if (JSON.stringify(rootNames) !== JSON.stringify(["journal.json", "snapshot"])) {
    throw new Error("Dome Home upgrade transaction has an unknown or missing root entry");
  }
  await assertDirectDirectory(join(active, "snapshot"), "upgrade snapshot root");
  const journalPath = join(active, "journal.json");
  const info = await lstat(journalPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) {
    throw new Error("Dome Home upgrade journal is not a bounded regular file");
  }
  let value: unknown;
  try { value = JSON.parse(await readFile(journalPath, "utf8")); }
  catch { throw new Error("Dome Home upgrade journal is corrupt"); }
  return parseJournal(value, vault);
}

async function inspectUpgradeAncestors(paths: HomeInstallationPaths): Promise<string | null> {
  const chain = [paths.root, dirname(paths.installations), paths.installations, join(paths.installations, "upgrade")];
  for (const path of chain) {
    if (!await present(path)) return null;
    await assertDirectDirectory(path, "managed Dome Home admission path");
  }
  return chain.at(-1) ?? null;
}

async function withQuiescedOwnership<T>(
  vault: string,
  operation: () => Promise<T>,
): Promise<T> {
  const localLock = join(vault, ".dome", "state", "locks", "product-host.lock");
  const before = await inspectExclusiveFileLock(localLock);
  if (before.kind === "possibly-live") throw new Error("Dome Home is not quiesced; Product Host ownership may be live");
  const owned = await withProductHostOwnership(vault, operation);
  if (owned.kind === "busy") throw new Error("Dome Home is not quiesced; Product Host ownership is busy");
  return owned.value;
}

async function ensureUpgradeLayout(paths: HomeInstallationPaths): Promise<{ readonly upgrade: string; readonly active: string }> {
  const installParent = dirname(paths.installations);
  for (const path of [paths.root, installParent, paths.installations]) await ensureDirectOwnedDirectory(path);
  const upgrade = join(paths.installations, "upgrade");
  await ensureDirectOwnedDirectory(upgrade);
  await chmod(upgrade, 0o700);
  return Object.freeze({ upgrade, active: join(upgrade, "active") });
}

async function artifactEvidence(
  paths: HomeInstallationPaths,
  artifactId: string,
  verify: HomeArtifactVerifier,
): Promise<HomeUpgradeArtifactEvidence> {
  const root = releaseRoot(paths, artifactId);
  await assertDirectDirectory(root, "managed release");
  await assertRegular(join(root, "manifest.json"), "managed release manifest");
  const manifest = await verify(root);
  if (manifest.artifact.id !== artifactId) throw new Error("managed release artifact identity changed");
  if (manifest.writerBarrier?.protocol !== 1) {
    throw new Error("managed release is ineligible for upgrade: writer-barrier protocol 1 is required");
  }
  return Object.freeze({
    artifactId,
    version: manifest.product.version,
    releasePath: root,
    manifestSha256: await hashFile(join(root, "manifest.json")),
  });
}

async function validateJournalReferences(
  journal: HomeUpgradeTransaction,
  paths: HomeInstallationPaths,
  deps: HomeUpgradeTransactionDeps,
): Promise<void> {
  for (const artifact of [journal.old, journal.candidate]) {
    await validateArtifactReference(artifact, paths);
  }
  await validateSelectorReferences(journal, paths, deps);
}

async function validateRestoreJournalReferences(
  journal: HomeUpgradeTransaction,
  paths: HomeInstallationPaths,
  deps: HomeUpgradeTransactionDeps,
): Promise<void> {
  await validateArtifactReference(journal.old, paths);
  validateCanonicalArtifactPath(journal.candidate, paths);
  await validateSelectorReferences(journal, paths, deps);
}

async function validateArtifactReference(
  artifact: HomeUpgradeArtifactEvidence,
  paths: HomeInstallationPaths,
): Promise<void> {
  validateCanonicalArtifactPath(artifact, paths);
  const expected = artifact.releasePath;
  await assertDirectDirectory(expected, "managed release");
  const manifest = join(expected, "manifest.json");
  await assertRegular(manifest, "managed release manifest");
  if (await hashFile(manifest) !== artifact.manifestSha256) throw new Error("upgrade journal artifact manifest changed");
}

function validateCanonicalArtifactPath(
  artifact: HomeUpgradeArtifactEvidence,
  paths: HomeInstallationPaths,
): void {
  const expected = releaseRoot(paths, artifact.artifactId);
  if (artifact.releasePath !== expected) throw new Error("upgrade journal release path is not canonical");
}

async function validateSelectorReferences(
  journal: HomeUpgradeTransaction,
  paths: HomeInstallationPaths,
  deps: HomeUpgradeTransactionDeps,
): Promise<void> {
  await assertFileEvidence(journal.selectors.installation, paths.record, "installation.json");
  await assertFileEvidence(journal.selectors.plist, homePlistPath(journal.vault, deps), "Dome Home launchd plist");
}

async function snapshotDurableState(vault: string, snapshotRoot: string): Promise<ReadonlyArray<HomeUpgradeSnapshotEntry>> {
  const state = join(vault, ".dome", "state");
  await assertDirectDirectory(state, "vault operational-state root");
  const inventory: HomeUpgradeSnapshotEntry[] = [];
  for (const database of DATABASES) {
    const source = join(state, database.name);
    const sourceInfo = await assertRegular(source, database.name);
    const destination = join(snapshotRoot, database.name);
    await snapshotSqliteReadonly({ source, destination });
    await chmod(destination, 0o600);
    inventory.push(Object.freeze({
      name: database.name,
      kind: "sqlite" as const,
      present: true,
      mode: sourceInfo.mode & 0o777,
      size: (await lstat(destination)).size,
      sha256: await hashFile(destination),
      schemaHash: await readSqliteSchemaHash(destination, database.metaTable),
    }));
  }
  for (const name of DURABLE_FILES) {
    const source = join(state, name);
    if (!await present(source)) {
      inventory.push(Object.freeze({
        name,
        kind: "file" as const,
        present: false,
        mode: null,
        size: null,
        sha256: null,
        schemaHash: null,
      }));
      continue;
    }
    const sourceInfo = await assertRegular(source, name);
    await validateDurableFile(name, source);
    const destination = join(snapshotRoot, name);
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    await chmod(destination, 0o600);
    inventory.push(Object.freeze({
      name,
      kind: "file" as const,
      present: true,
      mode: sourceInfo.mode & 0o777,
      size: (await lstat(destination)).size,
      sha256: await hashFile(destination),
      schemaHash: null,
    }));
  }
  return Object.freeze(inventory);
}

async function validateSnapshotInventory(active: string, inventory: ReadonlyArray<HomeUpgradeSnapshotEntry>): Promise<void> {
  const snapshot = join(active, "snapshot");
  await assertDirectDirectory(snapshot, "upgrade snapshot root");
  const names = (await readdir(snapshot)).sort(compareStrings);
  const expected = inventory.filter((entry) => entry.present).map((entry) => entry.name).sort(compareStrings);
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error("upgrade snapshot inventory is not closed");
  for (const entry of inventory) {
    if (!entry.present) continue;
    const path = join(snapshot, entry.name);
    const info = await assertRegular(path, `snapshot ${entry.name}`);
    if ((info.mode & 0o777) !== 0o600 || info.size !== entry.size || await hashFile(path) !== entry.sha256) {
      throw new Error(`upgrade snapshot evidence changed: ${entry.name}`);
    }
    if (entry.kind === "sqlite") {
      const spec = DATABASES.find((candidate) => candidate.name === entry.name)!;
      await validateSqliteSnapshot(path);
      if (await readSqliteSchemaHash(path, spec.metaTable) !== entry.schemaHash) {
        throw new Error(`upgrade snapshot schema evidence changed: ${entry.name}`);
      }
    } else await validateDurableFile(entry.name as typeof DURABLE_FILES[number], path);
  }
}

function parseJournal(value: unknown, expectedVault: string): HomeUpgradeTransaction {
  const root = exactRecord(value, "upgrade journal", [
    "schema", "vault", "transactionId", "phase", "old", "candidate", "selectors", "snapshot", "timestamps",
  ]);
  if (root["schema"] !== HOME_UPGRADE_TRANSACTION_SCHEMA || root["vault"] !== expectedVault ||
    (root["phase"] !== "prepared" && root["phase"] !== "restored")) {
    throw new Error("Dome Home upgrade journal has invalid fixed fields or unknown phase");
  }
  assertTransactionId(root["transactionId"]);
  const old = parseArtifact(root["old"], "old artifact");
  const candidate = parseArtifact(root["candidate"], "candidate artifact");
  if (old.artifactId === candidate.artifactId) throw new Error("upgrade journal artifacts are not distinct");
  const selectorsValue = exactRecord(root["selectors"], "upgrade selectors", ["installation", "plist"]);
  const selectors = Object.freeze({
    installation: parseFileEvidence(selectorsValue["installation"], "installation selector"),
    plist: parseFileEvidence(selectorsValue["plist"], "plist selector"),
  });
  const snapshot = exactRecord(root["snapshot"], "upgrade snapshot", ["root", "inventory"]);
  if (snapshot["root"] !== "snapshot" || !Array.isArray(snapshot["inventory"]) || snapshot["inventory"].length !== SNAPSHOT_NAMES.length) {
    throw new Error("upgrade journal snapshot inventory is invalid");
  }
  const inventory = snapshot["inventory"].map(parseSnapshotEntry);
  if (JSON.stringify(inventory.map((entry) => entry.name)) !== JSON.stringify(SNAPSHOT_NAMES)) {
    throw new Error("upgrade journal snapshot inventory is not canonical");
  }
  const timestamps = exactRecord(root["timestamps"], "upgrade timestamps", ["preparedAt", "restoredAt"]);
  assertTimestamp(timestamps["preparedAt"], "prepared timestamp");
  if (timestamps["restoredAt"] !== null) assertTimestamp(timestamps["restoredAt"], "restored timestamp");
  if ((root["phase"] === "prepared") !== (timestamps["restoredAt"] === null)) {
    throw new Error("upgrade journal phase evidence is inconsistent");
  }
  return Object.freeze({
    schema: HOME_UPGRADE_TRANSACTION_SCHEMA,
    vault: expectedVault,
    transactionId: root["transactionId"] as string,
    phase: root["phase"] as UpgradePhase,
    old,
    candidate,
    selectors,
    snapshot: Object.freeze({ root: "snapshot", inventory: Object.freeze(inventory) }),
    timestamps: Object.freeze({
      preparedAt: timestamps["preparedAt"] as string,
      restoredAt: timestamps["restoredAt"] as string | null,
    }),
  });
}

function parseFileEvidence(value: unknown, label: string): HomeUpgradeFileEvidence {
  const evidence = exactRecord(value, label, ["path", "mode", "size", "sha256"]);
  if (typeof evidence["path"] !== "string" || !evidence["path"].startsWith("/") ||
    !Number.isInteger(evidence["mode"]) || (evidence["mode"] as number) < 0 || (evidence["mode"] as number) > 0o777 ||
    !Number.isSafeInteger(evidence["size"]) || (evidence["size"] as number) < 0) {
    throw new Error(`${label} has invalid fixed fields`);
  }
  assertSha(evidence["sha256"], `${label} hash`);
  return Object.freeze(evidence as unknown as HomeUpgradeFileEvidence);
}

function parseArtifact(value: unknown, label: string): HomeUpgradeArtifactEvidence {
  const artifact = exactRecord(value, label, ["artifactId", "version", "releasePath", "manifestSha256"]);
  assertSha(artifact["artifactId"], `${label} id`);
  assertSha(artifact["manifestSha256"], `${label} manifest hash`);
  if (typeof artifact["version"] !== "string" || artifact["version"].length === 0 || artifact["version"].length > 1024 ||
    typeof artifact["releasePath"] !== "string" || !isAbsolute(artifact["releasePath"]) ||
    resolve(artifact["releasePath"]) !== artifact["releasePath"]) {
    throw new Error(`${label} evidence is invalid`);
  }
  return Object.freeze(artifact as unknown as HomeUpgradeArtifactEvidence);
}

function parseSnapshotEntry(value: unknown): HomeUpgradeSnapshotEntry {
  const entry = exactRecord(value, "upgrade snapshot entry", ["name", "kind", "present", "mode", "size", "sha256", "schemaHash"]);
  if (!SNAPSHOT_NAMES.includes(entry["name"] as typeof SNAPSHOT_NAMES[number]) ||
    (entry["kind"] !== "sqlite" && entry["kind"] !== "file") ||
    typeof entry["present"] !== "boolean") {
    throw new Error("upgrade snapshot entry fixed fields are invalid");
  }
  const isDatabase = DATABASES.some((candidate) => candidate.name === entry["name"]);
  if (isDatabase && entry["present"] !== true) throw new Error("upgrade SQLite snapshot must be present");
  if (entry["present"] === true) {
    if (!Number.isInteger(entry["mode"]) || (entry["mode"] as number) < 0 || (entry["mode"] as number) > 0o777 ||
      !Number.isSafeInteger(entry["size"]) || (entry["size"] as number) < 0) {
      throw new Error("upgrade snapshot entry metadata is invalid");
    }
    assertSha(entry["sha256"], "upgrade snapshot hash");
  } else if (entry["mode"] !== null || entry["size"] !== null || entry["sha256"] !== null) {
    throw new Error("absent upgrade snapshot entry carries file evidence");
  }
  if (isDatabase !== (entry["kind"] === "sqlite") ||
    (isDatabase ? !isSha(entry["schemaHash"]) : entry["schemaHash"] !== null)) {
    throw new Error("upgrade snapshot schema evidence is invalid");
  }
  return Object.freeze(entry as unknown as HomeUpgradeSnapshotEntry);
}

async function validateDurableFile(name: typeof DURABLE_FILES[number], path: string): Promise<void> {
  const info = await assertRegular(path, name);
  if (info.size > 16 * 1024 * 1024) throw new Error(`durable file exceeds its size budget: ${name}`);
  if (name === "quarantined.json") {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(path, "utf8")); }
    catch { throw new Error("quarantined.json is corrupt"); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("quarantined.json is not an object");
  } else {
    const id = (await readFile(path, "utf8")).trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("product-host-id is malformed");
  }
}

async function replaceJournal(path: string, journal: HomeUpgradeTransaction): Promise<void> {
  const active = dirname(path);
  const upgrade = dirname(active);
  // A crash may leave this exact sibling behind. It is outside active's
  // closed inventory, so readers and rollback remain usable; retry replaces
  // only its own transaction-scoped debris.
  const temporary = join(upgrade, `.journal-${journal.transactionId}.tmp`);
  await rm(temporary, { force: true });
  try {
    await writePrivateJson(temporary, journal, true);
    await rename(temporary, path);
    await fsyncDirectory(active);
    await fsyncDirectory(upgrade);
  } finally {
    await rm(temporary, { force: true });
    await fsyncDirectory(upgrade);
  }
}

async function fileEvidence(path: string, label: string): Promise<HomeUpgradeFileEvidence> {
  const info = await assertRegular(path, label);
  return Object.freeze({ path, mode: info.mode & 0o777, size: info.size, sha256: await hashFile(path) });
}

async function assertFileEvidence(evidence: HomeUpgradeFileEvidence, path: string, label: string): Promise<void> {
  if (evidence.path !== path) throw new Error(`${label} path changed`);
  const current = await fileEvidence(path, label);
  if (JSON.stringify(current) !== JSON.stringify(evidence)) throw new Error(`${label} evidence changed`);
}

function homePlistPath(vault: string, deps: HomeUpgradeTransactionDeps): string {
  const launchAgents = resolve(deps.launchAgentsDir ?? join(homedir(), "Library", "LaunchAgents"));
  return join(launchAgents, `${homeServiceLabelForVault(vault)}.plist`);
}

async function writePrivateJson(path: string, value: unknown, exclusive: boolean): Promise<void> {
  const handle = await open(path, exclusive ? "wx" : "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  await chmod(path, 0o600);
}

async function clearOwnedStaging(path: string): Promise<void> {
  if (!await present(path)) return;
  await assertDirectDirectory(path, "upgrade staging directory");
  await rm(path, { recursive: true });
}

async function clearOwnedRestoreTemporary(path: string): Promise<void> {
  if (!await present(path)) return;
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`restore temporary is redirected or special: ${path}`);
  await rm(path);
}

async function readRequiredHomeUpgrade(vault: string, deps: HomeUpgradeTransactionDeps): Promise<HomeUpgradeTransaction> {
  const journal = await readHomeUpgrade(vault, deps);
  if (journal === null) throw new Error("no prepared Dome Home upgrade transaction exists");
  return journal;
}

async function readRequiredRestoreHomeUpgrade(
  vault: string,
  deps: HomeUpgradeTransactionDeps,
): Promise<HomeUpgradeTransaction> {
  const paths = homeInstallationPaths(vault, deps);
  const upgrade = await inspectUpgradeAncestors(paths);
  if (upgrade === null) throw new Error("no prepared Dome Home upgrade transaction exists");
  const active = join(upgrade, "active");
  if (!await present(active)) throw new Error("no prepared Dome Home upgrade transaction exists");
  const journal = await readBoundedJournal(active, vault);
  await validateRestoreJournalReferences(journal, paths, deps);
  await validateSnapshotInventory(active, journal.snapshot.inventory);
  return journal;
}

async function canonicalVault(path: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  await assertDirectDirectory(canonical, "vault root");
  return canonical;
}

async function ensureDirectOwnedDirectory(path: string): Promise<void> {
  let created = false;
  if (!await present(path)) {
    const parent = dirname(path);
    if (parent === path) throw new Error(`managed Dome Home directory cannot be created: ${path}`);
    await ensureDirectOwnedDirectory(parent);
    await mkdir(path, { mode: 0o700 });
    created = true;
  }
  await assertDirectDirectory(path, "managed Dome Home directory");
  if (created) {
    await fsyncDirectory(path);
    await fsyncDirectory(dirname(path));
  }
}

async function assertDirectDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) {
    throw new Error(`${label} is not a direct owned directory: ${path}`);
  }
}

async function assertRegular(path: string, label: string): Promise<{ readonly mode: number; readonly size: number }> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} is not a regular file: ${path}`);
  return { mode: Number(info.mode), size: Number(info.size) };
}

async function rejectRedirectedIfPresent(path: string, label: string): Promise<void> {
  if (!await present(path)) return;
  await assertRegular(path, label);
}

async function fsyncTree(root: string): Promise<void> {
  const directories: string[] = [];
  async function visit(path: string): Promise<void> {
    directories.push(path);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const info = await lstat(child);
      if (info.isDirectory()) await visit(child);
      else if (info.isFile()) await fsyncFile(child);
      else throw new Error(`upgrade staging contains a special entry: ${child}`);
    }
  }
  await visit(root);
  for (const directory of directories.reverse()) await fsyncDirectory(directory);
}

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function hashFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, offset);
      if (read.bytesRead === 0) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
  } finally { await handle.close(); }
  return hash.digest("hex");
}

function exactRecord(value: unknown, label: string, expectedKeys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort(compareStrings);
  const expected = [...expectedKeys].sort(compareStrings);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} has unknown or missing fields`);
  return value as Record<string, unknown>;
}

function assertTransactionId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("upgrade transaction id must be a UUID");
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} is invalid`);
  }
}

function assertSha(value: unknown, label: string): asserts value is string {
  if (!isSha(value)) throw new Error(`${label} is invalid`);
}
function isSha(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
async function present(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
