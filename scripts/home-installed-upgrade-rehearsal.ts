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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import { inspectExclusiveFileLock } from "../src/engine/host/file-lock";
import { verifyHomeArtifact, type HomeArtifactManifest } from "../src/product-host/home-artifact";
import { externalProductHostLockPath } from "../src/product-host/host-ownership";
import { homeInstallationPaths, releaseRoot } from "../src/product-host/home-installation";
import { homeServiceLabelForVault } from "../src/product-host/home-lifecycle";
import { isHomePairingReadiness } from "../src/product-host/home-readiness";
import { HOME_STORE_MIGRATIONS } from "../src/product-host/home-store-migrations";
import { isHomeUpgradeVersionAdvance } from "../src/product-host/home-upgrade-version";
import { readHomePredecessorReceipt } from "./home-predecessor-artifact";
import { inspectHomeArtifactTar, MAX_HOME_ARTIFACT_TAR_BYTES } from "./home-artifact-tar";
import { runHomePwaChromiumAcceptance } from "./home-pwa-chromium-acceptance";
import { runHomePwaUpdateRehearsal } from "./home-pwa-update-rehearsal";
import { parsePwaShellHashedAssetPath } from "./home-pwa-shell";
import {
  assertInstalledFunctionalClosure,
  prepareInstalledFunctionalClosure,
  type FunctionalClosureBoundary,
} from "./home-installed-functional-closure";
import {
  assertFrozenN1State,
  assertFrozenN1RuntimeBaseline,
  assertFrozenN1RuntimeProvenance,
  establishFrozenN1RuntimeBaseline,
  materializeFrozenN1Fixture,
  observeFrozenN1State,
  readFrozenN1Manifest,
  type FrozenN1StateObservation,
} from "../tests/fixtures/home-upgrade/n-1/freeze-n1";

const HOST = "127.0.0.1";
const PORT = 3663;
const MAX_COMPRESSED_ARTIFACT_BYTES = 256 * 1024 * 1024;
const PREDECESSOR_INSTALL_TIMEOUT_MS = 60_000;
const PREDECESSOR_LATE_READINESS_TIMEOUT_MS = 30_000;
const INSTALLED_TEMPORARY_CLEANUP_TIMEOUT_MS = 120_000;
const INSTALLED_TEMPORARY_PREFIX = "dome-installed-upgrade-";
const FROZEN_PREDECESSOR_ARTIFACT_ID = "911d5219bd5888f8a45fbfb0bbcf6da57b54e3a0ffcf8077bd2d843327747096";
const FROZEN_PREDECESSOR_VERSION = "0.1.0";
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

type RetainedCheckpointPhase = "switching" | "committed";

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

