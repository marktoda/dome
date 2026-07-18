import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { HomeArtifactEntry, HomeArtifactManifest } from "../../src/product-host/home-artifact";
import {
  assertProductPackageSafePath,
  isProductPackageSourcePath,
  PRODUCT_PACKAGE_CAPS,
  PRODUCT_PACKAGE_NAME,
  PRODUCT_PACKAGE_SCHEMA,
  PRODUCT_PACKAGE_SOURCE_PATHS,
  PRODUCT_PACKAGE_VERSION,
  validateProductPackageManifest,
  type ProductPackageFile,
  type ProductPackageManifest,
} from "../../src/product-package/manifest";
import { preparePrivateDirectoryPublication } from "../../src/platform/private-directory-publication";
import { verifyPackedProductArchive } from "./archive";
import {
  runBoundedReleaseCommand,
  type ReleaseCommandResult,
  type ReleaseCommandOptions,
} from "../release-command";

export {
  PRODUCT_PACKAGE_CAPS,
  PRODUCT_PACKAGE_SOURCE_PATHS,
  validateProductPackageManifest,
} from "../../src/product-package/manifest";

export type ProductPackagePackResult = Readonly<{
  filename: string;
  size: number;
  unpackedSize: number;
  entryCount: number;
  files: ReadonlyArray<Readonly<{ path: string; size: number; mode: number }>>;
}>;

export type PortableProductPackageAssembly = Readonly<{
  evidence: false;
  tarball: string;
  packed: ProductPackagePackResult;
  manifest: ProductPackageManifest;
}>;

export type ProductPackageBuildHomeResult = Readonly<{
  archive: string;
  archiveSha256: string;
  manifest: HomeArtifactManifest;
}>;

export type ProductPackageArchiveInspection = Readonly<{
  root: string;
  manifest: HomeArtifactManifest;
  archiveBytes: number;
  archiveSha256: string;
  manifestSha256: string;
  dispose(): Promise<void>;
}>;

export type ProductPackageAssemblerDependencies = Readonly<{
  buildHome(input: Readonly<{ repoRoot: string; outputDir: string }>): Promise<ProductPackageBuildHomeResult>;
  inspectHome(input: Readonly<{
    archive: string;
    temporaryParent: string;
    expected: Readonly<{ compressedSha256: string; artifactId: string; productVersion: string }>;
  }>): Promise<ProductPackageArchiveInspection>;
  publish(input: Readonly<{ source: string; target: string }>): Promise<void>;
}>;

export type ProductPackageCommandResult = ReleaseCommandResult;
type CommandResult = ProductPackageCommandResult;
type TreeEntry = Readonly<{ mode: "100644" | "100755"; type: "blob"; object: string; size: number; path: string }>;

/**
 * Portable orchestration seam. It may create a test tarball, but can never
 * return release evidence. The production script supplies the only real Home
 * builder and archive verifier and promotes the closed result separately.
 */
