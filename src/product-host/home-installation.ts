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
  /** Test/diagnostic crash seam for committed-candidate release repair. */
  readonly repairReleaseCheckpoint?: ((name:
    "replacement-staged" | "corrupt-release-quarantined" | "candidate-release-published"
  ) => Promise<void>) | undefined;
};

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
  return parseHomeInstallation(parsed, resolve(vault));
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

export async function ensureManagedRelease(input: {
  readonly source: string;
  readonly manifest: HomeArtifactManifest;
  readonly paths: HomeInstallationPaths;
  readonly platform: NodeJS.Platform;
}, deps: HomeInstallationDeps = {}): Promise<{ readonly root: string; readonly published: boolean }> {
  const verify = deps.verifyArtifact ?? verifyHomeArtifact;
  const source = resolve(input.source);
  const sourceManifest = await verify(source);
  assertSameManifest(sourceManifest, input.manifest, "managed release identity mismatch");
  const target = releaseRoot(input.paths, input.manifest.artifact.id);
  return withManagedReleaseOwnership(input.paths, input.manifest.artifact.id, "publish", async () => {
    if (await pathPresent(target)) {
      try {
        await durablyVerifyManagedRelease(target, input.paths, input.manifest, verify, deps);
        return Object.freeze({ root: target, published: false });
      } catch (error) {
        throw new Error(`immutable managed release is corrupt at ${target}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await ensureOwnedDirectory(input.paths.root);
    await ensureOwnedDirectory(input.paths.releases);
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
 * Repair one global content-addressed release under artifact-keyed ownership.
 * Every repair caller re-inspects inside this lock, so a second vault can
 * never quarantine a valid winner based on stale corruption evidence.
 */
export async function repairManagedRelease(input: {
  readonly source: string;
  readonly manifest: HomeArtifactManifest;
  readonly expectedManifestSha256: string;
  readonly paths: HomeInstallationPaths;
  readonly platform: NodeJS.Platform;
}, deps: HomeInstallationDeps = {}): Promise<{
  readonly root: string;
  readonly published: boolean;
  readonly quarantined: string | null;
}> {
  const verify = deps.verifyArtifact ?? verifyHomeArtifact;
  await assertExactArtifact(
    resolve(input.source),
    input.manifest,
    input.expectedManifestSha256,
    verify,
    "invoking repair candidate",
  );
  const target = releaseRoot(input.paths, input.manifest.artifact.id);
  return withManagedReleaseOwnership(input.paths, input.manifest.artifact.id, "repair", async () => {
    // The source and target are deliberately re-read after global ownership.
    // The pre-lock proof keeps wrong-candidate attempts write-free; this proof
    // closes the wait/race window before staging or quarantine begins.
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

    await ensureOwnedDirectory(input.paths.root);
    await ensureOwnedDirectory(input.paths.releases);
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
  await ensureOwnedDirectory(paths.releases);
  await (deps.syncReleaseParent ?? fsyncDirectory)(paths.releases);
  const durable = await verify(target);
  assertSameManifest(durable, manifest, "managed release identity mismatch");
}

async function durablyVerifyExactRepairTarget(
  target: string,
  input: Pick<Parameters<typeof repairManagedRelease>[0],
    "manifest" | "expectedManifestSha256" | "paths">,
  verify: HomeArtifactVerifier,
  deps: HomeInstallationDeps,
): Promise<void> {
  await ensureOwnedDirectory(input.paths.releases);
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
  paths: HomeInstallationPaths,
  artifactId: string,
  purpose: "publish" | "repair",
  operation: () => Promise<T>,
): Promise<T> {
  const ownership = await withExclusiveFileLock({
    lockPath: releaseRepairLockPath(paths, artifactId),
    command: `dome-home-release-${purpose}:${artifactId}`,
    wait: { timeoutMs: 30_000, intervalMs: 25 },
  }, operation);
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
  input: Pick<Parameters<typeof repairManagedRelease>[0], "manifest" | "expectedManifestSha256">,
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

export async function publishHomeInstallation(
  path: string,
  record: HomeInstallationRecord,
  deps: HomeInstallationDeps = {},
): Promise<void> {
  if (deps.publishRecord !== undefined) return deps.publishRecord(path, record);
  const installation = dirname(path);
  const installations = dirname(installation);
  const root = dirname(installations);
  await ensureOwnedDirectory(root);
  await ensureOwnedDirectory(installations);
  await ensureOwnedDirectory(installation);
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

function parseHomeInstallation(value: unknown, expectedVault: string): HomeInstallationRecord {
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

async function ensureOwnedDirectory(path: string): Promise<void> {
  if (!await pathPresent(path)) await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) {
    throw new Error(`managed Dome Home path is not a direct owned directory: ${path}`);
  }
}
