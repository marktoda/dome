#!/usr/bin/env bun

import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  MAX_HOME_ARTIFACT_TAR_BYTES,
  materializeHomeArtifactArchive,
  type MaterializedHomeArtifact,
} from "../src/product-host/home-artifact-archive";

const RECEIPT_SCHEMA = "dome.home-predecessor-artifact/v1" as const;
const DEFAULT_RECEIPT = resolve(
  import.meta.dir,
  "../tests/fixtures/home-upgrade/n-1/0.1.0-eb644dc2/artifact-receipt.json",
);
const PINNED_LEGACY_MODE_SUFFIXES = Object.freeze([
  "app/node_modules/.bin/crc32",
  "app/node_modules/.bin/esparse",
  "app/node_modules/.bin/esvalidate",
  "app/node_modules/.bin/isogit",
  "app/node_modules/.bin/js-yaml",
  "app/node_modules/.bin/node-which",
  "app/node_modules/.bin/sha.js",
  "app/node_modules/.bin/yaml",
]);

export type HomePredecessorReceipt = Readonly<{
  schema: typeof RECEIPT_SCHEMA;
  classification: "reconstructed-internal-floor";
  distributed: false;
  releaseId: string;
  builder: Readonly<{ bun: string; sourceCommit: string; expectedExitCode: 1 }>;
  archive: Readonly<{ name: string; root: string; bytes: number; sha256: string }>;
  manifest: Readonly<{
    bytes: number;
    sha256: string;
    schema: "dome.home-artifact/v1";
    productVersion: string;
    target: Readonly<{ os: "darwin"; arch: "arm64" }>;
    buildCommit: string;
    artifactId: string;
  }>;
  knownPostArchiveFailure: Readonly<{
    command: readonly ["home", "status", "--vault", "<rehearsal-vault>", "--json"];
    commandExitCode: 64;
    schema: "dome.home.lifecycle/v1";
    action: "status";
    status: "error";
    exitCode: 64;
    error: string;
  }>;
}>;

export type HomePredecessorObservation = Readonly<{
  archivePath: string;
  archiveBytes: number;
  archiveSha256: string;
  archiveRoot: string;
  manifestBytes: number;
  manifestSha256: string;
  manifest: Readonly<{
    schema: string;
    productVersion: string;
    targetOs: string;
    targetArch: string;
    buildCommit: string;
    artifactId: string;
  }>;
}>;

type ReconstructDeps = Readonly<{
  platform?: string;
  arch?: string;
  bunVersion?: string;
  build?: (input: {
    readonly repoRoot: string;
    readonly workspace: string;
    readonly index: 1 | 2;
    readonly receipt: HomePredecessorReceipt;
  }) => Promise<HomePredecessorObservation>;
  compare?: (left: string, right: string) => Promise<boolean>;
  publish?: (source: string, destination: string) => Promise<void>;
}>;

export type HomePredecessorCliArgs =
  | Readonly<{ help: true; outputDir: null }>
  | Readonly<{ help: false; outputDir: string }>;

export function parseHomePredecessorCliArgs(argv: readonly string[]): HomePredecessorCliArgs {
  if (argv.length === 1 && argv[0] === "--help") return Object.freeze({ help: true as const, outputDir: null });
  if (argv.length !== 2 || argv[0] !== "--output" || argv[1] === "") {
    throw new Error("usage: bun scripts/home-predecessor-artifact.ts --output <directory>");
  }
  return Object.freeze({ help: false as const, outputDir: argv[1]! });
}

export async function readHomePredecessorReceipt(path = DEFAULT_RECEIPT): Promise<HomePredecessorReceipt> {
  return parseHomePredecessorReceipt(JSON.parse(await readFile(path, "utf8")));
}

