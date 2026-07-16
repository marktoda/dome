// backup/vault-backup: one deep Module for encrypted, offline Dome backups.
// The CLI supplies paths; source admission, Home fencing, exact inventory,
// SQLite snapshots, archive validation, encryption, and publication live here.

import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir,
  realpath, rename, rm, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

import { openDeviceAuthority } from "../device-authority/device-authority";
import { compareStrings } from "../core/compare";
import { withExclusiveFileLock } from "../engine/host/file-lock";
import { acquireOperationalWriterLease } from "../operational-state/writer-barrier";
import {
  checkoutPathsAtRef,
  readStandaloneBackupSource,
  readStandaloneBackupBlob,
  validateStandaloneBackupRepository,
  type StandaloneBackupTreeEntry,
} from "../git";
import { publishDirectoryExclusive, publishPathExclusive } from "../platform/exclusive-rename";
import { snapshotSqliteReadonly, validateSqliteSnapshot } from "../sqlite/snapshot";
import {
  withSupervisedHomeSuspended,
  type HomeLifecycleSuspensionDeps,
  type SupervisedHomeSuspensionResult,
} from "../product-host/home-lifecycle-suspension";
import { withProductHostOwnership } from "../product-host/host-ownership";
import type { ServiceDeps } from "../surface/service-probe";
import { extractTarTree, inspectTar, readTarFile, writeTarTree, type TarEntry } from "./tar";

export const BACKUP_SCHEMA = "dome.backup/v1" as const;
export const BACKUP_MANIFEST_SCHEMA = "dome.backup-manifest/v1" as const;

const DATABASES = [
  { name: "answers.db", durability: "durable" },
  { name: "proposals.db", durability: "durable" },
  { name: "outbox.db", durability: "durable" },
  { name: "runs.db", durability: "durable" },
  { name: "request-receipts.db", durability: "durable" },
  { name: "device-authority.db", durability: "durable" },
  { name: "projection.db", durability: "rebuildable" },
] as const;
const DURABLE_FILES = new Set(["quarantined.json", "product-host-id"]);
const TRANSIENT_FILES = new Set([
  "serve-heartbeat.json", "model-provider-probe.json", "serve.log",
  "serve-daemon.log", "home.log", "last-reconcile-mtime.txt",
  "scheduled.json", "last-reconciled-sha.txt",
]);
const BACKUP_EXCLUSIONS = Object.freeze([
  ".dome/state/locks/**", ".dome/state/*-wal", ".dome/state/*-shm",
  ".dome/state/*.log", ".dome/state/serve-heartbeat.json",
  ".dome/state/model-provider-probe.json", ".git/logs/**", ".git/index",
  ".dome/state/last-reconcile-mtime.txt", ".dome/state/scheduled.json",
  ".dome/state/last-reconciled-sha.txt", ".git/**/*.lock",
]);
const EXTERNAL_GIT_OBJECT_PATHS = [
  "objects/info/alternates",
  "objects/info/http-alternates",
] as const;

export type BackupResult = {
  readonly schema: typeof BACKUP_SCHEMA;
  readonly operation: "keygen" | "create" | "verify" | "restore";
  readonly status: "created" | "verified" | "restored" | "error";
  readonly exitCode: 0 | 1 | 64;
  readonly output?: string;
  readonly archive?: string;
  readonly recipient?: string;
  readonly backupId?: string;
  readonly sha256?: string;
  readonly target?: string;
  readonly authEpoch?: number | null;
  readonly authority?: "invalidated" | "absent";
  readonly durability?: "durable" | "uncertain";
  readonly restart?: "not-running" | "restarted" | "failed";
  readonly restartError?: string;
  readonly error?: string;
};

type BackupEntry = {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly mode: number;
  readonly size: number;
  readonly sha256?: string;
};

type BackupManifest = {
  readonly schema: typeof BACKUP_MANIFEST_SCHEMA;
  readonly backupId: string;
  readonly createdAt: string;
  readonly source: {
    readonly vaultId: string | null;
    readonly branch: string;
    readonly head: string;
    readonly refs: ReadonlyArray<{ readonly name: string; readonly oid: string }>;
    readonly refDigest: string;
    readonly repositoryDigest: string;
    readonly policy: "clean-committed-standalone";
  };
  readonly databases: ReadonlyArray<{ readonly name: string; readonly durability: "durable" | "rebuildable"; readonly present: boolean }>;
  readonly exclusions: ReadonlyArray<string>;
  readonly restore: { readonly invalidateDeviceAuthority: true; readonly projectionRebuildable: true };
  readonly entries: ReadonlyArray<BackupEntry>;
};

