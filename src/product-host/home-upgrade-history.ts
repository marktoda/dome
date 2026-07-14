// product-host/home-upgrade-history: terminal proof and immutable retirement.
// The transaction Module owns evidence interpretation. This Module owns the
// lifecycle/operational serialization and the one active -> history rename.

import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  acquireOperationalWriterLease,
  inspectOperationalWriterBarrier,
  operationalWriterCoordinatorPath,
} from "../operational-state/writer-barrier";
import { publishDirectoryExclusive, publishPathExclusive } from "../platform/exclusive-rename";
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
  readHomeUpgradeHistoryIdentity,
  type HomeUpgradeTransaction,
  type HomeUpgradeTransactionDeps,
} from "./home-upgrade-transaction";

const HOME_UPGRADE_TERMINAL_SUMMARY_SCHEMA = "dome.home-upgrade-terminal-summary/v1" as const;
const MAX_SUMMARY_BYTES = 4096;

export type HomeUpgradeHistorySummary = {
  readonly schema: typeof HOME_UPGRADE_TERMINAL_SUMMARY_SCHEMA;
  readonly operationId: string;
  readonly candidate: {
    readonly artifactId: string;
    readonly productVersion: string;
  };
  readonly outcome: "committed" | "restored";
  readonly terminalAt: string;
};

export type HomeUpgradeTerminalService = {
  readonly state: "ready" | "stopped";
  readonly artifactId: string;
  readonly productVersion: string;
};

export type HomeUpgradeRetirementCheckpoint =
  | "summary-published"
  | "receipts-published"
  | "before-rename"
  | "after-rename"
  | "history-synced"
  | "upgrade-synced";

export type HomeUpgradeHistoryDeps = HomeUpgradeTransactionDeps &
  HomeLifecycleDeps &
  HomeLifecycleMutationDeps & {
    readonly publishHistory?: ((source: string, target: string) => Promise<void>) | undefined;
    readonly publishReceipt?: ((source: string, target: string) => Promise<void>) | undefined;
    readonly syncHistoryDirectory?: ((path: string) => Promise<void>) | undefined;
    readonly inspectTerminalService?: ((vaultPath: string) => Promise<HomeUpgradeTerminalService>) | undefined;
    /** Test-only race seam for O(1) active-precedence readers. */
    readonly receiptCheckpoint?: ((name: "candidate-active-observed" | "latest-active-observed") => Promise<void>) | undefined;
    /** Test/diagnostic crash seam around the one atomic retirement boundary. */
    readonly retirementCheckpoint?: ((name: HomeUpgradeRetirementCheckpoint) => Promise<void>) | undefined;
  };

export type HomeUpgradeRetirement = {
  readonly transaction: HomeUpgradeTransaction;
  /** False means a prior process completed the atomic move. */
  readonly retired: boolean;
};

/**
 * O(1) failed-candidate lookup. History GC invalidates its derived receipt by
 * removing the referenced immutable transaction; stale receipts then miss.
 */
export async function readHomeUpgradeCandidateReceipt(
  vaultPath: string,
  artifactId: string,
  deps: HomeUpgradeHistoryDeps = {},
): Promise<HomeUpgradeHistorySummary | null> {
  assertArtifactId(artifactId);
  const vault = await realpath(resolve(vaultPath));
  const paths = homeInstallationPaths(vault, deps);
  const upgrade = join(paths.installations, "upgrade");
  if (!await present(upgrade)) return null;
  await assertDirectDirectory(upgrade, "upgrade root");
  if ((await inspectActiveSummary(upgrade, "candidate", deps)).kind === "active") return null;
  if (!await inspectReceiptRoots(upgrade)) return null;
  const receipt = join(upgrade, "receipts", "candidates", `${artifactId}.json`);
  const summary = await readTerminalSummary(receipt);
  if (summary === null) return null;
  if (summary.outcome !== "restored" || summary.candidate.artifactId !== artifactId) {
    throw new Error("Dome Home failed-candidate receipt has invalid identity");
  }
  const archived = await validateArchivedReceipt(vault, upgrade, summary, deps);
  if ((await inspectActiveSummary(upgrade, "candidate", deps)).kind === "active") return null;
  return archived;
}