export async function assembleProductPackageForTests(
  input: Readonly<{ repoRoot: string; outputDir: string }>,
  dependencies: ProductPackageAssemblerDependencies,
): Promise<PortableProductPackageAssembly> {
  const repoRoot = await realpath(resolve(input.repoRoot));
  const sourceCommit = await assertCleanTrackedHead(repoRoot);
  const tree = await readHeadTree(repoRoot, sourceCommit);
  validateTrackedSource(tree);
  const publication = await preparePrivateDirectoryPublication({
    target: resolve(input.outputDir),
    prefix: ".dome-product-package-",
    label: "product package",
  });
  const privateRoot = publication.stage;
  let primaryFailure: unknown;
  try {
    const work = join(privateRoot, ".work");
    const stage = join(work, "stage");
    const homeOutput = join(work, "home-build");
    const packOutput = join(work, "pack");
    await mkdir(work, { mode: 0o700 });
    await Promise.all([mkdir(stage, { mode: 0o700 }), mkdir(packOutput, { mode: 0o700 })]);
    const capturedFiles = await stageCapturedBlobs(repoRoot, stage, tree);
    const stagedCapturedFiles = await inventoryStage(stage, new Set());
    if (JSON.stringify(stagedCapturedFiles) !== JSON.stringify(capturedFiles)) {
      throw new Error("staged package source differs from captured commit blobs");
    }
    await sanitizeStagedPackageManifest(stage);
    // Close over normalized tracked input before invoking the expensive Home
    // builder. The completed stage is inventoried again after payload assembly.
    const sanitizedSourceFiles = await inventoryStage(stage, new Set());

    const built = await dependencies.buildHome({ repoRoot, outputDir: homeOutput });
    const materialized = await dependencies.inspectHome({
      archive: built.archive,
      temporaryParent: privateRoot,
      expected: {
        compressedSha256: built.archiveSha256,
        artifactId: built.manifest.artifact.id,
        productVersion: PRODUCT_PACKAGE_VERSION,
      },
    });
    let home: ProductPackageManifest["home"];
    let pwaEntries: ReadonlyArray<ProductPackageFile>;
    try {
      assertExactHomeIdentity(built, materialized, sourceCommit);
      const homeName = basename(built.archive);
      if (!/^dome-home-0\.4\.0-darwin-arm64\.tar\.gz$/.test(homeName)) {
        throw new Error(`Home archive name is not the 0.4.0 product payload: ${homeName}`);
      }
      const homeRelative = `product/home/${homeName}`;
      const homeDestination = join(stage, ...homeRelative.split("/"));
      await mkdir(dirname(homeDestination), { recursive: true, mode: 0o755 });
      await copyFile(built.archive, homeDestination);
      await chmod(homeDestination, 0o644);
      const copied = await fileEvidence(homeDestination, homeRelative, PRODUCT_PACKAGE_CAPS.packedBytes);
      if (copied.bytes !== materialized.archiveBytes || copied.sha256 !== materialized.archiveSha256) {
        throw new Error("copied Home archive differs from verified archive evidence");
      }
      home = Object.freeze({
        path: homeRelative,
        bytes: copied.bytes,
        sha256: copied.sha256,
        root: materialized.root.split(sep).at(-1)!,
        manifestSha256: materialized.manifestSha256,
        artifactId: materialized.manifest.artifact.id,
        productVersion: PRODUCT_PACKAGE_VERSION,
        buildCommit: sourceCommit,
      });
      pwaEntries = await copyAndInventoryPwa(
        join(materialized.root, "app", "pwa", "dist"),
        join(stage, "product", "pwa"),
      );
      assertPwaMatchesVerifiedHome(pwaEntries, materialized.manifest);
    } catch (primary) {
      try { await materialized.dispose(); }
      catch (cleanup) { throw new AggregateError([primary, cleanup], "Home package materialization and cleanup both failed"); }
      throw primary;
    }
    await materialized.dispose();

    const files = await inventoryStage(stage, new Set(["product/manifest.json"]));
    if (JSON.stringify(files.filter((entry) => !entry.path.startsWith("product/"))) !==
      JSON.stringify(sanitizedSourceFiles)) {
      throw new Error("normalized package source changed during product assembly");
    }
    const manifest: ProductPackageManifest = Object.freeze({
      schema: PRODUCT_PACKAGE_SCHEMA,
      package: Object.freeze({ name: PRODUCT_PACKAGE_NAME, version: PRODUCT_PACKAGE_VERSION, sourceCommit }),
      platform: Object.freeze({ os: "darwin" as const, arch: "arm64" as const }),
      home,
      pwa: Object.freeze({ root: "product/pwa" as const, entries: pwaEntries }),
      files,
    });
    validateProductPackageManifest(manifest);
    const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
    if (Buffer.byteLength(manifestBody) > PRODUCT_PACKAGE_CAPS.manifestBytes) {
      throw new Error("product package manifest exceeds its size budget");
    }
    await writeFile(join(stage, "product", "manifest.json"), manifestBody, { flag: "wx", mode: 0o644 });
    await assertStageMatchesManifest(stage, manifest, manifestBody);
    const manifestEvidence = await fileEvidence(
      join(stage, "product", "manifest.json"), "product/manifest.json", PRODUCT_PACKAGE_CAPS.manifestBytes,
    );
    if (await assertCleanTrackedHead(repoRoot) !== sourceCommit) {
      throw new Error("source HEAD changed during complete product assembly");
    }

    const packed = await npmPackStage(stage, packOutput);
    validatePackedProduct(packed, manifest, manifestEvidence);
    const sourceTarball = join(packOutput, basename(packed.filename));
    await verifyPackedProductArchive({
      archive: sourceTarball,
      compressedBytes: packed.size,
      expected: Object.freeze([...manifest.files, manifestEvidence]),
    });
    const stagedTarball = join(privateRoot, basename(packed.filename));
    await copyFile(sourceTarball, stagedTarball);
    await chmod(stagedTarball, 0o644);
    await verifyPackedProductArchive({
      archive: stagedTarball,
      compressedBytes: packed.size,
      expected: Object.freeze([...manifest.files, manifestEvidence]),
    });
    await rm(work, { recursive: true });
    await publication.publish(async (source, target) => await dependencies.publish({ source, target }));
    const tarball = join(publication.target, basename(packed.filename));
    return Object.freeze({ evidence: false as const, tarball, packed, manifest });
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try { await publication.dispose(); }
    catch (cleanup) {
      if (primaryFailure !== undefined) {
        throw new AggregateError([primaryFailure, cleanup], "product package assembly and private cleanup both failed");
      }
      throw cleanup;
    }
  }
}

