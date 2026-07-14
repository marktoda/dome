// product-host/home-upgrade-transaction: durable pre-commit upgrade recovery.
// This Module owns prepare/read/migrate/restore plus normal-host admission
// inspection. Migration remains private and write-closed; it does not launch
// candidates, switch launchd, or commit an installation selection.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod, copyFile, lstat, mkdir, open, opendir, readFile, readdir, realpath, rename, rm,
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
import {
  captureHomeSelection,
  captureHomeSelectionDocument,
  classifyHomeSelection,
  publishHomeSelectionDocument,
  renderHomeSelection,
  selectionDocument,
  type HomeSelection,
  type HomeSelectionDocument,
} from "./home-selection";
import { readVaultId } from "./vault-id";
import { verifyHomeArtifact, type HomeArtifactVerifier } from "./home-artifact";
import {
  HOME_DURABLE_STATE_PROTOCOL,
  HOME_STORE_MIGRATIONS,
  migratePreparedHomeStores,
  preflightHomeStoreMigrations,
  preflightHomeStoreSnapshots,
  type HomeStoreMigrationEntry,
} from "./home-store-migrations";
import {
  engageHomeUpgradeBarrier,
  readHomeUpgradeBarrier,
  type HomeUpgradeBarrierOwner,
  withHomeUpgradeBarrierOwnership,
} from "./home-upgrade-barrier";
import { inspectOperationalWriterBarrier } from "../operational-state/writer-barrier";
import { withProductHostOwnership } from "./host-ownership";
import { homeServiceLabelForVault } from "./home-lifecycle";
import {
  inspectHomeLifecycleSuspension,
  type HomeLifecycleSuspensionInspection,
} from "./home-lifecycle-suspension";

const HOME_UPGRADE_TRANSACTION_SCHEMA_V1 = "dome.home-upgrade-transaction/v1" as const;
export const HOME_UPGRADE_TRANSACTION_SCHEMA = "dome.home-upgrade-transaction/v2" as const;

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

type UpgradePhase = "prepared" | "switching" | "committed" | "restored";

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

export type HomeUpgradeStoredSelectionDocument = HomeUpgradeFileEvidence & {
  readonly stored: "selectors/old-installation.json" | "selectors/old.plist" |
    "selectors/candidate-installation.json" | "selectors/candidate.plist";
};

export type HomeUpgradeSelectionEvidence = {
  readonly old: {
    readonly installation: HomeUpgradeStoredSelectionDocument;
    readonly plist: HomeUpgradeStoredSelectionDocument;
  };
  readonly candidate: {
    readonly installation: HomeUpgradeStoredSelectionDocument;
    readonly plist: HomeUpgradeStoredSelectionDocument;
  };
};

export type HomeUpgradeProbationProof = {
  readonly schema: "dome.home-upgrade-probation-proof/v1";
  readonly transactionId: string;
  readonly readinessSchema: "dome.product.readiness/v1";
  readonly hostState: "probation";
  readonly artifactId: string;
  readonly productVersion: string;
  readonly vaultId: string;
  readonly writesAdmitted: false;
  readonly provenAt: string;
};

export type HomeUpgradeTransaction = {
  readonly schema: typeof HOME_UPGRADE_TRANSACTION_SCHEMA | typeof HOME_UPGRADE_TRANSACTION_SCHEMA_V1;
  readonly vault: string;
  readonly transactionId: string;
  readonly phase: UpgradePhase;
  readonly old: HomeUpgradeArtifactEvidence;
  readonly candidate: HomeUpgradeArtifactEvidence;
  readonly selectors: {
    readonly installation: HomeUpgradeFileEvidence;
    readonly plist: HomeUpgradeFileEvidence;
  };
  /** Null only for a parsed legacy v1 transaction, which is restore-only. */
  readonly selection: HomeUpgradeSelectionEvidence | null;
  readonly probation: HomeUpgradeProbationProof | null;
  readonly snapshot: {
    readonly root: "snapshot";
    readonly inventory: ReadonlyArray<HomeUpgradeSnapshotEntry>;
  };
  readonly timestamps: {
    readonly preparedAt: string;
    readonly switchingAt: string | null;
    readonly committedAt: string | null;
    readonly restoredAt: string | null;
  };
};

export type HomeUpgradeHistoryIdentity = {
  readonly operationId: string;
  readonly candidate: {
    readonly artifactId: string;
    readonly productVersion: string;
  };
  readonly outcome: "committed" | "restored";
  readonly terminalAt: string;
};

