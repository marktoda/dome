#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { verifyHomeArtifact } from "../src/product-host/home-artifact";

const RECEIPT_SCHEMA = "dome.home-predecessor-artifact/v1" as const;
const DEFAULT_RECEIPT = resolve(
  import.meta.dir,
  "../tests/fixtures/home-upgrade/n-1/0.1.0-eb644dc2/artifact-receipt.json",
);

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
  const info = await lstat(path);
  const archive = await readFile(path);
  if (!info.isFile() || info.size !== receipt.archive.bytes || sha(archive) !== receipt.archive.sha256) {
    throw new Error("reconstructed predecessor archive bytes differ from its immutable receipt");
  }
  const listing = await requireSuccess(["tar", "-tzf", path], process.cwd());
  const names = listing.stdout.trimEnd().split("\n");
  if (names.length === 0 || names.some((name) => name !== `${receipt.archive.root}/` && !name.startsWith(`${receipt.archive.root}/`))) {
    throw new Error("predecessor archive root changed");
  }
  const member = `${receipt.archive.root}/manifest.json`;
  if (names.filter((name) => name === member).length !== 1) throw new Error("predecessor archive manifest entry changed");
  const extraction = await mkdtemp(join(tmpdir(), "dome-home-predecessor-verify-"));
  try {
    await requireSuccess(["tar", "-xzf", path, "-C", extraction], process.cwd());
    await verifyHomeArtifact(join(extraction, receipt.archive.root));
  } finally { await rm(extraction, { recursive: true, force: true }); }
  const extracted = await requireSuccess(["tar", "-xOzf", path, member], process.cwd(), undefined, true);
  const manifestBytes = Buffer.from(extracted.stdout, "binary");
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    schema: string;
    product: { version: string };
    target: { os: string; arch: string };
    build: { gitCommit: string };
    artifact: { id: string };
  };
  return Object.freeze({
    archivePath: path,
    archiveBytes: info.size,
    archiveSha256: sha(archive),
    archiveRoot: receipt.archive.root,
    manifestBytes: manifestBytes.byteLength,
    manifestSha256: sha(manifestBytes),
    manifest: Object.freeze({
      schema: manifest.schema,
      productVersion: manifest.product.version,
      targetOs: manifest.target.os,
      targetArch: manifest.target.arch,
      buildCommit: manifest.build.gitCommit,
      artifactId: manifest.artifact.id,
    }),
  });
}

async function command(
  args: readonly string[],
  cwd: string,
  environment?: Readonly<Record<string, string>>,
  binary = false,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn([...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(environment === undefined ? {} : { env: { ...process.env, ...environment } }),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    binary ? new Response(child.stdout).arrayBuffer() : new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    exitCode,
    stdout: typeof stdout === "string" ? stdout : Buffer.from(stdout).toString("binary"),
    stderr,
  };
}

async function requireSuccess(
  args: readonly string[],
  cwd: string,
  environment?: Readonly<Record<string, string>>,
  binary = false,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await command(args, cwd, environment, binary);
  if (result.exitCode !== 0) throw new Error(`${args[0]} failed (${result.exitCode}): ${result.stderr}`);
  return result;
}

async function filesEqual(left: string, right: string): Promise<boolean> {
  return Buffer.from(await readFile(left)).equals(await readFile(right));
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

function sha(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
