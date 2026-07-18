import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

import {
  MAX_HOME_ARTIFACT_MANIFEST_BYTES,
  verifyHomeArtifactEvidence,
  type HomeArtifactManifest,
} from "./home-artifact";

export const MAX_COMPRESSED_HOME_ARTIFACT_BYTES = 256 * 1024 * 1024;
export const MAX_HOME_ARTIFACT_TAR_BYTES = 512 * 1024 * 1024;
/** Current release input inventory is below 10k entries; retain ~60% growth headroom. */
export const MAX_HOME_ARTIFACT_ENTRIES = 16_384;
export { MAX_HOME_ARTIFACT_MANIFEST_BYTES } from "./home-artifact";

export type HomeArtifactTarEntry = Readonly<{
  path: string;
  type: "file" | "directory" | "symlink" | "hardlink";
  size: number;
  linkTarget: string | null;
}>;

export type HomeArtifactArchiveExpectation = Readonly<{
  compressedBytes?: number;
  compressedSha256?: string;
  artifactRoot?: string;
  manifestBytes?: number;
  manifestSha256?: string;
  artifactId?: string;
  productVersion?: string;
}>;

export type MaterializedHomeArtifact = Readonly<{
  root: string;
  manifest: HomeArtifactManifest;
  archiveBytes: number;
  archiveSha256: string;
  manifestBytes: number;
  manifestSha256: string;
  /** Remove the one private workspace owned by this materialization. */
  dispose(): Promise<void>;
}>;

type ParsedHomeArtifactTarEntry = HomeArtifactTarEntry & Readonly<{ bodyOffset: number }>;