const hexOid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const entrySchema = z.object({
  path: z.string().min(1),
  type: z.enum(["file", "directory"]),
  mode: z.number().int().min(0).max(0o777),
  size: z.number().int().nonnegative().max(64 * 1024 * 1024 * 1024),
  sha256: sha256Schema.optional(),
}).strict();
const manifestSchema = z.object({
  schema: z.literal(BACKUP_MANIFEST_SCHEMA),
  backupId: z.string().uuid(),
  createdAt: z.string().datetime(),
  source: z.object({
    vaultId: z.string().min(1).nullable(), branch: z.string().min(1), head: hexOid,
    refs: z.array(z.object({ name: z.string().regex(/^refs\/[A-Za-z0-9._\/-]+$/), oid: hexOid }).strict()),
    refDigest: sha256Schema, repositoryDigest: sha256Schema,
    policy: z.literal("clean-committed-standalone"),
  }).strict(),
  databases: z.array(z.object({
    name: z.enum(DATABASES.map((entry) => entry.name) as [typeof DATABASES[number]["name"], ...Array<typeof DATABASES[number]["name"]>]),
    durability: z.enum(["durable", "rebuildable"]), present: z.boolean(),
  }).strict()),
  exclusions: z.array(z.string()),
  restore: z.object({ invalidateDeviceAuthority: z.literal(true), projectionRebuildable: z.literal(true) }).strict(),
  entries: z.array(entrySchema),
}).strict();

type SourceSnapshot = Omit<BackupManifest["source"], "policy">;
type InspectedSource = {
  readonly manifest: SourceSnapshot;
  readonly tree: ReadonlyArray<StandaloneBackupTreeEntry>;
  readonly worktreeDigest: string;
};

export type BackupDeps = ServiceDeps & Pick<
  HomeLifecycleSuspensionDeps,
  "applicationSupportDir" | "legacyServeRunning" | "checkpoint"
> & {
  readonly agePath?: string;
  readonly ageKeygenPath?: string;
  readonly now?: () => Date;
  readonly beforeSourceRecheck?: (() => Promise<void>) | undefined;
  readonly syncBackupParent?: ((parent: string) => Promise<void>) | undefined;
  readonly readiness?: (() => Promise<boolean>) | undefined;
  readonly readinessTimeoutMs?: number;
  readonly publishRestoredVault?: ((source: string, target: string) => Promise<void>) | undefined;
  readonly syncRestoreTree?: ((vault: string) => Promise<void>) | undefined;
  readonly syncRestoreParent?: ((parent: string) => Promise<void>) | undefined;
};

