import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, lstat, link, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const fsPromises = { lstat, link, mkdir, readdir };

type OwnedGitLockWitness = Readonly<{
  schema: "dome.git-lock-owner/v1";
  tokenSha256: string;
  role: string;
  candidateName: string;
  dev: string;
  ino: string;
  pid: number;
}>;

function ownedLockDirectory(
  ownerRoot: string,
  ownerToken: string,
  role: string,
): string {
  return join(
    ownerRoot,
    "dome-lock-owners",
    sha256GitLockToken(ownerToken),
    sha256GitLockToken(role).slice(0, 24),
  );
}

async function ensureDurableDirectory(path: string): Promise<void> {
  const missing: string[] = [];
  let cursor = path;
  for (;;) {
    const stat = await lstatOptional(cursor);
    if (stat !== null) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Dome Git lock owner directory is not direct: ${cursor}`);
      }
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`Dome Git lock owner directory has no existing ancestor: ${path}`);
    missing.push(cursor);
    cursor = parent;
  }
  for (const directory of missing.reverse()) {
    await fsPromises.mkdir(directory, { mode: 0o700 });
    await syncDirectory(directory);
    await syncDirectory(dirname(directory));
  }
}

function sha256GitLockToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function recoverDeadOwnedGitLock(
  ownerRoot: string,
  lockPath: string,
  ownerToken: string,
  role: string,
): Promise<boolean> {
  const liveLock = await lstatOptional(lockPath);
  if (liveLock === null) return true;
  const directory = ownedLockDirectory(ownerRoot, ownerToken, role);
  let names: string[];
  try { names = await fsPromises.readdir(directory); }
  catch (error) { return hasFsCode(error, "ENOENT") ? false : Promise.reject(error); }
  if (names.length > 256) throw new Error(`commitFilesOnHead: too many owned lock records in ${directory}`);
  for (const name of names.sort()) {
    if (!/^[0-9a-f]{32}\.candidate\.json$/.test(name)) continue;
    const witnessPath = join(directory, name);
    let body: string;
    try { body = await readFileBounded(witnessPath, 4_096); }
    catch { continue; }
    const witness = decodeOwnedGitLockWitness(body, ownerToken, role, name);
    if (witness === null) continue;
    const candidatePath = join(directory, witness.candidateName);
    const candidate = await lstatOptional(candidatePath);
    if (candidate === null ||
      !sameOwnedLockIdentity(candidate, BigInt(witness.dev), BigInt(witness.ino)) ||
      !sameOwnedLockIdentity(liveLock, BigInt(witness.dev), BigInt(witness.ino))) continue;
    if (gitLockOwnerMayBeAlive(witness.pid)) {
      throw new Error(`commitFilesOnHead: ${role} remains owned by active process ${witness.pid}`);
    }
    const rechecked = await lstatOptional(lockPath);
    if (rechecked === null || !sameOwnedLockIdentity(rechecked, candidate.dev, candidate.ino)) {
      throw new Error(`commitFilesOnHead: refused concurrently replaced ${role}`);
    }
    await unlink(lockPath);
    await syncDirectory(dirname(lockPath));
    const candidateBody = await lstatOptional(candidatePath);
    if (candidateBody !== null && sameOwnedLockIdentity(candidateBody, candidate.dev, candidate.ino)) {
      await unlink(candidatePath);
    }
    if (await readFileBounded(witnessPath, 4_096) === body) await unlink(witnessPath);
    await syncDirectory(directory);
    return true;
  }
  return false;
}

function decodeOwnedGitLockWitness(
  body: string,
  ownerToken: string,
  role: string,
  witnessName: string,
): OwnedGitLockWitness | null {
  let value: unknown;
  try { value = JSON.parse(body); }
  catch { return null; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const witness: OwnedGitLockWitness = Object.freeze({
    schema: row.schema === "dome.git-lock-owner/v1" ? row.schema : "dome.git-lock-owner/v1",
    tokenSha256: typeof row.tokenSha256 === "string" ? row.tokenSha256 : "",
    role: typeof row.role === "string" ? row.role : "",
    candidateName: typeof row.candidateName === "string" ? row.candidateName : "",
    dev: typeof row.dev === "string" ? row.dev : "",
    ino: typeof row.ino === "string" ? row.ino : "",
    pid: typeof row.pid === "number" ? row.pid : -1,
  });
  if (row.schema !== "dome.git-lock-owner/v1" ||
    witness.tokenSha256 !== sha256GitLockToken(ownerToken) || witness.role !== role ||
    `${witness.candidateName}.json` !== witnessName ||
    !/^[0-9a-f]{32}\.candidate$/.test(witness.candidateName) ||
    !/^[0-9]+$/.test(witness.dev) || !/^[0-9]+$/.test(witness.ino) ||
    !Number.isSafeInteger(witness.pid) || witness.pid <= 0 ||
    body !== `${JSON.stringify(witness)}\n`) return null;
  return witness;
}

function gitLockOwnerMayBeAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !hasFsCode(error, "ESRCH"); }
}

async function lstatOptional(path: string): Promise<BigIntStats | null> {
  try { return await fsPromises.lstat(path, { bigint: true }); }
  catch (error) { if (hasFsCode(error, "ENOENT")) return null; throw error; }
}

function sameOwnedLockIdentity(stat: BigIntStats, dev: bigint, ino: bigint): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.dev === dev && stat.ino === ino;
}

async function readFileBounded(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) {
      throw new Error(`Git ownership record exceeds admitted size: ${path}`);
    }
    const bytes = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes || !sameFileProof(before, await handle.stat({ bigint: true }))) {
      throw new Error(`Git ownership record changed while reading: ${path}`);
    }
    return bytes.subarray(0, offset).toString("utf8");
  } finally { await handle.close(); }
}

function hasFsCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === code;
}

export class OwnedGitLock {
  private expectedSha256: string;
  private expectedBytes: number;

  private constructor(
    readonly lockPath: string,
    readonly candidatePath: string,
    readonly witnessPath: string,
    readonly witnessBody: string,
    readonly dev: bigint,
    readonly ino: bigint,
    expectedBody: string | Uint8Array,
  ) {
    const bytes = typeof expectedBody === "string" ? Buffer.from(expectedBody, "utf8") : expectedBody;
    this.expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    this.expectedBytes = bytes.byteLength;
  }

  static async acquire(
    ownerRoot: string,
    lockPath: string,
    ownerToken: string | undefined,
    role: string,
    body: string | Uint8Array,
    afterCandidateDurable?: ((role: string) => Promise<void>) | undefined,
  ): Promise<OwnedGitLock | null> {
    if (ownerToken === undefined) return null;
    const directory = ownedLockDirectory(ownerRoot, ownerToken, role);
    await ensureDurableDirectory(directory);
    const candidateName = `${randomBytes(16).toString("hex")}.candidate`;
    const candidatePath = join(directory, candidateName);
    const witnessPath = `${candidatePath}.json`;
    const handle = await open(candidatePath, "wx", 0o600);
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally { await handle.close(); }
    const candidate = await fsPromises.lstat(candidatePath, { bigint: true });
    if (!candidate.isFile() || candidate.isSymbolicLink()) {
      throw new Error(`Dome Git lock candidate is not a direct file: ${candidatePath}`);
    }
    await syncDirectory(directory);
    await afterCandidateDurable?.(role);
    const witness: OwnedGitLockWitness = Object.freeze({
      schema: "dome.git-lock-owner/v1",
      tokenSha256: sha256GitLockToken(ownerToken),
      role,
      candidateName,
      dev: candidate.dev.toString(),
      ino: candidate.ino.toString(),
      pid: process.pid,
    });
    const witnessBody = `${JSON.stringify(witness)}\n`;
    const witnessHandle = await open(witnessPath, "wx", 0o600);
    try {
      await witnessHandle.writeFile(witnessBody, "utf8");
      await witnessHandle.sync();
    } finally { await witnessHandle.close(); }
    await syncDirectory(directory);

    const owned = new OwnedGitLock(
      lockPath,
      candidatePath,
      witnessPath,
      witnessBody,
      candidate.dev,
      candidate.ino,
      body,
    );
    try {
      await fsPromises.link(candidatePath, lockPath);
    } catch (error) {
      let recovered = false;
      try {
        recovered = hasFsCode(error, "EEXIST") &&
          await recoverDeadOwnedGitLock(ownerRoot, lockPath, ownerToken, role);
      } catch (recoveryError) {
        await owned.cleanupCandidate().catch(() => {});
        throw recoveryError;
      }
      if (!recovered) {
        await owned.cleanupCandidate().catch(() => {});
        throw new Error(
          `commitFilesOnHead: could not lock ${role}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try { await fsPromises.link(candidatePath, lockPath); }
      catch (retryError) {
        await owned.cleanupCandidate().catch(() => {});
        throw new Error(
          `commitFilesOnHead: could not lock ${role}: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
        );
      }
    }
    await syncDirectory(dirname(lockPath));
    if (!await owned.lockStillOwned()) {
      await owned.cleanupCandidate().catch(() => {});
      throw new Error(`commitFilesOnHead: ${role} ownership changed during acquisition`);
    }
    return owned;
  }

  async publish(destination: string, beforeParentSync?: () => Promise<void>): Promise<void> {
    if (!await this.lockStillOwned() || !await this.pathHasExpectedBody(this.candidatePath)) {
      throw new Error(`commitFilesOnHead: refused replaced owned lock ${this.lockPath}`);
    }
    await rename(this.lockPath, destination);
    if (!await this.pathStillOwned(destination) || !await this.pathHasExpectedBody(destination)) {
      throw new Error(`commitFilesOnHead: published Git path identity changed at ${destination}`);
    }
    if (beforeParentSync !== undefined) await beforeParentSync();
    await syncDirectory(dirname(destination));
    await this.cleanupCandidate();
  }

  async release(): Promise<void> {
    const lock = await lstatOptional(this.lockPath);
    if (lock !== null) {
      if (!sameOwnedLockIdentity(lock, this.dev, this.ino)) {
        throw new Error(`commitFilesOnHead: refused replaced owned lock ${this.lockPath}`);
      }
      await unlink(this.lockPath);
      await syncDirectory(dirname(this.lockPath));
    }
    await this.cleanupCandidate();
  }

  async rewrite(body: Uint8Array): Promise<void> {
    const handle = await open(this.candidatePath, "r+");
    try {
      const before = await handle.stat({ bigint: true });
      if (!sameOwnedLockIdentity(before, this.dev, this.ino)) {
        throw new Error(`commitFilesOnHead: refused replaced lock candidate ${this.candidatePath}`);
      }
      await handle.truncate(0);
      await handle.writeFile(body);
      await handle.sync();
      if (!sameOwnedLockIdentity(await handle.stat({ bigint: true }), this.dev, this.ino)) {
        throw new Error(`commitFilesOnHead: lock candidate identity changed ${this.candidatePath}`);
      }
      this.expectedSha256 = createHash("sha256").update(body).digest("hex");
      this.expectedBytes = body.byteLength;
    } finally { await handle.close(); }
  }

  private async lockStillOwned(): Promise<boolean> {
    return this.pathStillOwned(this.lockPath);
  }

  private async pathStillOwned(path: string): Promise<boolean> {
    const [candidate, current] = await Promise.all([
      lstatOptional(this.candidatePath),
      lstatOptional(path),
    ]);
    return candidate !== null && current !== null &&
      sameOwnedLockIdentity(candidate, this.dev, this.ino) &&
      sameOwnedLockIdentity(current, this.dev, this.ino);
  }

  private async pathHasExpectedBody(path: string): Promise<boolean> {
    const handle = await open(path, "r");
    try {
      const before = await handle.stat({ bigint: true });
      if (!sameOwnedLockIdentity(before, this.dev, this.ino) || before.size !== BigInt(this.expectedBytes)) {
        return false;
      }
      const body = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      return sameFileProof(before, after) && body.byteLength === this.expectedBytes &&
        createHash("sha256").update(body).digest("hex") === this.expectedSha256;
    } finally { await handle.close(); }
  }

  private async cleanupCandidate(): Promise<void> {
    const candidate = await lstatOptional(this.candidatePath);
    if (candidate !== null) {
      if (!sameOwnedLockIdentity(candidate, this.dev, this.ino)) {
        throw new Error(`commitFilesOnHead: refused replaced lock candidate ${this.candidatePath}`);
      }
      await unlink(this.candidatePath);
    }
    let witness: string | null = null;
    try { witness = await readFileBounded(this.witnessPath, 4_096); }
    catch (error) { if (!hasFsCode(error, "ENOENT")) throw error; }
    if (witness !== null) {
      if (witness !== this.witnessBody) {
        throw new Error(`commitFilesOnHead: refused replaced lock witness ${this.witnessPath}`);
      }
      await unlink(this.witnessPath);
    }
    await syncDirectory(dirname(this.candidatePath));
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}

function sameFileProof(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
