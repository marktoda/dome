#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";

const REPO_ROOT = resolve(import.meta.dir, "..");

export const HOME_ARTIFACT_SCHEMA = "dome.home-artifact/v1" as const;
export const HOME_ARTIFACT_TARGET = Object.freeze({ os: "darwin", arch: "arm64" });
export const PINNED_BUN_VERSION = "1.2.13";
export const PINNED_BUN_ARCHIVE_URL =
  "https://github.com/oven-sh/bun/releases/download/bun-v1.2.13/bun-darwin-aarch64.zip";
export const PINNED_BUN_ARCHIVE_SHA256 = "8154367524d8c298edb269b8d0df61d469ec4194d361c07e4b8d2c65fbbc2efb";
export const PINNED_BUN_BINARY_SHA256 = "c059443bc18f61b17609d1c3c7ae3fa7d8e2c121921732baf2b71964c7142f6c";

export type HomeArtifactManifest = {
  readonly schema: typeof HOME_ARTIFACT_SCHEMA;
  readonly product: { readonly name: "Dome Home"; readonly version: string };
  readonly target: typeof HOME_ARTIFACT_TARGET;
  readonly build: { readonly gitCommit: string };
  readonly artifact: { readonly id: string };
  readonly runtime: {
    readonly name: "bun";
    readonly version: string;
    readonly sourceUrl: string;
    readonly archiveSha256: string;
    readonly sha256: string;
  };
  readonly entrypoint: "bin/dome";
  readonly pwa: "app/pwa/dist";
  readonly distribution: {
    readonly signed: false;
    readonly notarized: false;
    readonly upgradeSupported: false;
  };
  readonly entries: ReadonlyArray<HomeArtifactEntry>;
};

export type HomeArtifactEntry =
  | { readonly type: "file"; readonly path: string; readonly bytes: number; readonly sha256: string; readonly mode: string }
  | { readonly type: "directory"; readonly path: string; readonly mode: string }
  | { readonly type: "symlink"; readonly path: string; readonly target: string; readonly targetSha256: string };

type BuildOptions = {
  readonly repoRoot?: string;
  readonly outputDir?: string;
  readonly skipPwaBuild?: boolean;
};