export async function generateBackupIdentity(input: {
  readonly output: string;
}, deps: BackupDeps = {}): Promise<BackupResult> {
  const output = resolve(input.output);
  if (await exists(output)) return failure("keygen", `identity already exists: ${output}`, 64);
  const temporary = join(dirname(output), `.${basename(output)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await mkdir(dirname(output), { recursive: true });
    await run([deps.ageKeygenPath ?? "age-keygen", "-o", temporary]);
    await chmod(temporary, 0o600);
    const recipient = (await run([deps.ageKeygenPath ?? "age-keygen", "-y", temporary])).stdout.trim();
    if (!recipient.startsWith("age1")) throw new Error("age-keygen did not return an X25519 recipient");
    await rename(temporary, output);
    await fsyncPath(output);
    await fsyncDirectory(dirname(output));
    return Object.freeze({ schema: BACKUP_SCHEMA, operation: "keygen", status: "created", exitCode: 0, output, recipient });
  } catch (error) {
    await rm(temporary, { force: true });
    return failure("keygen", message(error));
  }
}

export async function createVaultBackup(input: {
  readonly vaultPath: string;
  readonly output: string;
  readonly recipient: string;
}, deps: BackupDeps = {}): Promise<BackupResult> {
  const vault = resolve(input.vaultPath);
  let canonicalVault: string;
  let output: string;
  try {
    canonicalVault = await realpath(vault);
    output = await canonicalNewOutput(input.output);
  } catch (error) { return failure("create", message(error), 64); }
  if (!input.recipient.startsWith("age1")) return failure("create", "recipient must be an age X25519 public recipient", 64);
  if (await exists(output)) return failure("create", `backup output already exists: ${output}`, 64);
  if (isWithin(canonicalVault, output)) return failure("create", "backup output must be outside the vault", 64);

  const operationId = randomUUID();
  let suspended: SupervisedHomeSuspensionResult<BackupResult>;
  let operationResult: BackupResult | undefined;
  try {
    suspended = await withSupervisedHomeSuspended({
      mode: "new",
      vaultPath: canonicalVault,
      purpose: "backup",
      operationId,
    }, async () => {
      try {
        const admission = await acquireOperationalWriterLease({
          vaultPath: canonicalVault,
          command: "dome-backup-create",
        });
        if (!admission.ok) {
          operationResult = failure("create", `operational write admission is closed: ${admission.error.kind}`);
          return operationResult;
        }
        try {
          const owned = await withProductHostOwnership(
            canonicalVault,
            async () => {
              operationResult = await createWhileFenced(canonicalVault, output, input.recipient, deps);
              return operationResult;
            },
          );
          if (owned.kind === "busy") {
            operationResult = failure("create", "Dome Home, upgrade probation, or another backup owns the vault; stop it and retry");
          } else {
            operationResult = owned.value;
          }
          return operationResult;
        } finally {
          admission.lease.close();
        }
      } catch (error) {
        operationResult = operationResult === undefined
          ? failure("create", message(error))
          : Object.freeze({
              ...operationResult,
              exitCode: 1,
              error: operationResult.error === undefined
                ? `backup operation cleanup failed: ${message(error)}`
                : `${operationResult.error}; backup operation cleanup also failed: ${message(error)}`,
            });
        return operationResult;
      }
    }, deps);
  } catch (error) {
    if (operationResult === undefined) return failure("create", message(error));
    return Object.freeze({
      ...operationResult,
      exitCode: 1,
      restart: "failed",
      restartError: `Home suspension ${operationId} failed after the backup operation: ${message(error)}`,
    });
  }
  return backupSuspensionResult(suspended);
}

function backupSuspensionResult(result: SupervisedHomeSuspensionResult<BackupResult>): BackupResult {
  if (result.kind === "ready" || result.kind === "not-required") {
    if (!result.operationRan || result.value === undefined) {
      return Object.freeze({
        ...failure("create", `Home suspension ${result.operationId} resumed without running the backup`),
        restart: result.kind === "ready" ? "restarted" as const : "not-running" as const,
      });
    }
    return Object.freeze({
      ...result.value,
      restart: result.kind === "ready" ? "restarted" as const : "not-running" as const,
    });
  }

  const archive = result.operationRan && result.value !== undefined
    ? result.value
    : failure("create", result.kind === "failed"
      ? `Home suspension ${result.operationId} did not run the backup: ${result.error}`
      : `Home suspension ${result.operationId} did not run the backup because operational write admission is closed by ${result.transactionId}`);
  const restartError = result.kind === "deferred"
    ? `Home suspension ${result.operationId} could not resume because operational write admission is closed by ${result.transactionId}`
    : `Home suspension ${result.operationId} could not resume: ${result.error}`;
  return Object.freeze({
    ...archive,
    exitCode: 1,
    restart: "failed",
    restartError,
  });
}

export async function verifyVaultBackup(input: {
  readonly archive: string;
  readonly identity: string;
}, deps: BackupDeps = {}): Promise<BackupResult> {
  const archive = resolve(input.archive);
  const identity = resolve(input.identity);
  const temporary = await mkdtemp(join(tmpdir(), "dome-backup-verify-"));
  try {
    const staged = await stageVerifiedBackup({ archive, identity, staging: temporary }, deps);
    return Object.freeze({
      schema: BACKUP_SCHEMA,
      operation: "verify",
      status: "verified",
      exitCode: 0,
      archive,
      backupId: staged.manifest.backupId,
      sha256: await hashFile(archive),
    });
  } catch (error) {
    return failure("verify", message(error));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Restore one verified archive into an absent blank-host vault path. */
export async function restoreVaultBackup(input: {
  readonly archive: string;
  readonly identity: string;
  readonly target: string;
}, deps: BackupDeps = {}): Promise<BackupResult> {
  if (!isAbsolute(input.target)) {
    return failure("restore", "restore target must be an absolute path", 64);
  }
  const archive = resolve(input.archive);
  const identity = resolve(input.identity);
  const requestedTarget = resolve(input.target);
  const requestedParent = dirname(requestedTarget);
  let parent: string;
  let target: string;
  try {
    if (await exists(requestedTarget)) return failure("restore", `restore target must be absent: ${requestedTarget}`, 64);
    await mkdir(requestedParent, { recursive: true });
    parent = await realpath(requestedParent);
    target = join(parent, basename(requestedTarget));
    if (await exists(target)) return failure("restore", `restore target must be absent: ${target}`, 64);
  } catch (error) {
    return failure("restore", message(error));
  }
  try {
    const locked = await withExclusiveFileLock({
      lockPath: join(parent, `.${basename(target)}.restore.lock`),
      command: "dome-backup-restore",
    }, async () => {
      if (await exists(target)) return failure("restore", `restore target must be absent: ${target}`, 64);
      return restoreWhileLocked({ archive, identity, target, parent }, deps);
    });
    return locked.kind === "busy"
      ? failure("restore", `another restore owns the target: ${target}`)
      : locked.value;
  } catch (error) {
    return failure("restore", message(error));
  }
}

async function restoreWhileLocked(input: {
  readonly archive: string;
  readonly identity: string;
  readonly target: string;
  readonly parent: string;
}, deps: BackupDeps): Promise<BackupResult> {
  let staging: string | null = null;
  try {
    staging = await mkdtemp(join(input.parent, `.${basename(input.target)}.restore-`));
    await chmod(staging, 0o700);
    const staged = await stageVerifiedBackup({ archive: input.archive, identity: input.identity, staging }, deps);
    const authority = await invalidateRestoredAuthority(staged.vault);
    await validateReconstructedVault(staged.vault, staged.manifest);
    await (deps.syncRestoreTree ?? fsyncDirectoryTree)(staged.vault);
    if (await exists(input.target)) throw new Error(`restore target appeared before publication: ${input.target}`);
    const publish = deps.publishRestoredVault
      ?? ((source: string, target: string) => publishDirectoryExclusive({ source, target }));
    await publish(staged.vault, input.target);
    const restored = {
      schema: BACKUP_SCHEMA,
      operation: "restore",
      status: "restored",
      archive: input.archive,
      target: input.target,
      backupId: staged.manifest.backupId,
      authEpoch: authority.authEpoch,
      authority: authority.status,
    } as const;
    try {
      await (deps.syncRestoreParent ?? fsyncDirectory)(input.parent);
      return Object.freeze({ ...restored, exitCode: 0 as const, durability: "durable" as const });
    } catch (error) {
      return Object.freeze({
        ...restored,
        exitCode: 1 as const,
        durability: "uncertain" as const,
        error: `restore was published but parent-directory durability is uncertain: ${message(error)}`,
      });
    }
  } catch (error) {
    return failure("restore", message(error));
  } finally {
    if (staging !== null) await rm(staging, { recursive: true, force: true });
  }
}

/** Compatibility wrapper retained for internal recovery rehearsals. */
export async function rehearseBlankTargetRestore(input: {
  readonly archive: string;
  readonly identity: string;
  readonly target: string;
}, deps: BackupDeps = {}): Promise<void> {
  const result = await restoreVaultBackup(input, deps);
  if (result.status !== "restored") throw new Error(result.error ?? "restore rehearsal failed");
}

async function stageVerifiedBackup(input: {
  readonly archive: string;
  readonly identity: string;
  readonly staging: string;
}, deps: BackupDeps): Promise<{ readonly manifest: BackupManifest; readonly vault: string }> {
  const tarPath = join(input.staging, "payload.tar");
  const restored = join(input.staging, "restored");
  await run([deps.agePath ?? "age", "--decrypt", "-i", input.identity, "-o", tarPath, input.archive]);
  const manifest = await validatePlainArchive(tarPath);
  await extractTarStrict(tarPath, restored);
  const vault = join(restored, "vault");
  await validateReconstructedVault(vault, manifest, false);
  await rebuildRestoredGitIndex(vault);
  return Object.freeze({ manifest, vault });
}

async function rebuildRestoredGitIndex(vault: string): Promise<void> {
  const source = await validateStandaloneBackupRepository(vault);
  await checkoutPathsAtRef({
    path: vault,
    ref: source.head,
    filepaths: source.tree.map((entry) => entry.path),
    force: true,
  });
  if (!(await readStandaloneBackupSource(vault)).clean) {
    throw new Error("reconstructed Git index and working tree are not clean at HEAD");
  }
}

async function invalidateRestoredAuthority(
  vault: string,
): Promise<{ readonly status: "invalidated" | "absent"; readonly authEpoch: number | null }> {
  const authorityPath = join(vault, ".dome", "state", "device-authority.db");
  if (!(await exists(authorityPath))) return Object.freeze({ status: "absent", authEpoch: null });
  const opened = await openDeviceAuthority({ path: authorityPath });
  if (!opened.ok) throw new Error(`restored device authority refused to open: ${opened.error.kind}`);
  let authEpoch: number;
  const previousEpoch = opened.value.authority.authEpoch();
  try { authEpoch = opened.value.authority.invalidateAll().authEpoch; } finally { opened.value.authority.close(); }
  if (authEpoch !== previousEpoch + 1) throw new Error("restored device authority epoch did not advance exactly once");
  const checkpoint = new Database(authorityPath);
  try {
    const result = checkpoint.query<{ busy: number; log: number; checkpointed: number }, []>(
      "PRAGMA wal_checkpoint(TRUNCATE)",
    ).get();
    if (result === null || result.busy !== 0) throw new Error("restored device authority WAL checkpoint was busy");
  } finally { checkpoint.close(); }
  await fsyncPath(authorityPath);
  await fsyncDirectory(dirname(authorityPath));
  const reopened = await openDeviceAuthority({ path: authorityPath });
  if (!reopened.ok) throw new Error(`invalidated device authority refused to reopen: ${reopened.error.kind}`);
  try {
    if (reopened.value.authority.authEpoch() !== authEpoch) throw new Error("restored device authority epoch was not durable");
  } finally { reopened.value.authority.close(); }
  return Object.freeze({ status: "invalidated", authEpoch });
}

async function createWhileFenced(vault: string, output: string, recipient: string, deps: BackupDeps): Promise<BackupResult> {
  if (await exists(output)) return failure("create", `backup output already exists: ${output}`, 64);
  const temporary = await mkdtemp(join(tmpdir(), "dome-backup-create-"));
  const root = join(temporary, "dome-backup");
  const stagedVault = join(root, "vault");
  const tarPath = join(temporary, "payload.tar");
  const encrypted = join(dirname(output), `.${basename(output)}.tmp-${process.pid}-${randomUUID()}`);
  let published: BackupResult | undefined;
  let result: BackupResult;
  try {
    const sourceBefore = await inspectSource(vault);
    await assertSourceAdmissible(vault, sourceBefore.manifest);
    const stateBefore = await operationalSourceDigest(vault);
    await mkdir(stagedVault, { recursive: true });
    await copyTrackedTree(vault, sourceBefore.tree, stagedVault);
    await copyGitDirectory(vault, stagedVault);
    const databases = await snapshotOperationalState(vault, stagedVault);
    const vaultEntries = await inventoryTree(stagedVault, "vault");
    const manifest: BackupManifest = Object.freeze({
      schema: BACKUP_MANIFEST_SCHEMA,
      backupId: randomUUID(),
      createdAt: (deps.now?.() ?? new Date()).toISOString(),
      source: Object.freeze({ ...sourceBefore.manifest, policy: "clean-committed-standalone" as const }),
      databases,
      exclusions: BACKUP_EXCLUSIONS,
      restore: Object.freeze({ invalidateDeviceAuthority: true as const, projectionRebuildable: true as const }),
      entries: Object.freeze(vaultEntries),
    });
    await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await deps.beforeSourceRecheck?.();
    const sourceAfter = await inspectSource(vault);
    if (JSON.stringify(sourceAfter.manifest) !== JSON.stringify(sourceBefore.manifest) || sourceAfter.worktreeDigest !== sourceBefore.worktreeDigest) throw new Error("vault Git state changed while the backup was being created");
    await assertSourceAdmissible(vault, sourceAfter.manifest);
    if (await operationalSourceDigest(vault) !== stateBefore) throw new Error("vault operational state changed while the backup was being created");
    const tarEntries = await writeTarTree(root, tarPath);
    assertTarMatchesManifest(tarEntries, manifest);
    await mkdir(dirname(output), { recursive: true });
    await run([deps.agePath ?? "age", "-r", recipient, "-o", encrypted, tarPath]);
    await chmod(encrypted, 0o600);
    await fsyncPath(encrypted);
    const created: BackupResult = Object.freeze({
      schema: BACKUP_SCHEMA,
      operation: "create",
      status: "created",
      exitCode: 0,
      archive: output,
      backupId: manifest.backupId,
      sha256: await hashFile(encrypted),
    });
    await publishPathExclusive({ source: encrypted, target: output });
    published = created;
    await (deps.syncBackupParent ?? fsyncDirectory)(dirname(output));
    result = created;
  } catch (error) {
    let detail = message(error);
    try { await rm(encrypted, { force: true }); }
    catch (cleanupError) { detail = `${detail}; encrypted staging cleanup also failed: ${message(cleanupError)}`; }
    if (published !== undefined) {
      result = Object.freeze({
        ...published,
        exitCode: 1,
        error: `backup archive was published but parent-directory durability is uncertain: ${detail}`,
      });
    } else {
      result = failure("create", detail);
    }
  }
  try { await rm(temporary, { recursive: true, force: true }); }
  catch (cleanupError) {
    result = Object.freeze({
      ...result,
      exitCode: 1,
      error: result.error === undefined
        ? `backup staging cleanup failed: ${message(cleanupError)}`
        : `${result.error}; backup staging cleanup also failed: ${message(cleanupError)}`,
    });
  }
  return result;
}

async function inspectSource(vault: string): Promise<InspectedSource> {
  const source = await readStandaloneBackupSource(vault);
  if (!source.clean) throw new Error("backup requires a clean working tree, including no untracked files");
  const worktreeEntries: Array<{ readonly path: string; readonly mode: number; readonly size: number; readonly sha256: string }> = [];
  for (const entry of source.tree) {
    const path = join(vault, ...entry.path.split("/"));
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`backup requires a regular clean tracked file: ${entry.path}`);
    const worktreeHash = await hashFile(path);
    const committedHash = sha256(await readStandaloneBackupBlob(vault, entry.path));
    if (worktreeHash !== committedHash) throw new Error(`backup requires a clean working tree: ${entry.path}`);
    worktreeEntries.push({ path: entry.path, mode: info.mode & 0o777, size: info.size, sha256: worktreeHash });
  }
  const worktreeDigest = sha256(Buffer.from(JSON.stringify(worktreeEntries)));
  const repositoryDigest = sha256(Buffer.from(JSON.stringify(await inventoryGitDirectory(join(vault, ".git")))));
  const vaultIdPath = join(vault, ".dome", "state", "product-host-id");
  const vaultId = await exists(vaultIdPath) ? (await readFile(vaultIdPath, "utf8")).trim() : null;
  const manifest = Object.freeze({
    branch: source.branch.replace(/^refs\/heads\//, ""),
    head: source.head,
    refs: source.refs,
    refDigest: sha256(Buffer.from(JSON.stringify(source.refs))),
    repositoryDigest,
    vaultId,
  });
  return Object.freeze({ manifest, tree: source.tree, worktreeDigest });
}

async function assertSourceAdmissible(vault: string, source: SourceSnapshot): Promise<void> {
  if (source.branch === "") throw new Error("backup requires a normal branch, not detached HEAD");
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge"]) {
    if (await exists(join(vault, ".git", marker))) throw new Error(`backup refuses an in-progress Git operation: ${marker}`);
  }
  const gitLocks = await findMatching(join(vault, ".git"), (path) => path.endsWith(".lock"));
  if (gitLocks.length > 0) throw new Error(`backup refuses active Git lock: ${relative(vault, gitLocks[0]!)}`);
  for (const path of EXTERNAL_GIT_OBJECT_PATHS) {
    if (await exists(join(vault, ".git", ...path.split("/")))) throw new Error(`backup refuses external Git object dependency: .git/${path}`);
  }
  if (await exists(join(vault, ".dome", "state", "finalize-intent.json"))) throw new Error("backup refuses an active finalize-intent recovery journal");
  const mutations = join(vault, ".dome", "state", "mutations");
  if (await exists(mutations) && (await readdir(mutations)).some((name) => name.endsWith(".json"))) {
    throw new Error("backup refuses an active controlled-mutation recovery journal");
  }
}

async function copyTrackedTree(vault: string, tree: ReadonlyArray<StandaloneBackupTreeEntry>, destination: string): Promise<void> {
  for (const entry of tree) {
    const target = join(destination, entry.path);
    await mkdir(dirname(target), { recursive: true });
    const content = await readStandaloneBackupBlob(vault, entry.path);
    await writeFile(target, content, { flag: "wx", mode: entry.mode & 0o111 ? 0o755 : 0o644 });
  }
}

async function copyGitDirectory(vault: string, destination: string): Promise<void> {
  const source = join(vault, ".git");
  const target = join(destination, ".git");
  await copyTree(source, target, (relativePath, info) => {
    const path = relativePath.split(sep).join("/");
    return includeGitPath(path) && (info.isDirectory() || info.isFile());
  });
}

async function snapshotOperationalState(vault: string, destination: string): Promise<BackupManifest["databases"]> {
  const sourceState = join(vault, ".dome", "state");
  const targetState = join(destination, ".dome", "state");
  await mkdir(targetState, { recursive: true });
  await assertKnownStateInventory(sourceState);
  const inventory: Array<{ name: string; durability: "durable" | "rebuildable"; present: boolean }> = [];
  for (const database of DATABASES) {
    const source = join(sourceState, database.name);
    const target = join(targetState, database.name);
    const present = await exists(source);
    inventory.push(Object.freeze({ ...database, present }));
    if (!present) continue;
    await snapshotSqliteReadonly({ source, destination: target });
  }
  for (const name of [...DURABLE_FILES].sort()) {
    const source = join(sourceState, name);
    if (await exists(source)) await copyRegular(source, join(targetState, name));
  }
  return Object.freeze(inventory);
}

async function assertKnownStateInventory(state: string): Promise<void> {
  if (!(await exists(state))) return;
  const knownDbs = new Set(DATABASES.map((entry) => entry.name));
  for (const entry of await readdir(state, { withFileTypes: true })) {
    const name = entry.name;
    if (entry.isDirectory() && (name === "locks" || name === "mutations")) continue;
    if (knownDbs.has(name as (typeof DATABASES)[number]["name"]) || DURABLE_FILES.has(name) || TRANSIENT_FILES.has(name)) continue;
    if (name.endsWith("-wal") || name.endsWith("-shm") || name.endsWith(".tmp") || name.includes(".tmp-")) continue;
    throw new Error(`backup has no durability classification for .dome/state/${name}`);
  }
}

async function quickCheckSqlite(path: string): Promise<void> {
  await validateSqliteSnapshot(path);
}

async function validatePlainArchive(tarPath: string): Promise<BackupManifest> {
  const entries = await inspectTar(tarPath);
  const manifestBytes = await readTarFile(tarPath, "manifest.json");
  const parsed = manifestSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)));
  if (!parsed.success) throw new Error(`backup manifest is invalid: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
  const manifest = parsed.data as BackupManifest;
  validateManifestSemantics(manifest);
  assertTarMatchesManifest(entries, manifest);
  return manifest;
}

function validateManifestSemantics(manifest: BackupManifest): void {
  if (JSON.stringify(manifest.exclusions) !== JSON.stringify(BACKUP_EXCLUSIONS)) throw new Error("backup manifest exclusions are not canonical");
  if (manifest.databases.length !== DATABASES.length) throw new Error("backup manifest must classify exactly seven databases");
  for (let index = 0; index < DATABASES.length; index += 1) {
    const actual = manifest.databases[index];
    const expected = DATABASES[index];
    if (actual === undefined || expected === undefined || actual.name !== expected.name || actual.durability !== expected.durability) throw new Error("backup manifest database inventory is not canonical");
  }
  const refs = [...manifest.source.refs].sort((a, b) => compareStrings(a.name, b.name));
  if (JSON.stringify(refs) !== JSON.stringify(manifest.source.refs) || new Set(refs.map((ref) => ref.name)).size !== refs.length) {
    throw new Error("backup manifest refs are not sorted and unique");
  }
  if (sha256(Buffer.from(JSON.stringify(refs))) !== manifest.source.refDigest) throw new Error("backup manifest ref digest is invalid");
  const paths = manifest.entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length || JSON.stringify([...paths].sort(compareStrings)) !== JSON.stringify(paths)) throw new Error("backup manifest entries are not sorted and unique");
  for (const entry of manifest.entries) {
    if (entry.path !== "vault" && !entry.path.startsWith("vault/")) throw new Error(`backup manifest entry escapes its root: ${entry.path}`);
    if (entry.path.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error(`backup manifest entry path is unsafe: ${entry.path}`);
    if (entry.type === "directory" && (entry.size !== 0 || entry.sha256 !== undefined)) throw new Error(`backup manifest directory metadata is invalid: ${entry.path}`);
    if (entry.type === "file" && entry.sha256 === undefined) throw new Error(`backup manifest file checksum is missing: ${entry.path}`);
  }
  const gitEntries = manifest.entries
    .filter((entry) => entry.path === "vault/.git" || entry.path.startsWith("vault/.git/"))
    .map((entry) => ({ ...entry, path: entry.path.slice("vault/".length) }));
  if (gitEntries.length === 0 || sha256(Buffer.from(JSON.stringify(gitEntries))) !== manifest.source.repositoryDigest) {
    throw new Error("backup manifest repository digest is invalid");
  }
  for (const path of EXTERNAL_GIT_OBJECT_PATHS) {
    if (manifest.entries.some((entry) => entry.path === `vault/.git/${path}`)) throw new Error(`backup manifest depends on external Git objects: .git/${path}`);
  }
  const statePrefix = "vault/.dome/state";
  const stateEntries = manifest.entries.filter((entry) => entry.path === statePrefix || entry.path.startsWith(`${statePrefix}/`));
  for (const entry of stateEntries) {
    if (entry.type === "directory") {
      if (entry.path !== statePrefix) throw new Error(`backup manifest contains an unexpected state directory: ${entry.path}`);
      continue;
    }
    const name = entry.path.slice(`${statePrefix}/`.length);
    if (name.includes("/") || (!DATABASES.some((database) => database.name === name) && !DURABLE_FILES.has(name))) {
      throw new Error(`backup manifest contains an unclassified operational state entry: ${entry.path}`);
    }
  }
  for (const database of manifest.databases) {
    const present = manifest.entries.some((entry) => entry.type === "file" && entry.path === `${statePrefix}/${database.name}`);
    if (present !== database.present) throw new Error(`backup manifest database presence disagrees for ${database.name}`);
  }
}

function assertTarMatchesManifest(tarEntries: ReadonlyArray<TarEntry>, manifest: BackupManifest): void {
  const actual = tarEntries.filter((entry) => entry.path !== "manifest.json").map(normalizeEntry);
  const expected = manifest.entries.map(normalizeEntry);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("backup archive entries do not exactly match the manifest");
  const manifestEntries = tarEntries.filter((entry) => entry.path === "manifest.json");
  if (manifestEntries.length !== 1 || tarEntries.some((entry) => !entry.path.startsWith("vault/") && entry.path !== "vault" && entry.path !== "manifest.json")) {
    throw new Error("backup archive contains an unexpected root entry");
  }
}

function normalizeEntry(entry: BackupEntry | TarEntry): BackupEntry {
  return { path: entry.path, type: entry.type, mode: entry.mode, size: entry.size, ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }) };
}