export type HomeUpgradeTransactionDeps = HomeInstallationDeps & {
  readonly platform?: NodeJS.Platform | undefined;
  readonly now?: (() => Date) | undefined;
  readonly publishTransaction?: ((source: string, target: string) => Promise<void>) | undefined;
  readonly launchAgentsDir?: string | undefined;
  readonly afterRestoreEntry?: ((name: typeof SNAPSHOT_NAMES[number]) => Promise<void>) | undefined;
  readonly afterStoreMigration?: ((name: HomeStoreMigrationEntry["name"]) => Promise<void>) | undefined;
  /** Test-only race seam for constant-cost immutable history identity reads. */
  readonly historyIdentityCheckpoint?: ((name: "transaction-observed") => Promise<void>) | undefined;
  /** Test/diagnostic crash seam for durable cutover and selector rollback. */
  readonly selectionCheckpoint?: ((name:
    "probation-recorded" | "switching-recorded" | "candidate-plist-published" |
    "candidate-installation-published" | "committed-recorded" |
    "old-installation-restored" | "old-plist-restored"
  ) => Promise<void>) | undefined;
  /** Internal lifecycle evidence seam used by isolated transaction tests. */
  readonly inspectLifecycleSuspension?: ((vaultPath: string) => Promise<HomeLifecycleSuspensionInspection>) | undefined;
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
    const oldSelection = await captureHomeSelection(vault, deps);
    if (oldSelection.installation.sha256 !== selectors.installation.sha256 ||
      oldSelection.plist.sha256 !== selectors.plist.sha256) {
      throw new Error("Dome Home selector evidence changed during upgrade preparation");
    }
    const candidateSelection = renderHomeSelection({
      vault,
      artifact: {
        id: candidate.artifactId,
        version: candidate.version,
        releasePath: candidate.releasePath,
      },
      environment: installation.environment,
    }, deps);
    const selection = await storeSelectionEvidence(staging, oldSelection, candidateSelection);

    // Copy live SQLite state without opening it. Exact N-1 compatibility is
    // then proved from the private standalone rollback snapshots before the
    // journal is published.
    const inventory = await snapshotDurableState(vault, snapshotRoot);
    await preflightHomeStoreSnapshots({
      snapshotRoot,
      phase: "prepare",
    });
    await assertCandidateDurableCompatibility(candidate, inventory, verify);
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
      selection,
      probation: null,
      snapshot: Object.freeze({ root: "snapshot" as const, inventory }),
      timestamps: Object.freeze({
        preparedAt,
        switchingAt: null,
        committedAt: null,
        restoredAt: null,
      }),
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

/**
 * Migrate a published prepared transaction while write admission remains
 * closed. There is deliberately no new journal phase: per-store current hash
 * is the idempotent retry cursor, and `phase: prepared` remains rollbackable.
 */
export async function migratePreparedHomeUpgrade(
  vaultPath: string,
  deps: HomeUpgradeTransactionDeps = {},
): Promise<HomeUpgradeTransaction> {
  const vault = await canonicalVault(vaultPath);
  const initial = await readRequiredHomeUpgrade(vault, deps);
  if (initial.phase !== "prepared") throw new Error("only a prepared Dome Home upgrade may migrate durable state");
  if (initial.schema !== HOME_UPGRADE_TRANSACTION_SCHEMA) {
    throw new Error("legacy Dome Home upgrade transactions are restore-only");
  }
  await engageForTransaction(vault, initial.transactionId, deps);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ownership = await withHomeUpgradeBarrierOwnership({
      vaultPath: vault,
      transactionId: initial.transactionId,
    }, deps, async (owner) => {
      await assertActiveHomeBarrier(vault, owner, deps);
      return await withQuiescedOwnership(vault, async () => {
        const journal = await readRequiredHomeUpgrade(vault, deps);
        if (journal.phase !== "prepared" || journal.transactionId !== initial.transactionId) {
          throw new Error("prepared Dome Home upgrade evidence changed before migration");
        }
        const verify = deps.verifyArtifact ?? verifyHomeArtifact;
        await assertCandidateDurableCompatibility(journal.candidate, journal.snapshot.inventory, verify);
        const paths = homeInstallationPaths(vault, deps);
        const preflightRoot = join(
          paths.installations,
          "upgrade",
          `.migration-preflight-${journal.transactionId}`,
        );
        await createOwnedMigrationPreflight(preflightRoot);
        try {
          await migratePreparedHomeStores({
            stateRoot: join(vault, ".dome", "state"),
            preflightRoot,
            ...(deps.afterStoreMigration === undefined ? {} : { afterStore: deps.afterStoreMigration }),
          });
        } finally {
          await clearOwnedMigrationPreflight(preflightRoot);
        }
        // The migration Module completed its WAL-aware quick_check/target-hash
        // proof after every changed handle committed and closed.
        return await readRequiredHomeUpgrade(vault, deps);
      });
    });
    if (ownership.kind === "owned") return ownership.value;
    if (ownership.transactionId !== null && ownership.transactionId !== initial.transactionId) {
      throw new Error(`another Dome Home upgrade transaction is active: ${ownership.transactionId}`);
    }
    await engageForTransaction(vault, initial.transactionId, deps);
  }
  throw new Error("Dome Home upgrade migration ownership could not be recovered");
}

/**
 * Durably cross the irreversible selection boundary after stopped probation.
 * Barriers remain engaged: the lifecycle orchestrator must authorize resume
 * evidence before releasing them and letting launchd admit candidate writes.
 */
export async function commitPreparedHomeUpgrade(input: {
  readonly vaultPath: string;
  readonly proof: HomeUpgradeProbationProof;
}, deps: HomeUpgradeTransactionDeps = {}): Promise<HomeUpgradeTransaction> {
  const vault = await canonicalVault(input.vaultPath);
  const initial = await readRequiredHomeUpgrade(vault, deps);
  if (initial.schema !== HOME_UPGRADE_TRANSACTION_SCHEMA) {
    throw new Error("legacy Dome Home upgrade transactions are restore-only");
  }
  if (initial.phase === "restored") throw new Error("a restored Dome Home upgrade cannot commit");
  await validateCommitProof(vault, initial, input.proof, deps.now?.() ?? new Date());
  if (initial.phase === "committed") return initial;
  await engageForTransaction(vault, initial.transactionId, deps);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ownership = await withHomeUpgradeBarrierOwnership({
      vaultPath: vault,
      transactionId: initial.transactionId,
    }, deps, async (owner) => {
      await assertActiveHomeBarrier(vault, owner, deps);
      return await withQuiescedOwnership(vault, async () => {
        let journal = await readRequiredHomeUpgrade(vault, deps);
        if (journal.schema !== HOME_UPGRADE_TRANSACTION_SCHEMA ||
          journal.transactionId !== initial.transactionId || journal.phase === "restored") {
          throw new Error("Dome Home upgrade evidence changed before selector commit");
        }
        await validateCommitProof(vault, journal, input.proof, deps.now?.() ?? new Date());
        if (journal.phase === "committed") return journal;
        await assertCandidateDurableCompatibility(
          journal.candidate,
          journal.snapshot.inventory,
          deps.verifyArtifact ?? verifyHomeArtifact,
        );
        await assertAllHomeStoresCurrent(vault, journal.transactionId, deps);
        const journalPath = join(
          homeInstallationPaths(vault, deps).installations,
          "upgrade", "active", "journal.json",
        );
        if (journal.phase === "prepared") {
          if (journal.probation !== null && JSON.stringify(journal.probation) !== JSON.stringify(input.proof)) {
            throw new Error("Dome Home probation proof changed before selection");
          }
          if (journal.probation === null) {
            journal = Object.freeze({ ...journal, probation: Object.freeze({ ...input.proof }) });
            await replaceJournal(journalPath, journal);
            journal = await readRequiredHomeUpgrade(vault, deps);
            await deps.selectionCheckpoint?.("probation-recorded");
          }
          const switchingAt = (deps.now?.() ?? new Date()).toISOString();
          assertTimestamp(switchingAt, "switching timestamp");
          if (Date.parse(switchingAt) < Date.parse(journal.timestamps.preparedAt)) {
            throw new Error("switching timestamp precedes preparation");
          }
          journal = Object.freeze({
            ...journal,
            phase: "switching" as const,
            timestamps: Object.freeze({ ...journal.timestamps, switchingAt }),
          });
          await replaceJournal(journalPath, journal);
          journal = await readRequiredHomeUpgrade(vault, deps);
          await deps.selectionCheckpoint?.("switching-recorded");
        }
        if (journal.phase !== "switching" || journal.selection === null) {
          throw new Error("Dome Home upgrade is not durably switching");
        }
        const stored = await loadStoredSelection(dirname(journalPath), journal.selection);
        await publishCandidateDocument(stored.old.plist, stored.candidate.plist);
        await deps.selectionCheckpoint?.("candidate-plist-published");
        await publishCandidateDocument(stored.old.installation, stored.candidate.installation);
        await deps.selectionCheckpoint?.("candidate-installation-published");
        if (await classifyHomeSelection(stored) !== "candidate") {
          throw new Error("candidate Home selection did not converge before commit");
        }
        const committedAt = (deps.now?.() ?? new Date()).toISOString();
        assertTimestamp(committedAt, "committed timestamp");
        if (journal.timestamps.switchingAt === null ||
          Date.parse(committedAt) < Date.parse(journal.timestamps.switchingAt)) {
          throw new Error("committed timestamp precedes selection");
        }
        const committed: HomeUpgradeTransaction = Object.freeze({
          ...journal,
          phase: "committed" as const,
          timestamps: Object.freeze({ ...journal.timestamps, committedAt }),
        });
        await replaceJournal(journalPath, committed);
        const durable = await readRequiredHomeUpgrade(vault, deps);
        await deps.selectionCheckpoint?.("committed-recorded");
        return durable;
      });
    });
    if (ownership.kind === "owned") return ownership.value;
    if (ownership.transactionId !== null && ownership.transactionId !== initial.transactionId) {
      throw new Error(`another Dome Home upgrade transaction is active: ${ownership.transactionId}`);
    }
    await engageForTransaction(vault, initial.transactionId, deps);
  }
  throw new Error("Dome Home selector commit ownership could not be recovered");
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
  await validateJournalReferences(journal, active, paths, deps);
  await validateSnapshotInventory(active, journal.snapshot.inventory);
  if (journal.probation !== null && journal.probation.vaultId !== await readVaultId(vault)) {
    throw new Error("upgrade probation proof vault identity does not match the live vault");
  }
  return journal;
}