export function parseHomePredecessorReceipt(input: unknown): HomePredecessorReceipt {
  const root = record(input, "predecessor receipt");
  exactKeys(root, [
    "schema", "classification", "distributed", "releaseId", "builder", "archive", "manifest",
    "knownPostArchiveFailure",
  ], "predecessor receipt");
  const builder = record(root["builder"], "predecessor builder");
  exactKeys(builder, ["bun", "sourceCommit", "expectedExitCode"], "predecessor builder");
  const archive = record(root["archive"], "predecessor archive");
  exactKeys(archive, ["name", "root", "bytes", "sha256"], "predecessor archive");
  const manifest = record(root["manifest"], "predecessor manifest");
  exactKeys(manifest, [
    "bytes", "sha256", "schema", "productVersion", "target", "buildCommit", "artifactId",
  ], "predecessor manifest");
  const target = record(manifest["target"], "predecessor target");
  exactKeys(target, ["os", "arch"], "predecessor target");
  const failure = record(root["knownPostArchiveFailure"], "predecessor known failure");
  exactKeys(failure, [
    "command", "commandExitCode", "schema", "action", "status", "exitCode", "error",
  ], "predecessor known failure");
  const command = failure["command"];
  if (!Array.isArray(command) || JSON.stringify(command) !==
    JSON.stringify(["home", "status", "--vault", "<rehearsal-vault>", "--json"])) {
    throw new Error("predecessor known failure command changed");
  }
  if (root["schema"] !== RECEIPT_SCHEMA || root["classification"] !== "reconstructed-internal-floor" ||
    root["distributed"] !== false || root["releaseId"] !== "0.1.0-eb644dc2" ||
    builder["bun"] !== "1.2.13" || builder["sourceCommit"] !== "eb644dc29b37cbc0c964f8cffc5329a95cad49ba" ||
    builder["expectedExitCode"] !== 1 || archive["name"] !== "dome-home-0.1.0-darwin-arm64.tar.gz" ||
    archive["root"] !== "dome-home-0.1.0-darwin-arm64" || archive["bytes"] !== 37_808_584 ||
    archive["sha256"] !== "35de119b40172ea5e418c0fa784a4db549c6ddf2911de9106beabf88fd492ebd" ||
    manifest["bytes"] !== 1_591_997 || manifest["sha256"] !== "fd375d9e8c492d730dcb75c6c12aa0efc35424bf1750f1437856a7e807d6dcaa" ||
    manifest["schema"] !== "dome.home-artifact/v1" || manifest["productVersion"] !== "0.1.0" ||
    target["os"] !== "darwin" || target["arch"] !== "arm64" ||
    manifest["buildCommit"] !== builder["sourceCommit"] ||
    manifest["artifactId"] !== "911d5219bd5888f8a45fbfb0bbcf6da57b54e3a0ffcf8077bd2d843327747096" ||
    failure["commandExitCode"] !== 64 || failure["schema"] !== "dome.home.lifecycle/v1" ||
    failure["action"] !== "status" || failure["status"] !== "error" || failure["exitCode"] !== 64 ||
    failure["error"] !== "not an initialized Dome vault; run `dome init` first") {
    throw new Error("predecessor receipt identity changed");
  }
  return Object.freeze(root as HomePredecessorReceipt);
}

export function assertKnownHistoricalFailure(stderr: string, receipt: HomePredecessorReceipt): void {
  const escapedRoot = escapeRegExp(receipt.archive.root);
  const match = stderr.match(new RegExp(
    `^dome home artifact: "([^"]+)/Installed Dome Home/${escapedRoot}/bin/dome" "home" "status" "--vault" "([^"]+)/vault" "--json" failed \\(64\\)\\n([\\s\\S]+)\\n$`,
  ));
  if (match === null || match[1] !== match[2]) throw new Error("historical builder failure signature changed");
  let parsed: unknown;
  try { parsed = JSON.parse(match[3]!); } catch { throw new Error("historical builder failure payload changed"); }
  const value = record(parsed, "historical builder failure payload");
  exactKeys(value, [
    "schema", "action", "vault", "label", "plist", "log", "program", "installation", "release",
    "artifactId", "productVersion", "status", "installed", "loaded", "ready", "exitCode", "error", "lifecycle",
  ], "historical builder failure payload");
  const lifecycle = record(value["lifecycle"], "historical builder lifecycle");
  exactKeys(lifecycle, ["state", "error"], "historical builder lifecycle");
  const expected = receipt.knownPostArchiveFailure;
  const vault = value["vault"];
  const label = value["label"];
  if (value["schema"] !== expected.schema || value["action"] !== expected.action || value["status"] !== expected.status ||
    value["exitCode"] !== expected.exitCode || value["error"] !== expected.error || lifecycle["state"] !== "unavailable" ||
    lifecycle["error"] !== expected.error || typeof vault !== "string" || typeof label !== "string" ||
    basename(vault) !== basename(match[1]!) || !/^com\.dome\.home\.[a-z0-9-]+-[a-f0-9]{8}$/.test(label) ||
    value["log"] !== `${vault}/.dome/state/home.log` || typeof value["plist"] !== "string" ||
    !(value["plist"] as string).endsWith(`/Library/LaunchAgents/${label}.plist`) ||
    typeof value["installation"] !== "string" ||
    !(value["installation"] as string).endsWith(`/Library/Application Support/Dome/Home/installations/${label.slice("com.dome.home.".length)}/installation.json`) ||
    value["program"] !== "" || value["release"] !== null || value["artifactId"] !== null ||
    value["productVersion"] !== null || value["installed"] !== null || value["loaded"] !== null || value["ready"] !== null) {
    throw new Error("historical builder failure signature changed");
  }
}