async function extractTarStrict(tarPath: string, destination: string): Promise<void> {
  await extractTarTree(tarPath, destination);
}

async function validateReconstructedVault(
  vault: string,
  manifest: BackupManifest,
  requireCleanIndex = true,
): Promise<void> {
  if (!(await exists(join(vault, ".git", "HEAD")))) {
    throw new Error("reconstructed Git directory is missing HEAD");
  }
  const source = await validateStandaloneBackupRepository(vault);
  if (requireCleanIndex && !source.clean) {
    throw new Error("reconstructed Git index and working tree are not clean at HEAD");
  }
  const refs = source.refs;
  if (source.head !== manifest.source.head || source.branch.replace(/^refs\/heads\//, "") !== manifest.source.branch || sha256(Buffer.from(JSON.stringify(refs))) !== manifest.source.refDigest) {
    throw new Error("reconstructed Git state does not match the backup manifest");
  }
  const repositoryDigest = sha256(Buffer.from(JSON.stringify(await inventoryGitDirectory(join(vault, ".git")))));
  if (repositoryDigest !== manifest.source.repositoryDigest) throw new Error("reconstructed Git directory does not match the backup manifest");
  const archivedTrackedFiles = manifest.entries
    .filter((entry) => entry.type === "file" && !entry.path.startsWith("vault/.git/") && !entry.path.startsWith("vault/.dome/state/"))
    .map((entry) => entry.path.slice("vault/".length));
  if (JSON.stringify(archivedTrackedFiles) !== JSON.stringify(source.tree.map((entry) => entry.path))) {
    throw new Error("reconstructed working tree does not exactly match committed Git paths");
  }
  for (const entry of source.tree) {
    const workingPath = join(vault, ...entry.path.split("/"));
    const info = await lstat(workingPath);
    if (!info.isFile() || await hashFile(workingPath) !== sha256(await readStandaloneBackupBlob(vault, entry.path))) {
      throw new Error(`reconstructed working tree differs from committed Git: ${entry.path}`);
    }
    const expectedMode = entry.mode & 0o111 ? 0o755 : 0o644;
    if ((info.mode & 0o777) !== expectedMode) throw new Error(`reconstructed working tree mode differs from committed Git: ${entry.path}`);
  }
  for (const database of manifest.databases) if (database.present) await quickCheckSqlite(join(vault, ".dome", "state", database.name));
  const quarantinePath = join(vault, ".dome", "state", "quarantined.json");
  if (await exists(quarantinePath)) {
    const parsed = JSON.parse(await readFile(quarantinePath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("restored quarantine state is not a JSON object");
  }
  const vaultIdPath = join(vault, ".dome", "state", "product-host-id");
  const restoredVaultId = await exists(vaultIdPath) ? (await readFile(vaultIdPath, "utf8")).trim() : null;
  if (restoredVaultId !== manifest.source.vaultId) throw new Error("restored Product Host identity does not match the backup manifest");
}

async function inventoryTree(root: string, prefix: string): Promise<BackupEntry[]> {
  const entries: BackupEntry[] = [];
  async function visit(directory: string): Promise<void> {
    for (const child of (await readdir(directory, { withFileTypes: true })).sort((a, b) => compareStrings(a.name, b.name))) {
      const absolute = join(directory, child.name);
      const path = `${prefix}/${relative(root, absolute).split(sep).join("/")}`;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`backup refuses symlink payload: ${path}`);
      if (info.isDirectory()) {
        entries.push({ path, type: "directory", mode: info.mode & 0o777, size: 0 });
        await visit(absolute);
      } else if (info.isFile()) {
        entries.push({ path, type: "file", mode: info.mode & 0o777, size: info.size, sha256: await hashFile(absolute) });
      } else throw new Error(`backup refuses special payload entry: ${path}`);
    }
  }
  const rootInfo = await lstat(root);
  entries.push({ path: prefix, type: "directory", mode: rootInfo.mode & 0o777, size: 0 });
  await visit(root);
  return entries.sort((a, b) => compareStrings(a.path, b.path));
}

async function inventoryGitDirectory(root: string): Promise<BackupEntry[]> {
  const entries: BackupEntry[] = [{ path: ".git", type: "directory", mode: (await lstat(root)).mode & 0o777, size: 0 }];
  async function visit(directory: string): Promise<void> {
    for (const child of (await readdir(directory, { withFileTypes: true })).sort((a, b) => compareStrings(a.name, b.name))) {
      const absolute = join(directory, child.name);
      const relativePath = relative(root, absolute).split(sep).join("/");
      if (!includeGitPath(relativePath)) continue;
      const info = await lstat(absolute);
      const path = `.git/${relativePath}`;
      if (info.isDirectory()) { entries.push({ path, type: "directory", mode: info.mode & 0o777, size: 0 }); await visit(absolute); }
      else if (info.isFile()) entries.push({ path, type: "file", mode: info.mode & 0o777, size: info.size, sha256: await hashFile(absolute) });
      else throw new Error(`backup refuses special Git entry: ${relativePath}`);
    }
  }
  await visit(root);
  return entries.sort((a, b) => compareStrings(a.path, b.path));
}

function includeGitPath(path: string): boolean {
  if (path === "index" || path === "COMMIT_EDITMSG" || path === "FETCH_HEAD" || path === "ORIG_HEAD") return false;
  if (path === "logs" || path.startsWith("logs/") || path === "worktrees" || path.startsWith("worktrees/")) return false;
  return !path.endsWith(".lock") && !path.includes("/.tmp");
}

async function operationalSourceDigest(vault: string): Promise<string> {
  const state = join(vault, ".dome", "state");
  await assertKnownStateInventory(state);
  const paths = [
    ...DATABASES.flatMap((database) => [database.name, `${database.name}-wal`]),
    ...DURABLE_FILES,
  ].sort(compareStrings);
  const entries: Array<{ readonly path: string; readonly size: number; readonly mtimeMs: number; readonly sha256: string }> = [];
  for (const path of paths) {
    const absolute = join(state, path);
    if (!(await exists(absolute))) continue;
    const before = await lstat(absolute);
    if (!before.isFile()) throw new Error(`backup operational state entry is not a regular file: ${path}`);
    const digest = await hashFile(absolute);
    const after = await lstat(absolute);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error(`vault operational state changed while hashing: ${path}`);
    entries.push({ path, size: after.size, mtimeMs: after.mtimeMs, sha256: digest });
  }
  return sha256(Buffer.from(JSON.stringify(entries)));
}

async function copyTree(source: string, target: string, include: (path: string, info: Awaited<ReturnType<typeof lstat>>) => boolean): Promise<void> {
  async function visit(currentSource: string, currentTarget: string): Promise<void> {
    const info = await lstat(currentSource);
    const path = relative(source, currentSource);
    if (!include(path, info)) return;
    if (info.isDirectory()) {
      await mkdir(currentTarget, { recursive: true, mode: info.mode & 0o777 });
      for (const entry of await readdir(currentSource)) await visit(join(currentSource, entry), join(currentTarget, entry));
      return;
    }
    await copyRegular(currentSource, currentTarget);
  }
  await visit(source, target);
}

async function copyRegular(source: string, target: string): Promise<void> {
  const info = await lstat(source);
  if (!info.isFile()) throw new Error(`backup refuses non-regular file: ${source}`);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target, constants.COPYFILE_EXCL);
  await chmod(target, info.mode & 0o777);
}

async function findMatching(root: string, predicate: (path: string) => boolean): Promise<string[]> {
  if (!(await exists(root))) return [];
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (predicate(path)) found.push(path);
      if (entry.isDirectory()) await visit(path);
    }
  }
  await visit(root);
  return found;
}

async function run(command: ReadonlyArray<string>, cwd?: string): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn([...command], { ...(cwd === undefined ? {} : { cwd }), stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`${basename(command[0] ?? "command")} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  return { stdout, stderr };
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

async function fsyncPath(path: string): Promise<void> { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } }
async function fsyncDirectory(path: string): Promise<void> { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } }
async function fsyncDirectoryTree(root: string): Promise<void> {
  async function visit(directory: string): Promise<void> {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      if (child.isDirectory()) await visit(join(directory, child.name));
    }
    await fsyncDirectory(directory);
  }
  await visit(root);
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
async function canonicalNewOutput(path: string): Promise<string> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  return join(await realpath(dirname(absolute)), basename(absolute));
}
function isWithin(root: string, path: string): boolean { const rel = relative(root, path); return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".."); }
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function failure(operation: BackupResult["operation"], error: string, exitCode: 1 | 64 = 1): BackupResult {
  return Object.freeze({ schema: BACKUP_SCHEMA, operation, status: "error", exitCode, error });
}
