#!/usr/bin/env bun

/**
 * Archive-input, installed Dome Home upgrade evidence gate.
 *
 * This deliberately lives outside `bun test`: only the production adapter on
 * a logged-in darwin-arm64 desktop can emit installed evidence. Portable tests
 * exercise the orchestration contract through the explicitly non-evidence
 * adapter below.
 */

import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  cp, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import { verifyHomeArtifact, type HomeArtifactManifest } from "../src/product-host/home-artifact";
import { homeInstallationPaths } from "../src/product-host/home-installation";
import { homeServiceLabelForVault } from "../src/product-host/home-lifecycle";
import { HOME_STORE_MIGRATIONS } from "../src/product-host/home-store-migrations";
import { isHomeUpgradeVersionAdvance } from "../src/product-host/home-upgrade-version";
import { readHomePredecessorReceipt } from "./home-predecessor-artifact";
import { inspectHomeArtifactTar, MAX_HOME_ARTIFACT_TAR_BYTES } from "./home-artifact-tar";
import {
  assertFrozenN1State,
  materializeFrozenN1Fixture,
  observeFrozenN1State,
  readFrozenN1Manifest,
} from "../tests/fixtures/home-upgrade/n-1/freeze-n1";

const HOST = "127.0.0.1";
const PORT = 3663;
const MAX_COMPRESSED_ARTIFACT_BYTES = 256 * 1024 * 1024;
const EVIDENCE_SCHEMA = "dome.home-installed-upgrade-rehearsal/v1" as const;

export type InstalledHomeUpgradeRehearsalInput = Readonly<{
  predecessorArchive: string;
  candidateArchive: string;
  frozenFixtureRoot: string;
}>;

export type InstalledHomeUpgradeScenario =
  | "ready-success"
  | "stopped-precommit-crash"
  | "committed-exact-repair";

const SCENARIOS: ReadonlyArray<InstalledHomeUpgradeScenario> = Object.freeze([
  "ready-success",
  "stopped-precommit-crash",
  "committed-exact-repair",
]);

export type InstalledHomeUpgradeRehearsalResult = Readonly<{
  schema: typeof EVIDENCE_SCHEMA;
  evidence: "installed-darwin-arm64";
  host: Readonly<{ platform: "darwin"; arch: "arm64"; uid: number }>;
  fixture: Readonly<{ releaseId: string; sourceCommit: string; canaryDigest: string }>;
  predecessor: Readonly<{ artifactId: string; version: string; buildCommit: string; archiveSha256: string; manifestSha256: string }>;
  candidate: Readonly<{ artifactId: string; version: string; buildCommit: string; archiveSha256: string; manifestSha256: string }>;
  scenarios: ReadonlyArray<InstalledHomeUpgradeScenario>;
}>;

export type NonEvidenceInstalledUpgradeResult = Readonly<{
  evidence: false;
  scenarios: ReadonlyArray<InstalledHomeUpgradeScenario>;
}>;

/** Portable launchctl exit-pair contract; it emits no installed evidence. */
export function classifyLaunchctlDrainForTests(
  bootoutExitCode: number,
  printExitCode: number,
): "drained" | "pending" {
  if (bootoutExitCode === 3) {
    if (printExitCode === 113) return "drained";
    throw new Error(`launchctl bootout reported absent (${bootoutExitCode}) without absent print proof (${printExitCode})`);
  }
  if (bootoutExitCode !== 0) throw new Error(`launchctl bootout failed (${bootoutExitCode})`);
  if (printExitCode === 113) return "drained";
  if (printExitCode === 0) return "pending";
  throw new Error(`launchctl print failed (${printExitCode})`);
}

/** Portable pre-read archive allocation gate; it emits no installed evidence. */
export function assertBoundedArchiveStatForTests(
  input: Readonly<{ isFile: boolean; size: number }>,
  maxBytes: number,
  expectedBytes?: number,
): void {
  if (!input.isFile || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > maxBytes) {
    throw new Error("archive is not a bounded regular file");
  }
  if (expectedBytes !== undefined && input.size !== expectedBytes) {
    throw new Error("archive size differs from its immutable receipt");
  }
}

type PreparedArtifacts = Readonly<{
  temporary: string;
  predecessorRoot: string;
  predecessor: HomeArtifactManifest;
  predecessorArchiveSha256: string;
  predecessorManifestSha256: string;
  candidateRoot: string;
  candidate: HomeArtifactManifest;
  candidateArchiveSha256: string;
  candidateManifestSha256: string;
  fixtureRoot: string;
  fixtureManifest: Awaited<ReturnType<typeof readFrozenN1Manifest>>;
}>;

type RehearsalOperations<TPrepared> = Readonly<{
  prepare(input: InstalledHomeUpgradeRehearsalInput): Promise<TPrepared>;
  runScenario(name: InstalledHomeUpgradeScenario, prepared: TPrepared): Promise<void>;
  cleanupScenario(name: InstalledHomeUpgradeScenario, prepared: TPrepared): Promise<void>;
  cleanup(prepared: TPrepared | null): Promise<void>;
}>;