/**
 * Read rollback truth without requiring the candidate payload to exist.
 * Only recovery orchestration and restore use this narrower evidence view.
 */
export async function readHomeUpgradeForRecovery(
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
  await validateRestoreJournalReferences(journal, active, paths, deps);
  await validateSnapshotInventory(active, journal.snapshot.inventory);
  return journal;
}

/**
 * Strictly read one immutable terminal transaction. History is keyed by the
 * operation identity, never by mutable selection state. History validation is
 * intrinsic: later selections and release collection must not make an older
 * closed record unreadable.
 */
export async function readHomeUpgradeHistory(
  vaultPath: string,
  transactionId: string,
  deps: HomeUpgradeTransactionDeps = {},
): Promise<HomeUpgradeTransaction | null> {
  assertTransactionId(transactionId);
  const vault = await canonicalVault(vaultPath);
  const paths = homeInstallationPaths(vault, deps);
  const upgrade = await inspectUpgradeAncestors(paths);
  if (upgrade === null) return null;
  const history = join(upgrade, "history");
  if (!await present(history)) return null;
  await assertDirectDirectory(history, "upgrade history root");
  const transactionRoot = join(history, transactionId);
  if (!await present(transactionRoot)) return null;
  const journal = await readBoundedJournal(transactionRoot, vault);
  if (journal.transactionId !== transactionId) {
    throw new Error("Dome Home upgrade history directory disagrees with its transaction identity");
  }
  if (journal.phase !== "committed" && journal.phase !== "restored") {
    throw new Error("Dome Home upgrade history contains a non-terminal transaction");
  }
  validateCanonicalArtifactPath(journal.old, paths);
  validateCanonicalArtifactPath(journal.candidate, paths);
  validateArchivedSelectorPaths(journal, paths, deps);
  await validateSnapshotInventory(transactionRoot, journal.snapshot.inventory);
  return journal;
}

/**
 * Constant-cost immutable-history identity proof for derived receipt readers.
 * This uses the canonical closed-root and strict journal parser, but never
 * opens or hashes stored selector and snapshot contents; full audit stays in
 * `readHomeUpgradeHistory`.
 */
export async function readHomeUpgradeHistoryIdentity(
  vaultPath: string,
  transactionId: string,
  deps: HomeUpgradeTransactionDeps = {},
): Promise<HomeUpgradeHistoryIdentity | null> {
  assertTransactionId(transactionId);
  const vault = await canonicalVault(vaultPath);
  const paths = homeInstallationPaths(vault, deps);
  const upgrade = await inspectUpgradeAncestors(paths);
  if (upgrade === null) return null;
  const history = join(upgrade, "history");
  if (!await present(history)) return null;
  await assertPrivateDirectory(history, "upgrade history root");
  const transactionRoot = join(history, transactionId);
  if (!await present(transactionRoot)) return null;
  await deps.historyIdentityCheckpoint?.("transaction-observed");
  try {
    if (!await present(join(transactionRoot, "journal.json"))) {
      if (!await present(transactionRoot)) return null;
      throw new Error("Dome Home archived upgrade transaction lacks its journal");
    }
    const journal = await readBoundedJournalRoot(transactionRoot, vault);
    if (journal.transactionId !== transactionId ||
      (journal.phase !== "committed" && journal.phase !== "restored")) {
      throw new Error("Dome Home archived upgrade journal has invalid terminal identity");
    }
    const terminalAt = journal.phase === "committed"
      ? journal.timestamps.committedAt
      : journal.timestamps.restoredAt;
    if (terminalAt === null) throw new Error("Dome Home archived upgrade transaction lacks its terminal timestamp");
    return Object.freeze({
      operationId: journal.transactionId,
      candidate: Object.freeze({
        artifactId: journal.candidate.artifactId,
        productVersion: journal.candidate.version,
      }),
      outcome: journal.phase,
      terminalAt,
    });
  } catch (error) {
    if (hasCode(error, "ENOENT") && !await present(transactionRoot)) return null;
    throw error;
  }
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
  if (initial.phase === "committed") {
    throw new Error("committed Dome Home upgrades are irreversible and cannot be restored");
  }
  if (initial.phase === "restored") {
    await finishTerminalRestore(vault, initial, deps);
    return initial;
  }
  await engageForTransaction(vault, initial.transactionId, deps);
  return runRestoreOwnership(vault, initial, deps);
}

