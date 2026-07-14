// product-host/home-installation: durable selection and immutable managed
// release publication for Dome Home. No ambient symlink participates in
// selection: one closed per-vault record names one content-addressed release.

import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { publishDirectoryExclusive } from "../platform/exclusive-rename";
import { compareStrings } from "../core/compare";
import { withExclusiveFileLock } from "../engine/host/file-lock";
import { vaultServiceSlug } from "../surface/service-probe";
import {
  verifyHomeArtifact,
  type HomeArtifactManifest,
  type HomeArtifactVerifier,
} from "./home-artifact";
import {
  assertManagedReleaseStoreOwner,
  withManagedReleaseArtifactRank,
  withManagedReleaseStoreCoordinator,
  type ManagedReleaseStoreOwner,
} from "./managed-release-store-coordinator";

export const HOME_INSTALLATION_SCHEMA = "dome.home.installation/v1" as const;

export type HomeInstallationRecord = {
  readonly schema: typeof HOME_INSTALLATION_SCHEMA;
  readonly vault: string;
  readonly artifact: { readonly id: string; readonly version: string };
  readonly environment: ReadonlyArray<{ readonly name: string; readonly value: string }>;
};

export type HomeInstallationPaths = {
  readonly root: string;
  readonly releases: string;
  readonly installations: string;
  readonly record: string;
};

export type HomeInstallationDeps = {
  readonly applicationSupportDir?: string | undefined;
  readonly verifyArtifact?: HomeArtifactVerifier | undefined;
  readonly publishRelease?: ((source: string, target: string) => Promise<void>) | undefined;
  readonly syncRelease?: ((root: string) => Promise<void>) | undefined;
  readonly publishRecord?: ((path: string, record: HomeInstallationRecord) => Promise<void>) | undefined;
  readonly quarantineRelease?: ((source: string, target: string) => Promise<void>) | undefined;
  readonly syncReleaseParent?: ((path: string) => Promise<void>) | undefined;
  /** Test/diagnostic seam; runs immediately before each real directory fsync. */
  readonly directoryDurabilityCheckpoint?: ((step: ManagedDirectoryDurabilityStep) => Promise<void>) | undefined;
  /** Test/diagnostic crash seam for committed-candidate release repair. */
  readonly repairReleaseCheckpoint?: ((name:
    "replacement-staged" | "corrupt-release-quarantined" | "candidate-release-published"
  ) => Promise<void>) | undefined;
};

export type ManagedDirectoryDurabilityStep = Readonly<{
  subject: string;
  path: string;
  kind: "directory" | "parent-entry";
}>;

export type EnsureManagedReleaseInput = Readonly<{
  source: string;
  manifest: HomeArtifactManifest;
  paths: HomeInstallationPaths;
  platform: NodeJS.Platform;
}>;

export type RepairManagedReleaseInput = Readonly<EnsureManagedReleaseInput & {
  expectedManifestSha256: string;
}>;

/** Preserves release-publication truth when selector durability fails. */
export class ManagedHomeInstallationPublicationError extends Error {
  readonly releasePublished: boolean;

  constructor(cause: unknown, releasePublished: boolean) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ManagedHomeInstallationPublicationError";
    this.releasePublished = releasePublished;
  }
}

export function homeInstallationPaths(vault: string, deps: HomeInstallationDeps = {}): HomeInstallationPaths {
  const root = resolve(deps.applicationSupportDir ?? join(homedir(), "Library", "Application Support", "Dome", "Home"));
  const releases = join(root, "releases");
  const installations = join(root, "installations", vaultServiceSlug(vault));
  return Object.freeze({ root, releases, installations, record: join(installations, "installation.json") });
}

export function releaseRoot(paths: HomeInstallationPaths, artifactId: string): string {
  if (!/^[a-f0-9]{64}$/.test(artifactId)) throw new Error("installation artifact id is invalid");
  return join(paths.releases, artifactId);
}