/** Exact safe renderer embedded in diagnostic children; it emits no installed evidence. */
export function renderInstalledCoordinationErrorForTests(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return "Non-Error coordination failure";
  const parts = [`${error.name}: ${error.message}`];
  if (depth < 2) {
    if (error instanceof AggregateError) {
      for (const nested of error.errors.slice(0, 4)) {
        parts.push(`nested: ${renderInstalledCoordinationErrorForTests(nested, depth + 1)}`);
      }
    } else if (error.cause !== undefined) {
      parts.push(`caused by: ${renderInstalledCoordinationErrorForTests(error.cause, depth + 1)}`);
    }
  }
  const redacted = parts.join(" | ")
    .replace(/\bdome_(?:pair|cred|csrf)(?:\.[A-Za-z0-9_-]+)+(?![A-Za-z0-9_-])/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");
  return redacted.length <= 2_048 ? redacted : `${redacted.slice(0, 2_047)}…`;
}

/** Bounded allowlisted ownership detail for a strict checkpoint failure. */
export function retainedCheckpointOwnershipSummaryForTests(status: unknown): string {
  const root = status !== null && typeof status === "object" && !Array.isArray(status)
    ? status as Record<string, unknown>
    : {};
  const lifecycle = summaryRecord(root["lifecycle"]);
  const upgrade = summaryRecord(root["upgrade"]);
  return JSON.stringify({
    lifecycle: {
      state: summaryEnum(lifecycle["state"], ["inactive", "active", "invalid", "unavailable"]),
      phase: summaryEnum(lifecycle["phase"], ["suspending", "suspended", "resuming"]),
      purpose: summaryEnum(lifecycle["purpose"], ["backup", "upgrade"]),
      operationId: summaryOperationId(lifecycle["operationId"]),
    },
    upgrade: {
      state: summaryEnum(upgrade["state"], ["inactive", "active", "complete", "recovery-required", "unavailable"]),
      operationId: summaryOperationId(upgrade["operationId"]),
      outcome: summaryEnum(upgrade["outcome"], ["committed", "restored"]),
      nextAction: summaryEnum(upgrade["nextAction"], [
        "none", "rerun-requested-upgrade", "retry-recovery", "supply-exact-candidate", "inspect-home-status",
      ]),
    },
  });
}

/** Exact lifecycle and upgrade ownership expected at each durable crash checkpoint. */
export function retainedCheckpointOwnershipMatchesForTests(
  status: unknown,
  phase: RetainedCheckpointPhase,
  transactionId: string,
): boolean {
  const root = summaryRecord(status);
  const lifecycle = summaryRecord(root["lifecycle"]);
  const upgrade = summaryRecord(root["upgrade"]);
  const expectedUpgrade = phase === "switching"
    ? { state: "active", outcome: null, nextAction: "retry-recovery" }
    : { state: "complete", outcome: "committed", nextAction: "none" };
  return lifecycle["state"] === "active" &&
    lifecycle["phase"] === "suspended" &&
    lifecycle["purpose"] === "upgrade" &&
    lifecycle["operationId"] === transactionId &&
    upgrade["state"] === expectedUpgrade.state &&
    upgrade["operationId"] === transactionId &&
    upgrade["outcome"] === expectedUpgrade.outcome &&
    upgrade["nextAction"] === expectedUpgrade.nextAction;
}

function summaryRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function summaryEnum(value: unknown, allowed: ReadonlyArray<string>): string | null {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}

function summaryOperationId(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

/** Portable launchd-label plus listener drain contract; it emits no installed evidence. */
export function classifyInstalledHomeDrainForTests(
  bootoutExitCode: number,
  printExitCode: number,
  portFree: boolean,
  ownershipFree: boolean,
): "drained" | "pending" {
  let labelDrained = false;
  if (bootoutExitCode === 3) {
    if (printExitCode !== 113) {
      throw new Error(`launchctl bootout reported absent (${bootoutExitCode}) without absent print proof (${printExitCode})`);
    }
    labelDrained = true;
  } else {
    if (bootoutExitCode !== 0) throw new Error(`launchctl bootout failed (${bootoutExitCode})`);
    if (printExitCode === 113) labelDrained = true;
    else if (printExitCode !== 0) throw new Error(`launchctl print failed (${printExitCode})`);
  }
  return labelDrained && portFree && ownershipFree ? "drained" : "pending";
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
  const causes: Array<Readonly<{ label: string; error: unknown }>> = [];
  try {
    prepared = await operations.prepare(input);
  } catch (error) {
    causes.push({ label: "prepare", error });
  }
  if (prepared !== null) {
    for (const scenario of SCENARIOS) {
      let runError: unknown | null = null;
      let scenarioCleanupError: unknown | null = null;
      try { await operations.runScenario(scenario, prepared); }
      catch (error) { runError = error; }
      try { await operations.cleanupScenario(scenario, prepared); }
      catch (error) { scenarioCleanupError = error; }
      if (runError !== null) causes.push({ label: `run:${scenario}`, error: runError });
      if (scenarioCleanupError !== null) {
        causes.push({ label: `scenario-cleanup:${scenario}`, error: scenarioCleanupError });
      }
      if (runError !== null || scenarioCleanupError !== null) break;
    }
  }
  try {
    // On success, the result retains only immutable manifest summaries. The
    // extracted roots are still destroyed before installed evidence returns.
    await operations.cleanup(prepared);
  } catch (error) {
    causes.push({ label: "global-cleanup", error });
  }
  if (causes.length > 1) {
    const global = causes.at(-1)?.label === "global-cleanup" ? causes.at(-1)! : null;
    const primary = global === null ? causes : causes.slice(0, -1);
    const primaryError = primary.length === 1
      ? primary[0]!.error
      : new AggregateError(primary.map((cause) => cause.error), "installed scenario and cleanup both failed");
    const combined = global === null
      ? primaryError
      : new AggregateError([primaryError, global.error], "installed rehearsal and global cleanup both failed");
    throw new Error(renderInstalledOrchestrationCauses(causes), { cause: combined });
  }
  if (causes.length === 1) throw causes[0]!.error;
  if (prepared === null) throw new Error("installed rehearsal completed without prepared artifacts");
  return prepared;
}

function renderInstalledOrchestrationCauses(
  causes: ReadonlyArray<Readonly<{ label: string; error: unknown }>>,
): string {
  const prefix = "installed rehearsal failures: ";
  const separator = " | ";
  const fixed = prefix.length + separator.length * (causes.length - 1) +
    causes.reduce((sum, cause) => sum + cause.label.length + 2, 0);
  const budget = Math.floor((2_048 - fixed) / causes.length);
  return prefix + causes.map((cause) => {
    const rendered = renderInstalledCoordinationErrorForTests(cause.error);
    const fragment = rendered.length <= budget ? rendered : `${rendered.slice(0, budget - 1)}…`;
    return `${cause.label}: ${fragment}`;
  }).join(separator);
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
      await removeInstalledTemporaryRoot(prepared.temporary);
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
    try {
      await removeInstalledTemporaryRoot(temporary);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "installed artifact preparation and temporary cleanup both failed",
      );
    }
    throw error;
  }
}

type InstalledTemporaryRemovalOptions = Readonly<{
  /** Test-only full argv override; production always uses `/bin/rm` directly. */
  command?: ReadonlyArray<string>;
  timeoutMs?: number;
}>;

type InstalledOwnedRoot =
  | Readonly<{ kind: "temporary"; root: string }>
  | Readonly<{
      kind: "scenario";
      root: string;
      temporaryRoot: string;
      scenario: InstalledHomeUpgradeScenario;
    }>;

/**
 * Portable test seam for the top-level installed-rehearsal root remover. It
 * emits no evidence and never certifies unsafe or incomplete removal.
 */
export async function removeInstalledTemporaryRootForTests(
  root: string,
  options: InstalledTemporaryRemovalOptions = {},
): Promise<void> {
  await removeInstalledTemporaryRoot(root, options);
}

/** Specific non-evidence seam for scenario-root containment and cleanup tests. */
export async function removeInstalledScenarioRootForTests(
  root: string,
  temporaryRoot: string,
  scenario: InstalledHomeUpgradeScenario,
  options: InstalledTemporaryRemovalOptions = {},
): Promise<void> {
  await removeInstalledScenarioRoot(root, temporaryRoot, scenario, options);
}

/**
 * Remove exactly one owned top-level rehearsal root using a fresh bounded OS
 * primitive. Bun 1.2.13 recursive `fs.rm` can partially delete these deep
 * artifact trees and then raise EFAULT, so this boundary deliberately does
 * not retry that primitive. Every failure is fixed-text, never certifies
 * absence, and retains whatever material the external primitive did not
 * remove.
 */
async function removeInstalledTemporaryRoot(
  root: string,
  options: InstalledTemporaryRemovalOptions = {},
): Promise<void> {
  await removeInstalledOwnedRoot({ kind: "temporary", root }, options);
}