/** Run the only adapter permitted to return installed rehearsal evidence. */
export async function rehearseInstalledHomeUpgrade(
  input: InstalledHomeUpgradeRehearsalInput,
): Promise<InstalledHomeUpgradeRehearsalResult> {
  const operations = realOperations();
  const prepared = await orchestrate(input, operations);
  const uid = process.getuid?.();
  if (process.platform !== "darwin" || process.arch !== "arm64" || uid === undefined) {
    throw new Error("installed evidence host identity changed after rehearsal");
  }
  return Object.freeze({
    schema: EVIDENCE_SCHEMA,
    evidence: "installed-darwin-arm64",
    host: Object.freeze({ platform: "darwin", arch: "arm64", uid }),
    fixture: Object.freeze({
      releaseId: prepared.fixtureManifest.releaseId,
      sourceCommit: prepared.fixtureManifest.sourceCommit,
      canaryDigest: prepared.fixtureManifest.canaryDigest,
    }),
    predecessor: Object.freeze({
      artifactId: prepared.predecessor.artifact.id,
      version: prepared.predecessor.product.version,
      buildCommit: prepared.predecessor.build.gitCommit,
      archiveSha256: prepared.predecessorArchiveSha256,
      manifestSha256: prepared.predecessorManifestSha256,
    }),
    candidate: Object.freeze({
      artifactId: prepared.candidate.artifact.id,
      version: prepared.candidate.product.version,
      buildCommit: prepared.candidate.build.gitCommit,
      archiveSha256: prepared.candidateArchiveSha256,
      manifestSha256: prepared.candidateManifestSha256,
    }),
    scenarios: SCENARIOS,
  });
}

/**
 * Portable orchestration seam. It cannot return the evidence schema or an
 * installed attestation, even when every injected operation succeeds.
 */
export async function exerciseInstalledUpgradeOrchestrationForTests<TPrepared>(
  input: InstalledHomeUpgradeRehearsalInput,
  operations: RehearsalOperations<TPrepared>,
): Promise<NonEvidenceInstalledUpgradeResult> {
  await orchestrate(input, operations);
  return Object.freeze({ evidence: false, scenarios: SCENARIOS });
}

async function orchestrate<TPrepared>(
  input: InstalledHomeUpgradeRehearsalInput,
  operations: RehearsalOperations<TPrepared>,
): Promise<TPrepared> {
  let prepared: TPrepared | null = null;
  let completed = false;
  try {
    prepared = await operations.prepare(input);
    for (const scenario of SCENARIOS) {
      try {
        await operations.runScenario(scenario, prepared);
      } finally {
        await operations.cleanupScenario(scenario, prepared);
      }
    }
    completed = true;
    return prepared;
  } finally {
    // On success, the result retains only immutable manifest summaries. The
    // extracted roots are still destroyed before installed evidence returns.
    await operations.cleanup(prepared);
    if (!completed) prepared = null;
  }
}

function realOperations(): RehearsalOperations<PreparedArtifacts> {
  const scenarios = new Map<InstalledHomeUpgradeScenario, ScenarioContext>();
  let cleanupSafe = true;
  return Object.freeze({
    prepare: prepareRealArtifacts,
    runScenario: async (name, prepared) => {
      const context = await createScenario(name, prepared, () => { cleanupSafe = false; });
      scenarios.set(name, context);
      await runRealScenario(context, prepared);
    },
    cleanupScenario: async (name) => {
      const context = scenarios.get(name);
      try {
        if (context !== undefined) await cleanupScenario(context);
        scenarios.delete(name);
      } catch (error) {
        cleanupSafe = false;
        throw error;
      }
    },
    cleanup: async (prepared) => {
      if (prepared === null) return;
      if (!cleanupSafe) {
        throw new Error(`installed rehearsal cleanup is incomplete; roots retained at ${prepared.temporary}`);
      }
      await assertPortFree();
      await rm(prepared.temporary, { recursive: true, force: true });
    },
  });
}