/** Release external then operational write barriers for an exact committed candidate. */
export async function releaseCommittedHomeUpgrade(
  vaultPath: string,
  deps: HomeUpgradeTransactionDeps = {},
): Promise<HomeUpgradeTransaction> {
  const vault = await canonicalVault(vaultPath);
  const committed = await readRequiredHomeUpgrade(vault, deps);
  if (committed.phase !== "committed") {
    throw new Error("only a committed Dome Home upgrade may release write admission");
  }
  const inspection = await inspectOperationalWriterBarrier(vault);
  const marker = await readHomeUpgradeBarrier(vault, deps);
  if (!inspection.blocked) {
    if (marker !== null) throw new Error("committed upgrade has an orphaned external writer marker");
    return committed;
  }
  if (inspection.transactionId !== committed.transactionId || inspection.blockedAt === null ||
    (marker !== null && (marker.transactionId !== committed.transactionId || marker.engagedAt !== inspection.blockedAt))) {
    throw new Error("committed upgrade writer evidence does not match");
  }
  await assertCandidateLifecycleAuthorization(committed, deps);
  const ownership = await withHomeUpgradeBarrierOwnership({
    vaultPath: vault,
    transactionId: committed.transactionId,
  }, deps, async (owner) => {
    await assertActiveHomeBarrier(vault, owner, deps);
    await owner.release(async () => {
      const current = await readRequiredHomeUpgrade(vault, deps);
      if (current.phase !== "committed" || current.transactionId !== committed.transactionId) {
        throw new Error("Dome Home upgrade is not durably committed");
      }
    });
  });
  if (ownership.kind === "not-owned") {
    const after = await inspectOperationalWriterBarrier(vault);
    if (after.blocked || await readHomeUpgradeBarrier(vault, deps) !== null) {
      throw new Error("committed upgrade writer release raced with another owner");
    }
  }
  return await readRequiredHomeUpgrade(vault, deps);
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
        if (journal.phase === "committed") {
          throw new Error("committed Dome Home upgrades are irreversible and cannot be restored");
        }
        if (journal.phase === "switching") {
          await restoreOldHomeSelection(journal, deps);
        }
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
          timestamps: Object.freeze({
            ...journal.timestamps,
            switchingAt: null,
            committedAt: null,
            restoredAt,
          }),
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
  launchArtifact?: { readonly id: string; readonly version: string } | undefined,
): Promise<{ readonly admitted: true } | { readonly admitted: false; readonly reason: string }> {
  const vault = await canonicalVault(vaultPath);
  const paths = homeInstallationPaths(vault, deps);
  try {
    const upgrade = await inspectUpgradeAncestors(paths);
    if (upgrade === null) return Object.freeze({ admitted: true as const });
    const active = join(upgrade, "active");
    if (!await present(active)) return Object.freeze({ admitted: true as const });
    const journal = await readBoundedJournal(active, vault);
    if (journal.phase !== "restored" && journal.phase !== "committed") {
      return Object.freeze({ admitted: false as const, reason: `upgrade transaction is ${journal.phase}` });
    }
    if (journal.phase === "committed") {
      if (launchArtifact?.id !== journal.candidate.artifactId ||
        launchArtifact.version !== journal.candidate.version) {
        return Object.freeze({ admitted: false as const, reason: "committed upgrade launch artifact is not the candidate" });
      }
      const installation = await readHomeInstallation(vault, deps);
      if (installation === null || installation.artifact.id !== journal.candidate.artifactId ||
        installation.artifact.version !== journal.candidate.version) {
        return Object.freeze({ admitted: false as const, reason: "committed upgrade selector is not the candidate" });
      }
      await validateArtifactReference(journal.candidate, paths);
      await validateSelectorReferences(journal, active, paths, deps);
      return Object.freeze({ admitted: true as const });
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
  const journal = await readBoundedJournalRoot(active, vault);
  if (journal.selection !== null) await validateStoredSelection(active, journal.selection);
  return journal;
}

async function readBoundedJournalRoot(active: string, vault: string): Promise<HomeUpgradeTransaction> {
  await assertPrivateDirectory(active, "upgrade transaction root");
  await assertPrivateDirectory(join(active, "snapshot"), "upgrade snapshot root");
  const journalPath = join(active, "journal.json");
  const info = await lstat(journalPath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
    (info.mode & 0o777) !== 0o600 || info.size > 1024 * 1024) {
    throw new Error("Dome Home upgrade journal is not a bounded regular file");
  }
  let value: unknown;
  try { value = JSON.parse(await readFile(journalPath, "utf8")); }
  catch { throw new Error("Dome Home upgrade journal is corrupt"); }
  const journal = parseJournal(value, vault);
  const expected = journal.schema === HOME_UPGRADE_TRANSACTION_SCHEMA
    ? ["journal.json", "selectors", "snapshot"]
    : ["journal.json", "snapshot"];
  const withSummary = [...expected, "summary.json"].sort(compareStrings);
  const rootNames = await readBoundedNames(active, withSummary.length);
  if (JSON.stringify(rootNames) !== JSON.stringify(expected) &&
    JSON.stringify(rootNames) !== JSON.stringify(withSummary)) {
    throw new Error("Dome Home upgrade transaction has an unknown or missing root entry");
  }
  if (rootNames.includes("summary.json")) {
    const summary = await assertRegular(join(active, "summary.json"), "upgrade terminal summary");
    if ((await lstat(join(active, "summary.json"))).nlink !== 1 ||
      (summary.mode & 0o777) !== 0o600 || summary.size === 0 || summary.size > 4096) {
      throw new Error("Dome Home upgrade terminal summary is not a bounded private file");
    }
  }
  if (journal.selection !== null) {
    await assertPrivateDirectory(join(active, "selectors"), "upgrade stored selectors");
  }
  return journal;
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

async function assertCandidateDurableCompatibility(
  candidate: HomeUpgradeArtifactEvidence,
  inventory: ReadonlyArray<HomeUpgradeSnapshotEntry>,
  verify: HomeArtifactVerifier,
): Promise<void> {
  if (await hashFile(join(candidate.releasePath, "manifest.json")) !== candidate.manifestSha256) {
    throw new Error("upgrade candidate manifest changed before durable-state migration");
  }
  const manifest = await verify(candidate.releasePath);
  if (manifest.artifact.id !== candidate.artifactId || manifest.product.version !== candidate.version) {
    throw new Error("upgrade candidate artifact or product version changed");
  }
  if (manifest.writerBarrier?.protocol !== 1 || manifest.durableState?.protocol !== HOME_DURABLE_STATE_PROTOCOL) {
    throw new Error("upgrade candidate lacks required writer-barrier or durable-state protocol");
  }
  if (manifest.durableState.stores.length !== HOME_STORE_MIGRATIONS.length ||
    !HOME_STORE_MIGRATIONS.every((expected, index) => {
      const actual = manifest.durableState?.stores[index];
      return actual?.name === expected.name && actual.metaTable === expected.metaTable &&
        actual.currentSchemaHash === expected.currentSchemaHash &&
        JSON.stringify(actual.migratesFrom) === JSON.stringify(expected.migratesFrom);
    })) {
    throw new Error("upgrade candidate durable-state inventory differs from this build");
  }
  for (const database of DATABASES) {
    const snapshot = inventory.find((entry) => entry.name === database.name);
    const route = manifest.durableState.stores.find((entry) => entry.name === database.name);
    if (snapshot?.schemaHash === null || snapshot?.schemaHash === undefined || route === undefined ||
      route.metaTable !== database.metaTable ||
      (snapshot.schemaHash !== route.currentSchemaHash && !route.migratesFrom.includes(snapshot.schemaHash))) {
      throw new Error(`upgrade candidate is incompatible with durable snapshot: ${database.name}`);
    }
  }
}

async function validateJournalReferences(
  journal: HomeUpgradeTransaction,
  transactionRoot: string,
  paths: HomeInstallationPaths,
  deps: HomeUpgradeTransactionDeps,
): Promise<void> {
  for (const artifact of [journal.old, journal.candidate]) {
    await validateArtifactReference(artifact, paths);
  }
  await validateSelectorReferences(journal, transactionRoot, paths, deps);
}

async function validateRestoreJournalReferences(
  journal: HomeUpgradeTransaction,
  transactionRoot: string,
  paths: HomeInstallationPaths,
  deps: HomeUpgradeTransactionDeps,
): Promise<void> {
  await validateArtifactReference(journal.old, paths);
  validateCanonicalArtifactPath(journal.candidate, paths);
  await validateSelectorReferences(journal, transactionRoot, paths, deps);
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
  transactionRoot: string,
  paths: HomeInstallationPaths,
  deps: HomeUpgradeTransactionDeps,
): Promise<void> {
  if (journal.selection === null) {
    await assertFileEvidence(journal.selectors.installation, paths.record, "installation.json");
    await assertFileEvidence(journal.selectors.plist, homePlistPath(journal.vault, deps), "Dome Home launchd plist");
    return;
  }
  const stored = await loadStoredSelection(
    transactionRoot,
    journal.selection,
  );
  const state = await classifyHomeSelection(stored);
  if (state === "invalid" ||
    ((journal.phase === "prepared" || journal.phase === "restored") && state !== "old") ||
    (journal.phase === "committed" && state !== "candidate")) {
    throw new Error(`Dome Home selector state ${state} is inconsistent with upgrade phase ${journal.phase}`);
  }
}

function validateArchivedSelectorPaths(
  journal: HomeUpgradeTransaction,
  paths: HomeInstallationPaths,
  deps: HomeUpgradeTransactionDeps,
): void {
  if (journal.selectors.installation.path !== paths.record) {
    throw new Error("archived installation selector path is not canonical");
  }
  if (journal.selectors.plist.path !== homePlistPath(journal.vault, deps)) {
    throw new Error("archived Dome Home plist path is not canonical");
  }
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
  await assertPrivateDirectory(snapshot, "upgrade snapshot root");
  const expected = inventory.filter((entry) => entry.present).map((entry) => entry.name).sort(compareStrings);
  const names = await readBoundedNames(snapshot, expected.length);
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error("upgrade snapshot inventory is not closed");
  for (const entry of inventory) {
    if (!entry.present) continue;
    const path = join(snapshot, entry.name);
    const info = await assertRegular(path, `snapshot ${entry.name}`);
    if ((await lstat(path)).nlink !== 1 || (info.mode & 0o777) !== 0o600 ||
      info.size !== entry.size || await hashFile(path) !== entry.sha256) {
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

async function storeSelectionEvidence(
  transactionRoot: string,
  old: HomeSelection,
  candidate: HomeSelection,
): Promise<HomeUpgradeSelectionEvidence> {
  const selectionRoot = join(transactionRoot, "selectors");
  await mkdir(selectionRoot, { mode: 0o700 });
  await chmod(selectionRoot, 0o700);
  const entries = [
    [old.installation, "selectors/old-installation.json"],
    [old.plist, "selectors/old.plist"],
    [candidate.installation, "selectors/candidate-installation.json"],
    [candidate.plist, "selectors/candidate.plist"],
  ] as const;
  const evidence = new Map<string, HomeUpgradeStoredSelectionDocument>();
  for (const [document, stored] of entries) {
    if (document.size > 128 * 1024) throw new Error(`upgrade selector exceeds its size budget: ${stored}`);
    const path = join(transactionRoot, stored);
    await writePrivateBytes(path, document.bytes);
    evidence.set(stored, Object.freeze({
      path: document.path,
      mode: document.mode,
      size: document.size,
      sha256: document.sha256,
      stored,
    }));
  }
  return Object.freeze({
    old: Object.freeze({
      installation: evidence.get("selectors/old-installation.json")!,
      plist: evidence.get("selectors/old.plist")!,
    }),
    candidate: Object.freeze({
      installation: evidence.get("selectors/candidate-installation.json")!,
      plist: evidence.get("selectors/candidate.plist")!,
    }),
  });
}

async function validateStoredSelection(
  active: string,
  selection: HomeUpgradeSelectionEvidence,
): Promise<void> {
  const root = join(active, "selectors");
  await assertPrivateDirectory(root, "upgrade stored selectors");
  const expected = [
    "candidate-installation.json", "candidate.plist", "old-installation.json", "old.plist",
  ];
  if (JSON.stringify(await readBoundedNames(root, expected.length)) !== JSON.stringify(expected)) {
    throw new Error("upgrade stored selector inventory is not closed");
  }
  for (const document of storedSelectionDocuments(selection)) {
    const path = join(active, document.stored);
    const info = await assertRegular(path, `stored ${document.stored}`);
    if ((await lstat(path)).nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size !== document.size ||
      await hashFile(path) !== document.sha256) {
      throw new Error(`upgrade stored selector evidence changed: ${document.stored}`);
    }
  }
}

async function loadStoredSelection(
  active: string,
  selection: HomeUpgradeSelectionEvidence,
): Promise<{ readonly old: HomeSelection; readonly candidate: HomeSelection }> {
  const load = async (document: HomeUpgradeStoredSelectionDocument): Promise<HomeSelectionDocument> =>
    selectionDocument(document.path, await readFile(join(active, document.stored), "utf8"), document.mode);
  return Object.freeze({
    old: Object.freeze({
      installation: await load(selection.old.installation),
      plist: await load(selection.old.plist),
    }),
    candidate: Object.freeze({
      installation: await load(selection.candidate.installation),
      plist: await load(selection.candidate.plist),
    }),
  });
}

async function publishCandidateDocument(
  old: HomeSelectionDocument,
  candidate: HomeSelectionDocument,
): Promise<void> {
  const live = await captureHomeSelectionDocument(old.path);
  if (sameSelectionDocument(live, candidate)) return;
  if (!sameSelectionDocument(live, old)) {
    throw new Error("live Home selector is neither exact old nor exact candidate evidence");
  }
  await publishHomeSelectionDocument({ expected: old, desired: candidate });
}

async function restoreOldHomeSelection(
  journal: HomeUpgradeTransaction,
  deps: HomeUpgradeTransactionDeps,
): Promise<void> {
  if (journal.selection === null) throw new Error("switching upgrade lacks stored selector evidence");
  const active = join(
    homeInstallationPaths(journal.vault, deps).installations,
    "upgrade", "active",
  );
  const stored = await loadStoredSelection(active, journal.selection);
  await publishOldDocument(stored.candidate.installation, stored.old.installation);
  await deps.selectionCheckpoint?.("old-installation-restored");
  await publishOldDocument(stored.candidate.plist, stored.old.plist);
  await deps.selectionCheckpoint?.("old-plist-restored");
  if (await classifyHomeSelection(stored) !== "old") {
    throw new Error("old Home selection did not converge during rollback");
  }
}

async function publishOldDocument(
  candidate: HomeSelectionDocument,
  old: HomeSelectionDocument,
): Promise<void> {
  const live = await captureHomeSelectionDocument(old.path);
  if (sameSelectionDocument(live, old)) return;
  if (!sameSelectionDocument(live, candidate)) {
    throw new Error("live Home selector is neither exact candidate nor exact old evidence");
  }
  await publishHomeSelectionDocument({ expected: candidate, desired: old });
}

function sameSelectionDocument(left: HomeSelectionDocument, right: HomeSelectionDocument): boolean {
  return left.path === right.path && left.mode === right.mode && left.size === right.size &&
    left.sha256 === right.sha256 && left.bytes === right.bytes;
}

async function validateCommitProof(
  vault: string,
  journal: HomeUpgradeTransaction,
  proof: HomeUpgradeProbationProof,
  commitClock: Date,
): Promise<void> {
  if (proof.schema !== "dome.home-upgrade-probation-proof/v1" ||
    proof.readinessSchema !== "dome.product.readiness/v1" || proof.hostState !== "probation" ||
    proof.transactionId !== journal.transactionId ||
    proof.artifactId !== journal.candidate.artifactId ||
    proof.productVersion !== journal.candidate.version || proof.writesAdmitted !== false ||
    proof.vaultId !== await readVaultId(vault)) {
    throw new Error("candidate probation proof does not match the upgrade transaction and vault");
  }
  assertTimestamp(proof.provenAt, "candidate probation proof timestamp");
  if (Date.parse(proof.provenAt) < Date.parse(journal.timestamps.preparedAt) ||
    Date.parse(proof.provenAt) > commitClock.getTime()) {
    throw new Error("candidate probation proof is outside the prepared-to-commit interval");
  }
}

async function assertCandidateLifecycleAuthorization(
  journal: HomeUpgradeTransaction,
  deps: HomeUpgradeTransactionDeps,
): Promise<void> {
  if (journal.selection === null) throw new Error("committed upgrade lacks candidate selection evidence");
  const inspected = await (deps.inspectLifecycleSuspension ?? inspectHomeLifecycleSuspension)(journal.vault);
  if (inspected.kind !== "active" || inspected.suspension.purpose !== "upgrade" ||
    inspected.suspension.operationId !== journal.transactionId ||
    inspected.suspension.resumeArtifactId !== journal.candidate.artifactId ||
    inspected.suspension.resumeArtifactVersion !== journal.candidate.version ||
    inspected.suspension.resumeInstallationSha256 !== journal.selection.candidate.installation.sha256 ||
    inspected.suspension.resumePlistSha256 !== journal.selection.candidate.plist.sha256) {
    throw new Error("committed upgrade lacks exact candidate lifecycle resume authorization");
  }
}

async function assertAllHomeStoresCurrent(
  vault: string,
  transactionId: string,
  deps: HomeUpgradeTransactionDeps,
): Promise<void> {
  const root = join(
    homeInstallationPaths(vault, deps).installations,
    "upgrade", `.selection-preflight-${transactionId}`,
  );
  await createOwnedMigrationPreflight(root);
  try {
    const evidence = await preflightHomeStoreMigrations({
      stateRoot: join(vault, ".dome", "state"),
      snapshotRoot: root,
      phase: "prepared-retry",
    });
    const predecessor = evidence.find((entry) => entry.state !== "current");
    if (predecessor !== undefined) {
      throw new Error(`Dome Home store is not current before selector commit: ${predecessor.name}`);
    }
  } finally {
    await clearOwnedMigrationPreflight(root);
  }
}

function storedSelectionDocuments(
  selection: HomeUpgradeSelectionEvidence,
): ReadonlyArray<HomeUpgradeStoredSelectionDocument> {
  return [
    selection.old.installation, selection.old.plist,
    selection.candidate.installation, selection.candidate.plist,
  ];
}

function stripStoredSelection(
  selection: HomeUpgradeSelectionEvidence["old"],
): HomeUpgradeTransaction["selectors"] {
  const strip = ({ stored: _stored, ...document }: HomeUpgradeStoredSelectionDocument) => document;
  return Object.freeze({
    installation: Object.freeze(strip(selection.installation)),
    plist: Object.freeze(strip(selection.plist)),
  });
}

function parseJournal(value: unknown, expectedVault: string): HomeUpgradeTransaction {
  const untrusted = exactRecordShape(value, "upgrade journal");
  const schema = untrusted["schema"];
  const isV2 = schema === HOME_UPGRADE_TRANSACTION_SCHEMA;
  const root = exactRecord(value, "upgrade journal", isV2
    ? [
      "schema", "vault", "transactionId", "phase", "old", "candidate", "selectors",
      "selection", "probation", "snapshot", "timestamps",
    ]
    : [
      "schema", "vault", "transactionId", "phase", "old", "candidate", "selectors",
      "snapshot", "timestamps",
    ]);
  const phase = root["phase"];
  if ((schema !== HOME_UPGRADE_TRANSACTION_SCHEMA && schema !== HOME_UPGRADE_TRANSACTION_SCHEMA_V1) ||
    root["vault"] !== expectedVault ||
    (phase !== "prepared" && phase !== "switching" && phase !== "committed" && phase !== "restored") ||
    (!isV2 && phase !== "prepared" && phase !== "restored")) {
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
  const selection = isV2 ? parseSelectionEvidence(root["selection"], selectors) : null;
  const probation = isV2
    ? parseProbationProof(root["probation"], root["transactionId"] as string, candidate)
    : null;
  if ((phase === "switching" || phase === "committed") && probation === null) {
    throw new Error("upgrade phase requires exact candidate probation proof");
  }
  const snapshot = exactRecord(root["snapshot"], "upgrade snapshot", ["root", "inventory"]);
  if (snapshot["root"] !== "snapshot" || !Array.isArray(snapshot["inventory"]) || snapshot["inventory"].length !== SNAPSHOT_NAMES.length) {
    throw new Error("upgrade journal snapshot inventory is invalid");
  }
  const inventory = snapshot["inventory"].map(parseSnapshotEntry);
  if (JSON.stringify(inventory.map((entry) => entry.name)) !== JSON.stringify(SNAPSHOT_NAMES)) {
    throw new Error("upgrade journal snapshot inventory is not canonical");
  }
  const timestamps = exactRecord(root["timestamps"], "upgrade timestamps", isV2
    ? ["preparedAt", "switchingAt", "committedAt", "restoredAt"]
    : ["preparedAt", "restoredAt"]);
  assertTimestamp(timestamps["preparedAt"], "prepared timestamp");
  if (isV2 && timestamps["switchingAt"] !== null) assertTimestamp(timestamps["switchingAt"], "switching timestamp");
  if (isV2 && timestamps["committedAt"] !== null) assertTimestamp(timestamps["committedAt"], "committed timestamp");
  if (timestamps["restoredAt"] !== null) assertTimestamp(timestamps["restoredAt"], "restored timestamp");
  if (!validPhaseTimestamps(phase as UpgradePhase, {
    preparedAt: timestamps["preparedAt"],
    switchingAt: isV2 ? timestamps["switchingAt"] : null,
    committedAt: isV2 ? timestamps["committedAt"] : null,
    restoredAt: timestamps["restoredAt"],
  })) {
    throw new Error("upgrade journal phase evidence is inconsistent");
  }
  validatePersistedProbationOrder(phase as UpgradePhase, probation, {
    preparedAt: timestamps["preparedAt"] as string,
    switchingAt: isV2 ? timestamps["switchingAt"] as string | null : null,
    restoredAt: timestamps["restoredAt"] as string | null,
  });
  return Object.freeze({
    schema: schema as HomeUpgradeTransaction["schema"],
    vault: expectedVault,
    transactionId: root["transactionId"] as string,
    phase: phase as UpgradePhase,
    old,
    candidate,
    selectors,
    selection,
    probation,
    snapshot: Object.freeze({ root: "snapshot", inventory: Object.freeze(inventory) }),
    timestamps: Object.freeze({
      preparedAt: timestamps["preparedAt"] as string,
      switchingAt: isV2 ? timestamps["switchingAt"] as string | null : null,
      committedAt: isV2 ? timestamps["committedAt"] as string | null : null,
      restoredAt: timestamps["restoredAt"] as string | null,
    }),
  });
}

function exactRecordShape(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
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

function parseSelectionEvidence(
  value: unknown,
  oldSelectors: HomeUpgradeTransaction["selectors"],
): HomeUpgradeSelectionEvidence {
  const root = exactRecord(value, "upgrade selection", ["old", "candidate"]);
  const old = parseSelectionSide(root["old"], "old", {
    installation: "selectors/old-installation.json",
    plist: "selectors/old.plist",
  });
  const candidate = parseSelectionSide(root["candidate"], "candidate", {
    installation: "selectors/candidate-installation.json",
    plist: "selectors/candidate.plist",
  });
  if (JSON.stringify(stripStoredSelection(old)) !== JSON.stringify(oldSelectors)) {
    throw new Error("upgrade old selection differs from legacy selector evidence");
  }
  if (old.installation.path !== candidate.installation.path || old.plist.path !== candidate.plist.path) {
    throw new Error("upgrade selection paths differ between old and candidate");
  }
  if (old.installation.sha256 === candidate.installation.sha256 ||
    old.plist.sha256 === candidate.plist.sha256) {
    throw new Error("upgrade candidate selection is not distinct");
  }
  return Object.freeze({ old, candidate });
}

function parseSelectionSide(
  value: unknown,
  label: "old" | "candidate",
  stored: { readonly installation: HomeUpgradeStoredSelectionDocument["stored"]; readonly plist: HomeUpgradeStoredSelectionDocument["stored"] },
): HomeUpgradeSelectionEvidence["old"] {
  const side = exactRecord(value, `${label} selection`, ["installation", "plist"]);
  return Object.freeze({
    installation: parseStoredSelectionDocument(side["installation"], `${label} installation`, stored.installation),
    plist: parseStoredSelectionDocument(side["plist"], `${label} plist`, stored.plist),
  });
}

function parseStoredSelectionDocument(
  value: unknown,
  label: string,
  expectedStored: HomeUpgradeStoredSelectionDocument["stored"],
): HomeUpgradeStoredSelectionDocument {
  const root = exactRecord(value, label, ["path", "mode", "size", "sha256", "stored"]);
  const evidence = parseFileEvidence({
    path: root["path"], mode: root["mode"], size: root["size"], sha256: root["sha256"],
  }, label);
  if (root["stored"] !== expectedStored || evidence.size > 128 * 1024) {
    throw new Error(`${label} stored evidence is invalid`);
  }
  return Object.freeze({ ...evidence, stored: expectedStored });
}

function parseProbationProof(
  value: unknown,
  transactionId: string,
  candidate: HomeUpgradeArtifactEvidence,
): HomeUpgradeProbationProof | null {
  if (value === null) return null;
  const proof = exactRecord(value, "upgrade probation proof", [
    "schema", "transactionId", "readinessSchema", "hostState", "artifactId", "productVersion", "vaultId",
    "writesAdmitted", "provenAt",
  ]);
  if (proof["schema"] !== "dome.home-upgrade-probation-proof/v1" ||
    proof["readinessSchema"] !== "dome.product.readiness/v1" || proof["hostState"] !== "probation" ||
    proof["transactionId"] !== transactionId ||
    proof["artifactId"] !== candidate.artifactId || proof["productVersion"] !== candidate.version ||
    typeof proof["vaultId"] !== "string" || proof["vaultId"].length === 0 || proof["vaultId"].length > 128 ||
    proof["writesAdmitted"] !== false) {
    throw new Error("upgrade probation proof is invalid");
  }
  assertTransactionId(proof["transactionId"]);
  assertTimestamp(proof["provenAt"], "probation proof timestamp");
  return Object.freeze(proof as unknown as HomeUpgradeProbationProof);
}

function validatePersistedProbationOrder(
  phase: UpgradePhase,
  proof: HomeUpgradeProbationProof | null,
  timestamps: {
    readonly preparedAt: string;
    readonly switchingAt: string | null;
    readonly restoredAt: string | null;
  },
): void {
  if (proof === null) return;
  const provenAt = Date.parse(proof.provenAt);
  if (provenAt < Date.parse(timestamps.preparedAt)) {
    throw new Error("upgrade probation proof precedes preparation");
  }
  if ((phase === "switching" || phase === "committed") &&
    (timestamps.switchingAt === null || provenAt > Date.parse(timestamps.switchingAt))) {
    throw new Error("upgrade probation proof follows selector switching");
  }
  if (phase === "restored" &&
    (timestamps.restoredAt === null || provenAt > Date.parse(timestamps.restoredAt))) {
    throw new Error("upgrade probation proof follows restoration");
  }
}

function validPhaseTimestamps(
  phase: UpgradePhase,
  timestamps: { readonly preparedAt: unknown; readonly switchingAt: unknown; readonly committedAt: unknown; readonly restoredAt: unknown },
): boolean {
  const prepared = Date.parse(timestamps.preparedAt as string);
  if (phase === "prepared") {
    return timestamps.switchingAt === null && timestamps.committedAt === null && timestamps.restoredAt === null;
  }
  if (phase === "switching") {
    return typeof timestamps.switchingAt === "string" && Date.parse(timestamps.switchingAt) >= prepared &&
      timestamps.committedAt === null && timestamps.restoredAt === null;
  }
  if (phase === "committed") {
    return typeof timestamps.switchingAt === "string" && typeof timestamps.committedAt === "string" &&
      Date.parse(timestamps.switchingAt) >= prepared &&
      Date.parse(timestamps.committedAt) >= Date.parse(timestamps.switchingAt) &&
      timestamps.restoredAt === null;
  }
  return timestamps.switchingAt === null && timestamps.committedAt === null &&
    typeof timestamps.restoredAt === "string" && Date.parse(timestamps.restoredAt) >= prepared;
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
    await writePrivateJson(temporary, journalDocument(journal), true);
    await rename(temporary, path);
    await fsyncDirectory(active);
    await fsyncDirectory(upgrade);
  } finally {
    await rm(temporary, { force: true });
    await fsyncDirectory(upgrade);
  }
}

function journalDocument(journal: HomeUpgradeTransaction): unknown {
  if (journal.schema === HOME_UPGRADE_TRANSACTION_SCHEMA) return journal;
  return Object.freeze({
    schema: journal.schema,
    vault: journal.vault,
    transactionId: journal.transactionId,
    phase: journal.phase,
    old: journal.old,
    candidate: journal.candidate,
    selectors: journal.selectors,
    snapshot: journal.snapshot,
    timestamps: Object.freeze({
      preparedAt: journal.timestamps.preparedAt,
      restoredAt: journal.timestamps.restoredAt,
    }),
  });
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

async function writePrivateBytes(path: string, bytes: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  await chmod(path, 0o600);
}

async function clearOwnedStaging(path: string): Promise<void> {
  if (!await present(path)) return;
  await assertDirectDirectory(path, "upgrade staging directory");
  await rm(path, { recursive: true });
}

async function createOwnedMigrationPreflight(path: string): Promise<void> {
  await clearOwnedMigrationPreflight(path);
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function clearOwnedMigrationPreflight(path: string): Promise<void> {
  if (!await present(path)) return;
  await assertDirectDirectory(path, "upgrade migration preflight directory");
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
  const journal = await readHomeUpgradeForRecovery(vault, deps);
  if (journal === null) throw new Error("no prepared Dome Home upgrade transaction exists");
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

async function assertPrivateDirectory(path: string, label: string): Promise<void> {
  await assertDirectDirectory(path, label);
  if (((await lstat(path)).mode & 0o777) !== 0o700) {
    throw new Error(`${label} is not private: ${path}`);
  }
}

async function readBoundedNames(path: string, maximum: number): Promise<ReadonlyArray<string>> {
  const names: string[] = [];
  const directory = await opendir(path);
  try {
    for await (const entry of directory) {
      names.push(entry.name);
      if (names.length > maximum) {
        throw new Error(`Dome Home upgrade directory is not closed; inventory budget exceeded: ${path}`);
      }
    }
  } finally {
    try { await directory.close(); } catch (error) {
      if (!hasCode(error, "ERR_DIR_CLOSED")) throw error;
    }
  }
  return names.sort(compareStrings);
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

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