/** Emit the one normalized USTAR header shape accepted by archive admission. */
export function createNormalizedHomeArtifactTarHeader(
  path: string,
  values: Readonly<{ mode: number; size: number; type: string; link: string }>,
): Buffer {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitHomeTarPath(path);
  homeTarField(header, 0, 100, name);
  homeTarOctalField(header, 100, 8, values.mode);
  homeTarOctalField(header, 108, 8, 0);
  homeTarOctalField(header, 116, 8, 0);
  homeTarOctalField(header, 124, 12, values.size);
  homeTarOctalField(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  homeTarField(header, 156, 1, values.type);
  homeTarField(header, 157, 100, values.link);
  homeTarField(header, 257, 6, "ustar\0");
  homeTarField(header, 263, 2, "00");
  homeTarField(header, 265, 32, "root");
  homeTarField(header, 297, 32, "wheel");
  homeTarField(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  homeTarField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

/** Parse the exact normalized USTAR contract before any extraction. */
export function inspectHomeArtifactTar(input: Uint8Array): Readonly<{
  root: string;
  entries: ReadonlyArray<HomeArtifactTarEntry>;
}> {
  const inspected = parseHomeArtifactTar(input);
  return Object.freeze({
    root: inspected.root,
    entries: Object.freeze(inspected.entries.map(({ bodyOffset: _bodyOffset, ...entry }) => Object.freeze(entry))),
  });
}

/**
 * Admit and materialize exactly one immutable Dome Home archive.
 *
 * The source is read once through a stable regular-file handle. The compressed
 * bytes, normalized USTAR, raw manifest, extracted tree, and verified Product
 * Host identity are bound before the root is returned. All extraction occurs
 * in one mode-0700 workspace, which is removed on every failure.
 */
export async function materializeHomeArtifactArchive(input: Readonly<{
  archive: string;
  temporaryParent?: string;
  maxCompressedBytes?: number;
  expected?: HomeArtifactArchiveExpectation;
}>): Promise<MaterializedHomeArtifact> {
  const maxCompressedBytes = input.maxCompressedBytes ?? MAX_COMPRESSED_HOME_ARTIFACT_BYTES;
  if (!Number.isSafeInteger(maxCompressedBytes) || maxCompressedBytes < 1 ||
    maxCompressedBytes > MAX_COMPRESSED_HOME_ARTIFACT_BYTES) {
    throw new Error("Home artifact compressed size budget is invalid");
  }
  const compressed = await readBoundedRegularFile(
    input.archive,
    maxCompressedBytes,
    input.expected?.compressedBytes,
  );
  const archiveSha256 = sha256(compressed);
  assertExpectedDigest(input.expected?.compressedSha256, archiveSha256, "archive digest");

  let tar: Buffer;
  try {
    tar = gunzipSync(compressed, { maxOutputLength: MAX_HOME_ARTIFACT_TAR_BYTES });
  } catch {
    throw new Error("Home artifact archive is invalid or exceeds its uncompressed size budget");
  }
  const inspected = parseHomeArtifactTar(tar);
  if (input.expected?.artifactRoot !== undefined && inspected.root !== input.expected.artifactRoot) {
    throw new Error("Home artifact root differs from its immutable expectation");
  }
  const manifestEntry = inspected.entries.find((entry) =>
    entry.path === `${inspected.root}/manifest.json` && entry.type === "file"
  );
  if (manifestEntry === undefined) throw new Error("Home artifact archive has no regular manifest");
  if (manifestEntry.size > MAX_HOME_ARTIFACT_MANIFEST_BYTES) {
    throw new Error("Home artifact raw manifest exceeds its size budget");
  }
  const rawManifest = tar.subarray(manifestEntry.bodyOffset, manifestEntry.bodyOffset + manifestEntry.size);
  const manifestSha256 = sha256(rawManifest);
  assertExpectedNumber(input.expected?.manifestBytes, rawManifest.byteLength, "raw manifest size");
  assertExpectedDigest(input.expected?.manifestSha256, manifestSha256, "raw manifest digest");

  const parent = input.temporaryParent === undefined
    ? await realpath(tmpdir())
    : await realpath(resolve(input.temporaryParent));
  const workspace = await mkdtemp(join(parent, ".dome-home-artifact-"));
  try {
    const workspaceInfo = await lstat(workspace);
    if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()) {
      throw new Error("Home artifact workspace is not a private directory");
    }
    const validatedTar = join(workspace, ".validated-artifact.tar");
    await writeFile(validatedTar, tar, { flag: "wx", mode: 0o600 });
    let extractionError: unknown | null = null;
    try {
      await extractValidatedTar(validatedTar, workspace);
    } catch (error) {
      extractionError = error;
    }
    try {
      await rm(validatedTar, { force: true });
    } catch (cleanupError) {
      if (extractionError !== null) {
        throw new AggregateError(
          [extractionError, cleanupError],
          "Home artifact extraction and validated-tar cleanup both failed",
        );
      }
      throw cleanupError;
    }
    if (extractionError !== null) throw extractionError;

    const children = await readdir(workspace);
    if (children.length !== 1 || children[0] !== inspected.root) {
      throw new Error("Home artifact extraction did not produce exactly one root");
    }
    const root = await resolveContainedArtifactRoot(workspace, inspected.root);
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error("Home artifact root is not a directory");
    }
    const extractedManifest = await readFile(join(root, "manifest.json"));
    if (extractedManifest.byteLength !== rawManifest.byteLength || sha256(extractedManifest) !== manifestSha256) {
      throw new Error("Home artifact manifest changed during extraction");
    }
    const evidence = await verifyHomeArtifactEvidence(root);
    if (evidence.manifestSha256 !== manifestSha256) {
      throw new Error("Home artifact verifier observed a different manifest");
    }
    if (input.expected?.artifactId !== undefined &&
      evidence.manifest.artifact.id !== input.expected.artifactId) {
      throw new Error("Home artifact identity differs from its immutable expectation");
    }
    if (input.expected?.productVersion !== undefined &&
      evidence.manifest.product.version !== input.expected.productVersion) {
      throw new Error("Home artifact version differs from its immutable expectation");
    }
    let disposed = false;
    return Object.freeze({
      root,
      manifest: evidence.manifest,
      archiveBytes: compressed.byteLength,
      archiveSha256,
      manifestBytes: rawManifest.byteLength,
      manifestSha256,
      dispose: async () => {
        if (disposed) return;
        await removePrivateWorkspace(workspace);
        disposed = true;
      },
    });
  } catch (error) {
    try {
      await removePrivateWorkspace(workspace);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Home artifact materialization and private workspace cleanup both failed",
      );
    }
    throw error;
  }
}

async function readBoundedRegularFile(
  pathInput: string,
  maxBytes: number,
  expectedBytes: number | undefined,
): Promise<Buffer> {
  const path = resolve(pathInput);
  const lexical = await lstat(path);
  if (!lexical.isFile() || lexical.isSymbolicLink()) {
    throw new Error("Home artifact archive is not a bounded regular file");
  }
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== lexical.dev || before.ino !== lexical.ino ||
      !Number.isSafeInteger(before.size) || before.size < 1 || before.size > maxBytes) {
      throw new Error("Home artifact archive is not a bounded regular file");
    }
    assertExpectedNumber(expectedBytes, before.size, "archive size");
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead <= 0) throw new Error("Home artifact archive changed during its bounded read");
      offset += read.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead !== 0) {
      throw new Error("Home artifact archive changed during its bounded read");
    }
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error("Home artifact archive changed during its bounded read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function extractValidatedTar(tar: string, destination: string): Promise<void> {
  const child = Bun.spawn(["/usr/bin/tar", "-xf", tar, "-C", destination], {
    cwd: destination,
    env: process.env,
    stdout: "ignore",
    stderr: "ignore",
  });
  if (await child.exited !== 0) throw new Error("Home artifact extraction failed");
}