async function prepareRealArtifacts(input: InstalledHomeUpgradeRehearsalInput): Promise<PreparedArtifacts> {
  await assertInstalledHomeUpgradeHostPreconditions();
  const predecessorArchive = await realpath(resolve(input.predecessorArchive));
  const candidateArchive = await realpath(resolve(input.candidateArchive));
  const fixtureRoot = await realpath(resolve(input.frozenFixtureRoot));
  const receipt = await readHomePredecessorReceipt(join(fixtureRoot, "artifact-receipt.json"));
  const fixtureManifest = await readFrozenN1Manifest(fixtureRoot);

  const temporary = await mkdtemp(join(tmpdir(), "dome-installed-upgrade-"));
  try {
    const stagedInputs = join(temporary, "inputs");
    await mkdir(stagedInputs, { mode: 0o700 });
    const stagedPredecessor = join(stagedInputs, "predecessor.tar.gz");
    const stagedCandidate = join(stagedInputs, "candidate.tar.gz");
    const predecessorStage = await stageBoundedArchive(
      predecessorArchive,
      stagedPredecessor,
      MAX_COMPRESSED_ARTIFACT_BYTES,
      receipt.archive.bytes,
    );
    if (predecessorStage.sha256 !== receipt.archive.sha256) {
      throw new Error("predecessor archive differs from its immutable receipt");
    }
    const candidateStage = await stageBoundedArchive(
      candidateArchive,
      stagedCandidate,
      MAX_COMPRESSED_ARTIFACT_BYTES,
    );
    const predecessorArchiveSha256 = predecessorStage.sha256;
    const candidateArchiveSha256 = candidateStage.sha256;
    const receiptManifest = await readArchiveMember(
      stagedPredecessor,
      `${receipt.archive.root}/manifest.json`,
      temporary,
    );
    if (receiptManifest.byteLength !== receipt.manifest.bytes ||
      sha256(receiptManifest) !== receipt.manifest.sha256) {
      throw new Error("predecessor raw manifest differs from its immutable receipt before extraction");
    }
    const predecessorRoot = await extractOneSafeArtifact(stagedPredecessor, join(temporary, "predecessor"));
    const rawPredecessorManifest = await readFile(join(predecessorRoot, "manifest.json"));
    if (rawPredecessorManifest.byteLength !== receipt.manifest.bytes ||
      sha256(rawPredecessorManifest) !== receipt.manifest.sha256) {
      throw new Error("predecessor raw manifest differs from its immutable receipt");
    }
    const predecessor = await verifyHomeArtifact(predecessorRoot);
    if (basename(predecessorRoot) !== receipt.archive.root ||
      predecessor.artifact.id !== receipt.manifest.artifactId ||
      predecessor.product.version !== receipt.manifest.productVersion) {
      throw new Error("predecessor artifact identity differs from its immutable receipt");
    }

    const candidateRoot = await extractOneSafeArtifact(stagedCandidate, join(temporary, "candidate"));
    const candidateManifestSha256 = await fileSha256(join(candidateRoot, "manifest.json"));
    const candidate = await verifyHomeArtifact(candidateRoot);
    assertCandidateContract(predecessor, candidate);
    return Object.freeze({
      temporary,
      predecessorRoot,
      predecessor,
      predecessorArchiveSha256,
      predecessorManifestSha256: receipt.manifest.sha256,
      candidateRoot,
      candidate,
      candidateArchiveSha256,
      candidateManifestSha256,
      fixtureRoot,
      fixtureManifest,
    });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function readArchiveMember(archive: string, member: string, cwd: string): Promise<Uint8Array> {
  const child = Bun.spawn(["/usr/bin/tar", "-xOzf", archive, member], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`could not read ${member} from predecessor archive\n${stderr}`);
  return new Uint8Array(stdout);
}

function assertCandidateContract(predecessor: HomeArtifactManifest, candidate: HomeArtifactManifest): void {
  const oldVersion = predecessor.product.version;
  const newVersion = candidate.product.version;
  if (!isHomeUpgradeVersionAdvance(oldVersion, newVersion)) {
    throw new Error("candidate artifact must be a strict SemVer advance over its predecessor");
  }
  if (candidate.distribution.upgradeSupported !== true || candidate.writerBarrier === undefined ||
    candidate.durableState === undefined) {
    throw new Error("candidate artifact is not enabled for durable installed upgrades");
  }
  const actual = candidate.durableState.stores.map((store) => ({
    name: store.name,
    metaTable: store.metaTable,
    currentSchemaHash: store.currentSchemaHash,
    migratesFrom: [...store.migratesFrom],
  }));
  const expected = HOME_STORE_MIGRATIONS.map((store) => ({
    name: store.name,
    metaTable: store.metaTable,
    currentSchemaHash: store.currentSchemaHash,
    migratesFrom: [...store.migratesFrom],
  }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("candidate artifact durable-state inventory is not the exact current contract");
  }
}

export async function assertInstalledHomeUpgradeHostPreconditions(): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(`installed upgrade rehearsal requires darwin-arm64, got ${process.platform}-${process.arch}`);
  }
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("installed upgrade rehearsal requires a Unix user session");
  await runRaw(["/bin/launchctl", "print", `gui/${uid}`], process.cwd(), process.env);
  await assertPortFree();
}

async function stageBoundedArchive(
  source: string,
  destination: string,
  maxBytes: number,
  expectedBytes?: number,
): Promise<Readonly<{ bytes: number; sha256: string }>> {
  const input = await open(source, "r");
  let bytes: Buffer;
  try {
    const before = await input.stat();
    assertBoundedArchiveStatForTests({ isFile: before.isFile(), size: before.size }, maxBytes, expectedBytes);
    bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await input.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead <= 0) throw new Error("archive changed or truncated during its bounded read");
      offset += read.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await input.read(extra, 0, 1, bytes.length)).bytesRead !== 0) {
      throw new Error("archive grew during its bounded read");
    }
    const after = await input.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error("archive changed during its bounded read");
    }
  } finally {
    await input.close();
  }

  const output = await open(destination, "wx", 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = await output.write(bytes, offset, bytes.length - offset, offset);
      if (written.bytesWritten <= 0) throw new Error("staged archive write made no progress");
      offset += written.bytesWritten;
    }
    await output.chmod(0o400);
    await output.sync();
  } finally {
    await output.close();
  }
  return Object.freeze({ bytes: bytes.length, sha256: sha256(bytes) });
}

async function extractOneSafeArtifact(archive: string, destination: string): Promise<string> {
  await mkdir(destination, { mode: 0o700 });
  const tar = gunzipSync(await readFile(archive), { maxOutputLength: MAX_HOME_ARTIFACT_TAR_BYTES });
  const inspected = inspectHomeArtifactTar(tar);
  const validatedTar = join(destination, ".validated-artifact.tar");
  await writeFile(validatedTar, tar, { flag: "wx", mode: 0o600 });
  try {
    await runRaw(["/usr/bin/tar", "-xf", validatedTar, "-C", destination], destination, process.env);
  } finally {
    await rm(validatedTar, { force: true });
  }
  const root = inspected.root;
  const extracted = await realpath(join(destination, root));
  const contained = relative(destination, extracted);
  if (contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
    throw new Error("artifact root escaped extraction directory");
  }
  return extracted;
}

type LiveDevice = Readonly<{ deviceId: string; cookie: string }>;

type ScenarioContext = {
  readonly name: InstalledHomeUpgradeScenario;
  readonly root: string;
  readonly home: string;
  readonly vault: string;
  readonly label: string;
  readonly plist: string;
  readonly environment: Record<string, string>;
  readonly seedCommit: string;
  readonly ownerMarkdown: string;
  readonly ownerMarkdownSha256: string;
  readonly fixtureRoot: string;
  readonly fixtureManifest: Awaited<ReturnType<typeof readFrozenN1Manifest>>;
  activeDevice: LiveDevice | null;
  revokedDevice: LiveDevice | null;
  checkpointChild: ReturnType<typeof Bun.spawn> | null;
};

