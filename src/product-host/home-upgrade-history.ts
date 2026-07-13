// product-host/home-upgrade-history: terminal proof and immutable retirement.
// The transaction Module owns evidence interpretation. This Module owns the
// lifecycle/operational serialization and the one active -> history rename.

import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  acquireOperationalWriterLease,
  inspectOperationalWriterBarrier,
  operationalWriterCoordinatorPath,
} from "../operational-state/writer-barrier";
import { publishDirectoryExclusive } from "../platform/exclusive-rename";
import {
  homeInstallationPaths,
  syncDirectory,
} from "./home-installation";
import {
  manageHome,
  type HomeLifecycleDeps,
} from "./home-lifecycle";
import {
  withHomeLifecycleMutation,
  type HomeLifecycleMutationDeps,
} from "./home-lifecycle-suspension";
import { readHomeUpgradeBarrier } from "./home-upgrade-barrier";
import {
  readHomeUpgrade,
  readHomeUpgradeForRecovery,
  readHomeUpgradeHistory,
  type HomeUpgradeTransaction,
  type HomeUpgradeTransactionDeps,
} from "./home-upgrade-transaction";

export type HomeUpgradeTerminalService = {
  readonly state: "ready" | "stopped";
  readonly artifactId: string;
  readonly productVersion: string;
};

export type HomeUpgradeRetirementCheckpoint =
  | "before-rename"
  | "after-rename"
  | "history-synced"
  | "upgrade-synced";

export type HomeUpgradeHistoryDeps = HomeUpgradeTransactionDeps &
  HomeLifecycleDeps &
  HomeLifecycleMutationDeps & {
    readonly publishHistory?: ((source: string, target: string) => Promise<void>) | undefined;
    readonly syncHistoryDirectory?: ((path: string) => Promise<void>) | undefined;
    readonly inspectTerminalService?: ((vaultPath: string) => Promise<HomeUpgradeTerminalService>) | undefined;
    /** Test/diagnostic crash seam around the one atomic retirement boundary. */
    readonly retirementCheckpoint?: ((name: HomeUpgradeRetirementCheckpoint) => Promise<void>) | undefined;
  };

export type HomeUpgradeRetirement = {
  readonly transaction: HomeUpgradeTransaction;
  /** False means a prior process completed the atomic move. */
  readonly retired: boolean;
};

/**
 * Move one exact terminal operation from `active/` to immutable history.
 *
 * Lifecycle ownership prevents an install or suspension from changing Home
 * selection. The ordinary operational lease prevents a new upgrade barrier
 * from engaging. All terminal evidence is then re-read beneath both owners,
 * immediately before the no-replace rename.
 */
export async function retireHomeUpgrade(input: {
  readonly vaultPath: string;
  readonly transactionId: string;
}, deps: HomeUpgradeHistoryDeps = {}): Promise<HomeUpgradeRetirement> {
  const vault = await realpath(resolve(input.vaultPath));
  await assertExistingOperationalCoordinator(vault);
  const lifecycle = await withHomeLifecycleMutation(vault, async () => {
    const admission = await acquireOperationalWriterLease({
      vaultPath: vault,
      command: "dome-home-upgrade-retirement",
    });
    if (!admission.ok) {
      throw new Error(`Dome Home upgrade retirement cannot acquire write admission: ${admission.error.kind}`);
    }
    try {
      return await retireWhileOwned(vault, input.transactionId, deps);
    } finally {
      admission.lease.close();
    }
  }, deps);
  if (lifecycle.kind === "suspended") {
    throw new Error(
      `Dome Home upgrade retirement is blocked by lifecycle operation ${lifecycle.suspension.operationId}`,
    );
  }
  return lifecycle.value;
}

async function assertExistingOperationalCoordinator(vault: string): Promise<void> {
  const path = operationalWriterCoordinatorPath(vault);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size === 0 ||
    (info.mode & 0o777) !== 0o600 || await realpath(path) !== resolve(path)) {
    throw new Error("Dome Home operational writer coordinator is missing or invalid for retirement");
  }
}

async function retireWhileOwned(
  vault: string,
  transactionId: string,
  deps: HomeUpgradeHistoryDeps,
): Promise<HomeUpgradeRetirement> {
  const paths = homeInstallationPaths(vault, deps);
  const upgrade = join(paths.installations, "upgrade");
  const active = join(upgrade, "active");
  const history = join(upgrade, "history");
  const destination = join(history, transactionId);
  await assertDirectDirectory(upgrade, "upgrade root");
  await ensureHistoryRoot(history, upgrade, deps);

  if (!await present(active)) {
    const prior = await readHomeUpgradeHistory(vault, transactionId, deps);
    if (prior === null) {
      throw new Error(`Dome Home upgrade transaction ${transactionId} is neither active nor retired`);
    }
    await syncRetirementParents(history, upgrade, deps);
    return Object.freeze({ transaction: prior, retired: false as const });
  }

  const terminal = await readTerminalActive(vault, transactionId, deps);
  await assertTerminalState(vault, terminal, deps);
  const sourceIdentity = transactionIdentity(terminal);

  const existing = await readHomeUpgradeHistory(vault, transactionId, deps);
  if (existing !== null) {
    if (transactionIdentity(existing) !== sourceIdentity) {
      throw new Error("Dome Home upgrade history destination conflicts with active evidence");
    }
    throw new Error("Dome Home upgrade evidence exists in both active and immutable history");
  }

  // Re-read live truth at the last possible point under both owners. History
  // setup and collision inspection above are intentionally outside this
  // terminal qualification window.
  const finalTerminal = await readTerminalActive(vault, transactionId, deps);
  await assertTerminalState(vault, finalTerminal, deps);
  if (transactionIdentity(finalTerminal) !== sourceIdentity) {
    throw new Error("Dome Home terminal upgrade evidence changed before retirement");
  }

  await deps.retirementCheckpoint?.("before-rename");
  const publish = deps.publishHistory ?? ((source: string, target: string) =>
    publishDirectoryExclusive({
      source,
      target,
      ...(deps.platform === undefined ? {} : { platform: deps.platform }),
    }));
  let retired = true;
  try {
    await publish(active, destination);
  } catch (error) {
    if (await present(active)) throw error;
    const concurrent = await readHomeUpgradeHistory(vault, transactionId, deps);
    if (concurrent === null || transactionIdentity(concurrent) !== sourceIdentity) {
      throw new Error("Dome Home upgrade retirement lost its active transaction without exact history");
    }
    retired = false;
  }
  await deps.retirementCheckpoint?.("after-rename");

  const archived = await readHomeUpgradeHistory(vault, transactionId, deps);
  if (archived === null || transactionIdentity(archived) !== sourceIdentity) {
    throw new Error("retired Dome Home upgrade history differs from active evidence");
  }
  await syncRetirementParents(history, upgrade, deps);
  return Object.freeze({ transaction: archived, retired });
}