/** O(1) latest terminal status without walking immutable history. */
export async function readLatestHomeUpgradeSummary(
  vaultPath: string,
  deps: HomeUpgradeHistoryDeps = {},
): Promise<HomeUpgradeHistorySummary | null> {
  const vault = await realpath(resolve(vaultPath));
  const paths = homeInstallationPaths(vault, deps);
  const upgrade = join(paths.installations, "upgrade");
  if (!await present(upgrade)) return null;
  await assertDirectDirectory(upgrade, "upgrade root");
  const active = await inspectActiveSummary(upgrade, "latest", deps);
  if (active.kind === "active") return active.summary;
  if (!await inspectReceiptRoots(upgrade)) return null;
  const summary = await readTerminalSummary(join(upgrade, "receipts", "latest.json"));
  const archived = summary === null ? null : await validateArchivedReceipt(vault, upgrade, summary, deps);
  const after = await inspectActiveSummary(upgrade, "latest", deps);
  return after.kind === "active" ? after.summary : archived;
}

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
    const summary = await requireExactSummary(join(destination, "summary.json"), terminalSummary(prior));
    await publishDerivedReceipts(vault, upgrade, summary, deps);
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

  // The immutable summary and its O(1) derived receipts become durable while
  // active remains authoritative. Therefore any crash before rename retries
  // from active, while every crash after rename already has lookup receipts.
  const summary = terminalSummary(finalTerminal);
  await publishTerminalSummary(active, upgrade, summary, deps);
  await deps.retirementCheckpoint?.("summary-published");
  await publishDerivedReceipts(vault, upgrade, summary, deps);
  await deps.retirementCheckpoint?.("receipts-published");

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
  await requireExactSummary(join(destination, "summary.json"), summary);
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

function terminalSummary(transaction: HomeUpgradeTransaction): HomeUpgradeHistorySummary {
  const terminalAt = transaction.phase === "committed"
    ? transaction.timestamps.committedAt
    : transaction.phase === "restored" ? transaction.timestamps.restoredAt : null;
  if (terminalAt === null) throw new Error("terminal Dome Home upgrade lacks its terminal timestamp");
  return Object.freeze({
    schema: HOME_UPGRADE_TERMINAL_SUMMARY_SCHEMA,
    operationId: transaction.transactionId,
    candidate: Object.freeze({
      artifactId: transaction.candidate.artifactId,
      productVersion: transaction.candidate.version,
    }),
    outcome: transaction.phase as "committed" | "restored",
    terminalAt,
  });
}

async function publishTerminalSummary(
  active: string,
  upgrade: string,
  summary: HomeUpgradeHistorySummary,
  deps: HomeUpgradeHistoryDeps,
): Promise<void> {
  await publishExactSummary(join(active, "summary.json"), summary, upgrade, deps);
  const sync = deps.syncHistoryDirectory ?? syncDirectory;
  await sync(active);
  await sync(upgrade);
}

async function publishDerivedReceipts(
  vault: string,
  upgrade: string,
  summary: HomeUpgradeHistorySummary,
  deps: HomeUpgradeHistoryDeps,
): Promise<void> {
  const receipts = join(upgrade, "receipts");
  const candidates = join(receipts, "candidates");
  await ensurePrivateDirectory(receipts, upgrade, deps);
  await ensurePrivateDirectory(candidates, receipts, deps);
  if (summary.outcome === "restored") {
    const candidate = join(candidates, `${summary.candidate.artifactId}.json`);
    const existing = await readTerminalSummary(candidate);
    if (existing === null) {
      await publishExactSummary(candidate, summary, receipts, deps);
    } else if (summaryIdentity(existing) !== summaryIdentity(summary)) {
      const archived = await validateArchivedReceipt(vault, upgrade, existing, deps);
      if (archived === null) {
        await unlink(candidate);
        await (deps.syncHistoryDirectory ?? syncDirectory)(candidates);
        await publishExactSummary(candidate, summary, receipts, deps);
      }
      // A still-referenced first rollback remains authoritative for this
      // candidate, so its exclusive failure receipt is intentionally kept.
    }
  }
  await replaceLatestSummary(vault, join(receipts, "latest.json"), summary, deps);
  const sync = deps.syncHistoryDirectory ?? syncDirectory;
  await sync(candidates);
  await sync(receipts);
  await sync(upgrade);
}