function assertPwaMatchesVerifiedHome(
  pwa: ReadonlyArray<ProductPackageFile>,
  home: HomeArtifactManifest,
): void {
  const expected = home.entries
    .filter((entry): entry is Extract<HomeArtifactEntry, { type: "file" }> =>
      entry.type === "file" && entry.path.startsWith(`${home.pwa}/`))
    .map((entry) => Object.freeze({
      path: `product/pwa/${entry.path.slice(`${home.pwa}/`.length)}`,
      bytes: entry.bytes,
      sha256: entry.sha256,
      mode: entry.mode,
    }))
    .sort((left, right) => left.path < right.path ? -1 : 1);
  if (JSON.stringify(expected) !== JSON.stringify(pwa)) {
    throw new Error("copied PWA differs from verified Home manifest inventory");
  }
}

async function assertCleanTrackedHead(repoRoot: string): Promise<string> {
  const status = await runBoundedProductCommand(["git", "status", "--porcelain=v1", "--untracked-files=all"], repoRoot, {
    timeoutMs: 15_000, maxStdoutBytes: 1024 * 1024, maxStderrBytes: 64 * 1024,
  });
  if (status.stdout.byteLength !== 0) throw new Error("complete product packaging requires a clean tracked HEAD with no untracked files");
  const head = (await runBoundedProductCommand(["git", "rev-parse", "HEAD"], repoRoot, {
    timeoutMs: 15_000, maxStdoutBytes: 128, maxStderrBytes: 64 * 1024,
  })).stdout.toString("utf8").trim();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("complete product packaging requires one commit HEAD");
  return head;
}

async function readHeadTree(repoRoot: string, sourceCommit: string): Promise<ReadonlyArray<TreeEntry>> {
  const output = (await runBoundedProductCommand([
    "git", "ls-tree", "-r", "-l", "-z", "--full-tree", sourceCommit, "--", ...PRODUCT_PACKAGE_SOURCE_PATHS,
  ], repoRoot, { timeoutMs: 15_000, maxStdoutBytes: 1024 * 1024, maxStderrBytes: 64 * 1024 })).stdout.toString("utf8");
  const entries: TreeEntry[] = [];
  for (const row of output.split("\0")) {
    if (row === "") continue;
    const match = /^(\d{6}) ([^ ]+) ([0-9a-f]{40})\s+(\d+)\t(.+)$/.exec(row);
    if (match === null) throw new Error("tracked HEAD inventory is malformed");
    const size = Number(match[4]);
    entries.push(Object.freeze({
      mode: match[1] as TreeEntry["mode"], type: match[2] as TreeEntry["type"], object: match[3]!, size, path: match[5]!,
    }));
  }
  return Object.freeze(entries);
}

