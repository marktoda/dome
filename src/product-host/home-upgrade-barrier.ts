// product-host/home-upgrade-barrier: external durable evidence Adapter over
// the neutral operational-writer coordinator.

import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  engageOperationalWriterBarrier,
  inspectOperationalWriterBarrier,
  type OperationalWriterBarrierOwner,
  releaseOperationalWriterBarrier,
  withOperationalWriterBarrierOwnership,
} from "../operational-state/writer-barrier";
import {
  homeInstallationPaths,
  type HomeInstallationDeps,
} from "./home-installation";

export const HOME_UPGRADE_WRITER_BARRIER_SCHEMA =
  "dome.home-upgrade-writer-barrier/v1" as const;

export type HomeUpgradeWriterBarrier = {
  readonly schema: typeof HOME_UPGRADE_WRITER_BARRIER_SCHEMA;
  readonly vault: string;
  readonly transactionId: string;
  readonly protocol: 1;
  readonly engagedAt: string;
};

export type HomeUpgradeBarrierDeps = HomeInstallationDeps;

export type HomeUpgradeBarrierOwner = {
  readonly transactionId: string;
  readonly engagedAt: string;
  readonly release: (validateTerminal: () => Promise<void>) => Promise<void>;
};

export async function engageHomeUpgradeBarrier(input: {
  readonly vaultPath: string;
  readonly transactionId: string;
  readonly now?: Date;
}, deps: HomeUpgradeBarrierDeps = {}): Promise<HomeUpgradeWriterBarrier> {
  const vault = await canonicalVault(input.vaultPath);
  // Establish a direct, durable external publication path before closing
  // vault write admission. Failures before core engagement remain harmless.
  const path = await markerPath(vault, deps, true);
  if (path === null) throw new Error("external upgrade writer barrier path is unavailable");
  const engaged = await engageOperationalWriterBarrier({
    vaultPath: vault,
    transactionId: input.transactionId,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if (!engaged.ok) {
    throw new Error(`operational writer barrier could not engage: ${engaged.error.kind}`);
  }

  const marker: HomeUpgradeWriterBarrier = Object.freeze({
    schema: HOME_UPGRADE_WRITER_BARRIER_SCHEMA,
    vault,
    transactionId: input.transactionId,
    protocol: 1 as const,
    engagedAt: engaged.blockedAt,
  });
  if (await present(path)) {
    const current = await readHomeUpgradeBarrier(vault, deps);
    if (
      current === null || current.transactionId !== input.transactionId ||
      current.engagedAt !== engaged.blockedAt
    ) {
      throw new Error("external upgrade writer barrier is owned by another transaction");
    }
    return current;
  }

  const temporary = join(dirname(path), `.writer-barrier-${process.pid}-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(marker, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  await chmod(temporary, 0o600);
  try {
    try { await link(temporary, path); }
    catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const current = await readHomeUpgradeBarrier(vault, deps);
      if (
        current === null || current.transactionId !== input.transactionId ||
        current.engagedAt !== engaged.blockedAt
      ) {
        throw new Error("external upgrade writer barrier is owned by another transaction");
      }
      return current;
    }
    await fsyncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
    await fsyncDirectory(dirname(path));
  }
  return marker;
}

export async function readHomeUpgradeBarrier(
  vaultPath: string,
  deps: HomeUpgradeBarrierDeps = {},
): Promise<HomeUpgradeWriterBarrier | null> {
  const vault = await canonicalVault(vaultPath);
  const path = await markerPath(vault, deps, false);
  if (path === null || !await present(path)) return null;
  const info = await lstat(path);
  if (
    !info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 ||
    (info.mode & 0o777) !== 0o600 || info.nlink !== 1
  ) {
    throw new Error("external upgrade writer barrier is not a bounded regular file");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error("external upgrade writer barrier is corrupt"); }
  return parseMarker(parsed, vault);
}

/** Hold SQLite EXCLUSIVE for the complete prepare/restore recovery section. */
export async function withHomeUpgradeBarrierOwnership<T>(input: {
  readonly vaultPath: string;
  readonly transactionId: string;
}, deps: HomeUpgradeBarrierDeps, operation: (
  owner: HomeUpgradeBarrierOwner,
) => Promise<T>): Promise<
  | { readonly kind: "owned"; readonly value: T }
  | { readonly kind: "not-owned"; readonly transactionId: string | null }
> {
  const vault = await canonicalVault(input.vaultPath);
  return withOperationalWriterBarrierOwnership({
    vaultPath: vault,
    transactionId: input.transactionId,
  }, async (owner) => operation(homeOwner(vault, deps, owner)));
}

export async function releaseHomeUpgradeBarrier(input: {
  readonly vaultPath: string;
  readonly transactionId: string;
  readonly validateTerminal: () => Promise<void>;
}, deps: HomeUpgradeBarrierDeps = {}): Promise<void> {
  const vault = await canonicalVault(input.vaultPath);
  const inspection = await inspectOperationalWriterBarrier(vault);
  if (
    inspection.transactionId !== input.transactionId ||
    inspection.blockedAt === null
  ) {
    throw new Error("operational writer barrier is not owned by this transaction");
  }
  const blockedAt = inspection.blockedAt;
  await releaseOperationalWriterBarrier({
    vaultPath: vault,
    transactionId: input.transactionId,
    validateAndRemoveExternalEvidence: async () => {
      await input.validateTerminal();
      await removeExternalMarker(
        vault,
        deps,
        input.transactionId,
        blockedAt,
      );
    },
  });
}

function homeOwner(
  vault: string,
  deps: HomeUpgradeBarrierDeps,
  owner: OperationalWriterBarrierOwner,
): HomeUpgradeBarrierOwner {
  return Object.freeze({
    transactionId: owner.transactionId,
    engagedAt: owner.blockedAt,
    release: async (validateTerminal) => owner.release(async () => {
      await validateTerminal();
      await removeExternalMarker(vault, deps, owner.transactionId, owner.blockedAt);
    }),
  });
}

async function removeExternalMarker(
  vault: string,
  deps: HomeUpgradeBarrierDeps,
  transactionId: string,
  engagedAt: string,
): Promise<void> {
  const current = await readHomeUpgradeBarrier(vault, deps);
  // Marker removal is deliberately before the coordinator clear. A crash
  // after unlink+fsync resumes with blocked coordinator and an absent marker.
  if (
    current !== null &&
    (current.transactionId !== transactionId || current.engagedAt !== engagedAt)
  ) {
    throw new Error("external upgrade writer barrier is missing or has the wrong owner");
  }
  const path = await markerPath(vault, deps, false);
  if (path === null) throw new Error("external upgrade writer barrier path is missing");
  if (current !== null) await unlink(path);
  await fsyncDirectory(dirname(path));
}

async function markerPath(
  vault: string,
  deps: HomeUpgradeBarrierDeps,
  create: boolean,
): Promise<string | null> {
  const paths = homeInstallationPaths(vault, deps);
  const chain = [paths.root, dirname(paths.installations), paths.installations];
  for (const path of chain) {
    if (!await present(path)) {
      if (!create) return null;
      throw new Error("Dome Home must be installed before an upgrade barrier engages");
    }
    await assertDirectDirectory(path);
  }
  const upgrade = join(paths.installations, "upgrade");
  if (!await present(upgrade)) {
    if (!create) return null;
    let created = false;
    try {
      await mkdir(upgrade, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    if (created) {
      await fsyncDirectory(upgrade);
      await fsyncDirectory(paths.installations);
    }
  }
  await assertDirectDirectory(upgrade);
  return join(upgrade, "writer-barrier.json");
}

function parseMarker(value: unknown, vault: string): HomeUpgradeWriterBarrier {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("external upgrade writer barrier must be an object");
  }
  const record = value as Record<string, unknown>;
  const expected = ["engagedAt", "protocol", "schema", "transactionId", "vault"];
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expected)) {
    throw new Error("external upgrade writer barrier has unknown or missing fields");
  }
  if (
    record["schema"] !== HOME_UPGRADE_WRITER_BARRIER_SCHEMA ||
    record["vault"] !== vault ||
    record["protocol"] !== 1 ||
    typeof record["transactionId"] !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record["transactionId"]) ||
    typeof record["engagedAt"] !== "string" ||
    !isExactTimestamp(record["engagedAt"])
  ) throw new Error("external upgrade writer barrier has invalid fixed fields");
  return Object.freeze(record as unknown as HomeUpgradeWriterBarrier);
}

function isExactTimestamp(value: string): boolean {
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

async function canonicalVault(path: string): Promise<string> {
  return realpath(resolve(path));
}

async function assertDirectDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) {
    throw new Error(`external upgrade writer barrier ancestor is redirected: ${path}`);
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function present(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { readonly code?: unknown }).code === code;
}