async function createScenario(
  name: InstalledHomeUpgradeScenario,
  prepared: PreparedArtifacts,
  unsafeCleanup: () => void,
): Promise<ScenarioContext> {
  await assertPortFree();
  const root = await mkdtemp(join(prepared.temporary, `${name}-`));
  const home = join(root, "home");
  const vault = join(root, `vault-${randomUUID()}`);
  const label = homeServiceLabelForVault(vault);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const environment = isolatedEnvironment(home);
  const predecessorDome = join(prepared.predecessorRoot, "bin", "dome");
  try {
  await runJson([predecessorDome, "init", vault, "--json"], root, environment);

  const stateRoot = join(vault, ".dome", "state");
  await rm(stateRoot, { recursive: true, force: true });
  await mkdir(stateRoot, { mode: 0o700 });
  const fixtureManifest = await materializeFrozenN1Fixture({
    fixtureRoot: prepared.fixtureRoot,
    destination: stateRoot,
  });
  const ownerMarkdown = join(vault, "owner-upgrade-canary.md");
  await writeFile(ownerMarkdown, "# Owner upgrade canary\n\nThese bytes must survive the installed upgrade.\n", { flag: "wx" });
  await runRaw(["/usr/bin/git", "add", "owner-upgrade-canary.md"], vault, environment);
  await runRaw([
    "/usr/bin/git", "-c", "user.name=Dome Rehearsal", "-c",
    "user.email=rehearsal@dome.invalid", "commit", "-m", "seed installed upgrade rehearsal",
  ], vault, environment);
  const seedCommit = (await runRaw(["/usr/bin/git", "rev-parse", "HEAD"], vault, environment)).stdout.trim();

  const installed = await runJson([
    predecessorDome, "home", "install", "--vault", vault,
    "--env", `HOME=${home}`, "--json",
  ], root, environment);
  assertObjectFields(installed, { status: "installed", loaded: true, ready: true });
  if (stringField(installed, "label") !== label) throw new Error("installed Home returned the wrong unique label");
  const plist = stringField(installed, "plist");
  if (plist !== join(home, "Library", "LaunchAgents", `${label}.plist`)) {
    throw new Error("installed Home escaped the isolated LaunchAgents directory");
  }

  const context: ScenarioContext = {
    name, root, home, vault, label, plist, environment, seedCommit, ownerMarkdown,
    fixtureRoot: prepared.fixtureRoot,
    ownerMarkdownSha256: await fileSha256(ownerMarkdown), fixtureManifest,
    activeDevice: null, revokedDevice: null, checkpointChild: null,
  };
  context.activeDevice = await pairFreshDevice(context, prepared.predecessorRoot, `${name}-active`);
  context.revokedDevice = await pairFreshDevice(context, prepared.predecessorRoot, `${name}-revoked`);
  await runJson([
    predecessorDome, "devices", "revoke", context.revokedDevice.deviceId,
    "--vault", vault, "--json",
  ], root, environment);
  await assertLiveCredentialTruth(context, prepared.predecessor);
  await assertFrozenState(context, "n1");
  return context;
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    try { await bootoutAndDrain({ label }); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
    try { await assertPortFree(); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
    if (cleanupFailures.length === 0) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
    unsafeCleanup();
    throw new AggregateError([error, ...cleanupFailures], `partial installed rehearsal cleanup failed for ${label}; root retained at ${root}`);
  }
}

async function runRealScenario(context: ScenarioContext, prepared: PreparedArtifacts): Promise<void> {
  switch (context.name) {
    case "ready-success":
      await readySuccess(context, prepared);
      break;
    case "stopped-precommit-crash":
      await stoppedPrecommitCrash(context, prepared);
      break;
    case "committed-exact-repair":
      await committedExactRepair(context, prepared);
      break;
  }
  await assertOwnerSubstrate(context);
}

async function readySuccess(context: ScenarioContext, prepared: PreparedArtifacts): Promise<void> {
  await packagedBackup(context, prepared.candidateRoot);
  await assertTerminalStatus(context, prepared.candidateRoot, prepared.predecessor, "ready");
  await assertFrozenState(context, "n1");
  await assertLiveCredentialTruth(context, prepared.predecessor);
  const upgraded = await candidateUpgrade(context, prepared.candidateRoot);
  assertObjectFields(upgraded, { status: "upgraded", exitCode: 0, service: "ready" });
  await assertTerminalStatus(context, prepared.candidateRoot, prepared.candidate, "ready");
  await assertFrozenState(context, "current");
  await assertLiveCredentialTruth(context, prepared.candidate);
  await assertPwa();
}

async function stoppedPrecommitCrash(context: ScenarioContext, prepared: PreparedArtifacts): Promise<void> {
  await bootoutAndDrain(context);
  await assertTerminalStatus(context, prepared.candidateRoot, prepared.predecessor, "stopped");
  await crashAtCheckpoint(context, prepared.candidateRoot, "candidate-installation-published");
  await assertRetainedCheckpoint(context, "switching");

  const recovered = await candidateUpgrade(context, prepared.candidateRoot, true);
  if (field(recovered, "status") !== "rolled-back" ||
    field(recovered, "service") !== "stopped" || field(recovered, "recovered") !== true) {
    throw new Error("packaged candidate did not exactly recover the stopped pre-commit crash");
  }
  const receipt = await candidateUpgrade(context, prepared.candidateRoot, true);
  if (field(receipt, "status") !== "rolled-back" || field(receipt, "service") !== "stopped" ||
    stringField(record(receipt, "transaction"), "operationId") !==
      stringField(record(recovered, "transaction"), "operationId")) {
    throw new Error("packaged candidate did not return the terminal rollback receipt");
  }
  await assertTerminalStatus(context, prepared.candidateRoot, prepared.predecessor, "stopped");
  await assertFrozenState(context, "n1");
  await assertLiveCredentialRows(context);
}

async function committedExactRepair(context: ScenarioContext, prepared: PreparedArtifacts): Promise<void> {
  await crashAtCheckpoint(context, prepared.candidateRoot, "committed-recorded");
  const journal = await assertRetainedCheckpoint(context, "committed");
  const active = join(homeInstallationPaths(context.vault, {
    applicationSupportDir: join(context.home, "Library", "Application Support", "Dome", "Home"),
  }).installations, "upgrade", "active");
  await rm(stringField(record(journal, "old"), "releasePath"), { recursive: true, force: true });
  await damageSnapshot(active, journal);
  const candidateRelease = stringField(record(journal, "candidate"), "releasePath");
  await rm(candidateRelease, { recursive: true, force: true });
  await writeFile(join(homeInstallationPaths(context.vault, {
    applicationSupportDir: join(context.home, "Library", "Application Support", "Dome", "Home"),
  }).installations, "installation.json"), "broken\n");
  await writeFile(context.plist, "broken\n");

  const wrong = await createWrongRawCandidate(context, prepared.candidateRoot);
  await verifyHomeArtifact(wrong);
  await assertPortFree();
  await assertLaunchdAbsent(context.label);
  const before = await fullFingerprint([context.home, context.vault]);
  const refused = await candidateUpgrade(context, wrong, true);
  assertObjectFields(refused, {
    status: "recovery-required",
    exitCode: 1,
    reason: "candidate-repair-required",
    nextAction: "supply-exact-candidate",
  });
  const after = await fullFingerprint([context.home, context.vault]);
  if (before !== after) throw new Error("wrong raw-manifest candidate refusal was not write-free");
  await assertLaunchdAbsent(context.label);

  const repaired = await candidateUpgrade(context, prepared.candidateRoot);
  if (!["upgraded", "already-current"].includes(String(field(repaired, "status")))) {
    throw new Error("exact packaged candidate did not complete committed forward repair");
  }
  await assertTerminalStatus(context, prepared.candidateRoot, prepared.candidate, "ready");
  await assertFrozenState(context, "current");
  await assertLiveCredentialTruth(context, prepared.candidate);
  await assertPwa();
}

async function candidateUpgrade(
  context: ScenarioContext,
  candidateRoot: string,
  allowFailure = false,
): Promise<Record<string, unknown>> {
  return await runJson([
    join(candidateRoot, "bin", "dome"), "home", "upgrade", "--vault", context.vault, "--json",
  ], context.root, context.environment, allowFailure);
}

async function pairFreshDevice(
  context: ScenarioContext,
  artifactRoot: string,
  name: string,
): Promise<LiveDevice> {
  const dome = join(artifactRoot, "bin", "dome");
  const grant = await runJson([
    dome, "devices", "pair", "--name", name, "--grant", "read,capture",
    "--vault", context.vault, "--json",
  ], context.root, context.environment);
  const pairingCode = stringField(grant, "pairingCode");
  const response = await fetch(`http://${HOST}:${PORT}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://${HOST}:${PORT}` },
    body: JSON.stringify({ code: pairingCode }),
  });
  if (response.status !== 200) throw new Error(`fresh device pairing failed (${response.status})`);
  const body = record(await response.json(), "pair response");
  const deviceId = stringField(record(body, "device"), "id");
  const cookie = response.headers.getSetCookie().map((value) => value.split(";", 1)[0]!).join("; ");
  if (cookie === "") throw new Error("fresh device pairing returned no credential cookies");
  return Object.freeze({ deviceId, cookie });
}