export async function buildHomeArtifact(options: BuildOptions = {}): Promise<{
  readonly archive: string;
  readonly archiveSha256: string;
  readonly directory: string;
  readonly manifest: HomeArtifactManifest;
}> {
  const repoRoot = resolve(options.repoRoot ?? REPO_ROOT);
  const outputDir = resolve(options.outputDir ?? join(repoRoot, "dist"));
  const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
    readonly version: string;
  };

  const dirty = (await run(["git", "status", "--porcelain", "--untracked-files=all"], repoRoot)).stdout.trim();
  if (dirty !== "") {
    throw new Error("Dome Home artifacts require a clean git worktree so build.gitCommit identifies their source");
  }
  const sourceHead = (await run(["git", "rev-parse", "HEAD"], repoRoot)).stdout.trim();
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(`Dome Home v1 artifact must be built on darwin-arm64, got ${process.platform}-${process.arch}`);
  }
  const downloadedRuntime = await downloadPinnedRuntime();
  const runtimePath = downloadedRuntime.path;
  try {
    if (!options.skipPwaBuild) {
      await run([runtimePath, "install", "--frozen-lockfile"], repoRoot);
      await run([runtimePath, "install", "--frozen-lockfile"], join(repoRoot, "pwa"));
      await run([runtimePath, "run", "build"], join(repoRoot, "pwa"));
    }
    const pwaDist = join(repoRoot, "pwa", "dist");
    if (!existsSync(join(pwaDist, "index.html"))) {
      throw new Error("PWA build is missing pwa/dist/index.html");
    }
    await assertSourceSnapshot(repoRoot, sourceHead);

  await mkdir(outputDir, { recursive: true });
  const artifactName = `dome-home-${pkg.version}-darwin-arm64`;
  const directory = join(outputDir, artifactName);
  await rm(directory, { recursive: true, force: true });
  await mkdir(join(directory, "bin"), { recursive: true });
  await mkdir(join(directory, "runtime"), { recursive: true });
  await mkdir(join(directory, "app"), { recursive: true });

  await cp(runtimePath, join(directory, "runtime", "bun"));
  await chmod(join(directory, "runtime", "bun"), 0o755);
  await cp(join(repoRoot, "src"), join(directory, "app", "src"), { recursive: true });
  await cp(join(repoRoot, "contracts"), join(directory, "app", "contracts"), { recursive: true });
  await cp(join(repoRoot, "bin"), join(directory, "app", "bin"), { recursive: true });
  await cp(join(repoRoot, "assets"), join(directory, "app", "assets"), { recursive: true });
  await cp(pwaDist, join(directory, "app", "pwa", "dist"), { recursive: true });
  await cp(join(repoRoot, "package.json"), join(directory, "app", "package.json"));
  await cp(join(repoRoot, "bun.lock"), join(directory, "app", "bun.lock"));

  await writeFile(join(directory, "bin", "dome"), domeWrapper(), { mode: 0o755 });
  await run([
    join(directory, "runtime", "bun"),
    "install",
    "--production",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--backend=copyfile",
  ], join(directory, "app"));

  await normalizeArtifactModes(directory);
  await assertSourceSnapshot(repoRoot, sourceHead);
  const manifest = await writeArtifactMetadata(directory, pkg.version, sourceHead);
  await verifyHomeArtifact(directory);
  const archive = `${directory}.tar.gz`;
  await writeFile(
    archive,
    gzipSync(await createDeterministicTar(directory, basename(directory)), { level: 9 }),
  );
  await rehearseHomeArtifact(archive);
    return { archive, archiveSha256: sha256(await readFile(archive)), directory, manifest };
  } finally {
    await rm(downloadedRuntime.temporary, { recursive: true, force: true });
  }
}

export async function writeArtifactMetadata(
  artifactRoot: string,
  productVersion: string,
  gitCommit = "0000000000000000000000000000000000000000",
): Promise<HomeArtifactManifest> {
  await rm(join(artifactRoot, "manifest.json"), { force: true });
  await rm(join(artifactRoot, "checksums.sha256"), { force: true });
  const entries = await inventoryEntries(artifactRoot);
  const runtimeEntry = entries.find((entry) => entry.type === "file" && entry.path === "runtime/bun");
  const fileEntries = entries.filter((entry): entry is Extract<HomeArtifactEntry, { type: "file" }> => entry.type === "file");
  const manifest: HomeArtifactManifest = Object.freeze({
    schema: HOME_ARTIFACT_SCHEMA,
    product: Object.freeze({ name: "Dome Home", version: productVersion }),
    target: HOME_ARTIFACT_TARGET,
    build: Object.freeze({ gitCommit }),
    artifact: Object.freeze({ id: sha256(Buffer.from(JSON.stringify(entries))) }),
    runtime: Object.freeze({
      name: "bun",
      version: PINNED_BUN_VERSION,
      sourceUrl: PINNED_BUN_ARCHIVE_URL,
      archiveSha256: PINNED_BUN_ARCHIVE_SHA256,
      sha256: runtimeEntry?.type === "file" ? runtimeEntry.sha256 : "unavailable",
    }),
    entrypoint: "bin/dome",
    pwa: "app/pwa/dist",
    distribution: Object.freeze({ signed: false, notarized: false, upgradeSupported: false }),
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
  });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(artifactRoot, "manifest.json"), manifestText);
  const checksumEntries = [
    ...fileEntries.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
    { path: "manifest.json", sha256: sha256(Buffer.from(manifestText)) },
  ].sort((left, right) => left.path.localeCompare(right.path));
  await writeFile(
    join(artifactRoot, "checksums.sha256"),
    `${checksumEntries.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`,
  );
  return manifest;
}

