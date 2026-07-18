import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  materializeHomeArtifactArchive,
  type MaterializedHomeArtifact,
} from "../product-host/home-artifact-archive";
import {
  PRODUCT_PACKAGE_CAPS,
  validateProductPackageManifest,
  type ProductPackageFile,
  type ProductPackageManifest,
} from "./manifest";

export type InstalledProductEvidence = Readonly<{
  manifest: ProductPackageManifest;
  manifestSha256: string;
  filesVerified: number;
  pwaFilesVerified: number;
  home: Readonly<{ artifactId: string; archiveSha256: string; manifestSha256: string; buildCommit: string }>;
}>;

/** Closed installed-package proof that performs reads only. */
export type ReadOnlyInstalledProductEvidence = Readonly<{
  manifest: ProductPackageManifest;
  manifestSha256: string;
  filesVerified: number;
  pwaFilesVerified: number;
  /** Identity declared by the verified package, not an extracted Home proof. */
  declaredHome: Readonly<{
    artifactId: string;
    archiveSha256: string;
    manifestSha256: string;
    buildCommit: string;
  }>;
}>;

export type InstalledProductVerifierDependencies = Readonly<{
  materializeHome(input: Parameters<typeof materializeHomeArtifactArchive>[0]): Promise<MaterializedHomeArtifact>;
}>;

const INSTALLED_PRODUCT_TREE_POLICY = Object.freeze({
  packageManagerOwnedRoot: "node_modules" as const,
});

/** Verify one globally installed complete product without trusting npm for package-owned evidence. */
export async function verifyInstalledProduct(input: Readonly<{
  packageRoot: string;
  temporaryParent?: string;
}>, dependencies: InstalledProductVerifierDependencies = {
  materializeHome: async (archiveInput) => await materializeHomeArtifactArchive(archiveInput),
}): Promise<InstalledProductEvidence> {
  const verified = await verifyInstalledProductPackageRoot(input.packageRoot);
  const { manifest } = verified.evidence;
  const homeArchive = join(verified.packageRoot, ...manifest.home.path.split("/"));
  const materialized = await dependencies.materializeHome({
    archive: homeArchive,
    ...(input.temporaryParent === undefined ? {} : { temporaryParent: input.temporaryParent }),
    maxCompressedBytes: PRODUCT_PACKAGE_CAPS.packedBytes,
    expected: {
      compressedBytes: manifest.home.bytes,
      compressedSha256: manifest.home.sha256,
      artifactRoot: manifest.home.root,
      manifestSha256: manifest.home.manifestSha256,
      artifactId: manifest.home.artifactId,
      productVersion: manifest.home.productVersion,
    },
  });
  let primary: unknown;
  try {
    if (materialized.manifest.build.gitCommit !== manifest.home.buildCommit ||
      materialized.manifest.build.gitCommit !== manifest.package.sourceCommit ||
      basename(materialized.root) !== manifest.home.root) {
      throw new Error("installed Home provenance differs from product package identity");
    }
    return Object.freeze({
      manifest: verified.evidence.manifest,
      manifestSha256: verified.evidence.manifestSha256,
      filesVerified: verified.evidence.filesVerified,
      pwaFilesVerified: verified.evidence.pwaFilesVerified,
      home: Object.freeze({
        artifactId: materialized.manifest.artifact.id,
        archiveSha256: materialized.archiveSha256,
        manifestSha256: materialized.manifestSha256,
        buildCommit: materialized.manifest.build.gitCommit,
      }),
    });
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try { await materialized.dispose(); }
    catch (cleanup) {
      if (primary !== undefined) {
        throw new AggregateError([primary, cleanup], "installed Home verification and cleanup both failed");
      }
      throw cleanup;
    }
  }
}

/**
 * Verify the closed installed package tree, exact file bytes/modes, and the
 * compressed Home archive hash without extracting, executing, or writing.
 * Full Home admission composes this proof in `verifyInstalledProduct`.
 */
export async function verifyInstalledProductReadOnly(input: Readonly<{
  packageRoot: string;
}>): Promise<ReadOnlyInstalledProductEvidence> {
  return (await verifyInstalledProductPackageRoot(input.packageRoot)).evidence;
}