export async function readHomeInstallation(vault: string, deps: HomeInstallationDeps = {}): Promise<HomeInstallationRecord | null> {
  const path = homeInstallationPaths(vault, deps).record;
  if (!await pathPresent(path)) return null;
  const info = await lstat(path);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error(`Dome Home installation record is not a bounded regular file at ${path}`);
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error(`Dome Home installation record is invalid at ${path}`); }
  return parseHomeInstallationRecord(parsed, resolve(vault));
}

export function createHomeInstallation(
  vault: string,
  manifest: HomeArtifactManifest,
  environment: ReadonlyMap<string, string>,
): HomeInstallationRecord {
  return Object.freeze({
    schema: HOME_INSTALLATION_SCHEMA,
    vault: resolve(vault),
    artifact: Object.freeze({ id: manifest.artifact.id, version: manifest.product.version }),
    environment: Object.freeze([...environment]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([name, value]) => Object.freeze({ name, value }))),
  });
}

/** Isolated convenience interface; production spans use the owned interface. */
export async function ensureManagedRelease(
  input: EnsureManagedReleaseInput,
  deps: HomeInstallationDeps = {},
): Promise<{ readonly root: string; readonly published: boolean }> {
  await prepareManagedReleaseStoreRoot(input.paths, deps);
  const ownership = await withManagedReleaseStoreCoordinator(input.paths.root, async (owner) =>
    ensureManagedReleaseOwned(owner, input, deps), { waitMs: 30_000 });
  if (ownership.kind === "busy") throw new Error(`managed release publish is busy for ${input.manifest.artifact.id}`);
  return ownership.value;
}