async function assertLiveCredentialTruth(
  context: ScenarioContext,
  expected: HomeArtifactManifest,
): Promise<void> {
  if (context.activeDevice === null || context.revokedDevice === null) {
    throw new Error("fresh live credential evidence is incomplete");
  }
  const active = await fetch(`http://${HOST}:${PORT}/readyz`, {
    headers: { cookie: context.activeDevice.cookie },
  });
  const revoked = await fetch(`http://${HOST}:${PORT}/readyz`, {
    headers: { cookie: context.revokedDevice.cookie },
  });
  const activeBody = active.status === 200 ? record(await active.json(), "active readiness") : null;
  const revokedBody = revoked.status === 401 ? record(await revoked.json(), "revoked readiness error") : null;
  if (active.status !== 200 || activeBody === null ||
    field(activeBody, "schema") !== "dome.product.readiness/v1" ||
    field(activeBody, "artifactId") !== expected.artifact.id ||
    field(activeBody, "productVersion") !== expected.product.version ||
    field(activeBody, "writesAdmitted") !== true ||
    field(record(activeBody, "host"), "state") !== "ready" ||
    field(record(activeBody, "device"), "id") !== context.activeDevice.deviceId ||
    revoked.status !== 401 || revokedBody === null ||
    field(revokedBody, "status") !== "error" ||
    field(revokedBody, "error") !== "credential-invalid" ||
    field(revokedBody, "message") !== "Device authentication is invalid.") {
    throw new Error(`fresh active/revoked credential truth changed (${active.status}/${revoked.status})`);
  }
  await assertLiveCredentialRows(context);
}

async function assertLiveCredentialRows(context: ScenarioContext): Promise<void> {
  if (context.activeDevice === null || context.revokedDevice === null) {
    throw new Error("fresh device row evidence is incomplete");
  }
  const db = new Database(join(context.vault, ".dome", "state", "device-authority.db"), {
    readonly: true,
    create: false,
  });
  try {
    const rows = db.query<{ id: string; revoked: number }, [string, string]>(
      "SELECT id,revoked_at IS NOT NULL AS revoked FROM devices WHERE id IN (?,?) ORDER BY id",
    ).all(context.activeDevice.deviceId, context.revokedDevice.deviceId);
    const byId = new Map(rows.map((row) => [row.id, row.revoked]));
    if (byId.get(context.activeDevice.deviceId) !== 0 || byId.get(context.revokedDevice.deviceId) !== 1) {
      throw new Error("fresh active/revoked device rows changed");
    }
  } finally { db.close(); }
}