async function verifyInstalledProductPackageRoot(packageRootInput: string): Promise<Readonly<{
  packageRoot: string;
  evidence: ReadOnlyInstalledProductEvidence;
}>> {
  const requestedRoot = resolve(packageRootInput);
  const lexicalRoot = await lstat(requestedRoot);
  if (!lexicalRoot.isDirectory() || lexicalRoot.isSymbolicLink()) throw new Error("installed product root is not a direct directory");
  const packageRoot = await realpath(requestedRoot);
  const rootInfo = await lstat(packageRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.dev !== lexicalRoot.dev || rootInfo.ino !== lexicalRoot.ino) {
    throw new Error("installed product root identity is inconsistent");
  }
  const manifestPath = join(packageRoot, "product", "manifest.json");
  const manifestRead = await readBoundedStableFile(packageRoot, manifestPath, PRODUCT_PACKAGE_CAPS.manifestBytes);
  if (manifestRead.mode !== 0o644) throw new Error("installed product manifest mode is not 0644");
  const manifestBytes = manifestRead.bytes;
  const manifest = validateProductPackageManifest(JSON.parse(manifestBytes.toString("utf8")));
  await verifyClosedTree(
    packageRoot,
    [...manifest.files.map((entry) => entry.path), "product/manifest.json"],
    INSTALLED_PRODUCT_TREE_POLICY,
  );
  for (const evidence of manifest.files) {
    await verifyFile(packageRoot, evidence);
  }
  return Object.freeze({
    packageRoot,
    evidence: Object.freeze({
      manifest,
      manifestSha256: sha256(manifestBytes),
      filesVerified: manifest.files.length,
      pwaFilesVerified: manifest.pwa.entries.length,
      declaredHome: Object.freeze({
        artifactId: manifest.home.artifactId,
        archiveSha256: manifest.home.sha256,
        manifestSha256: manifest.home.manifestSha256,
        buildCommit: manifest.home.buildCommit,
      }),
    }),
  });
}

async function verifyFile(root: string, evidence: ProductPackageFile): Promise<void> {
  const path = join(root, ...evidence.path.split("/"));
  const maxBytes = evidence.path.startsWith("product/home/") ? PRODUCT_PACKAGE_CAPS.packedBytes :
    evidence.path.startsWith("product/pwa/") ? PRODUCT_PACKAGE_CAPS.pwaBytes : PRODUCT_PACKAGE_CAPS.sourceFileBytes;
  const read = await readBoundedStableFile(root, path, maxBytes);
  if (read.bytes.byteLength !== evidence.bytes || sha256(read.bytes) !== evidence.sha256 ||
    read.mode !== Number.parseInt(evidence.mode, 8)) {
    throw new Error(`installed product file differs from closed evidence: ${evidence.path}`);
  }
}

async function verifyClosedTree(
  root: string,
  expectedFiles: ReadonlyArray<string>,
  policy: typeof INSTALLED_PRODUCT_TREE_POLICY,
): Promise<void> {
  if (expectedFiles.some((path) =>
    path === policy.packageManagerOwnedRoot || path.startsWith(`${policy.packageManagerOwnedRoot}/`))) {
    throw new Error("installed product manifest crosses the package-manager ownership boundary");
  }
  const files = new Set(expectedFiles);
  const directories = new Set<string>();
  for (const path of expectedFiles) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join("/"));
  }
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (directory === root && path === policy.packageManagerOwnedRoot) {
        const info = await lstat(absolute);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new Error(`installed product package-manager root is not a direct directory: ${path}`);
        }
        if (!isSafeInstalledDirectoryMode(info.mode)) {
          throw new Error(`installed product package-manager directory mode is unsafe: ${path}`);
        }
        continue;
      }
      if (entry.isSymbolicLink()) throw new Error(`installed product contains a symlink: ${path}`);
      if (entry.isDirectory()) {
        if (!directories.has(path)) throw new Error(`installed product contains an unexpected directory: ${path}`);
        const info = await lstat(absolute);
        if (!isSafeInstalledDirectoryMode(info.mode)) {
          throw new Error(`installed product directory mode is unsafe: ${path}`);
        }
        await visit(absolute);
      } else if (entry.isFile()) {
        if (!files.has(path)) throw new Error(`installed product contains an unexpected file: ${path}`);
      } else {
        throw new Error(`installed product contains a special entry: ${path}`);
      }
    }
  }
  await visit(root);
}

function isSafeInstalledDirectoryMode(mode: number): boolean {
  const permissions = mode & 0o7777;
  return (permissions & 0o700) === 0o700 &&
    (permissions & 0o022) === 0 &&
    (permissions & 0o7000) === 0;
}

async function readBoundedStableFile(
  root: string, path: string, maxBytes: number,
): Promise<Readonly<{ bytes: Buffer; mode: number }>> {
  const parent = dirname(path);
  if (await realpath(parent) !== parent || !contains(root, path)) {
    throw new Error("installed product file parent escapes through a symlink");
  }
  const lexical = await lstat(path);
  if (!lexical.isFile() || lexical.isSymbolicLink() || !Number.isSafeInteger(lexical.size) ||
    lexical.size < 0 || lexical.size > maxBytes) {
    throw new Error(`installed product contains an invalid bounded file: ${path.split(sep).at(-1)}`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== lexical.dev || before.ino !== lexical.ino || before.size !== lexical.size) {
      throw new Error("installed product file identity changed before read");
    }
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead <= 0) throw new Error("installed product file changed during read");
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error("installed product file changed during read");
    }
    if (await realpath(parent) !== parent) throw new Error("installed product file parent changed during read");
    return Object.freeze({ bytes, mode: before.mode & 0o7777 });
  } finally {
    await handle.close();
  }
}

function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