async function readTerminalActive(
  vault: string,
  transactionId: string,
  deps: HomeUpgradeHistoryDeps,
): Promise<HomeUpgradeTransaction> {
  const recovery = await readHomeUpgradeForRecovery(vault, deps);
  if (recovery === null || recovery.transactionId !== transactionId) {
    throw new Error(`another Dome Home upgrade transaction is active: ${recovery?.transactionId ?? "unknown"}`);
  }
  const terminal = recovery.phase === "committed"
    ? await readHomeUpgrade(vault, deps)
    : recovery;
  if (terminal === null || terminal.transactionId !== transactionId ||
    (terminal.phase !== "committed" && terminal.phase !== "restored")) {
    throw new Error("only an exact committed or restored Dome Home upgrade may retire");
  }
  return terminal;
}

async function assertTerminalState(
  vault: string,
  transaction: HomeUpgradeTransaction,
  deps: HomeUpgradeHistoryDeps,
): Promise<void> {
  const operational = await inspectOperationalWriterBarrier(vault);
  if (operational.blocked || operational.transactionId !== null || operational.blockedAt !== null) {
    throw new Error("Dome Home upgrade writer admission is not open for retirement");
  }
  if (await readHomeUpgradeBarrier(vault, deps) !== null) {
    throw new Error("Dome Home upgrade external writer marker remains present");
  }
  const service = await (deps.inspectTerminalService ?? inspectTerminalService)(vault, deps);
  const selected = transaction.phase === "committed" ? transaction.candidate : transaction.old;
  if (service.artifactId !== selected.artifactId || service.productVersion !== selected.version) {
    throw new Error("Dome Home terminal service does not select the transaction-bound artifact");
  }
}

async function inspectTerminalService(
  vault: string,
  deps: HomeUpgradeHistoryDeps,
): Promise<HomeUpgradeTerminalService> {
  const status = await manageHome({ action: "status", vaultPath: vault }, deps);
  if (status.artifactId === null || status.productVersion === null) {
    throw new Error("Dome Home terminal service has no selected artifact");
  }
  if (status.status === "ready" && status.loaded === true && status.ready === true) {
    return Object.freeze({
      state: "ready" as const,
      artifactId: status.artifactId,
      productVersion: status.productVersion,
    });
  }
  if (status.status === "installed-stopped" && status.installed === true && status.loaded === false) {
    return Object.freeze({
      state: "stopped" as const,
      artifactId: status.artifactId,
      productVersion: status.productVersion,
    });
  }
  throw new Error(`Dome Home terminal service is neither ready nor stopped: ${status.status}`);
}

async function ensureHistoryRoot(
  history: string,
  upgrade: string,
  deps: HomeUpgradeHistoryDeps,
): Promise<void> {
  if (!await present(history)) {
    let created = false;
    try {
      await mkdir(history, { mode: 0o700 });
      created = true;
    }
    catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    if (!await present(history)) throw new Error("upgrade history creation did not publish a directory");
    // Never chmod an EEXIST path: a raced symlink must be rejected below
    // without changing its target. mkdir applies the final mode atomically.
    await assertDirectDirectory(history, "upgrade history root");
    if (((await lstat(history)).mode & 0o777) !== 0o700) {
      throw new Error("upgrade history root is not private");
    }
    if (created) {
      const sync = deps.syncHistoryDirectory ?? syncDirectory;
      await sync(history);
      await sync(upgrade);
    }
  }
  await assertDirectDirectory(history, "upgrade history root");
  const historyInfo = await lstat(history);
  const upgradeInfo = await lstat(upgrade);
  if ((historyInfo.mode & 0o777) !== 0o700 || historyInfo.dev !== upgradeInfo.dev) {
    throw new Error("upgrade history must be private and on the upgrade filesystem");
  }
}

async function syncRetirementParents(
  history: string,
  upgrade: string,
  deps: HomeUpgradeHistoryDeps,
): Promise<void> {
  const sync = deps.syncHistoryDirectory ?? syncDirectory;
  await sync(history);
  await deps.retirementCheckpoint?.("history-synced");
  await sync(upgrade);
  await deps.retirementCheckpoint?.("upgrade-synced");
}

function transactionIdentity(transaction: HomeUpgradeTransaction): string {
  // Strict parsing has already proven the bounded private journal, stored
  // selector bytes, and every snapshot file against the evidence below.
  // Reuse that closed identity instead of performing a weaker second walk.
  return JSON.stringify(transaction);
}

async function assertDirectDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) {
    throw new Error(`${label} is not a direct owned directory: ${path}`);
  }
}

async function present(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