async function assertFrozenState(context: ScenarioContext, expectedSchema: "n1" | "current"): Promise<void> {
  const observation = await observeFrozenN1State({
    fixtureRoot: context.fixtureRoot,
    stateRoot: join(context.vault, ".dome", "state"),
  });
  assertFrozenN1State(observation, context.fixtureManifest);
  for (const store of observation.stores) {
    const expected = expectedSchema === "n1"
      ? context.fixtureManifest.stores.find((entry) => entry.name === store.name)?.schemaHash
      : HOME_STORE_MIGRATIONS.find((entry) => entry.name === `${store.name}.db`)?.currentSchemaHash;
    if (expected === undefined || store.schemaHash !== expected) {
      throw new Error(`unexpected ${expectedSchema} schema hash: ${store.name}`);
    }
  }
}

async function crashAtCheckpoint(
  context: ScenarioContext,
  candidateRoot: string,
  checkpoint: "candidate-installation-published" | "committed-recorded",
): Promise<void> {
  const marker = join(context.root, `${checkpoint}.marker`);
  const childScript = join(context.root, `${checkpoint}.ts`);
  const moduleUrl = pathToFileURL(join(candidateRoot, "app", "src", "product-host", "home-upgrade.ts")).href;
  const source = [
    'import { open } from "node:fs/promises";',
    `const marker = ${JSON.stringify(marker)};`,
    `const markerParent = ${JSON.stringify(context.root)};`,
    `const imported = await import(${JSON.stringify(moduleUrl)});`,
    "await imported.manageHomeUpgrade(",
    `  { action: "run", vaultPath: ${JSON.stringify(context.vault)} },`,
    "  {",
    `    artifactRoot: ${JSON.stringify(candidateRoot)},`,
    "    selectionCheckpoint: async (name) => {",
    `      if (name !== ${JSON.stringify(checkpoint)}) return;`,
    "      const handle = await open(marker, \"wx\", 0o600);",
    "      try { await handle.writeFile(`${name}\\n`); await handle.sync(); } finally { await handle.close(); }",
    "      const parent = await open(markerParent, \"r\");",
    "      try { await parent.sync(); } finally { await parent.close(); }",
    "      process.kill(process.pid, \"SIGKILL\");",
    "    },",
    "  },",
    ");",
    "throw new Error(\"diagnostic checkpoint was not reached\");",
    "",
  ].join("\n");
  await writeFile(childScript, source, { flag: "wx", mode: 0o600 });
  const child = Bun.spawn([join(candidateRoot, "runtime", "bun"), childScript], {
    cwd: context.root,
    env: context.environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  context.checkpointChild = child;
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  context.checkpointChild = null;
  if (exitCode !== 137 || child.signalCode !== "SIGKILL" ||
    await readFile(marker, "utf8").catch(() => "") !== `${checkpoint}\n`) {
    throw new Error(`diagnostic child did not die by its exact SIGKILL checkpoint (${exitCode})\n${stdout}${stderr}`);
  }
}

async function assertRetainedCheckpoint(
  context: ScenarioContext,
  phase: "switching" | "committed",
): Promise<Record<string, unknown>> {
  const paths = homeInstallationPaths(context.vault, {
    applicationSupportDir: join(context.home, "Library", "Application Support", "Dome", "Home"),
  });
  const active = join(paths.installations, "upgrade", "active");
  const journal = record(JSON.parse(await readFile(join(active, "journal.json"), "utf8")), "journal");
  if (field(journal, "phase") !== phase) throw new Error(`retained journal did not reach ${phase}`);
  const selection = record(journal, "selection");
  const candidate = record(selection, "candidate");
  await assertFileSha(paths.record, stringField(record(candidate, "installation"), "sha256"));
  await assertFileSha(context.plist, stringField(record(candidate, "plist"), "sha256"));

  const status = await runJson([
    join(context.home, "Library", "Application Support", "Dome", "Home", "releases",
      stringField(record(journal, "candidate"), "artifactId"), "bin", "dome"),
    "home", "status", "--vault", context.vault, "--json",
  ], context.root, context.environment, true);
  if (field(record(status, "lifecycle"), "state") !== "active" ||
    field(record(status, "upgrade"), "state") !== "active") {
    throw new Error("checkpoint crash did not retain lifecycle and upgrade ownership");
  }
  return journal;
}

async function damageSnapshot(active: string, journal: Record<string, unknown>): Promise<void> {
  const snapshot = record(journal, "snapshot");
  const inventory = arrayField(snapshot, "inventory").map((entry) => record(entry, "snapshot entry"))
    .filter((entry) => field(entry, "present") === true);
  if (inventory.length < 2) throw new Error("committed rehearsal snapshot lacks two present entries to damage");
  await rm(join(active, "snapshot", stringField(inventory[0]!, "name")), { force: true });
  await writeFile(join(active, "snapshot", stringField(inventory[1]!, "name")), "damaged snapshot\n");
}

async function createWrongRawCandidate(context: ScenarioContext, candidateRoot: string): Promise<string> {
  const wrong = join(context.root, "wrong-raw-candidate");
  await cp(candidateRoot, wrong, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false,
  });
  const manifestPath = join(wrong, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  const replacement = `${JSON.stringify(manifest)}\n`;
  const original = await readFile(manifestPath, "utf8");
  if (replacement === original) throw new Error("wrong candidate manifest formatting did not change");
  await writeFile(manifestPath, replacement);
  const checksumsPath = join(wrong, "checksums.sha256");
  const checksums = await readFile(checksumsPath, "utf8");
  const lines = checksums.trimEnd().split("\n").map((line) =>
    line.endsWith("  manifest.json") ? `${sha256(Buffer.from(replacement))}  manifest.json` : line,
  );
  if (!lines.some((line) => line.endsWith("  manifest.json"))) {
    throw new Error("wrong candidate checksums lack manifest identity");
  }
  await writeFile(checksumsPath, `${lines.join("\n")}\n`);
  return wrong;
}

async function packagedBackup(context: ScenarioContext, candidateRoot: string): Promise<void> {
  const dome = join(candidateRoot, "bin", "dome");
  const identity = join(context.root, "backup.identity");
  const archive = join(context.root, "backup.tar.age");
  const key = await runJson([dome, "backup", "keygen", "--output", identity, "--json"], context.root, context.environment);
  const created = await runJson([
    dome, "backup", "create", "--vault", context.vault, "--output", archive,
    "--recipient", stringField(key, "recipient"), "--json",
  ], context.root, context.environment);
  assertObjectFields(created, { status: "created", restart: "restarted" });
  const verified = await runJson([
    dome, "backup", "verify", archive, "--identity", identity, "--json",
  ], context.root, context.environment);
  assertObjectFields(verified, { status: "verified" });
  const restoredVault = join(context.root, "restored-backup-vault");
  const blankHome = join(context.root, "blank-restore-home");
  await mkdir(blankHome, { mode: 0o700 });
  const restored = await runJson([
    dome, "backup", "restore", archive, "--identity", identity,
    "--target", restoredVault, "--json",
  ], context.root, { ...context.environment, HOME: blankHome });
  assertInstalledBackupRestoreCanaryForTests(
    restored,
    await readFile(join(restoredVault, "core.md"), "utf8"),
    await fileSha256(join(restoredVault, "owner-upgrade-canary.md")),
    context.ownerMarkdownSha256,
  );
}

/** Portable assertion for the real installed backup/blank-host restore canary. */
export function assertInstalledBackupRestoreCanaryForTests(
  restored: Record<string, unknown>,
  coreMarkdown: string,
  restoredOwnerMarkdownSha256: string,
  expectedOwnerMarkdownSha256: string,
): void {
  assertObjectFields(restored, {
    schema: "dome.backup/v1",
    operation: "restore",
    status: "restored",
    exitCode: 0,
    authority: "invalidated",
    durability: "durable",
  });
  if (!coreMarkdown.includes("# Core")) {
    throw new Error("installed packaged backup restore lost core.md content");
  }
  if (restoredOwnerMarkdownSha256 !== expectedOwnerMarkdownSha256) {
    throw new Error("installed packaged backup restore changed the owner canary");
  }
}

async function assertTerminalStatus(
  context: ScenarioContext,
  observerRoot: string,
  selected: HomeArtifactManifest,
  service: "ready" | "stopped",
): Promise<void> {
  const status = await runJson([
    join(observerRoot, "bin", "dome"),
    "home", "status", "--vault", context.vault, "--json",
  ], context.root, context.environment);
  assertObjectFields(status, service === "ready"
    ? { status: "ready", loaded: true, ready: true }
    : { status: "installed-stopped", loaded: false, ready: null });
  if (field(status, "artifactId") !== selected.artifact.id ||
    field(status, "productVersion") !== selected.product.version) {
    throw new Error("terminal Home status selected the wrong artifact");
  }
  if (field(record(status, "lifecycle"), "state") !== "inactive" ||
    field(record(status, "upgrade"), "state") !== "inactive") {
    throw new Error("terminal Home status retained lifecycle or upgrade ownership");
  }
  assertNoPhase(status);
}

async function assertPwa(): Promise<void> {
  const response = await fetch(`http://${HOST}:${PORT}/`);
  const html = await response.text();
  if (!response.ok || !html.includes('id="root"')) {
    throw new Error(`installed Home did not serve its PWA shell (${response.status})`);
  }
  const assetPath = html.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
  if (assetPath === undefined || !/[-.][a-zA-Z0-9_]{6,}\.(?:js|css)$/.test(assetPath)) {
    throw new Error("installed PWA shell did not reference a hashed asset");
  }
  const asset = await fetch(new URL(assetPath, `http://${HOST}:${PORT}/`));
  if (!asset.ok || (await asset.arrayBuffer()).byteLength === 0) {
    throw new Error(`installed Home did not serve PWA asset ${assetPath}`);
  }
}

async function assertOwnerSubstrate(context: ScenarioContext): Promise<void> {
  if (await fileSha256(context.ownerMarkdown) !== context.ownerMarkdownSha256) {
    throw new Error("owner Markdown bytes changed during installed upgrade");
  }
  await runRaw([
    "/usr/bin/git", "merge-base", "--is-ancestor", context.seedCommit, "HEAD",
  ], context.vault, context.environment);
}

async function bootoutAndDrain(context: Pick<ScenarioContext, "label">): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("launchd drain requires a Unix uid");
  const target = `gui/${uid}/${context.label}`;
  const result = await runRawAllowFailure(["/bin/launchctl", "bootout", target], process.cwd(), process.env);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const printed = await runRawAllowFailure(["/bin/launchctl", "print", target], process.cwd(), process.env);
    const state = classifyLaunchctlDrainForTests(result.exitCode, printed.exitCode);
    if (state === "drained") return;
    await Bun.sleep(100);
  }
  throw new Error(`launchd label did not drain: ${context.label}`);
}