async function inventoryEntries(artifactRoot: string): Promise<HomeArtifactEntry[]> {
  return await Promise.all((await archiveEntries(artifactRoot)).map(async (path): Promise<HomeArtifactEntry> => {
    const absolute = join(artifactRoot, path);
    const info = await lstat(absolute);
    if (info.isDirectory()) return { type: "directory", path, mode: mode(info.mode) };
    if (info.isSymbolicLink()) {
      const target = await readlink(absolute);
      return { type: "symlink", path, target, targetSha256: sha256(Buffer.from(target)) };
    }
    return { type: "file",
      path,
      bytes: info.size,
      sha256: sha256(await readFile(absolute)),
      mode: mode(info.mode),
    };
  }));
}

export async function verifyHomeArtifact(artifactRoot: string): Promise<HomeArtifactManifest> {
  const manifest = JSON.parse(
    await readFile(join(artifactRoot, "manifest.json"), "utf8"),
  ) as HomeArtifactManifest;
  if (manifest.schema !== HOME_ARTIFACT_SCHEMA) throw new Error(`unsupported artifact schema: ${manifest.schema}`);
  if (manifest.target.os !== HOME_ARTIFACT_TARGET.os || manifest.target.arch !== HOME_ARTIFACT_TARGET.arch) {
    throw new Error(`artifact target must be ${HOME_ARTIFACT_TARGET.os}-${HOME_ARTIFACT_TARGET.arch}`);
  }
  if (manifest.runtime.version !== PINNED_BUN_VERSION) {
    throw new Error(`artifact runtime must be Bun ${PINNED_BUN_VERSION}`);
  }
  if (
    manifest.product.name !== "Dome Home" || manifest.runtime.name !== "bun" ||
    manifest.entrypoint !== "bin/dome" || manifest.pwa !== "app/pwa/dist" ||
    manifest.distribution.signed !== false || manifest.distribution.notarized !== false ||
    manifest.distribution.upgradeSupported !== false
  ) throw new Error("artifact manifest fixed product semantics are invalid");
  if (
    manifest.runtime.sourceUrl !== PINNED_BUN_ARCHIVE_URL ||
    manifest.runtime.archiveSha256 !== PINNED_BUN_ARCHIVE_SHA256
  ) throw new Error("artifact runtime provenance is not the pinned official Bun release");
  if (!/^[a-f0-9]{40,64}$/.test(manifest.build.gitCommit)) {
    throw new Error("artifact build.gitCommit is not a full git object id");
  }
  const actualEntries = await inventoryEntriesWithoutMetadata(artifactRoot);
  const expectedShape = manifest.entries.map((entry) => `${entry.path}\0${entry.type}`).sort();
  const actualShape = actualEntries.map((entry) => `${entry.path}\0${entry.type}`).sort();
  if (JSON.stringify(actualShape) !== JSON.stringify(expectedShape)) {
    throw new Error("artifact entry path/type set differs from its manifest");
  }
  for (const entry of manifest.entries) {
    const absolute = join(artifactRoot, entry.path);
    const info = await lstat(absolute);
    if (entry.type === "symlink") {
      const target = await readlink(absolute);
      if (target !== entry.target || sha256(Buffer.from(target)) !== entry.targetSha256) {
        throw new Error(`artifact symlink target mismatch: ${entry.path}`);
      }
      continue;
    }
    if (entry.type === "file" && (info.size !== entry.bytes || sha256(await readFile(absolute)) !== entry.sha256)) {
      throw new Error(`artifact checksum mismatch: ${entry.path}`);
    }
    if (mode(info.mode) !== entry.mode) {
      throw new Error(`artifact mode mismatch: ${entry.path}`);
    }
  }
  const expectedArtifactId = sha256(Buffer.from(JSON.stringify(manifest.entries)));
  if (manifest.artifact.id !== expectedArtifactId) throw new Error("artifact identity does not match its payload");
  const runtimeEntry = manifest.entries.find((entry) => entry.type === "file" && entry.path === "runtime/bun");
  if (runtimeEntry?.type !== "file" || runtimeEntry.sha256 !== manifest.runtime.sha256) {
    throw new Error("artifact runtime checksum is missing or inconsistent");
  }
  const expectedChecksums = [
    ...manifest.entries.filter((entry): entry is Extract<HomeArtifactEntry, { type: "file" }> => entry.type === "file")
      .map((entry) => `${entry.sha256}  ${entry.path}`),
    `${sha256(await readFile(join(artifactRoot, "manifest.json")))}  manifest.json`,
  ].sort((left, right) => left.slice(66).localeCompare(right.slice(66))).join("\n") + "\n";
  if (await readFile(join(artifactRoot, "checksums.sha256"), "utf8") !== expectedChecksums) {
    throw new Error("artifact checksums.sha256 is incomplete or inconsistent");
  }
  for (const path of await archiveEntries(artifactRoot)) {
    const absolute = join(artifactRoot, path);
    if (!(await lstat(absolute)).isSymbolicLink()) continue;
    const target = resolve(dirname(absolute), await readlink(absolute));
    const relativeTarget = relative(artifactRoot, target);
    if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || resolve(target) === resolve(artifactRoot)) {
      throw new Error(`artifact symlink escapes its root: ${path}`);
    }
    if (!existsSync(target)) throw new Error(`artifact contains broken symlink: ${path}`);
  }
  const entrypointInfo = await lstat(join(artifactRoot, manifest.entrypoint));
  if (!entrypointInfo.isFile() || (entrypointInfo.mode & 0o111) === 0) {
    throw new Error("artifact entrypoint is missing or not executable");
  }
  if (!(await lstat(join(artifactRoot, manifest.pwa, "index.html"))).isFile()) {
    throw new Error("artifact PWA index is missing");
  }
  if (manifest.runtime.sha256 !== PINNED_BUN_BINARY_SHA256) {
    throw new Error("artifact runtime binary is not the pinned official Bun build");
  }
  const runtimeVersion = (await run([join(artifactRoot, "runtime", "bun"), "--version"], artifactRoot)).stdout.trim();
  if (runtimeVersion !== PINNED_BUN_VERSION) throw new Error(`artifact runtime reports ${runtimeVersion}`);
  return manifest;
}