export function assertHomePredecessorObservation(
  observation: HomePredecessorObservation,
  receipt: HomePredecessorReceipt,
): void {
  const expected = receipt.manifest;
  if (basename(observation.archivePath) !== receipt.archive.name || observation.archiveBytes !== receipt.archive.bytes ||
    observation.archiveSha256 !== receipt.archive.sha256 || observation.archiveRoot !== receipt.archive.root ||
    observation.manifestBytes !== expected.bytes || observation.manifestSha256 !== expected.sha256 ||
    observation.manifest.schema !== expected.schema || observation.manifest.productVersion !== expected.productVersion ||
    observation.manifest.targetOs !== expected.target.os || observation.manifest.targetArch !== expected.target.arch ||
    observation.manifest.buildCommit !== expected.buildCommit || observation.manifest.artifactId !== expected.artifactId) {
    throw new Error("reconstructed predecessor artifact differs from its immutable receipt");
  }
}

/**
 * Admit the one byte-pinned 0.1 compatibility floor through today's strict
 * archive boundary. The historical archive records eight package-manager
 * symlinks as 0777. We first prove the immutable raw receipt, rewrite exactly
 * those eight USTAR headers in private memory, then let ordinary strict
 * materialization validate the complete canonical derivative.
 */
export async function materializePinnedHomePredecessorArchive(input: Readonly<{
  archive: string;
  receipt: HomePredecessorReceipt;
  temporaryParent?: string;
}>): Promise<MaterializedHomeArtifact> {
  const receipt = parseHomePredecessorReceipt(input.receipt);
  const archive = resolve(input.archive);
  const info = await lstat(archive);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== receipt.archive.bytes) {
    throw new Error("pinned predecessor archive is not the immutable receipt file");
  }
  const raw = await readFile(archive);
  if (raw.byteLength !== receipt.archive.bytes || sha256(raw) !== receipt.archive.sha256) {
    throw new Error("pinned predecessor archive differs from its immutable receipt");
  }
  let tar: Buffer;
  try {
    tar = gunzipSync(raw, { maxOutputLength: MAX_HOME_ARTIFACT_TAR_BYTES });
  } catch {
    throw new Error("pinned predecessor archive is not the immutable gzip payload");
  }
  const canonicalTar = normalizePinnedHomePredecessorTar(tar, receipt.archive.root);
  const parent = resolve(input.temporaryParent ?? tmpdir());
  const workspace = await mkdtemp(join(parent, "dome-home-predecessor-admission-"));
  let materialized: MaterializedHomeArtifact | undefined;
  let primary: unknown;
  try {
    const canonicalArchive = join(workspace, "canonical.tar.gz");
    await writeFile(canonicalArchive, gzipSync(canonicalTar, { level: 9 }), { flag: "wx", mode: 0o600 });
    materialized = await materializeHomeArtifactArchive({
      archive: canonicalArchive,
      temporaryParent: workspace,
      expected: {
        artifactRoot: receipt.archive.root,
        manifestBytes: receipt.manifest.bytes,
        manifestSha256: receipt.manifest.sha256,
        artifactId: receipt.manifest.artifactId,
        productVersion: receipt.manifest.productVersion,
      },
    });
    const strict = materialized;
    return Object.freeze({
      ...strict,
      // Evidence names the byte-pinned input, not the private compatibility
      // derivative that exists only long enough to pass strict admission.
      archiveBytes: receipt.archive.bytes,
      archiveSha256: receipt.archive.sha256,
      dispose: async () => {
        // Retain the compatibility workspace if strict disposal cannot prove
        // ownership; deleting its parent would erase the evidence it retained.
        await strict.dispose();
        await rm(workspace, { recursive: true, force: true });
      },
    });
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    if (materialized === undefined) {
      try { await rm(workspace, { recursive: true, force: true }); }
      catch (cleanup) {
        if (primary !== undefined) {
          throw new AggregateError([primary, cleanup], "predecessor admission and cleanup both failed");
        }
        throw cleanup;
      }
    }
  }
}

