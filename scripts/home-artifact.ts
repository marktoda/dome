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
import { compareStrings } from "../src/core/compare";
import {
  HOME_ARTIFACT_SCHEMA,
  HOME_ARTIFACT_TARGET,
  PINNED_AGE_ARCHIVE_SHA256,
  PINNED_AGE_ARCHIVE_URL,
  PINNED_AGE_BINARY_SHA256,
  PINNED_AGE_KEYGEN_BINARY_SHA256,
  PINNED_AGE_LICENSE_SHA256,
  PINNED_AGE_VERSION,
  PINNED_BUN_ARCHIVE_SHA256,
  PINNED_BUN_ARCHIVE_URL,
  PINNED_BUN_BINARY_SHA256,
  PINNED_BUN_VERSION,
  verifyHomeArtifact,
  type HomeArtifactEntry,
  type HomeArtifactManifest,
} from "../src/product-host/home-artifact";

export {
  HOME_ARTIFACT_SCHEMA,
  HOME_ARTIFACT_TARGET,
  PINNED_AGE_ARCHIVE_SHA256,
  PINNED_AGE_ARCHIVE_URL,
  PINNED_AGE_BINARY_SHA256,
  PINNED_AGE_KEYGEN_BINARY_SHA256,
  PINNED_AGE_LICENSE_SHA256,
  PINNED_AGE_VERSION,
  PINNED_BUN_ARCHIVE_SHA256,
  PINNED_BUN_ARCHIVE_URL,
  PINNED_BUN_BINARY_SHA256,
  PINNED_BUN_VERSION,
  verifyHomeArtifact,
  type HomeArtifactEntry,
  type HomeArtifactManifest,
} from "../src/product-host/home-artifact";