function validateTrackedSource(entries: ReadonlyArray<TreeEntry>): void {
  if (entries.length === 0 || entries.length > PRODUCT_PACKAGE_CAPS.sourceEntries) {
    throw new Error("tracked package source inventory is empty or exceeds its entry budget");
  }
  const paths = new Set(entries.map((entry) => entry.path));
  for (const required of ["package.json", "LICENSE", "README.md", "bin/dome", "src/index.ts"]) {
    if (!paths.has(required)) throw new Error(`tracked package source is missing ${required}`);
  }
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
      throw new Error(`tracked package source contains a symlink or special entry: ${entry.path}`);
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > PRODUCT_PACKAGE_CAPS.sourceFileBytes) {
      throw new Error(`tracked package source blob exceeds its per-file byte budget: ${entry.path}`);
    }
    totalBytes += entry.size;
    assertProductPackageSafePath(entry.path);
    if (!isProductPackageSourcePath(entry.path)) throw new Error(`tracked package source path is outside the allowlist: ${entry.path}`);
  }
  if (totalBytes > PRODUCT_PACKAGE_CAPS.sourceBytes) throw new Error("tracked package source exceeds its total byte budget");
}

async function stageCapturedBlobs(
  repoRoot: string,
  stage: string,
  entries: ReadonlyArray<TreeEntry>,
): Promise<ReadonlyArray<ProductPackageFile>> {
  const evidence: ProductPackageFile[] = [];
  for (const entry of entries) {
    const result = await runBoundedProductCommand(["git", "cat-file", "blob", entry.object], repoRoot, {
      timeoutMs: 15_000,
      maxStdoutBytes: entry.size,
      maxStderrBytes: 64 * 1024,
    });
    if (result.stdout.byteLength !== entry.size || gitBlobSha1(result.stdout) !== entry.object) {
      throw new Error(`captured package source blob differs from Git identity: ${entry.path}`);
    }
    const target = join(stage, ...entry.path.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    const mode = entry.mode === "100755" ? "0755" as const : "0644" as const;
    await writeFile(target, result.stdout, { flag: "wx", mode: Number.parseInt(mode, 8) });
    await chmod(target, Number.parseInt(mode, 8));
    evidence.push(Object.freeze({ path: entry.path, bytes: entry.size, sha256: sha256(result.stdout), mode }));
  }
  evidence.sort((left, right) => left.path < right.path ? -1 : 1);
  return Object.freeze(evidence);
}

async function sanitizeStagedPackageManifest(stage: string): Promise<void> {
  const path = join(stage, "package.json");
  const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  if (parsed["name"] !== PRODUCT_PACKAGE_NAME || parsed["version"] !== PRODUCT_PACKAGE_VERSION) {
    throw new Error("tracked package.json does not carry the complete product identity");
  }
  const scripts = parsed["scripts"];
  if (scripts !== undefined && (typeof scripts !== "object" || scripts === null || Array.isArray(scripts))) {
    throw new Error("tracked package.json scripts must be an object");
  }
  for (const lifecycle of [
    "preinstall", "install", "postinstall", "prepublish", "prepublishOnly", "prepare", "prepack", "postpack",
  ]) {
    if (scripts !== undefined && lifecycle in scripts) {
      throw new Error(`tracked package.json contains forbidden install or publish lifecycle hook: ${lifecycle}`);
    }
  }
  delete parsed["devDependencies"];
  delete parsed["scripts"];
  const files = parsed["files"];
  if (!Array.isArray(files) || !files.includes("product/")) {
    throw new Error("tracked package.json does not include the generated product payload");
  }
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o644 });
}