/** Test seam for the exact historical header migration used above. */
export function normalizePinnedHomePredecessorTarForTests(tar: Buffer, artifactRoot: string): Buffer {
  return normalizePinnedHomePredecessorTar(tar, artifactRoot);
}

function normalizePinnedHomePredecessorTar(input: Buffer, artifactRoot: string): Buffer {
  const tar = Buffer.from(input);
  const expected = new Set(PINNED_LEGACY_MODE_SUFFIXES.map((path) => `${artifactRoot}/${path}`));
  const normalized = new Set<string>();
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const path = prefix === "" ? name : `${prefix}/${name}`;
    const type = String.fromCharCode(header[156]!);
    const mode = tarOctal(header, 100, 8);
    const size = tarOctal(header, 124, 12);
    const canonicalMode = type === "0" ? ((mode & 0o111) === 0 ? 0o644 : 0o755) : 0o755;
    if (mode !== canonicalMode) {
      if (!expected.has(path) || type !== "2" || mode !== 0o777 || canonicalMode !== 0o755) {
        throw new Error(`pinned predecessor contains an unexpected legacy tar mode: ${path}`);
      }
      writeTarOctal(header, 100, 8, canonicalMode);
      rewriteTarChecksum(header);
      normalized.add(path);
    }
    const bodyBlocks = Math.ceil(size / 512);
    offset += 512 + bodyBlocks * 512;
  }
  if (offset + 1024 > tar.byteLength ||
    !tar.subarray(offset, offset + 1024).every((byte) => byte === 0) ||
    normalized.size !== expected.size || [...expected].some((path) => !normalized.has(path))) {
    throw new Error("pinned predecessor legacy tar mode inventory changed");
  }
  return tar;
}

function tarString(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul < 0 ? field.byteLength : nul).toString("utf8");
}

function tarOctal(header: Buffer, offset: number, length: number): number {
  const value = tarString(header, offset, length).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("pinned predecessor tar has a malformed octal field");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("pinned predecessor tar octal field is invalid");
  return parsed;
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  header.write(encoded, offset, length, "ascii");
}

function rewriteTarChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
}

export async function reconstructHomePredecessorArtifact(input: {
  readonly repoRoot: string;
  readonly outputDir: string;
  readonly receiptPath?: string;
}, deps: ReconstructDeps = {}): Promise<{ readonly archive: string; readonly receipt: HomePredecessorReceipt }> {
  const receipt = await readHomePredecessorReceipt(input.receiptPath);
  if ((deps.platform ?? process.platform) !== "darwin" || (deps.arch ?? process.arch) !== "arm64" ||
    (deps.bunVersion ?? Bun.version) !== receipt.builder.bun) {
    throw new Error(`predecessor reconstruction requires darwin-arm64 with Bun ${receipt.builder.bun}`);
  }
  const workspace = await mkdtemp(join(tmpdir(), "dome-home-predecessor-"));
  try {
    const build = deps.build ?? buildHistoricalClone;
    const first = await build({ repoRoot: resolve(input.repoRoot), workspace, index: 1, receipt });
    assertHomePredecessorObservation(first, receipt);
    const second = await build({ repoRoot: resolve(input.repoRoot), workspace, index: 2, receipt });
    assertHomePredecessorObservation(second, receipt);
    const equal = await (deps.compare ?? filesEqual)(first.archivePath, second.archivePath);
    if (!equal) throw new Error("independent predecessor reconstructions are not byte-identical");
    await mkdir(resolve(input.outputDir), { recursive: true });
    const destination = join(resolve(input.outputDir), receipt.archive.name);
    await (deps.publish ?? publishExclusive)(first.archivePath, destination);
    return Object.freeze({ archive: destination, receipt });
  } finally { await rm(workspace, { recursive: true, force: true }); }
}