async function removeInstalledScenarioRoot(
  root: string,
  temporaryRoot: string,
  scenario: InstalledHomeUpgradeScenario,
  options: InstalledTemporaryRemovalOptions = {},
): Promise<void> {
  await removeInstalledOwnedRoot({ kind: "scenario", root, temporaryRoot, scenario }, options);
}

/** One containment, process-supervision, and absence-proof path for every deep rehearsal tree. */
async function removeInstalledOwnedRoot(
  owned: InstalledOwnedRoot,
  options: InstalledTemporaryRemovalOptions,
): Promise<void> {
  const scope = owned.kind === "temporary" ? "temporary" : "scenario";
  const canonicalRoot = owned.kind === "temporary"
    ? await canonicalInstalledTemporaryRoot(owned.root)
    : await canonicalInstalledScenarioRoot(owned);
  const timeoutMs = options.timeoutMs ?? INSTALLED_TEMPORARY_CLEANUP_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > INSTALLED_TEMPORARY_CLEANUP_TIMEOUT_MS) {
    throw new Error(`installed rehearsal ${scope} cleanup timeout is invalid`);
  }
  const command = options.command ?? ["/bin/rm", "-rf", "--", canonicalRoot];
  if (command.length === 0) {
    throw new Error(`installed rehearsal ${scope} cleanup command is invalid`);
  }
  await runBoundedInstalledRemovalCommand(command, timeoutMs, scope);
  if (await pathStillExists(canonicalRoot, scope)) {
    throw new Error(`installed rehearsal ${scope} cleanup command left the root present`);
  }
}

async function canonicalInstalledTemporaryRoot(root: string): Promise<string> {
  try {
    if (!isAbsolute(root) || root !== resolve(root)) throw new Error("not canonical input");
    const lexicalTemporary = resolve(tmpdir());
    if (dirname(root) !== lexicalTemporary) throw new Error("not a direct temporary child");
    const name = basename(root);
    if (!name.startsWith(INSTALLED_TEMPORARY_PREFIX) || name.length === INSTALLED_TEMPORARY_PREFIX.length) {
      throw new Error("wrong temporary prefix");
    }
    const stat = await lstat(root);
    const uid = process.getuid?.();
    if (!stat.isDirectory() || stat.isSymbolicLink() || uid === undefined || stat.uid !== uid) {
      throw new Error("not an owned directory");
    }
    const [canonicalTemporary, canonicalRoot] = await Promise.all([
      realpath(lexicalTemporary),
      realpath(root),
    ]);
    if (dirname(canonicalRoot) !== canonicalTemporary || basename(canonicalRoot) !== name) {
      throw new Error("physical root escaped temporary directory");
    }
    return canonicalRoot;
  } catch {
    throw new Error("installed rehearsal temporary root is unsafe");
  }
}

async function canonicalInstalledScenarioRoot(
  owned: Extract<InstalledOwnedRoot, { kind: "scenario" }>,
): Promise<string> {
  try {
    if (!SCENARIOS.includes(owned.scenario) || !isAbsolute(owned.root) || owned.root !== resolve(owned.root)) {
      throw new Error("invalid scenario input");
    }
    const canonicalTemporary = await canonicalInstalledTemporaryRoot(owned.temporaryRoot);
    const name = basename(owned.root);
    const prefix = `${owned.scenario}-`;
    if (dirname(owned.root) !== canonicalTemporary || !name.startsWith(prefix) || name.length === prefix.length) {
      throw new Error("not a direct named scenario child");
    }
    const info = await lstat(owned.root);
    const uid = process.getuid?.();
    if (!info.isDirectory() || info.isSymbolicLink() || uid === undefined || info.uid !== uid) {
      throw new Error("not an owned directory");
    }
    const physical = await realpath(owned.root);
    if (physical !== owned.root || dirname(physical) !== canonicalTemporary || basename(physical) !== name) {
      throw new Error("physical scenario root escaped temporary directory");
    }
    return physical;
  } catch {
    throw new Error("installed rehearsal scenario root is unsafe");
  }
}

async function runBoundedInstalledRemovalCommand(
  command: ReadonlyArray<string>,
  timeoutMs: number,
  scope: "temporary" | "scenario",
): Promise<void> {
  let outcome: ReturnType<typeof Bun.spawnSync>;
  try {
    outcome = Bun.spawnSync([...command], {
      stdout: "ignore",
      stderr: "ignore",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
  } catch {
    throw new Error(`installed rehearsal ${scope} cleanup command failed`);
  }
  if (outcome.exitedDueToTimeout) {
    throw new Error(`installed rehearsal ${scope} cleanup command timed out`);
  }
  if (outcome.exitCode !== 0) {
    throw new Error(`installed rehearsal ${scope} cleanup command failed`);
  }
}

async function pathStillExists(path: string, scope: "temporary" | "scenario"): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`installed rehearsal ${scope} cleanup could not verify absence`);
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
  const canonicalDestination = await realpath(destination);
  const tar = gunzipSync(await readFile(archive), { maxOutputLength: MAX_HOME_ARTIFACT_TAR_BYTES });
  const inspected = inspectHomeArtifactTar(tar);
  const validatedTar = join(canonicalDestination, ".validated-artifact.tar");
  await writeFile(validatedTar, tar, { flag: "wx", mode: 0o600 });
  try {
    await runRaw(
      ["/usr/bin/tar", "-xf", validatedTar, "-C", canonicalDestination],
      canonicalDestination,
      process.env,
    );
  } finally {
    await rm(validatedTar, { force: true });
  }
  return await resolveContainedArtifactRootForTests(canonicalDestination, inspected.root);
}