async function copyAndInventoryPwa(source: string, destination: string): Promise<ReadonlyArray<ProductPackageFile>> {
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error("production PWA input is not a directory");
  await mkdir(destination, { recursive: true, mode: 0o755 });
  const entries: ProductPackageFile[] = [];
  let totalBytes = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const absolute = join(directory, entry.name);
      const relativePath = relative(source, absolute).split(sep).join("/");
      if (!isSafeRelativePath(relativePath) || entry.isSymbolicLink()) {
        throw new Error(`production PWA contains an unsafe path: ${relativePath}`);
      }
      if (entry.isDirectory()) { await visit(absolute); continue; }
      if (!entry.isFile()) throw new Error(`production PWA contains a special file: ${relativePath}`);
      const targetRelative = `product/pwa/${relativePath}`;
      assertProductPackageSafePath(targetRelative);
      const target = join(destination, ...relativePath.split("/"));
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      await copyFile(absolute, target);
      await chmod(target, 0o644);
      const evidence = await fileEvidence(target, targetRelative, PRODUCT_PACKAGE_CAPS.pwaBytes);
      totalBytes += evidence.bytes;
      entries.push(evidence);
      if (entries.length > PRODUCT_PACKAGE_CAPS.pwaEntries || totalBytes > PRODUCT_PACKAGE_CAPS.pwaBytes) {
        throw new Error("production PWA exceeds its package inventory budget");
      }
    }
  }
  await visit(source);
  entries.sort((left, right) => left.path < right.path ? -1 : 1);
  if (!entries.some((entry) => entry.path === "product/pwa/index.html")) {
    throw new Error("production PWA inventory is missing index.html");
  }
  return Object.freeze(entries);
}

async function inventoryStage(stage: string, excluded: ReadonlySet<string>): Promise<ReadonlyArray<ProductPackageFile>> {
  const files: ProductPackageFile[] = [];
  let totalBytes = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const absolute = join(directory, entry.name);
      const path = relative(stage, absolute).split(sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`product package stage contains a symlink: ${path}`);
      if (entry.isDirectory()) { await visit(absolute); continue; }
      if (!entry.isFile()) throw new Error(`product package stage contains a special file: ${path}`);
      if (!excluded.has(path)) {
        const maxBytes = path.startsWith("product/home/") ? PRODUCT_PACKAGE_CAPS.packedBytes :
          path.startsWith("product/pwa/") ? PRODUCT_PACKAGE_CAPS.pwaBytes :
          path === "product/manifest.json" ? PRODUCT_PACKAGE_CAPS.manifestBytes : PRODUCT_PACKAGE_CAPS.sourceFileBytes;
        const evidence = await fileEvidence(absolute, path, maxBytes);
        totalBytes += evidence.bytes;
        if (files.length >= PRODUCT_PACKAGE_CAPS.packedEntries || totalBytes > PRODUCT_PACKAGE_CAPS.unpackedBytes) {
          throw new Error("product package stage exceeds its entry or byte budget");
        }
        files.push(evidence);
      }
    }
  }
  await visit(stage);
  files.sort((left, right) => left.path < right.path ? -1 : 1);
  return Object.freeze(files);
}

async function fileEvidence(path: string, relativePath: string, maxBytes: number): Promise<ProductPackageFile> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`package file is not regular: ${relativePath}`);
  if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > maxBytes) {
    throw new Error(`package file exceeds its byte budget: ${relativePath}`);
  }
  const mode = (info.mode & 0o111) === 0 ? "0644" as const : "0755" as const;
  if ((info.mode & 0o777) !== Number.parseInt(mode, 8)) throw new Error(`package file mode is not normalized: ${relativePath}`);
  const body = await readFile(path);
  assertNoSecretContent(relativePath, body);
  return Object.freeze({ path: relativePath, bytes: body.byteLength, sha256: sha256(body), mode });
}

async function assertStageMatchesManifest(
  stage: string, manifest: ProductPackageManifest, manifestBody: string,
): Promise<void> {
  const actual = await inventoryStage(stage, new Set(["product/manifest.json"]));
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    throw new Error("product package stage changed after manifest closure");
  }
  const actualManifestBody = await readFile(join(stage, "product", "manifest.json"), "utf8");
  if (actualManifestBody !== manifestBody) throw new Error("product package manifest bytes changed after closure");
  const parsed = JSON.parse(actualManifestBody);
  validateProductPackageManifest(parsed);
  if (JSON.stringify(parsed) !== JSON.stringify(manifest)) {
    throw new Error("product package manifest identity changed after closure");
  }
}