const REPO_ROOT = resolve(import.meta.dir, "..");

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
  let downloadedAge: Awaited<ReturnType<typeof downloadPinnedAge>>;
  try {
    downloadedAge = await downloadPinnedAge();
  } catch (error) {
    await rm(downloadedRuntime.temporary, { recursive: true, force: true });
    throw error;
  }
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
  await mkdir(join(directory, "licenses"), { recursive: true });
  await mkdir(join(directory, "app"), { recursive: true });

  await cp(runtimePath, join(directory, "runtime", "bun"));
  await chmod(join(directory, "runtime", "bun"), 0o755);
  await cp(downloadedAge.age, join(directory, "runtime", "age"));
  await chmod(join(directory, "runtime", "age"), 0o755);
  await cp(downloadedAge.ageKeygen, join(directory, "runtime", "age-keygen"));
  await chmod(join(directory, "runtime", "age-keygen"), 0o755);
  await cp(downloadedAge.license, join(directory, "licenses", "age-LICENSE"));
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
    await Promise.all([
      rm(downloadedRuntime.temporary, { recursive: true, force: true }),
      rm(downloadedAge.temporary, { recursive: true, force: true }),
    ]);
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
  const ageEntry = entries.find((entry) => entry.type === "file" && entry.path === "runtime/age");
  const ageKeygenEntry = entries.find((entry) => entry.type === "file" && entry.path === "runtime/age-keygen");
  const ageLicenseEntry = entries.find((entry) => entry.type === "file" && entry.path === "licenses/age-LICENSE");
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
    tools: Object.freeze([
      Object.freeze({
        name: "age" as const,
        version: PINNED_AGE_VERSION,
        path: "runtime/age" as const,
        sourceUrl: PINNED_AGE_ARCHIVE_URL,
        archiveSha256: PINNED_AGE_ARCHIVE_SHA256,
        sha256: ageEntry?.type === "file" ? ageEntry.sha256 : "unavailable",
        licensePath: "licenses/age-LICENSE" as const,
        licenseSha256: ageLicenseEntry?.type === "file" ? ageLicenseEntry.sha256 : "unavailable",
      }),
      Object.freeze({
        name: "age-keygen" as const,
        version: PINNED_AGE_VERSION,
        path: "runtime/age-keygen" as const,
        sourceUrl: PINNED_AGE_ARCHIVE_URL,
        archiveSha256: PINNED_AGE_ARCHIVE_SHA256,
        sha256: ageKeygenEntry?.type === "file" ? ageKeygenEntry.sha256 : "unavailable",
        licensePath: "licenses/age-LICENSE" as const,
        licenseSha256: ageLicenseEntry?.type === "file" ? ageLicenseEntry.sha256 : "unavailable",
      }),
    ]),
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
  ].sort((left, right) => compareStrings(left.path, right.path));
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
    const fakeBin = join(temporary, "fake service manager");
    await mkdir(fakeBin, { recursive: true });
    const fakeLaunchctl = join(fakeBin, "launchctl");
    await writeFile(fakeLaunchctl, "#!/bin/sh\nexit 113\n", { mode: 0o755 });
    await chmod(fakeLaunchctl, 0o755);
    const lifecycleEnvironment = {
      ...offlineEnvironment(),
      PATH: `${fakeBin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
    };
    const lifecycleHelp = await run([dome, "home", "status", "--help"], temporary, lifecycleEnvironment);
    if (!lifecycleHelp.stdout.includes("Usage: dome home status")) {
      throw new Error("artifact nested Home lifecycle help failed");
    }
    const lifecycle = await run(
      [dome, "home", "status", "--vault", vault, "--json"],
      temporary,
      lifecycleEnvironment,
    );
    const lifecycleStatus = JSON.parse(lifecycle.stdout) as { readonly schema?: unknown; readonly status?: unknown };
    if (lifecycleStatus.schema !== "dome.home.lifecycle/v1" || lifecycleStatus.status !== "not-installed") {
      throw new Error("artifact Home lifecycle status did not report not-installed");
    }
    const identity = join(temporary, "backup identity.txt");
    const keygen = await run([dome, "backup", "keygen", "--output", identity, "--json"], temporary, lifecycleEnvironment);
    const key = JSON.parse(keygen.stdout) as { readonly schema?: unknown; readonly status?: unknown; readonly recipient?: unknown };
    if (key.schema !== "dome.backup/v1" || key.status !== "created" || typeof key.recipient !== "string") {
      throw new Error("artifact packaged backup keygen failed");
    }
    const backup = join(temporary, "vault backup.dome.age");
    const createdBackup = await run([
      dome, "backup", "create", "--vault", vault, "--output", backup,
      "--recipient", key.recipient, "--json",
    ], temporary, lifecycleEnvironment);
    const created = JSON.parse(createdBackup.stdout) as { readonly schema?: unknown; readonly status?: unknown; readonly restart?: unknown };
    if (created.schema !== "dome.backup/v1" || created.status !== "created" || created.restart !== "not-running") {
      throw new Error("artifact packaged backup create failed");
    }
    const verifiedBackup = await run([
      dome, "backup", "verify", backup, "--identity", identity, "--json",
    ], temporary, lifecycleEnvironment);
    const verified = JSON.parse(verifiedBackup.stdout) as { readonly schema?: unknown; readonly status?: unknown };
    if (verified.schema !== "dome.backup/v1" || verified.status !== "verified") {
      throw new Error("artifact packaged backup verify failed");
    }
    const restoreHelp = await run([
      dome, "backup", "restore", "--help",
    ], temporary, lifecycleEnvironment);
    if (!restoreHelp.stdout.includes("Usage: dome backup restore")) {
      throw new Error("artifact packaged backup restore help failed");
    }
    const restoredVault = join(temporary, "restored vault");
    const restoredBackup = await run([
      dome, "backup", "restore", backup, "--identity", identity,
      "--target", restoredVault, "--json",
    ], temporary, lifecycleEnvironment);
    const restored = JSON.parse(restoredBackup.stdout) as {
      readonly schema?: unknown;
      readonly status?: unknown;
      readonly authority?: unknown;
      readonly durability?: unknown;
    };
    if (restored.schema !== "dome.backup/v1" || restored.status !== "restored"
      || restored.authority !== "absent" || restored.durability !== "durable") {
      throw new Error("artifact packaged backup restore failed");
    }
    if (!(await readFile(join(restoredVault, "core.md"), "utf8")).includes("# Core")) {
      throw new Error("artifact packaged backup restore lost vault content");
    }
    await rehearseHomeServer(dome, vault, temporary);
    await rehearseHomeServer(dome, restoredVault, temporary);
    await rehearseAgeToolchain(installed, temporary);
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

async function downloadPinnedAge(): Promise<{
  readonly temporary: string;
  readonly age: string;
  readonly ageKeygen: string;
  readonly license: string;
}> {
  const temporary = await mkdtemp(join(tmpdir(), "dome-home-age-"));
  try {
    const response = await fetch(PINNED_AGE_ARCHIVE_URL);
    if (!response.ok) throw new Error(`failed to download pinned age toolchain (${response.status})`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (sha256(archive) !== PINNED_AGE_ARCHIVE_SHA256) {
      throw new Error("downloaded age archive checksum does not match the pinned release");
    }
    const archivePath = join(temporary, "age.tar.gz");
    const extracted = join(temporary, "extracted");
    await writeFile(archivePath, archive);
    await mkdir(extracted);
    await run([
      "/usr/bin/tar", "-xzf", archivePath, "-C", extracted,
      "age/age", "age/age-keygen", "age/LICENSE",
    ], temporary);
    const age = await realpath(join(extracted, "age", "age"));
    const ageKeygen = await realpath(join(extracted, "age", "age-keygen"));
    const license = await realpath(join(extracted, "age", "LICENSE"));
    if (sha256(await readFile(age)) !== PINNED_AGE_BINARY_SHA256) {
      throw new Error("extracted age binary checksum does not match the pinned release");
    }
    if (sha256(await readFile(ageKeygen)) !== PINNED_AGE_KEYGEN_BINARY_SHA256) {
      throw new Error("extracted age-keygen binary checksum does not match the pinned release");
    }
    if (sha256(await readFile(license)) !== PINNED_AGE_LICENSE_SHA256) {
      throw new Error("extracted age license checksum does not match the pinned release");
    }
    for (const [name, path] of [["age", age], ["age-keygen", ageKeygen]] as const) {
      const version = (await run([path, "--version"], temporary)).stdout.trim();
      if (version !== `v${PINNED_AGE_VERSION}`) {
        throw new Error(`Dome Home requires ${name} v${PINNED_AGE_VERSION}, got ${version}`);
      }
    }
    return { temporary, age, ageKeygen, license };
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
  return found.sort(compareStrings);
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

async function rehearseAgeToolchain(artifactRoot: string, temporary: string): Promise<void> {
  const age = join(artifactRoot, "runtime", "age");
  const ageKeygen = join(artifactRoot, "runtime", "age-keygen");
  const identity = join(temporary, "rehearsal-identity.txt");
  const plaintext = join(temporary, "rehearsal-plaintext.txt");
  const encrypted = join(temporary, "rehearsal-plaintext.txt.age");
  const decrypted = join(temporary, "rehearsal-decrypted.txt");
  const environment = offlineEnvironment();
  await run([ageKeygen, "-o", identity], temporary, environment);
  const recipient = (await run([ageKeygen, "-y", identity], temporary, environment)).stdout.trim();
  if (!recipient.startsWith("age1")) throw new Error("artifact age-keygen did not produce an age recipient");
  const content = "Dome Home encrypted backup rehearsal\n";
  await writeFile(plaintext, content);
  await run([age, "-r", recipient, "-o", encrypted, plaintext], temporary, environment);
  await run([age, "-d", "-i", identity, "-o", decrypted, encrypted], temporary, environment);
  if (await readFile(decrypted, "utf8") !== content) {
    throw new Error("artifact age toolchain did not round-trip rehearsal bytes");
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