/** Publish or converge one artifact while the exact Home-global owner is live. */
export async function ensureManagedReleaseOwned(
  owner: ManagedReleaseStoreOwner,
  input: EnsureManagedReleaseInput,
  deps: HomeInstallationDeps = {},
): Promise<{ readonly root: string; readonly published: boolean }> {
  assertManagedReleaseStoreOwner(owner, input.paths.root);
  assertManagedReleasePaths(input.paths);
  const verify = deps.verifyArtifact ?? verifyHomeArtifact;
  const source = resolve(input.source);
  const sourceManifest = await verify(source);
  assertSameManifest(sourceManifest, input.manifest, "managed release identity mismatch");
  const target = releaseRoot(input.paths, input.manifest.artifact.id);
  return withManagedReleaseOwnership(owner, input.paths, input.manifest.artifact.id, "publish", async () => {
    if (await pathPresent(target)) {
      try {
        await durablyVerifyManagedRelease(target, input.paths, input.manifest, verify, deps);
        return Object.freeze({ root: target, published: false });
      } catch (error) {
        throw new Error(`immutable managed release is corrupt at ${target}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await ensureDurableDirectDirectory(input.paths.root, deps);
    await ensureDurableDirectDirectory(input.paths.releases, deps);
    const staging = join(input.paths.releases, `.staging-${input.manifest.artifact.id}-${process.pid}-${randomUUID()}`);
    try {
      await cp(source, staging, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        preserveTimestamps: true,
        errorOnExist: true,
        force: false,
      });
      const staged = await verify(staging);
      assertSameManifest(staged, input.manifest, "staged release identity changed during copy");
      await (deps.syncRelease ?? fsyncTree)(staging);
      let didPublish = true;
      try {
        await (deps.publishRelease ?? (async (source, destination) => publishDirectoryExclusive({
          source,
          target: destination,
          platform: input.platform,
        })))(staging, target);
      } catch (publishError) {
        if (!await pathPresent(target)) throw publishError;
        try {
          const concurrent = await verify(target);
          assertSameManifest(concurrent, input.manifest, "concurrently published release identity mismatch");
          didPublish = false;
        } catch (verifyError) {
          throw new AggregateError(
            [publishError, verifyError],
            `managed release publication conflicted at ${target}`,
          );
        }
      }
      await (deps.syncReleaseParent ?? fsyncDirectory)(input.paths.releases);
      const published = await verify(target);
      assertSameManifest(published, input.manifest, "published release identity changed");
      return Object.freeze({ root: target, published: didPublish });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}

/**
 * The ordinary-install publication interface. One Home-global span closes the
 * reachability gap from immutable release publication through durable selector
 * publication; lifecycle callers never handle owner tokens or lock ranks.
 */
export async function publishManagedHomeInstallation(
  input: EnsureManagedReleaseInput & Readonly<{ record: HomeInstallationRecord }>,
  deps: HomeInstallationDeps = {},
): Promise<Readonly<{
  managed: Readonly<{ root: string; published: boolean }>;
  record: HomeInstallationRecord;
}>> {
  assertInstallationMatchesRelease(input);
  await prepareManagedReleaseStoreRoot(input.paths, deps);
  const ownership = await withManagedReleaseStoreCoordinator(input.paths.root, async (owner) => {
    const managed = await ensureManagedReleaseOwned(owner, input, deps);
    try { await publishHomeInstallation(input.paths.record, input.record, deps); }
    catch (error) { throw new ManagedHomeInstallationPublicationError(error, managed.published); }
    return Object.freeze({ managed, record: input.record });
  }, { waitMs: 30_000 });
  if (ownership.kind === "busy") throw new Error("managed Home release store is busy");
  return ownership.value;
}

/**
 * Repair one global content-addressed release under artifact-keyed ownership.
 * Every repair caller re-inspects inside this lock, so a second vault can
 * never quarantine a valid winner based on stale corruption evidence.
 */
export async function repairManagedRelease(
  input: RepairManagedReleaseInput,
  deps: HomeInstallationDeps = {},
): Promise<{
  readonly root: string;
  readonly published: boolean;
  readonly quarantined: string | null;
}> {
  await prepareManagedReleaseStoreRoot(input.paths, deps);
  const ownership = await withManagedReleaseStoreCoordinator(input.paths.root, async (owner) =>
    repairManagedReleaseOwned(owner, input, deps), { waitMs: 30_000 });
  if (ownership.kind === "busy") throw new Error(`managed release repair is busy for ${input.manifest.artifact.id}`);
  return ownership.value;
}

/** Repair one artifact while the exact Home-global owner is live. */
export async function repairManagedReleaseOwned(
  owner: ManagedReleaseStoreOwner,
  input: RepairManagedReleaseInput,
  deps: HomeInstallationDeps = {},
): Promise<{
  readonly root: string;
  readonly published: boolean;
  readonly quarantined: string | null;
}> {
  assertManagedReleaseStoreOwner(owner, input.paths.root);
  assertManagedReleasePaths(input.paths);
  const verify = deps.verifyArtifact ?? verifyHomeArtifact;
  await assertExactArtifact(
    resolve(input.source),
    input.manifest,
    input.expectedManifestSha256,
    verify,
    "invoking repair candidate",
  );
  const target = releaseRoot(input.paths, input.manifest.artifact.id);
  return withManagedReleaseOwnership(owner, input.paths, input.manifest.artifact.id, "repair", async () => {
    // The source and target are deliberately re-read after artifact ownership.
    // The pre-artifact proof keeps wrong-candidate attempts payload-write-free;
    // this proof closes the wait/race window before staging or quarantine.
    await assertExactArtifact(
      resolve(input.source),
      input.manifest,
      input.expectedManifestSha256,
      verify,
      "invoking repair candidate",
    );
    const initialTarget = await classifyRepairTarget(target, input, verify);
    if (initialTarget === "exact") {
      await durablyVerifyExactRepairTarget(target, input, verify, deps);
      return Object.freeze({ root: target, published: false, quarantined: null });
    }
    if (initialTarget === "valid-collision") throw validCollision(target);

    await ensureDurableDirectDirectory(input.paths.root, deps);
    await ensureDurableDirectDirectory(input.paths.releases, deps);
    const staging = join(
      input.paths.releases,
      `.repair-staging-${input.manifest.artifact.id}-${process.pid}-${randomUUID()}`,
    );
    let quarantined: string | null = null;
    try {
      await cp(resolve(input.source), staging, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        preserveTimestamps: true,
        errorOnExist: true,
        force: false,
      });
      await assertExactArtifact(
        staging,
        input.manifest,
        input.expectedManifestSha256,
        verify,
        "staged repair candidate",
      );
      await (deps.syncRelease ?? fsyncTree)(staging);
      await deps.repairReleaseCheckpoint?.("replacement-staged");

      // Re-inspect only after staging is durable. A concurrent ordinary
      // publisher may have filled a previously missing target while we copied.
      const stagedTarget = await classifyRepairTarget(target, input, verify);
      if (stagedTarget === "exact") {
        await durablyVerifyExactRepairTarget(target, input, verify, deps);
        return Object.freeze({ root: target, published: false, quarantined: null });
      }
      if (stagedTarget === "valid-collision") throw validCollision(target);
      if (stagedTarget === "intrinsically-corrupt") {
        quarantined = join(
          input.paths.releases,
          `.quarantine-${input.manifest.artifact.id}-${randomUUID()}`,
        );
        try {
          await (deps.quarantineRelease ?? (async (source, destination) => publishDirectoryExclusive({
            source,
            target: destination,
            platform: input.platform,
          })))(target, quarantined);
        } catch (error) {
          const raced = await classifyRepairTarget(target, input, verify);
          if (raced === "exact") {
            await durablyVerifyExactRepairTarget(target, input, verify, deps);
            return Object.freeze({ root: target, published: false, quarantined: null });
          }
          if (raced === "valid-collision") throw validCollision(target);
          if (raced === "intrinsically-corrupt") throw error;
          quarantined = null;
        }
        await (deps.syncReleaseParent ?? fsyncDirectory)(input.paths.releases);
        await deps.repairReleaseCheckpoint?.("corrupt-release-quarantined");
      }

      let published = true;
      try {
        await (deps.publishRelease ?? (async (source, destination) => publishDirectoryExclusive({
          source,
          target: destination,
          platform: input.platform,
        })))(staging, target);
      } catch (publishError) {
        const winner = await classifyRepairTarget(target, input, verify);
        if (winner === "valid-collision") throw validCollision(target);
        if (winner !== "exact") throw publishError;
        published = false;
      }
      await (deps.syncReleaseParent ?? fsyncDirectory)(input.paths.releases);
      await deps.repairReleaseCheckpoint?.("candidate-release-published");
      await assertExactArtifact(
        target,
        input.manifest,
        input.expectedManifestSha256,
        verify,
        "repaired managed release",
      );
      return Object.freeze({ root: target, published, quarantined });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}

async function durablyVerifyManagedRelease(
  target: string,
  paths: HomeInstallationPaths,
  manifest: HomeArtifactManifest,
  verify: HomeArtifactVerifier,
  deps: HomeInstallationDeps,
): Promise<void> {
  await ensureDurableDirectDirectory(paths.releases, deps);
  await (deps.syncReleaseParent ?? fsyncDirectory)(paths.releases);
  const durable = await verify(target);
  assertSameManifest(durable, manifest, "managed release identity mismatch");
}

async function durablyVerifyExactRepairTarget(
  target: string,
  input: Pick<RepairManagedReleaseInput, "manifest" | "expectedManifestSha256" | "paths">,
  verify: HomeArtifactVerifier,
  deps: HomeInstallationDeps,
): Promise<void> {
  await ensureDurableDirectDirectory(input.paths.releases, deps);
  await (deps.syncReleaseParent ?? fsyncDirectory)(input.paths.releases);
  await assertExactArtifact(
    target,
    input.manifest,
    input.expectedManifestSha256,
    verify,
    "durable repaired managed release",
  );
}

async function withManagedReleaseOwnership<T>(
  owner: ManagedReleaseStoreOwner,
  paths: HomeInstallationPaths,
  artifactId: string,
  purpose: "publish" | "repair",
  operation: () => Promise<T>,
): Promise<T> {
  const ownership = await withManagedReleaseArtifactRank(owner, paths.root, async () =>
    withExclusiveFileLock({
      lockPath: releaseRepairLockPath(paths, artifactId),
      command: `dome-home-release-${purpose}:${artifactId}`,
      wait: { timeoutMs: 30_000, intervalMs: 25 },
    }, operation));
  if (ownership.kind === "busy") {
    throw new Error(`managed release ${purpose} is busy for ${artifactId}`);
  }
  return ownership.value;
}

function releaseRepairLockPath(paths: HomeInstallationPaths, artifactId: string): string {
  const key = createHash("sha256")
    .update(`${resolve(paths.root)}\0${artifactId}`, "utf8")
    .digest("hex");
  return join(tmpdir(), "dome-home-release-repair-locks", `${key}.lock`);
}

async function classifyRepairTarget(
  target: string,
  input: Pick<RepairManagedReleaseInput, "manifest" | "expectedManifestSha256">,
  verify: HomeArtifactVerifier,
): Promise<"absent" | "exact" | "intrinsically-corrupt" | "valid-collision"> {
  if (!await pathPresent(target)) return "absent";
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(target) !== resolve(target)) {
      return "intrinsically-corrupt";
    }
  } catch { return "intrinsically-corrupt"; }
  try {
    const actual = await verify(target);
    const manifestSha256 = createHash("sha256")
      .update(await readFile(join(target, "manifest.json")))
      .digest("hex");
    return isDeepStrictEqual(actual, input.manifest) && manifestSha256 === input.expectedManifestSha256
      ? "exact"
      : "valid-collision";
  } catch { return "intrinsically-corrupt"; }
}

function validCollision(_target: string): Error {
  return new Error("valid managed release collision is not quarantineable");
}

async function assertExactArtifact(
  root: string,
  manifest: HomeArtifactManifest,
  expectedManifestSha256: string,
  verify: HomeArtifactVerifier,
  label: string,
): Promise<void> {
  const actual = await verify(root);
  assertSameManifest(actual, manifest, `${label} semantic identity mismatch`);
  const manifestSha256 = createHash("sha256").update(await readFile(join(root, "manifest.json"))).digest("hex");
  if (manifestSha256 !== expectedManifestSha256) {
    throw new Error(`${label} manifest fingerprint mismatch`);
  }
}

function assertSameManifest(
  actual: HomeArtifactManifest,
  expected: HomeArtifactManifest,
  error: string,
): void {
  // Artifact ids cover the payload-entry inventory, not every closed manifest
  // field. Publication convergence therefore requires the complete verified
  // semantic manifest, while object property order remains irrelevant.
  if (!isDeepStrictEqual(actual, expected)) throw new Error(error);
}

function assertInstallationMatchesRelease(
  input: EnsureManagedReleaseInput & Readonly<{ record: HomeInstallationRecord }>,
): void {
  parseHomeInstallationRecord(input.record, input.record.vault);
  const expectedPaths = homeInstallationPaths(input.record.vault, { applicationSupportDir: input.paths.root });
  if (input.record.vault !== resolve(input.record.vault) ||
    input.record.artifact.id !== input.manifest.artifact.id ||
    input.record.artifact.version !== input.manifest.product.version ||
    expectedPaths.root !== input.paths.root || expectedPaths.releases !== input.paths.releases ||
    expectedPaths.installations !== input.paths.installations || expectedPaths.record !== input.paths.record) {
    throw new Error("managed Home installation record does not match its release or selector path");
  }
}

function assertManagedReleasePaths(paths: HomeInstallationPaths): void {
  if (paths.root !== resolve(paths.root) || paths.releases !== join(paths.root, "releases")) {
    throw new Error("managed release paths are not bound to the owned Home root");
  }
}

export async function publishHomeInstallation(
  path: string,
  record: HomeInstallationRecord,
  deps: HomeInstallationDeps = {},
): Promise<void> {
  const installation = dirname(path);
  const installations = dirname(installation);
  const root = dirname(installations);
  await ensureDurableDirectDirectory(root, deps);
  await ensureDurableDirectDirectory(installations, deps);
  await ensureDurableDirectDirectory(installation, deps);
  if (deps.publishRecord !== undefined) return deps.publishRecord(path, record);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await rename(temporary, path);
    await fsyncDirectory(dirname(path));
  } finally { await rm(temporary, { force: true }); }
}

export async function syncDirectory(path: string): Promise<void> { await fsyncDirectory(path); }

/** Establish only the direct Home root required before global coordination. */
async function prepareManagedReleaseStoreRoot(
  paths: HomeInstallationPaths,
  deps: HomeInstallationDeps,
): Promise<void> {
  assertManagedReleasePaths(paths);
  await ensureDurableDirectDirectory(paths.root, deps);
}

/** Strict pure parser shared by selector readers and host-wide release inventory. */
export function parseHomeInstallationRecord(value: unknown, expectedVault: string): HomeInstallationRecord {
  const root = exactRecord(value, "installation record", ["schema", "vault", "artifact", "environment"]);
  const artifact = exactRecord(root["artifact"], "installation artifact", ["id", "version"]);
  if (root["schema"] !== HOME_INSTALLATION_SCHEMA || root["vault"] !== expectedVault ||
    typeof artifact["id"] !== "string" || !/^[a-f0-9]{64}$/.test(artifact["id"]) ||
    typeof artifact["version"] !== "string" || artifact["version"].length === 0 || artifact["version"].length > 1024 ||
    !Array.isArray(root["environment"])) throw new Error("Dome Home installation record has invalid fixed fields");
  const environment = root["environment"].map((candidate) => {
    const item = exactRecord(candidate, "installation environment entry", ["name", "value"]);
    if (typeof item["name"] !== "string" || item["name"].length === 0 || item["name"].includes("=") || item["name"].includes("\0") ||
      typeof item["value"] !== "string" || item["value"].includes("\0")) throw new Error("installation environment entry is invalid");
    return item as { readonly name: string; readonly value: string };
  });
  if (environment.some((item, index) => index > 0 && compareStrings(environment[index - 1]!.name, item.name) >= 0)) {
    throw new Error("installation environment entries must have unique sorted names");
  }
  return root as unknown as HomeInstallationRecord;
}

function exactRecord(value: unknown, label: string, expectedKeys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort(compareStrings);
  const expected = [...expectedKeys].sort(compareStrings);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} has unknown or missing fields`);
  return value as Record<string, unknown>;
}

async function fsyncTree(root: string): Promise<void> {
  const directories: string[] = [];
  async function visit(path: string): Promise<void> {
    directories.push(path);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const info = await lstat(child);
      if (info.isDirectory()) await visit(child);
      else if (info.isFile()) {
        const handle = await open(child, "r");
        try { await handle.sync(); } finally { await handle.close(); }
      }
    }
  }
  await visit(root);
  for (const directory of directories.reverse()) await fsyncDirectory(directory);
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function pathPresent(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensureDurableDirectDirectory(path: string, deps: HomeInstallationDeps): Promise<void> {
  if (!await pathPresent(path)) {
    const parent = dirname(path);
    if (parent === path) throw new Error(`managed Dome Home directory cannot be created: ${path}`);
    await ensureDurableDirectDirectory(parent, deps);
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) {
    throw new Error(`managed Dome Home path is not a direct owned directory: ${path}`);
  }
  // Always replay both proofs. A prior attempt may have created this visible
  // directory and failed before its own or its parent-entry fsync completed.
  await syncEstablishedDirectory(path, path, "directory", deps);
  await syncEstablishedDirectory(path, dirname(path), "parent-entry", deps);
}

async function syncEstablishedDirectory(
  subject: string,
  path: string,
  kind: ManagedDirectoryDurabilityStep["kind"],
  deps: HomeInstallationDeps,
): Promise<void> {
  await deps.directoryDurabilityCheckpoint?.(Object.freeze({ subject, path, kind }));
  await fsyncDirectory(path);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}