async function npmPackStage(stage: string, destination: string): Promise<ProductPackagePackResult> {
  const output = await runBoundedProductCommand([
    "npm", "pack", "--ignore-scripts", "--json", "--pack-destination", destination,
  ], stage, { timeoutMs: 60_000, maxStdoutBytes: 4 * 1024 * 1024, maxStderrBytes: 1024 * 1024 });
  const parsed = JSON.parse(output.stdout.toString("utf8")) as ReadonlyArray<ProductPackagePackResult>;
  if (parsed.length !== 1 || parsed[0] === undefined) throw new Error("npm pack did not return exactly one artifact");
  return parsed[0];
}

function validatePackedProduct(
  packed: ProductPackagePackResult,
  manifest: ProductPackageManifest,
  manifestEvidence: ProductPackageFile,
): void {
  if (packed.entryCount !== packed.files.length || packed.entryCount > PRODUCT_PACKAGE_CAPS.packedEntries ||
    packed.size > PRODUCT_PACKAGE_CAPS.packedBytes ||
    packed.unpackedSize > PRODUCT_PACKAGE_CAPS.unpackedBytes) {
    throw new Error("complete product tarball inventory or byte budget is invalid");
  }
  if (packed.filename !== "marktoda-dome-0.4.0.tgz") {
    throw new Error(`npm tarball filename is unexpected: ${packed.filename}`);
  }
  const expected = [...manifest.files, manifestEvidence]
    .map((entry) => ({ path: entry.path, size: entry.bytes, mode: Number.parseInt(entry.mode, 8) }))
    .sort((left, right) => left.path < right.path ? -1 : 1);
  const actual = packed.files
    .map((entry) => ({ path: entry.path, size: entry.size, mode: entry.mode }))
    .sort((left, right) => left.path < right.path ? -1 : 1);
  if (new Set(actual.map((entry) => entry.path)).size !== actual.length ||
    JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("npm tarball differs from the closed product package inventory");
  }
}

function assertExactHomeIdentity(
  built: ProductPackageBuildHomeResult,
  inspected: ProductPackageArchiveInspection,
  sourceCommit: string,
): void {
  const manifest = inspected.manifest;
  if (built.archiveSha256 !== inspected.archiveSha256 || built.manifest.artifact.id !== manifest.artifact.id ||
    built.manifest.product.version !== PRODUCT_PACKAGE_VERSION || manifest.product.version !== PRODUCT_PACKAGE_VERSION ||
    built.manifest.build.gitCommit !== sourceCommit || manifest.build.gitCommit !== sourceCommit ||
    manifest.target.os !== "darwin" || manifest.target.arch !== "arm64") {
    throw new Error("built Home identity differs from verified archive evidence");
  }
}

function isSafeRelativePath(path: string): boolean {
  return path !== "" && !isAbsolute(path) && !path.includes("\\") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

function assertNoSecretContent(path: string, bytes: Uint8Array): void {
  if (!/\.(?:css|html|js|json|md|sh|ts|txt|webmanifest|ya?ml)$/i.test(path) || bytes.byteLength > 8 * 1024 * 1024) {
    return;
  }
  const text = Buffer.from(bytes).toString("utf8");
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) ||
    /\bAKIA[0-9A-Z]{16}\b/.test(text) || /\bghp_[A-Za-z0-9]{36}\b/.test(text) ||
    /\bsk-ant-[A-Za-z0-9_-]{20,}\b/.test(text)) {
    throw new Error(`product package contains a high-confidence secret marker: ${path}`);
  }
}

export type BoundedCommandOptions = ReleaseCommandOptions;

export async function runBoundedProductCommand(
  command: ReadonlyArray<string>,
  cwd: string,
  options: BoundedCommandOptions,
): Promise<CommandResult> {
  return await runBoundedReleaseCommand(command, cwd, options);
}

export async function runProductPackageCommandForTests(
  command: ReadonlyArray<string>, cwd: string, timeoutMs: number,
): Promise<void> {
  await runBoundedProductCommand(command, cwd, { timeoutMs, maxStdoutBytes: 1024, maxStderrBytes: 1024 });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitBlobSha1(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}
