// product-host/home-installation: durable selection and immutable managed
// release publication for Dome Home. No ambient symlink participates in
// selection: one closed per-vault record names one content-addressed release.

import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { publishDirectoryExclusive } from "../platform/exclusive-rename";
import { compareStrings } from "../core/compare";
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
  const target = releaseRoot(input.paths, input.manifest.artifact.id);
  if (await pathPresent(target)) {
    try {
      const installed = await verify(target);
      if (installed.artifact.id !== input.manifest.artifact.id) throw new Error("managed release identity mismatch");
      return Object.freeze({ root: target, published: false });
    } catch (error) {
      throw new Error(`immutable managed release is corrupt at ${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await ensureOwnedDirectory(input.paths.root);
  await ensureOwnedDirectory(input.paths.releases);
  const staging = join(input.paths.releases, `.staging-${input.manifest.artifact.id}-${process.pid}-${randomUUID()}`);
  try {
    await cp(resolve(input.source), staging, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      errorOnExist: true,
      force: false,
    });
    const staged = await verify(staging);
    if (staged.artifact.id !== input.manifest.artifact.id) throw new Error("staged release identity changed during copy");
    await (deps.syncRelease ?? fsyncTree)(staging);
    await (deps.publishRelease ?? (async (source, destination) => publishDirectoryExclusive({ source, target: destination, platform: input.platform })))(staging, target);
    await fsyncDirectory(input.paths.releases);
    const published = await verify(target);
    if (published.artifact.id !== input.manifest.artifact.id) throw new Error("published release identity changed");
    return Object.freeze({ root: target, published: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
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