async function publishExactSummary(
  destination: string,
  summary: HomeUpgradeHistorySummary,
  temporaryParent: string,
  deps: HomeUpgradeHistoryDeps,
): Promise<void> {
  const existing = await readTerminalSummary(destination);
  if (existing !== null) {
    if (summaryIdentity(existing) !== summaryIdentity(summary)) {
      throw new Error(`Dome Home terminal summary conflicts at ${destination}`);
    }
    return;
  }
  const temporary = join(temporaryParent, `.summary-${summary.operationId}.tmp`);
  await rm(temporary, { force: true });
  try {
    await writePrivateSummary(temporary, summary);
    const publish = deps.publishReceipt ?? ((source: string, target: string) => publishPathExclusive({
      source,
      target,
      ...(deps.platform === undefined ? {} : { platform: deps.platform }),
    }));
    try { await publish(temporary, destination); }
    catch (error) {
      const winner = await readTerminalSummary(destination);
      if (winner === null || summaryIdentity(winner) !== summaryIdentity(summary)) throw error;
    }
    await (deps.syncHistoryDirectory ?? syncDirectory)(dirname(destination));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function replaceLatestSummary(
  vault: string,
  destination: string,
  summary: HomeUpgradeHistorySummary,
  deps: HomeUpgradeHistoryDeps,
): Promise<void> {
  const existing = await readTerminalSummary(destination);
  if (existing !== null && await validateArchivedReceipt(
    vault,
    dirname(dirname(destination)),
    existing,
    deps,
  ) !== null &&
    (existing.terminalAt > summary.terminalAt ||
      (existing.terminalAt === summary.terminalAt && existing.operationId >= summary.operationId))) return;
  const temporary = join(dirname(destination), `.latest-${summary.operationId}.tmp`);
  await rm(temporary, { force: true });
  try {
    await writePrivateSummary(temporary, summary);
    await rename(temporary, destination);
    await (deps.syncHistoryDirectory ?? syncDirectory)(dirname(destination));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writePrivateSummary(path: string, summary: HomeUpgradeHistorySummary): Promise<void> {
  const body = `${JSON.stringify(summary)}\n`;
  if (Buffer.byteLength(body) > MAX_SUMMARY_BYTES) throw new Error("Dome Home terminal summary exceeds its byte budget");
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
}

async function readTerminalSummary(path: string): Promise<HomeUpgradeHistorySummary | null> {
  const bytes = await readBoundedPrivateFile(path, MAX_SUMMARY_BYTES, "Dome Home terminal summary");
  if (bytes === null) return null;
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Dome Home terminal summary is corrupt"); }
  return parseTerminalSummary(value);
}

async function readBoundedPrivateFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw new Error(`${label} cannot be opened without following links: ${message(error)}`);
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o777n) !== 0o600n ||
      before.size === 0n || before.size > BigInt(maxBytes)) {
      throw new Error(`${label} is not a bounded private file`);
    }
    await assertOpenedPath(path, before, label);
    const expected = Number(before.size);
    const bytes = Buffer.alloc(expected + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (offset !== expected || !sameFileStat(before, after)) {
      throw new Error(`${label} changed during bounded inspection`);
    }
    await assertOpenedPath(path, after, label);
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

async function requireExactSummary(
  path: string,
  expected: HomeUpgradeHistorySummary,
): Promise<HomeUpgradeHistorySummary> {
  const summary = await readTerminalSummary(path);
  if (summary === null || summaryIdentity(summary) !== summaryIdentity(expected)) {
    throw new Error("immutable Dome Home history lacks its exact terminal summary");
  }
  return summary;
}

async function validateArchivedReceipt(
  vault: string,
  upgrade: string,
  receipt: HomeUpgradeHistorySummary,
  deps: HomeUpgradeHistoryDeps,
): Promise<HomeUpgradeHistorySummary | null> {
  const proof = await readHomeUpgradeHistoryIdentity(vault, receipt.operationId, deps);
  if (proof === null) return null;
  if (summaryProofIdentity(proof) !== summaryProofIdentity(receipt)) {
    throw new Error("Dome Home terminal receipt disagrees with its archived upgrade journal");
  }
  const archived = await readTerminalSummary(join(upgrade, "history", receipt.operationId, "summary.json"));
  if (archived === null || summaryIdentity(archived) !== summaryIdentity(receipt)) {
    throw new Error("Dome Home terminal receipt disagrees with immutable history");
  }
  // Future GC must first atomically rename the whole history/<operation-id>
  // directory out of history, then recursively delete it. The transaction
  // Module rejects a partial in-place root, while an absent root expires the
  // derived receipt without enumerating history.
  return archived;
}

function parseTerminalSummary(value: unknown): HomeUpgradeHistorySummary {
  const root = exactRecord(value, "Dome Home terminal summary", [
    "schema", "operationId", "candidate", "outcome", "terminalAt",
  ]);
  const candidate = exactRecord(root["candidate"], "Dome Home terminal summary candidate", [
    "artifactId", "productVersion",
  ]);
  if (root["schema"] !== HOME_UPGRADE_TERMINAL_SUMMARY_SCHEMA ||
    typeof root["operationId"] !== "string" || !isOperationId(root["operationId"]) ||
    (root["outcome"] !== "committed" && root["outcome"] !== "restored") ||
    typeof root["terminalAt"] !== "string" || !isExactTimestamp(root["terminalAt"]) ||
    typeof candidate["artifactId"] !== "string" || !isArtifactId(candidate["artifactId"]) ||
    typeof candidate["productVersion"] !== "string" || candidate["productVersion"].length === 0 ||
    candidate["productVersion"].length > 1024) {
    throw new Error("Dome Home terminal summary has invalid fields");
  }
  return Object.freeze({
    schema: HOME_UPGRADE_TERMINAL_SUMMARY_SCHEMA,
    operationId: root["operationId"],
    candidate: Object.freeze({
      artifactId: candidate["artifactId"],
      productVersion: candidate["productVersion"],
    }),
    outcome: root["outcome"],
    terminalAt: root["terminalAt"],
  } as HomeUpgradeHistorySummary);
}

function exactRecord(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} has unknown or missing keys`);
  return value as Record<string, unknown>;
}

function summaryIdentity(summary: HomeUpgradeHistorySummary): string { return JSON.stringify(summary); }
function summaryProofIdentity(summary: Omit<HomeUpgradeHistorySummary, "schema">): string {
  return JSON.stringify({
    operationId: summary.operationId,
    candidate: summary.candidate,
    outcome: summary.outcome,
    terminalAt: summary.terminalAt,
  });
}
function isArtifactId(value: string): boolean { return /^[0-9a-f]{64}$/.test(value); }
function assertArtifactId(value: string): void {
  if (!isArtifactId(value)) throw new Error("Dome Home artifact id is invalid");
}
function isOperationId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
function isExactTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function sameFileStat(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mode === right.mode && left.nlink === right.nlink && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

async function assertOpenedPath(path: string, opened: BigIntStats, label: string): Promise<void> {
  const current = await lstat(path, { bigint: true });
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino ||
    await realpath(path) !== resolve(path)) {
    throw new Error(`${label} path changed during bounded inspection`);
  }
}

async function inspectActiveSummary(
  upgrade: string,
  consumer: "candidate" | "latest",
  deps: HomeUpgradeHistoryDeps,
): Promise<
  | { readonly kind: "inactive" }
  | { readonly kind: "active"; readonly summary: HomeUpgradeHistorySummary | null }
> {
  const active = join(upgrade, "active");
  try { await lstat(active); }
  catch (error) {
    if (hasCode(error, "ENOENT")) return Object.freeze({ kind: "inactive" as const });
    throw error;
  }
  await deps.receiptCheckpoint?.(`${consumer}-active-observed`);
  try {
    await assertDirectDirectory(active, "upgrade active transaction");
    return Object.freeze({
      kind: "active" as const,
      summary: await readTerminalSummary(join(active, "summary.json")),
    });
  } catch (error) {
    // Retirement's one atomic active -> history rename can linearize between
    // observation and open. The caller then validates the already-durable
    // receipt/history pair and performs one final active-precedence recheck.
    if (hasCode(error, "ENOENT")) return Object.freeze({ kind: "inactive" as const });
    throw error;
  }
}

async function inspectReceiptRoots(upgrade: string): Promise<boolean> {
  const receipts = join(upgrade, "receipts");
  const candidates = join(receipts, "candidates");
  if (!await present(receipts) || !await present(candidates)) return false;
  await assertPrivateSameDevice(receipts, upgrade, "upgrade receipts root");
  await assertPrivateSameDevice(candidates, receipts, "upgrade candidate receipts root");
  return true;
}

async function assertPrivateSameDevice(path: string, parent: string, label: string): Promise<void> {
  await assertDirectDirectory(path, label);
  const info = await lstat(path);
  const parentInfo = await lstat(parent);
  if ((info.mode & 0o777) !== 0o700 || info.dev !== parentInfo.dev) {
    throw new Error(`${label} must be private and on its parent filesystem`);
  }
}

async function ensurePrivateDirectory(
  path: string,
  parent: string,
  deps: HomeUpgradeHistoryDeps,
): Promise<void> {
  if (!await present(path)) {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
  }
  await assertDirectDirectory(path, "upgrade receipt directory");
  const info = await lstat(path);
  const parentInfo = await lstat(parent);
  if ((info.mode & 0o777) !== 0o700 || info.dev !== parentInfo.dev) {
    throw new Error("upgrade receipt directory must be private and on the upgrade filesystem");
  }
  await (deps.syncHistoryDirectory ?? syncDirectory)(parent);
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

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