/** Resolve an extracted root against one canonical containment boundary. */
export async function resolveContainedArtifactRootForTests(
  canonicalDestination: string,
  artifactRoot: string,
): Promise<string> {
  const extracted = await realpath(join(canonicalDestination, artifactRoot));
  const contained = relative(canonicalDestination, extracted);
  if (contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
    throw new Error("artifact root escaped extraction directory");
  }
  return extracted;
}

type LiveDevice = Readonly<{ deviceId: string; cookie: string }>;

type ScenarioContext = {
  readonly name: InstalledHomeUpgradeScenario;
  readonly root: string;
  readonly temporaryRoot: string;
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
  runtimeBaseline: FrozenN1StateObservation | null;
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
  const root = await canonicalizeInstalledScenarioRootForTests(
    await mkdtemp(join(prepared.temporary, `${name}-`)),
  );
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
  const rawFixture = await observeFrozenN1State({
    fixtureRoot: prepared.fixtureRoot,
    stateRoot,
  });
  assertFrozenN1State(rawFixture, fixtureManifest);
  const ownerMarkdown = join(vault, "owner-upgrade-canary.md");
  await writeFile(ownerMarkdown, "# Owner upgrade canary\n\nThese bytes must survive the installed upgrade.\n", { flag: "wx" });
  await runRaw(["/usr/bin/git", "add", "owner-upgrade-canary.md"], vault, environment);
  await runRaw([
    "/usr/bin/git", "-c", "user.name=Dome Rehearsal", "-c",
    "user.email=rehearsal@dome.invalid", "commit", "-m", "seed installed upgrade rehearsal",
  ], vault, environment);
  const seedCommit = (await runRaw(["/usr/bin/git", "rev-parse", "HEAD"], vault, environment)).stdout.trim();

  // Frozen 0.1 predates correct nested Home --vault forwarding. Preserve its
  // exact bytes and use the compiler boundary it already supports: cwd vault
  // discovery. Candidate/0.2 nested commands continue to pass --vault.
  const predecessorInstall = predecessorHomeInstallInvocationForTests({
    dome: predecessorDome,
    vault,
    home,
  });
  const installed = await runPredecessorInstallWithin(
    predecessorInstall.command,
    predecessorInstall.cwd,
    environment,
    PREDECESSOR_INSTALL_TIMEOUT_MS,
  );
  const expectedInstall = predecessorInstallExpectation({
    home,
    vault,
    label,
    manifest: prepared.predecessor,
  });
  const classification = classifyPredecessorInstallForTests(installed, expectedInstall);
  await awaitPredecessorInstallForTests({
    classification,
    observe: async (signal) => await observeLatePredecessorReadiness({
      root,
      environment,
      candidateRoot: prepared.candidateRoot,
      expected: expectedInstall,
    }, signal),
  });
  const plist = expectedInstall.plist;

  const context: ScenarioContext = {
    name, root, temporaryRoot: prepared.temporary, home, vault, label, plist, environment, seedCommit, ownerMarkdown,
    fixtureRoot: prepared.fixtureRoot,
    ownerMarkdownSha256: await fileSha256(ownerMarkdown), fixtureManifest,
    runtimeBaseline: null, activeDevice: null, revokedDevice: null, checkpointChild: null,
  };
  context.activeDevice = await pairFreshDevice(context, prepared.predecessorRoot, `${name}-active`);
  context.revokedDevice = await pairFreshDevice(context, prepared.predecessorRoot, `${name}-revoked`);
  await runJson([
    predecessorDome, "devices", "revoke", context.revokedDevice.deviceId,
    "--vault", vault, "--json",
  ], root, environment);
  await assertLiveCredentialTruth(context, prepared.predecessor);
  context.runtimeBaseline = await establishFrozenN1RuntimeBaseline({
    fixtureRoot: context.fixtureRoot,
    stateRoot,
  });
  const completedTick = await readinessTick(context);
  await waitForNextReadinessTick(context, completedTick);
  assertFrozenN1RuntimeProvenance(stateRoot);
  const quiescent = await observeFrozenN1State({
    fixtureRoot: context.fixtureRoot,
    stateRoot,
  });
  assertFrozenN1RuntimeBaseline(quiescent, context.runtimeBaseline);
  await assertFrozenState(context, "n1");
  return context;
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    try { await bootoutAndDrain({ label, vault }); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
    try { await assertPortFree(); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
    if (cleanupFailures.length === 0) {
      try {
        await removeInstalledScenarioRoot(root, prepared.temporary, name);
      } catch (cleanupError) {
        unsafeCleanup();
        throw new AggregateError(
          [error, cleanupError],
          `partial installed rehearsal cleanup failed for ${label}; root retained at ${root}`,
        );
      }
      throw error;
    }
    unsafeCleanup();
    throw new AggregateError([error, ...cleanupFailures], `partial installed rehearsal cleanup failed for ${label}; root retained at ${root}`);
  }
}

/** Capture the physical identity of a fresh private scenario root exactly once. */
export async function canonicalizeInstalledScenarioRootForTests(createdRoot: string): Promise<string> {
  return await realpath(createdRoot);
}

/** Exact compatibility invocation for the frozen pre-fix 0.1 Home CLI. */
export function predecessorHomeInstallInvocationForTests(input: Readonly<{
  dome: string;
  vault: string;
  home: string;
}>): Readonly<{ command: ReadonlyArray<string>; cwd: string }> {
  return Object.freeze({
    command: Object.freeze([
      input.dome,
      "home",
      "install",
      "--env",
      `HOME=${input.home}`,
      "--json",
    ]),
    cwd: input.vault,
  });
}

type PackagedJsonOutcome = Readonly<{
  exitCode: number;
  document: Record<string, unknown>;
}>;

type PredecessorInstallExpectation = Readonly<{
  vault: string;
  label: string;
  plist: string;
  log: string;
  program: string;
  installation: string;
  release: string;
  artifactId: string;
  productVersion: string;
}>;

/** Strict immutable-N-1 compatibility classifier; every other failure stays fatal. */
export function classifyPredecessorInstallForTests(
  outcome: Readonly<{ exitCode: number; document: unknown }>,
  expected: PredecessorInstallExpectation,
): "ready" | "late-readiness" {
  const common = {
    schema: "dome.home.lifecycle/v1",
    action: "install",
    vault: expected.vault,
    label: expected.label,
    plist: expected.plist,
    log: expected.log,
    program: expected.program,
    installation: expected.installation,
    release: expected.release,
    artifactId: expected.artifactId,
    productVersion: expected.productVersion,
    installed: true,
    loaded: true,
    replaced: false,
    releasePublished: true,
  } as const;
  if (outcome.exitCode === 0 && exactShallowRecord(outcome.document, {
    ...common,
    status: "installed",
    ready: true,
    exitCode: 0,
  })) return "ready";
  if (expected.artifactId === FROZEN_PREDECESSOR_ARTIFACT_ID &&
    expected.productVersion === FROZEN_PREDECESSOR_VERSION && outcome.exitCode === 1 &&
    exactShallowRecord(outcome.document, {
      ...common,
      status: "error",
      ready: false,
      exitCode: 1,
      error: `Dome Home did not become ready at http://${HOST}:${PORT}/pair/status`,
    })) return "late-readiness";
  throw new Error("predecessor Home install returned an unsupported lifecycle outcome");
}

/** Run the one bounded late-readiness compatibility arm through an injected strict observer. */
export async function awaitPredecessorInstallForTests(input: Readonly<{
  classification: "ready" | "late-readiness";
  timeoutMs?: number;
  observe(signal: AbortSignal): Promise<boolean>;
}>): Promise<void> {
  if (input.classification === "ready") return;
  const timeoutMs = input.timeoutMs ?? PREDECESSOR_LATE_READINESS_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > PREDECESSOR_LATE_READINESS_TIMEOUT_MS) {
    throw new Error("predecessor late-readiness timeout is invalid");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    while (!controller.signal.aborted) {
      if (await observeBeforeAbort(input.observe, controller.signal)) return;
      await abortableDelay(Math.min(200, timeoutMs), controller.signal);
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  throw new Error("frozen predecessor Home did not reach bounded late readiness");
}

async function observeBeforeAbort(
  observe: (signal: AbortSignal) => Promise<boolean>,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) throw new Error("predecessor late-readiness observation aborted");
  return await new Promise<boolean>((resolvePromise, reject) => {
    const onAbort = (): void => reject(new Error("predecessor late-readiness observation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    void observe(signal).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function exactShallowRecord(value: unknown, expected: Readonly<Record<string, unknown>>): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === Object.keys(expected).length &&
    keys.every((key) => Object.hasOwn(expected, key) && Object.is(record[key], expected[key]));
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("predecessor late-readiness observation aborted");
  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(new Error("predecessor late-readiness observation aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Candidate-observed terminal proof for the selected frozen predecessor. */
export function assertPredecessorReadyObserverForTests(
  outcome: Readonly<{ exitCode: number; document: unknown }>,
  expected: PredecessorInstallExpectation,
): void {
  if (outcome.exitCode !== 0) throw new Error("predecessor ready observer command failed");
  const document = asRecord(outcome.document, "predecessor ready observer");
  assertObjectFields(document, {
    schema: "dome.home.lifecycle/v1",
    action: "status",
    vault: expected.vault,
    label: expected.label,
    plist: expected.plist,
    log: expected.log,
    program: expected.program,
    installation: expected.installation,
    release: expected.release,
    artifactId: expected.artifactId,
    productVersion: expected.productVersion,
    status: "ready",
    installed: true,
    loaded: true,
    ready: true,
    exitCode: 0,
  });
  if (field(objectField(document, "lifecycle"), "state") !== "inactive" ||
    field(objectField(document, "upgrade"), "state") !== "inactive") {
    throw new Error("predecessor ready observer retained lifecycle or upgrade ownership");
  }
}

function predecessorInstallExpectation(input: Readonly<{
  home: string;
  vault: string;
  label: string;
  manifest: HomeArtifactManifest;
}>): PredecessorInstallExpectation {
  const paths = homeInstallationPaths(input.vault, {
    applicationSupportDir: join(input.home, "Library", "Application Support", "Dome", "Home"),
  });
  const release = releaseRoot(paths, input.manifest.artifact.id);
  return Object.freeze({
    vault: input.vault,
    label: input.label,
    plist: join(input.home, "Library", "LaunchAgents", `${input.label}.plist`),
    log: join(input.vault, ".dome", "state", "home.log"),
    program: join(release, "app", "bin", "dome"),
    installation: paths.record,
    release,
    artifactId: input.manifest.artifact.id,
    productVersion: input.manifest.product.version,
  });
}

async function observeLatePredecessorReadiness(input: Readonly<{
  root: string;
  environment: Readonly<Record<string, string | undefined>>;
  candidateRoot: string;
  expected: PredecessorInstallExpectation;
}>, signal: AbortSignal): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(`http://${HOST}:${PORT}/pair/status`, {
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    return false;
  }
  if (!await isHomePairingReadiness(response)) return false;

  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("predecessor ready observer requires a Unix uid");
  const loaded = await runRawAllowFailure([
    "/bin/launchctl", "print", `gui/${uid}/${input.expected.label}`,
  ], input.root, input.environment, signal);
  if (loaded.exitCode !== 0) throw new Error("late-ready predecessor launchd label is not loaded");

  const status = await runJsonOutcome([
    join(input.candidateRoot, "bin", "dome"),
    "home", "status", "--vault", input.expected.vault, "--json",
  ], input.root, input.environment, signal);
  assertPredecessorReadyObserverForTests(status, input.expected);
  return true;
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
  const functionalClosure = installedFunctionalClosureBoundary(context);
  const functionalCanary = await prepareInstalledFunctionalClosure(functionalClosure);
  await runHomePwaChromiumAcceptance({
    baseUrl: `http://${HOST}:${PORT}/`,
    expected: {
      productVersion: prepared.candidate.product.version,
      vaultName: basename(context.vault),
      functionalCanary,
    },
    mintPairingCode: async (deviceName, signal) => await mintChromiumPairingCode(
      context,
      prepared.candidateRoot,
      deviceName,
      signal,
    ),
    revokeDevice: async (deviceName, signal) => await revokeChromiumDevice(
      context,
      prepared.candidateRoot,
      deviceName,
      signal,
    ),
    assertLogicalCapture: async (text, captureId, signal) =>
      await assertChromiumLogicalCapture(context, text, captureId, signal),
    assertTaskSettlement: async (commit, signal) =>
      await assertInstalledFunctionalClosure(functionalClosure, functionalCanary, commit, signal),
  });
  await runHomePwaUpdateRehearsal({
    staticRoot: join(prepared.candidateRoot, "app", "pwa", "dist"),
  });
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
    stringField(objectField(receipt, "transaction"), "operationId") !==
      stringField(objectField(recovered, "transaction"), "operationId")) {
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
  await rm(stringField(objectField(journal, "old"), "releasePath"), { recursive: true, force: true });
  await damageSnapshot(active, journal);
  const candidateRelease = stringField(objectField(journal, "candidate"), "releasePath");
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
  const deviceId = pairedDeviceIdForTests(await response.json());
  const cookie = response.headers.getSetCookie().map((value) => value.split(";", 1)[0]!).join("; ");
  if (cookie === "") throw new Error("fresh device pairing returned no credential cookies");
  return Object.freeze({ deviceId, cookie });
}

function installedFunctionalClosureBoundary(context: ScenarioContext): FunctionalClosureBoundary {
  return Object.freeze({
    vaultPath: context.vault,
    git: async (args, signal) => await runRawAllowFailure(
      ["/usr/bin/git", ...args], context.vault, context.environment, signal,
    ),
    readHome: async (pathname, signal) => {
      if (context.activeDevice === null) throw new Error("functional acceptance requires an active host device");
      try {
        const response = await fetch(`http://${HOST}:${PORT}${pathname}`, {
          headers: { cookie: context.activeDevice.cookie },
          signal,
        });
        if (response.status !== 200) throw new Error(`functional acceptance read failed (${response.status})`);
        return asRecord(await readFunctionalHomeJson(response, signal), "functional acceptance document");
      } catch (error) {
        if (signal.aborted) throw new Error("functional acceptance Home read exceeded its bound", { cause: error });
        throw error;
      }
    },
  });
}

async function readFunctionalHomeJson(response: Response, signal: AbortSignal): Promise<unknown> {
  return await new Promise<unknown>((resolveBody, rejectBody) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      rejectBody(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void response.json().then(
      (body) => { signal.removeEventListener("abort", onAbort); resolveBody(body); },
      (error) => { signal.removeEventListener("abort", onAbort); rejectBody(error); },
    );
  });
}

async function mintChromiumPairingCode(
  context: ScenarioContext,
  artifactRoot: string,
  deviceName: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await runJson([
    join(artifactRoot, "bin", "dome"), "devices", "pair",
    "--name", deviceName, "--grant", "read,capture,resolve",
    "--vault", context.vault, "--json",
  ], context.root, context.environment, false, signal);
  assertObjectFields(result, {
    schema: "dome.devices.pairing-grant/v1",
    status: "minted",
    deviceName,
  });
  return stringField(result, "pairingCode");
}

async function revokeChromiumDevice(
  context: ScenarioContext,
  artifactRoot: string,
  deviceName: string,
  signal: AbortSignal,
): Promise<void> {
  const dome = join(artifactRoot, "bin", "dome");
  const listed = await runJson([
    dome, "devices", "list", "--vault", context.vault, "--json",
  ], context.root, context.environment, false, signal);
  const devices = arrayField(listed, "devices")
    .map((device) => asRecord(device, "device"))
    .filter((device) => field(device, "name") === deviceName && field(device, "revokedAt") === null);
  if (devices.length !== 1) throw new Error("Chromium acceptance device identity is not unique");
  const revoked = await runJson([
    dome, "devices", "revoke", stringField(devices[0]!, "id"),
    "--vault", context.vault, "--json",
  ], context.root, context.environment, false, signal);
  assertObjectFields(revoked, { schema: "dome.devices.revoke/v1", status: "revoked" });
}

async function assertChromiumLogicalCapture(
  context: ScenarioContext,
  text: string,
  captureId: string,
  signal: AbortSignal,
): Promise<void> {
  const revision = (await runRaw([
    "/usr/bin/git", "rev-parse", "--verify", "HEAD^{commit}",
  ], context.vault, context.environment, signal)).stdout.trim();
  const result = await runRawAllowFailure([
    "/usr/bin/git", "grep", "-l", "-z", "--fixed-strings", "-e", text, revision, "--",
  ], context.vault, context.environment, signal);
  signal.throwIfAborted();
  if (result.exitCode !== 0 && !(result.exitCode === 1 && result.stdout === "" && result.stderr === "")) {
    throw new Error("Chromium offline capture revision search failed");
  }
  const paths = parseHomePwaRevisionGrepPathsForTests(result.stdout, revision);
  if (paths.length !== 1) throw new Error("Chromium offline capture did not reconcile exactly once");
  const body = (await runRaw([
    "/usr/bin/git", "show", `${revision}:${paths[0]!}`,
  ], context.vault, context.environment, signal)).stdout;
  signal.throwIfAborted();
  if (body.split(text).length !== 2 ||
    !hasExactHomePwaCaptureIdentityForTests(body, captureId)) {
    throw new Error("Chromium offline capture identity is missing or duplicated");
  }
}

/** Accept the capture scalar before or after canonical YAML quote removal. */
export function hasExactHomePwaCaptureIdentityForTests(body: string, captureId: string): boolean {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(captureId)) {
    return false;
  }
  const lines = body.split(/\r?\n/);
  if (lines[0] !== "---") return false;
  const closing = lines.indexOf("---", 1);
  if (closing < 2) return false;
  const values = lines.slice(1, closing)
    .filter((line) => line.startsWith("capture_id: "))
    .map((line) => line.slice("capture_id: ".length));
  return values.length === 1 && (values[0] === captureId || values[0] === JSON.stringify(captureId));
}

/** Parse `git grep -l -z <revision>` without confusing its revision prefix for a path. */
export function parseHomePwaRevisionGrepPathsForTests(
  output: string,
  revision: string,
): readonly string[] {
  if (!/^[0-9a-f]{40,64}$/.test(revision)) {
    throw new Error("Chromium offline capture revision is invalid");
  }
  if (output === "") return Object.freeze([]);
  if (!output.endsWith("\0")) {
    throw new Error("Chromium offline capture path inventory is malformed");
  }
  const prefix = `${revision}:`;
  const records = output.slice(0, -1).split("\0");
  return Object.freeze(records.map((record) => {
    if (!record.startsWith(prefix) || record.length === prefix.length) {
      throw new Error("Chromium offline capture path inventory is malformed");
    }
    return record.slice(prefix.length);
  }));
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
  const activeBody = active.status === 200 ? asRecord(await active.json(), "active readiness") : null;
  const revokedBody = revoked.status === 401 ? asRecord(await revoked.json(), "revoked readiness error") : null;
  if (active.status !== 200 || activeBody === null ||
    field(activeBody, "schema") !== "dome.product.readiness/v1" ||
    field(activeBody, "artifactId") !== expected.artifact.id ||
    field(activeBody, "productVersion") !== expected.product.version ||
    field(activeBody, "writesAdmitted") !== true ||
    field(objectField(activeBody, "host"), "state") !== "ready" ||
    field(objectField(activeBody, "device"), "id") !== context.activeDevice.deviceId ||
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
  if (context.runtimeBaseline === null) {
    throw new Error("frozen N-1 runtime baseline was not captured");
  }
  const observation = await observeFrozenN1State({
    fixtureRoot: context.fixtureRoot,
    stateRoot: join(context.vault, ".dome", "state"),
  });
  assertFrozenN1RuntimeBaseline(observation, context.runtimeBaseline);
  for (const store of observation.stores) {
    const expected = expectedSchema === "n1"
      ? context.fixtureManifest.stores.find((entry) => entry.name === store.name)?.schemaHash
      : HOME_STORE_MIGRATIONS.find((entry) => entry.name === `${store.name}.db`)?.currentSchemaHash;
    if (expected === undefined || store.schemaHash !== expected) {
      throw new Error(`unexpected ${expectedSchema} schema hash: ${store.name}`);
    }
  }
}

async function readinessTick(context: ScenarioContext): Promise<string> {
  if (context.activeDevice === null) throw new Error("readiness tick requires an active device");
  const response = await fetch(`http://${HOST}:${PORT}/readyz`, {
    headers: { cookie: context.activeDevice.cookie },
  });
  if (response.status !== 200) throw new Error(`readiness tick unavailable (${response.status})`);
  const body = asRecord(await response.json(), "readiness tick");
  return stringField(objectField(body, "adoption"), "lastSuccessAt");
}

async function waitForNextReadinessTick(context: ScenarioContext, previous: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await readinessTick(context);
    if (current !== previous) return;
    await Bun.sleep(100);
  }
  throw new Error("frozen N-1 Product Host did not complete a second runtime tick");
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
    "let coordinationCause = null;",
    `const renderCoordinationError = ${renderInstalledCoordinationErrorForTests.toString()};`,
    `const imported = await import(${JSON.stringify(moduleUrl)});`,
    "const result = await imported.manageHomeUpgrade(",
    `  { action: "run", vaultPath: ${JSON.stringify(context.vault)} },`,
    "  {",
    `    artifactRoot: ${JSON.stringify(candidateRoot)},`,
    "    onCoordinationError: (error) => { coordinationCause = renderCoordinationError(error); },",
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
    "throw new Error(`diagnostic checkpoint was not reached: ${JSON.stringify({ result, coordinationCause })}`);",
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
  phase: RetainedCheckpointPhase,
): Promise<Record<string, unknown>> {
  const paths = homeInstallationPaths(context.vault, {
    applicationSupportDir: join(context.home, "Library", "Application Support", "Dome", "Home"),
  });
  const active = join(paths.installations, "upgrade", "active");
  const journal = asRecord(JSON.parse(await readFile(join(active, "journal.json"), "utf8")), "journal");
  if (field(journal, "phase") !== phase) throw new Error(`retained journal did not reach ${phase}`);
  const transactionId = stringField(journal, "transactionId");
  const selection = objectField(journal, "selection");
  const candidate = objectField(selection, "candidate");
  await assertFileSha(paths.record, stringField(objectField(candidate, "installation"), "sha256"));
  await assertFileSha(context.plist, stringField(objectField(candidate, "plist"), "sha256"));

  const status = await runJson([
    join(context.home, "Library", "Application Support", "Dome", "Home", "releases",
      stringField(objectField(journal, "candidate"), "artifactId"), "bin", "dome"),
    "home", "status", "--vault", context.vault, "--json",
  ], context.root, context.environment, true);
  if (!retainedCheckpointOwnershipMatchesForTests(status, phase, transactionId)) {
    throw new Error(
      `checkpoint crash did not retain lifecycle and upgrade ownership: ${retainedCheckpointOwnershipSummaryForTests(status)}`,
    );
  }
  return journal;
}

async function damageSnapshot(active: string, journal: Record<string, unknown>): Promise<void> {
  const snapshot = objectField(journal, "snapshot");
  const inventory = arrayField(snapshot, "inventory").map((entry) => asRecord(entry, "snapshot entry"))
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
  if (field(objectField(status, "lifecycle"), "state") !== "inactive" ||
    field(objectField(status, "upgrade"), "state") !== "inactive") {
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
  let assetPath: string;
  try {
    assetPath = parsePwaShellHashedAssetPath(html);
  } catch {
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

async function bootoutAndDrain(context: Pick<ScenarioContext, "label" | "vault">): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("launchd drain requires a Unix uid");
  const target = `gui/${uid}/${context.label}`;
  const ownershipPath = externalProductHostLockPath(await realpath(context.vault));
  const result = await runRawAllowFailure(["/bin/launchctl", "bootout", target], process.cwd(), process.env);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const printed = await runRawAllowFailure(["/bin/launchctl", "print", target], process.cwd(), process.env);
    const ownership = await inspectExclusiveFileLock(ownershipPath);
    const state = classifyInstalledHomeDrainForTests(
      result.exitCode,
      printed.exitCode,
      await isPortFree(),
      ownership.kind !== "possibly-live",
    );
    if (state === "drained") return;
    await Bun.sleep(100);
  }
  throw new Error(`launchd label, ${HOST}:${PORT}, or Product Host ownership did not drain: ${context.label}`);
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
    await removeInstalledScenarioRoot(context.root, context.temporaryRoot, context.name);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `installed rehearsal cleanup failed for ${context.label}; roots retained`);
  }
}

async function assertPortFree(): Promise<void> {
  if (await isPortFree()) return;
  throw new Error(`installed rehearsal requires ${HOST}:${PORT} to be unbound: address remains in use`);
}

async function isPortFree(): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolvePromise(false);
      else reject(error);
    });
    server.listen(PORT, HOST, () => server.close((error) => {
      if (error === undefined) resolvePromise(true);
      else reject(error);
    }));
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
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const result = await runRawAllowFailure(command, cwd, environment, signal);
  if (!allowFailure && result.exitCode !== 0) {
    throw new Error(`${renderCommand(command)} failed (${result.exitCode})\n${result.stdout}${result.stderr}`);
  }
  let value: unknown;
  try { value = JSON.parse(result.stdout); }
  catch { throw new Error(`${renderCommand(command)} returned non-JSON output\n${result.stdout}${result.stderr}`); }
  return asRecord(value, "packaged command result");
}

async function runJsonOutcome(
  command: ReadonlyArray<string>,
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<PackagedJsonOutcome> {
  const result = await runRawAllowFailure(command, cwd, environment, signal);
  let value: unknown;
  try { value = JSON.parse(result.stdout); }
  catch { throw new Error(`${renderCommand(command)} returned non-JSON output\n${result.stdout}${result.stderr}`); }
  return Object.freeze({
    exitCode: result.exitCode,
    document: asRecord(value, "packaged command result"),
  });
}

async function runPredecessorInstallWithin(
  command: ReadonlyArray<string>,
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
): Promise<PackagedJsonOutcome> {
  const controller = new AbortController();
  let expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await runJsonOutcome(command, cwd, environment, controller.signal);
  } catch (error) {
    // runRawAllowFailure has already killed and drained the packaged child
    // before control returns here. Preserve that process bound while naming
    // the owning predecessor-install phase instead of leaking a Chromium
    // adapter implementation detail.
    if (expired) throw new Error("frozen predecessor Home install command timed out");
    throw error;
  }
  finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

/** Portable timeout-classification seam; launches no Home and emits no evidence. */
export async function exercisePredecessorInstallTimeoutForTests(
  command: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<void> {
  await runPredecessorInstallWithin(command, process.cwd(), process.env, timeoutMs);
}

async function runRaw(
  command: ReadonlyArray<string>,
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  const result = await runRawAllowFailure(command, cwd, environment, signal);
  if (result.exitCode !== 0) {
    throw new Error(`${renderCommand(command)} failed (${result.exitCode})\n${result.stdout}${result.stderr}`);
  }
  return result;
}

async function runRawAllowFailure(
  command: ReadonlyArray<string>,
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (abortSignalIsSet(signal)) throw new Error("installed Chromium acceptance command aborted");
  const child = Bun.spawn([...command], {
    cwd,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
    ...(signal === undefined ? {} : { signal, killSignal: "SIGKILL" as const }),
  });
  const settled = await Promise.allSettled([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (abortSignalIsSet(signal)) throw new Error("installed Chromium acceptance command aborted");
  const [exitCode, stdout, stderr] = settled;
  if (exitCode?.status !== "fulfilled" || stdout?.status !== "fulfilled" || stderr?.status !== "fulfilled") {
    throw new Error("installed command output did not settle");
  }
  return { exitCode: exitCode.value, stdout: stdout.value, stderr: stderr.value };
}

function abortSignalIsSet(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Portable abort seam for the installed Chromium adapter; emits no installed evidence. */
export async function exerciseAbortableInstalledCommandForTests(signal: AbortSignal): Promise<void> {
  await runRawAllowFailure(
    [process.execPath, "-e", "await Bun.sleep(60_000)"],
    process.cwd(),
    process.env,
    signal,
  );
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

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function objectField(value: Record<string, unknown>, name: string): Record<string, unknown> {
  return asRecord(value[name], name);
}

/** Portable response-shape assertion; it emits no installed evidence. */
export function pairedDeviceIdForTests(value: unknown): string {
  const response = asRecord(value, "pair response");
  return stringField(objectField(response, "device"), "id");
}

function field(value: Record<string, unknown>, name: string): unknown {
  return value[name];
}

function stringField(value: Record<string, unknown>, name: string): string {
  const candidate = value[name];
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