async function inventoryEntriesWithoutMetadata(artifactRoot: string): Promise<HomeArtifactEntry[]> {
  return (await inventoryEntries(artifactRoot)).filter((entry) =>
    entry.path !== "manifest.json" && entry.path !== "checksums.sha256"
  );
}

export async function assertSourceSnapshot(repoRoot: string, expectedHead: string): Promise<void> {
  const actualHead = (await run(["git", "rev-parse", "HEAD"], repoRoot)).stdout.trim();
  if (actualHead !== expectedHead) throw new Error("source HEAD changed during artifact build");
  const dirty = (await run(["git", "status", "--porcelain", "--untracked-files=all"], repoRoot)).stdout.trim();
  if (dirty !== "") throw new Error("source worktree changed during artifact build");
}

export async function normalizeArtifactModes(artifactRoot: string): Promise<void> {
  await chmod(artifactRoot, 0o755);
  for (const path of await archiveEntries(artifactRoot)) {
    const absolute = join(artifactRoot, path);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) await chmod(absolute, 0o755);
    else if (info.isFile()) await chmod(absolute, (info.mode & 0o111) === 0 ? 0o644 : 0o755);
  }
}

export async function rehearseHomeArtifact(archivePath: string): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "dome-home-rehearsal-"));
  try {
    const extracted = join(temporary, "archive extraction");
    await mkdir(extracted, { recursive: true });
    await run(["tar", "-xzf", resolve(archivePath), "-C", extracted], temporary);
    const artifactName = basename(archivePath).replace(/\.tar\.gz$/, "");
    const extractedRoot = join(extracted, artifactName);
    if (!existsSync(extractedRoot)) throw new Error(`artifact archive did not contain ${artifactName}`);
    const installed = join(temporary, "Installed Dome Home", artifactName);
    await mkdir(dirname(installed), { recursive: true });
    await rename(extractedRoot, installed);
    await verifyHomeArtifact(installed);
    const dome = join(installed, "bin", "dome");
    const help = await run([dome, "--help"], temporary, offlineEnvironment());
    if (!help.stdout.includes("Dome vault compiler")) throw new Error("artifact dome --help failed");
    const vault = join(temporary, "vault");
    await run([dome, "init", vault], temporary, offlineEnvironment());
    await rehearseHomeServer(dome, vault, temporary);
    await rehearseHomeServer(dome, vault, temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function createDeterministicTar(root: string, prefix = ""): Promise<Buffer> {
  const chunks: Buffer[] = [];
  if (prefix !== "") {
    chunks.push(tarHeader(`${prefix}/`, { mode: 0o755, size: 0, type: "5", link: "" }));
  }
  for (const path of await archiveEntries(root)) {
    const absolute = join(root, path);
    const info = await lstat(absolute);
    const type = info.isDirectory() ? "5" : info.isSymbolicLink() ? "2" : "0";
    const body = info.isFile() ? await readFile(absolute) : Buffer.alloc(0);
    const link = info.isSymbolicLink() ? await readlink(absolute) : "";
    const archivePath = `${prefix === "" ? "" : `${prefix}/`}${path}${info.isDirectory() ? "/" : ""}`;
    chunks.push(tarHeader(archivePath, {
      mode: info.mode & 0o777,
      size: body.length,
      type,
      link,
    }));
    if (body.length > 0) {
      chunks.push(body);
      const remainder = body.length % 512;
      if (remainder !== 0) chunks.push(Buffer.alloc(512 - remainder));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

async function downloadPinnedRuntime(): Promise<{ readonly temporary: string; readonly path: string }> {
  const temporary = await mkdtemp(join(tmpdir(), "dome-home-runtime-"));
  try {
    const response = await fetch(PINNED_BUN_ARCHIVE_URL);
    if (!response.ok) throw new Error(`failed to download pinned Bun runtime (${response.status})`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (sha256(archive) !== PINNED_BUN_ARCHIVE_SHA256) {
      throw new Error("downloaded Bun archive checksum does not match the pinned release");
    }
    const archivePath = join(temporary, "bun.zip");
    const extracted = join(temporary, "extracted");
    await writeFile(archivePath, archive);
    await mkdir(extracted);
    await run(["ditto", "-x", "-k", archivePath, extracted], temporary);
    const path = await realpath(join(extracted, "bun-darwin-aarch64", "bun"));
    if (sha256(await readFile(path)) !== PINNED_BUN_BINARY_SHA256) {
      throw new Error("extracted Bun binary checksum does not match the pinned release");
    }
    const version = (await run([path, "--version"], temporary)).stdout.trim();
    if (version !== PINNED_BUN_VERSION) {
      throw new Error(`Dome Home requires Bun ${PINNED_BUN_VERSION}, got ${version}`);
    }
    return { temporary, path };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function domeWrapper(): string {
  return `#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PATH="$ROOT/runtime:$PATH"
export PATH
exec "$ROOT/runtime/bun" "$ROOT/app/bin/dome" "$@"
`;
}

function mode(value: number): string {
  return (value & 0o777).toString(8).padStart(4, "0");
}

async function archiveEntries(root: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      found.push(path);
      if (entry.isDirectory()) await visit(absolute);
    }
  }
  await visit(root);
  return found.sort((left, right) => left.localeCompare(right));
}

function tarHeader(
  path: string,
  values: { readonly mode: number; readonly size: number; readonly type: string; readonly link: string },
): Buffer {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitTarPath(path);
  field(header, 0, 100, name);
  octal(header, 100, 8, values.mode);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, values.size);
  octal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  field(header, 156, 1, values.type);
  field(header, 157, 100, values.link);
  field(header, 257, 6, "ustar\0");
  field(header, 263, 2, "00");
  field(header, 265, 32, "root");
  field(header, 297, 32, "wheel");
  field(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const encoded = checksum.toString(8).padStart(6, "0");
  field(header, 148, 8, `${encoded}\0 `);
  return header;
}

function splitTarPath(path: string): { readonly name: string; readonly prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const directorySuffix = path.endsWith("/") ? "/" : "";
  const candidate = directorySuffix === "" ? path : path.slice(0, -1);
  for (let index = candidate.lastIndexOf("/"); index > 0; index = candidate.lastIndexOf("/", index - 1)) {
    const prefix = candidate.slice(0, index);
    const name = `${candidate.slice(index + 1)}${directorySuffix}`;
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`artifact path exceeds ustar limits: ${path}`);
}

function field(buffer: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value);
  if (encoded.length > length) throw new Error(`tar field exceeds ${length} bytes: ${value}`);
  encoded.copy(buffer, offset);
}

function octal(buffer: Buffer, offset: number, length: number, value: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  field(buffer, offset, length, encoded);
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function run(
  command: ReadonlyArray<string>,
  cwd: string,
  environment?: Readonly<Record<string, string>>,
): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn([...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(environment === undefined ? {} : { env: { ...process.env, ...environment } }),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${command.map((part) => JSON.stringify(part)).join(" ")} failed (${exitCode})\n${stdout}${stderr}`,
    );
  }
  return { stdout, stderr };
}

function offlineEnvironment(): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: "",
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "127.0.0.1,localhost",
  };
}

async function rehearseHomeServer(dome: string, vault: string, cwd: string): Promise<void> {
  const child = Bun.spawn([dome, "home", "--vault", vault, "--host", "127.0.0.1", "--port", "0"], {
    cwd,
    env: { ...process.env, ...offlineEnvironment() },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const stderr = child.stderr;
    if (typeof stderr === "number") throw new Error("home rehearsal stderr was not piped");
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    const ready = readHomeUrl(reader, decoder);
    const result = await Promise.race([
      ready,
      Bun.sleep(15_000).then(() => ({ output: "", url: undefined })),
    ]);
    reader.releaseLock();
    if (result.url === undefined) throw new Error(`artifact dome home did not become ready\n${result.output}`);
    const response = await fetch(result.url);
    const body = await response.text();
    if (!response.ok || !body.includes("id=\"root\"")) {
      throw new Error(`artifact dome home did not serve the bundled PWA (${response.status})`);
    }
    const assetPath = body.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
    if (assetPath === undefined || !/[-.][a-zA-Z0-9_]{6,}\.(?:js|css)$/.test(assetPath)) {
      throw new Error("artifact PWA shell did not reference a hashed asset");
    }
    const asset = await fetch(new URL(assetPath, result.url));
    if (!asset.ok || (await asset.arrayBuffer()).byteLength === 0) {
      throw new Error(`artifact dome home did not serve bundled asset ${assetPath}`);
    }
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
}

async function readHomeUrl(
  reader: { read(): Promise<{ readonly done: boolean; readonly value: Uint8Array | undefined }> },
  decoder: TextDecoder,
): Promise<{ readonly output: string; readonly url: string | undefined }> {
  let output = "";
  while (true) {
    const next = await reader.read();
    if (next.done) return { output, url: undefined };
    output += decoder.decode(next.value ?? new Uint8Array(), { stream: true });
    const url = output.match(/dome home: serving (http:\/\/[^\s]+)/)?.[1];
    if (url !== undefined) return { output, url };
  }
}

async function main(): Promise<void> {
  const outputFlag = process.argv.indexOf("--output");
  const outputDir = outputFlag === -1 ? undefined : process.argv[outputFlag + 1];
  if (outputFlag !== -1 && outputDir === undefined) throw new Error("--output requires a directory");
  const result = await buildHomeArtifact(outputDir === undefined ? {} : { outputDir });
  process.stdout.write(`${JSON.stringify({
    schema: result.manifest.schema,
    artifact: basename(result.archive),
    directory: result.directory,
    archive: result.archive,
    archiveSha256: result.archiveSha256,
  }, null, 2)}\n`);
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(`dome home artifact: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