async function resolveContainedArtifactRoot(destination: string, artifactRoot: string): Promise<string> {
  const extracted = await realpath(join(destination, artifactRoot));
  const contained = relative(destination, extracted);
  if (contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
    throw new Error("Home artifact root escaped its private workspace");
  }
  return extracted;
}

async function removePrivateWorkspace(workspace: string): Promise<void> {
  await rm(workspace, { recursive: true, force: true });
  try {
    await lstat(workspace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Home artifact private workspace cleanup was incomplete");
}

function assertExpectedNumber(expected: number | undefined, actual: number, label: string): void {
  if (expected !== undefined && expected !== actual) {
    throw new Error(`Home artifact ${label} differs from its immutable expectation`);
  }
}

function assertExpectedDigest(expected: string | undefined, actual: string, label: string): void {
  if (expected !== undefined && expected !== actual) {
    throw new Error(`Home artifact ${label} differs from its immutable expectation`);
  }
}

function parseHomeArtifactTar(input: Uint8Array): Readonly<{
  root: string;
  entries: ReadonlyArray<ParsedHomeArtifactTarEntry>;
}> {
  if (input.byteLength > MAX_HOME_ARTIFACT_TAR_BYTES) {
    throw new Error("Home artifact tar exceeds its uncompressed size budget");
  }
  const tar = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const entries: ParsedHomeArtifactTarEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (;;) {
    if (offset + 512 > tar.length) throw new Error("Home artifact tar is truncated");
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      if (offset + 512 !== tar.length || !tar.subarray(offset).every((byte) => byte === 0)) {
        throw new Error("Home artifact tar has invalid termination or trailing data");
      }
      break;
    }
    assertHomeTarHeader(header);
    const typeFlag = String.fromCharCode(header[156]!);
    const type = typeFlag === "0" ? "file" : typeFlag === "5" ? "directory" :
      typeFlag === "2" ? "symlink" : typeFlag === "1" ? "hardlink" : null;
    if (type === null) throw new Error(`Home artifact tar contains unsupported entry type ${JSON.stringify(typeFlag)}`);
    const name = homeTarString(header, 0, 100);
    const prefix = homeTarString(header, 345, 155);
    const rawPath = prefix === "" ? name : `${prefix}/${name}`;
    if ((type === "directory") !== rawPath.endsWith("/")) {
      throw new Error(`Home artifact tar member type disagrees with path: ${rawPath}`);
    }
    const path = validateHomeTarPath(type === "directory" ? rawPath.slice(0, -1) : rawPath);
    if (seen.has(path)) throw new Error(`Home artifact tar contains duplicate member: ${path}`);
    seen.add(path);
    const size = homeTarOctal(header, 124, 12);
    if ((type === "directory" || type === "symlink" || type === "hardlink") && size !== 0) {
      throw new Error(`Home artifact tar ${type} has a body: ${path}`);
    }
    const linkTarget = type === "symlink" || type === "hardlink"
      ? homeTarString(header, 157, 100)
      : null;
    const mode = homeTarOctal(header, 100, 8);
    const allowedMode = type === "directory" || type === "symlink" || type === "hardlink"
      ? mode === 0o755
      : mode === 0o644 || mode === 0o755;
    if (!allowedMode) throw new Error(`Home artifact tar mode is not normalized: ${path}`);
    const canonicalHeader = createNormalizedHomeArtifactTarHeader(
      rawPath,
      { mode, size, type: typeFlag, link: linkTarget ?? "" },
    );
    if (!header.equals(canonicalHeader)) {
      throw new Error(`Home artifact tar header is not canonical: ${path}`);
    }
    const bodyOffset = offset;
    if (offset + size > tar.length) throw new Error(`Home artifact tar body is truncated: ${path}`);
    offset += size;
    const padding = (512 - (size % 512)) % 512;
    if (offset + padding > tar.length || !tar.subarray(offset, offset + padding).every((byte) => byte === 0)) {
      throw new Error(`Home artifact tar padding is invalid: ${path}`);
    }
    offset += padding;
    if (entries.length >= MAX_HOME_ARTIFACT_ENTRIES) {
      throw new Error("Home artifact tar exceeds its entry budget");
    }
    entries.push(Object.freeze({ path, type, size, linkTarget, bodyOffset }));
  }
  if (entries.length === 0) throw new Error("Home artifact tar is empty");
  const roots = new Set(entries.map((entry) => entry.path.split("/")[0]!));
  if (roots.size !== 1) throw new Error("Home artifact tar must contain exactly one root");
  const root = [...roots][0]!;
  if (!entries.some((entry) => entry.path === root && entry.type === "directory")) {
    throw new Error("Home artifact tar root must be an explicit directory");
  }
  const rootAbsolute = resolve("/payload", root);
  const reservedAlias = `${root}/runtime/Dome Home`;
  const reservedEntry = entries.find((entry) => entry.path === reservedAlias);
  if (reservedEntry !== undefined && reservedEntry.type !== "hardlink") {
    throw new Error(`Home artifact tar reserved runtime alias is not the canonical hardlink: ${reservedAlias}`);
  }
  for (const link of entries.filter((entry) => entry.type === "hardlink")) {
    const expectedTarget = `${root}/runtime/bun`;
    const target = entries.find((entry) => entry.path === expectedTarget);
    if (link.path !== reservedAlias || link.linkTarget !== expectedTarget ||
      target?.type !== "file" || entries.indexOf(target) >= entries.indexOf(link)) {
      throw new Error(`Home artifact tar contains unsupported hardlink: ${link.path}`);
    }
  }
  const symlinks = entries.filter((entry) => entry.type === "symlink");
  for (const link of symlinks) {
    const target = link.linkTarget;
    if (target === null || target === "" || target.includes("\0") || isAbsolute(target)) {
      throw new Error(`Home artifact tar symlink target is unsafe: ${link.path}`);
    }
    const resolvedTarget = resolve("/payload", dirname(link.path), target);
    if (resolvedTarget !== rootAbsolute && !resolvedTarget.startsWith(`${rootAbsolute}${sep}`)) {
      throw new Error(`Home artifact tar symlink escapes its root: ${link.path}`);
    }
  }
  const nonDirectoryLinks = new Map(
    [...symlinks, ...entries.filter((entry) => entry.type === "hardlink")]
      .map((entry) => [entry.path, entry.type] as const),
  );
  for (const entry of entries) {
    let separatorIndex = entry.path.indexOf("/");
    while (separatorIndex >= 0) {
      const ancestor = entry.path.slice(0, separatorIndex);
      const ancestorType = nonDirectoryLinks.get(ancestor);
      if (ancestorType !== undefined) {
        throw new Error(`Home artifact tar contains a member beneath ${ancestorType}: ${ancestor}`);
      }
      separatorIndex = entry.path.indexOf("/", separatorIndex + 1);
    }
  }
  return Object.freeze({ root, entries: Object.freeze(entries) });
}

function assertHomeTarHeader(header: Buffer): void {
  if (!header.subarray(257, 263).equals(Buffer.from("ustar\0")) ||
    !header.subarray(263, 265).equals(Buffer.from("00"))) {
    throw new Error("Home artifact tar is not normalized USTAR");
  }
  const expected = homeTarOctal(header, 148, 8);
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  const actual = copy.reduce((sum, byte) => sum + byte, 0);
  if (expected !== actual) throw new Error("Home artifact tar header checksum is invalid");
}

function validateHomeTarPath(path: string): string {
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Home artifact tar path is unsafe: ${JSON.stringify(path)}`);
  }
  return path;
}

function homeTarString(buffer: Buffer, offset: number, length: number): string {
  const field = buffer.subarray(offset, offset + length);
  const zero = field.indexOf(0);
  return new TextDecoder("utf-8", { fatal: true }).decode(zero === -1 ? field : field.subarray(0, zero));
}

function homeTarOctal(buffer: Buffer, offset: number, length: number): number {
  const raw = homeTarString(buffer, offset, length).trim().replace(/\0+$/g, "");
  if (!/^[0-7]+$/.test(raw)) throw new Error("Home artifact tar contains an invalid numeric field");
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value)) throw new Error("Home artifact tar numeric field is too large");
  return value;
}

function splitHomeTarPath(path: string): Readonly<{ name: string; prefix: string }> {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const directorySuffix = path.endsWith("/") ? "/" : "";
  const candidate = directorySuffix === "" ? path : path.slice(0, -1);
  for (let index = candidate.lastIndexOf("/"); index > 0; index = candidate.lastIndexOf("/", index - 1)) {
    const prefix = candidate.slice(0, index);
    const name = `${candidate.slice(index + 1)}${directorySuffix}`;
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`Home artifact tar path exceeds USTAR limits: ${path}`);
}

function homeTarField(buffer: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value);
  if (encoded.length > length) throw new Error(`Home artifact tar field exceeds ${length} bytes`);
  encoded.copy(buffer, offset);
}

function homeTarOctalField(buffer: Buffer, offset: number, length: number, value: number): void {
  homeTarField(buffer, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