async function buildHistoricalClone(input: {
  readonly repoRoot: string;
  readonly workspace: string;
  readonly index: 1 | 2;
  readonly receipt: HomePredecessorReceipt;
}): Promise<HomePredecessorObservation> {
  const clone = join(input.workspace, `clone-${input.index}`);
  const output = join(input.workspace, `output-${input.index}`);
  await requireSuccess(["git", "clone", "--no-local", "--quiet", input.repoRoot, clone], input.workspace);
  await requireSuccess(["git", "checkout", "--detach", "--quiet", input.receipt.builder.sourceCommit], clone);
  const clean = await command(["git", "status", "--porcelain", "--untracked-files=all"], clone);
  if (clean.exitCode !== 0 || clean.stdout !== "") throw new Error("historical predecessor clone is not clean");
  const built = await command([process.execPath, "scripts/home-artifact.ts", "--output", output], clone, {
    BUN_INSTALL_CACHE_DIR: join(input.workspace, `bun-cache-${input.index}`),
  });
  if (built.exitCode !== input.receipt.builder.expectedExitCode || built.stdout !== "") {
    throw new Error("historical builder did not fail only at the pinned post-archive rehearsal");
  }
  assertKnownHistoricalFailure(built.stderr, input.receipt);
  return await observeArchive(join(output, input.receipt.archive.name), input.receipt);
}

async function observeArchive(path: string, receipt: HomePredecessorReceipt): Promise<HomePredecessorObservation> {
  const materialized = await materializePinnedHomePredecessorArchive({ archive: path, receipt });
  try {
    const manifest = materialized.manifest;
    return Object.freeze({
      archivePath: path,
      archiveBytes: materialized.archiveBytes,
      archiveSha256: materialized.archiveSha256,
      archiveRoot: receipt.archive.root,
      manifestBytes: materialized.manifestBytes,
      manifestSha256: materialized.manifestSha256,
      manifest: Object.freeze({
        schema: manifest.schema,
        productVersion: manifest.product.version,
        targetOs: manifest.target.os,
        targetArch: manifest.target.arch,
        buildCommit: manifest.build.gitCommit,
        artifactId: manifest.artifact.id,
      }),
    });
  } finally {
    await materialized.dispose();
  }
}

async function command(
  args: readonly string[],
  cwd: string,
  environment?: Readonly<Record<string, string>>,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn([...args], {
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
  return {
    exitCode,
    stdout,
    stderr,
  };
}

async function requireSuccess(
  args: readonly string[],
  cwd: string,
  environment?: Readonly<Record<string, string>>,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await command(args, cwd, environment);
  if (result.exitCode !== 0) throw new Error(`${args[0]} failed (${result.exitCode}): ${result.stderr}`);
  return result;
}

async function filesEqual(left: string, right: string): Promise<boolean> {
  return Buffer.from(await readFile(left)).equals(await readFile(right));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function publishExclusive(source: string, destination: string): Promise<void> {
  try { await copyFile(source, destination, constants.COPYFILE_EXCL); }
  catch (error) {
    if (!hasCode(error, "EEXIST") || !await filesEqual(source, destination)) throw error;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function main(): Promise<void> {
  const args = parseHomePredecessorCliArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("Usage: bun scripts/home-predecessor-artifact.ts --output <directory>\n");
    return;
  }
  const result = await reconstructHomePredecessorArtifact({
    repoRoot: resolve(import.meta.dir, ".."),
    outputDir: args.outputDir,
  });
  process.stdout.write(`reconstructed ${result.archive}\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`dome home predecessor: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