async function assertLaunchdAbsent(label: string): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("launchd absence proof requires a Unix uid");
  const printed = await runRawAllowFailure([
    "/bin/launchctl", "print", `gui/${uid}/${label}`,
  ], process.cwd(), process.env);
  if (printed.exitCode !== 113) {
    throw new Error(`launchd label is not absent: ${label} (${printed.exitCode})`);
  }
}

async function cleanupScenario(context: ScenarioContext): Promise<void> {
  const failures: unknown[] = [];
  if (context.checkpointChild !== null) {
    try {
      context.checkpointChild.kill("SIGKILL");
      await context.checkpointChild.exited;
    } catch (error) { failures.push(error); }
    context.checkpointChild = null;
  }
  try { await bootoutAndDrain(context); } catch (error) { failures.push(error); }
  try { await assertPortFree(); } catch (error) { failures.push(error); }
  if (failures.length === 0) {
    await rm(context.root, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `installed rehearsal cleanup failed for ${context.label}; roots retained`);
  }
}

async function assertPortFree(): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(PORT, HOST, () => server.close((error) => error === undefined ? resolvePromise() : reject(error)));
  }).catch((error: unknown) => {
    throw new Error(`installed rehearsal requires ${HOST}:${PORT} to be unbound: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function fullFingerprint(roots: ReadonlyArray<string>): Promise<string> {
  const entries: Array<unknown> = [];
  for (const root of roots) await fingerprintEntry(resolve(root), resolve(root), entries);
  return sha256(Buffer.from(JSON.stringify(entries)));
}

async function fingerprintEntry(root: string, path: string, output: Array<unknown>): Promise<void> {
  const info = await lstat(path);
  const key = `${basename(root)}/${relative(root, path)}`;
  if (info.isSymbolicLink()) {
    output.push([key, "symlink", info.mode & 0o777, await readlink(path)]);
    return;
  }
  if (info.isFile()) {
    output.push([key, "file", info.mode & 0o777, info.size, await fileSha256(path)]);
    return;
  }
  if (!info.isDirectory()) throw new Error(`fingerprint found unsupported entry: ${path}`);
  output.push([key, "directory", info.mode & 0o777]);
  for (const name of (await readdir(path)).sort()) await fingerprintEntry(root, join(path, name), output);
}

function isolatedEnvironment(home: string): Record<string, string> {
  return {
    ...process.env,
    HOME: home,
    ANTHROPIC_API_KEY: "",
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "127.0.0.1,localhost",
  } as Record<string, string>;
}

async function runJson(
  command: ReadonlyArray<string>,
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  allowFailure = false,
): Promise<Record<string, unknown>> {
  const result = await runRawAllowFailure(command, cwd, environment);
  if (!allowFailure && result.exitCode !== 0) {
    throw new Error(`${renderCommand(command)} failed (${result.exitCode})\n${result.stdout}${result.stderr}`);
  }
  let value: unknown;
  try { value = JSON.parse(result.stdout); }
  catch { throw new Error(`${renderCommand(command)} returned non-JSON output\n${result.stdout}${result.stderr}`); }
  return record(value, "packaged command result");
}

async function runRaw(
  command: ReadonlyArray<string>,
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<{ stdout: string; stderr: string }> {
  const result = await runRawAllowFailure(command, cwd, environment);
  if (result.exitCode !== 0) {
    throw new Error(`${renderCommand(command)} failed (${result.exitCode})\n${result.stdout}${result.stderr}`);
  }
  return result;
}

async function runRawAllowFailure(
  command: ReadonlyArray<string>,
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([...command], { cwd, env: environment, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function renderCommand(command: ReadonlyArray<string>): string {
  return command.map((part) => JSON.stringify(part)).join(" ");
}

async function assertFileSha(path: string, expected: string): Promise<void> {
  if (await fileSha256(path) !== expected) throw new Error(`file evidence changed: ${path}`);
}

async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function field(value: Record<string, unknown>, name: string): unknown {
  return value[name];
}

function stringField(value: Record<string, unknown>, name: string, nested?: string): string {
  const candidate = nested === undefined ? value[name] : record(value[name], name)[nested];
  if (typeof candidate !== "string" || candidate === "") throw new Error(`${name} must be a nonempty string`);
  return candidate;
}

function arrayField(value: Record<string, unknown>, name: string): ReadonlyArray<unknown> {
  const candidate = value[name];
  if (!Array.isArray(candidate)) throw new Error(`${name} must be an array`);
  return candidate;
}

function assertObjectFields(value: Record<string, unknown>, expected: Readonly<Record<string, unknown>>): void {
  for (const [name, wanted] of Object.entries(expected)) {
    if (!Object.is(value[name], wanted)) {
      throw new Error(`expected ${name}=${JSON.stringify(wanted)}, got ${JSON.stringify(value[name])}`);
    }
  }
}

function assertNoPhase(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoPhase(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Object.hasOwn(value, "phase")) throw new Error("public terminal status leaked an upgrade phase");
  for (const child of Object.values(value)) assertNoPhase(child);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await rehearseInstalledHomeUpgrade(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArgs(args: ReadonlyArray<string>): InstalledHomeUpgradeRehearsalInput {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (name === undefined || value === undefined || ![
      "--predecessor-archive", "--candidate-archive", "--frozen-fixture-root",
    ].includes(name)) throw new Error("usage: home-installed-upgrade-rehearsal --predecessor-archive <tar.gz> --candidate-archive <tar.gz> --frozen-fixture-root <dir>");
    values.set(name, value);
  }
  const predecessorArchive = values.get("--predecessor-archive");
  const candidateArchive = values.get("--candidate-archive");
  const frozenFixtureRoot = values.get("--frozen-fixture-root");
  if (values.size !== 3 || predecessorArchive === undefined || candidateArchive === undefined || frozenFixtureRoot === undefined) {
    throw new Error("usage: home-installed-upgrade-rehearsal --predecessor-archive <tar.gz> --candidate-archive <tar.gz> --frozen-fixture-root <dir>");
  }
  return Object.freeze({ predecessorArchive, candidateArchive, frozenFixtureRoot });
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(`dome installed Home upgrade rehearsal: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
