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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { compareStrings } from "../src/core/compare";
import { publishDirectoryExclusive } from "../src/platform/exclusive-rename";
import {
  HOME_ARTIFACT_SCHEMA,
  HOME_ARTIFACT_TARGET,
  HOME_WRITER_BARRIER_PROTOCOL,
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
import { HOME_DURABLE_STATE_PROTOCOL, HOME_STORE_MIGRATIONS } from "../src/product-host/home-store-migrations";
import {
  assertInstalledHomeUpgradeHostPreconditions,
  rehearseInstalledHomeUpgrade,
  type InstalledHomeUpgradeRehearsalResult,
} from "./home-installed-upgrade-rehearsal";
import { reconstructHomePredecessorArtifact } from "./home-predecessor-artifact";
import { readFrozenN1Manifest } from "../tests/fixtures/home-upgrade/n-1/freeze-n1";

export {
  inspectHomeArtifactTar,
  MAX_HOME_ARTIFACT_TAR_BYTES,
  type HomeArtifactTarEntry,
} from "./home-artifact-tar";

export {
  HOME_ARTIFACT_SCHEMA,
  HOME_ARTIFACT_TARGET,
  HOME_WRITER_BARRIER_PROTOCOL,
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
const ACTIVATION_EVIDENCE_SUFFIX = ".installed-upgrade-evidence.json";
const ACTIVATION_SCENARIOS = Object.freeze([
  "ready-success",
  "stopped-precommit-crash",
  "committed-exact-repair",
] as const);
const HOME_ARTIFACT_RELEASE_CLAIM = Object.freeze({
  version: "0.2.0",
  upgradeSupported: true,
} as const);

export function homeArtifactReleaseClaimForTests(): typeof HOME_ARTIFACT_RELEASE_CLAIM {
  return HOME_ARTIFACT_RELEASE_CLAIM;
}

type BuildOptions = {
  readonly repoRoot?: string;
  readonly outputDir?: string;
};

export type HomeArtifactCandidatePaths = Readonly<{
  artifactName: string;
  archiveName: string;
  directory: string;
  archive: string;
}>;

type CandidatePublisher = (source: string, target: string) => Promise<void>;

type CandidateParent = Readonly<{
  lexical: string;
  canonical: string;
  device: number;
  inode: number;
}>;

/**
 * Assemble and gate a complete release candidate before exposing any final
 * output. The output directory is the transaction unit: publishing its two
 * children separately could expose an expanded artifact without its archive,
 * or vice versa.
 */
export async function stageAndPublishHomeArtifactCandidate(input: Readonly<{
  outputDir: string;
  artifactName: string;
  forbiddenStagingRoots?: ReadonlyArray<string>;
  assemble: (candidate: HomeArtifactCandidatePaths) => Promise<void>;
  verifyArtifact: (candidate: HomeArtifactCandidatePaths) => Promise<void>;
  rehearseArchive: (candidate: HomeArtifactCandidatePaths) => Promise<void>;
}>, publish: CandidatePublisher = async (source, target) => {
  await publishDirectoryExclusive({ source, target });
}): Promise<HomeArtifactCandidatePaths> {
  if (input.artifactName === "" || basename(input.artifactName) !== input.artifactName ||
    input.artifactName === "." || input.artifactName === "..") {
    throw new Error(`invalid Home artifact name: ${input.artifactName}`);
  }
  const requestedOutput = resolve(input.outputDir);
  await assertOutputTargetAbsent(requestedOutput);
  await assertAllowedStagingParent(dirname(requestedOutput), input.forbiddenStagingRoots ?? []);
  const parent = await prepareCandidateParent(dirname(requestedOutput));
  const outputDir = join(parent.canonical, basename(requestedOutput));
  await assertOutputTargetAbsent(outputDir);
  await assertAllowedStagingParent(parent.canonical, input.forbiddenStagingRoots ?? []);

  const candidateOutput = await mkdtemp(join(parent.canonical, ".dome-home-candidate-"));
  const candidateInfo = await lstat(candidateOutput);
  const paths: HomeArtifactCandidatePaths = Object.freeze({
    artifactName: input.artifactName,
    archiveName: `${input.artifactName}.tar.gz`,
    directory: join(candidateOutput, input.artifactName),
    archive: join(candidateOutput, `${input.artifactName}.tar.gz`),
  });
  let published = false;
  try {
    await input.assemble(paths);
    await input.verifyArtifact(paths);
    await input.rehearseArchive(paths);
    await assertCandidateParentUnchanged(parent);
    await publish(candidateOutput, outputDir);
    published = true;
    return Object.freeze({
      artifactName: paths.artifactName,
      archiveName: paths.archiveName,
      directory: join(outputDir, paths.artifactName),
      archive: join(outputDir, paths.archiveName),
    });
  } finally {
    if (!published) await removeOwnedCandidate(candidateOutput, candidateInfo.dev, candidateInfo.ino);
  }
}

async function prepareCandidateParent(parentPath: string): Promise<CandidateParent> {
  await mkdir(parentPath, { recursive: true });
  const info = await lstat(parentPath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Home artifact output parent must be a direct non-symlink directory: ${parentPath}`);
  }
  const canonical = await realpath(parentPath);
  const canonicalInfo = await lstat(canonical);
  if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink() ||
    canonicalInfo.dev !== info.dev || canonicalInfo.ino !== info.ino) {
    throw new Error(`Home artifact output parent identity is inconsistent: ${parentPath}`);
  }
  return Object.freeze({ lexical: parentPath, canonical, device: info.dev, inode: info.ino });
}

async function assertCandidateParentUnchanged(parent: CandidateParent): Promise<void> {
  const info = await lstat(parent.lexical);
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== parent.device || info.ino !== parent.inode ||
    await realpath(parent.lexical) !== parent.canonical) {
    throw new Error(`Home artifact output parent changed during candidate assembly: ${parent.lexical}`);
  }
}

async function assertAllowedStagingParent(parent: string, forbiddenRoots: ReadonlyArray<string>): Promise<void> {
  const canonicalParent = await canonicalizePotentialPath(parent);
  for (const rootInput of forbiddenRoots) {
    const canonicalRoot = await canonicalizePotentialPath(rootInput);
    if (pathContains(canonicalRoot, canonicalParent)) {
      throw new Error(`Home artifact output parent is inside copied source tree: ${canonicalRoot}`);
    }
  }
}

async function canonicalizePotentialPath(pathInput: string): Promise<string> {
  let cursor = resolve(pathInput);
  const suffix: string[] = [];
  while (true) {
    try { return join(await realpath(cursor), ...suffix); }
    catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`Home artifact path has no existing ancestor: ${pathInput}`);
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
}

function pathContains(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function removeOwnedCandidate(path: string, device: number, inode: number): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== device || info.ino !== inode) return;
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

async function assertOutputTargetAbsent(outputDir: string): Promise<void> {
  try {
    const info = await lstat(outputDir);
    const kind = info.isSymbolicLink() ? "symbolic link"
      : info.isDirectory() ? "directory"
      : info.isFile() ? "file"
      : "filesystem entry";
    throw new Error(`Home artifact output path already exists as a ${kind}: ${outputDir}`);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function buildHomeArtifact(options: BuildOptions = {}): Promise<{
  readonly archive: string;
  readonly archiveSha256: string;
  readonly directory: string;
  readonly evidence: string;
  readonly evidenceSha256: string;
  readonly manifest: HomeArtifactManifest;
}> {
  const repoRoot = resolve(options.repoRoot ?? REPO_ROOT);
  const outputDir = resolve(options.outputDir ?? join(repoRoot, "dist"));
  const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
    readonly version: string;
  };
  if (pkg.version !== HOME_ARTIFACT_RELEASE_CLAIM.version) {
    throw new Error(
      `Dome Home activation builder requires package version ${HOME_ARTIFACT_RELEASE_CLAIM.version}, got ${pkg.version}`,
    );
  }

  const dirty = (await run(["git", "status", "--porcelain", "--untracked-files=all"], repoRoot)).stdout.trim();
  if (dirty !== "") {
    throw new Error("Dome Home artifacts require a clean git worktree so build.gitCommit identifies their source");
  }
  const sourceHead = (await run(["git", "rev-parse", "HEAD"], repoRoot)).stdout.trim();
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(`Dome Home v1 artifact must be built on darwin-arm64, got ${process.platform}-${process.arch}`);
  }
  await assertInstalledHomeUpgradeHostPreconditions();
  const artifactName = `dome-home-${pkg.version}-darwin-arm64`;
  let candidateMetadata: Readonly<{
    manifest: HomeArtifactManifest;
    identity: HomeArtifactActivationIdentityBinding["candidate"];
  }> | undefined;
  let activationReceipt: Readonly<{ evidenceSha256: string }> | undefined;
  const candidate = await stageAndPublishHomeArtifactCandidate({
    outputDir,
    artifactName,
    forbiddenStagingRoots: [
      join(repoRoot, "src"),
      join(repoRoot, "assets"),
      join(repoRoot, "bin"),
      join(repoRoot, "contracts"),
      join(repoRoot, "pwa", "dist"),
    ],
    assemble: async ({ directory, archive }) => {
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
        await run([runtimePath, "install", "--frozen-lockfile"], repoRoot);
        await run([runtimePath, "install", "--frozen-lockfile"], join(repoRoot, "pwa"));
        await run([runtimePath, "run", "build"], join(repoRoot, "pwa"));
        const pwaDist = join(repoRoot, "pwa", "dist");
        if (!existsSync(join(pwaDist, "index.html"))) {
          throw new Error("PWA build is missing pwa/dist/index.html");
        }
        await assertSourceSnapshot(repoRoot, sourceHead, dirname(directory));

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
        await assertSourceSnapshot(repoRoot, sourceHead, dirname(directory));
        const manifest = await writeArtifactMetadataForRelease(directory, pkg.version, sourceHead);
        await writeFile(
          archive,
          gzipSync(await createDeterministicTar(directory, basename(directory)), { level: 9 }),
        );
        candidateMetadata = Object.freeze({
          manifest,
          identity: await captureCandidateActivationIdentity({ directory, archive, manifest }),
        });
      } finally {
        await Promise.all([
          rm(downloadedRuntime.temporary, { recursive: true, force: true }),
          rm(downloadedAge.temporary, { recursive: true, force: true }),
        ]);
      }
    },
    verifyArtifact: async ({ directory }) => { await verifyHomeArtifact(directory); },
    rehearseArchive: async ({ directory, archive }) => {
      await rehearseHomeArtifact(archive);
      if (candidateMetadata === undefined) throw new Error("Home artifact candidate metadata was not assembled");
      activationReceipt = await activateHomeArtifactCandidate({
        repoRoot,
        sourceHead,
        directory,
        archive,
        expectedCandidate: candidateMetadata.identity,
      });
    },
  });
  if (candidateMetadata === undefined || activationReceipt === undefined) {
    throw new Error("Home artifact activation evidence was not assembled");
  }
  const evidence = join(dirname(candidate.archive), `${artifactName}${ACTIVATION_EVIDENCE_SUFFIX}`);
  return {
    archive: candidate.archive,
    archiveSha256: candidateMetadata.identity.archiveSha256,
    directory: candidate.directory,
    evidence,
    evidenceSha256: activationReceipt.evidenceSha256,
    manifest: candidateMetadata.manifest,
  };
}

export type HomeArtifactActivationIdentityBinding = Readonly<{
  predecessor: Readonly<{
    artifactId: string;
    version: string;
    buildCommit: string;
    archiveSha256: string;
    manifestSha256: string;
  }>;
  candidate: Readonly<{
    artifactId: string;
    version: string;
    buildCommit: string;
    archiveSha256: string;
    manifestSha256: string;
  }>;
  fixture: Readonly<{
    releaseId: string;
    sourceCommit: string;
    canaryDigest: string;
  }>;
}>;

type ActivationSequenceOperations<TPredecessor, TInstalled, TBound, TReceipt> = Readonly<{
  reconstructPredecessor(): Promise<TPredecessor>;
  runInstalledGate(predecessor: TPredecessor): Promise<TInstalled>;
  bindIdentity(predecessor: TPredecessor, installed: TInstalled): Promise<TBound>;
  writeReceipt(bound: TBound): Promise<TReceipt>;
  reproveCandidate(bound: TBound, receipt: TReceipt): Promise<void>;
  reproveSource(): Promise<void>;
  cleanup(predecessor: TPredecessor | null): Promise<void>;
}>;

async function runActivationSequence<TPredecessor, TInstalled, TBound, TReceipt>(
  operations: ActivationSequenceOperations<TPredecessor, TInstalled, TBound, TReceipt>,
): Promise<TReceipt> {
  let predecessor: TPredecessor | null = null;
  try {
    predecessor = await operations.reconstructPredecessor();
    const installed = await operations.runInstalledGate(predecessor);
    const bound = await operations.bindIdentity(predecessor, installed);
    const receipt = await operations.writeReceipt(bound);
    await operations.reproveCandidate(bound, receipt);
    await operations.reproveSource();
    return receipt;
  } finally {
    await operations.cleanup(predecessor);
  }
}

/** Portable ordering seam. It cannot construct or return installed evidence. */
export async function exerciseHomeArtifactActivationForTests(operations: Readonly<{
  admitCandidate(): Promise<void>;
  reconstructPredecessor(): Promise<void>;
  runInstalledGate(): Promise<void>;
  bindIdentity(): Promise<void>;
  writeReceipt(): Promise<void>;
  reproveCandidate(): Promise<void>;
  reproveSource(): Promise<void>;
  cleanup(): Promise<void>;
  reproveFinalSource(): Promise<void>;
  reproveFinalReceipt(): Promise<void>;
}>): Promise<Readonly<{ evidence: false }>> {
  await operations.admitCandidate();
  await runActivationSequence({
    reconstructPredecessor: operations.reconstructPredecessor,
    runInstalledGate: operations.runInstalledGate,
    bindIdentity: operations.bindIdentity,
    writeReceipt: operations.writeReceipt,
    reproveCandidate: operations.reproveCandidate,
    reproveSource: operations.reproveSource,
    cleanup: async () => { await operations.cleanup(); },
  });
  await operations.reproveFinalSource();
  await operations.reproveFinalReceipt();
  return Object.freeze({ evidence: false });
}

/** Schema-free identity comparison used by the real gate and portable tests. */
export function assertHomeArtifactActivationIdentityBindingForTests(
  expected: HomeArtifactActivationIdentityBinding,
  observed: HomeArtifactActivationIdentityBinding,
): void {
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error("installed Home upgrade evidence identity does not match the staged release");
  }
}

async function activateHomeArtifactCandidate(input: Readonly<{
  repoRoot: string;
  sourceHead: string;
  directory: string;
  archive: string;
  expectedCandidate: HomeArtifactActivationIdentityBinding["candidate"];
}>): Promise<Readonly<{ evidenceSha256: string }>> {
  const artifactName = basename(input.directory);
  const stagingOutput = dirname(input.directory);
  const predecessorOutput = join(stagingOutput, ".installed-upgrade-predecessor");
  const evidencePath = join(stagingOutput, `${artifactName}${ACTIVATION_EVIDENCE_SUFFIX}`);
  const frozenFixtureRoot = join(
    input.repoRoot,
    "tests", "fixtures", "home-upgrade", "n-1", "0.1.0-eb644dc2",
  );
  await assertOutputTargetAbsent(predecessorOutput);
  await assertOutputTargetAbsent(evidencePath);
  assertCandidateActivationIdentity(
    input.expectedCandidate,
    await observeCandidateActivationIdentity(input),
    "staged candidate changed after ordinary archive rehearsal",
  );

  type Predecessor = Awaited<ReturnType<typeof reconstructHomePredecessorArtifact>> & Readonly<{
    fixture: Awaited<ReturnType<typeof readFrozenN1Manifest>>;
  }>;
  type Bound = Readonly<{
    evidence: InstalledHomeUpgradeRehearsalResult;
    binding: HomeArtifactActivationIdentityBinding;
  }>;
  type Receipt = Readonly<{ evidenceSha256: string }>;

  const receipt = await runActivationSequence<Predecessor, InstalledHomeUpgradeRehearsalResult, Bound, Receipt>({
    reconstructPredecessor: async () => {
      const fixture = await readFrozenN1Manifest(frozenFixtureRoot);
      const predecessor = await reconstructHomePredecessorArtifact({
        repoRoot: input.repoRoot,
        outputDir: predecessorOutput,
      });
      return Object.freeze({ ...predecessor, fixture });
    },
    runInstalledGate: async (predecessor) => await rehearseInstalledHomeUpgrade({
      predecessorArchive: predecessor.archive,
      candidateArchive: input.archive,
      frozenFixtureRoot,
    }),
    bindIdentity: async (predecessor, evidence) => {
      assertInstalledEvidenceEnvelope(evidence);
      const binding = expectedCandidateActivationBinding(input.expectedCandidate, predecessor);
      assertHomeArtifactActivationIdentityBindingForTests(binding, bindingFromInstalledEvidence(evidence));
      return Object.freeze({ evidence, binding });
    },
    writeReceipt: async (bound) => {
      const bytes = Buffer.from(`${JSON.stringify(bound.evidence, null, 2)}\n`);
      await writeFile(evidencePath, bytes, { flag: "wx", mode: 0o644 });
      return Object.freeze({ evidenceSha256: sha256(bytes) });
    },
    reproveCandidate: async (_bound, written) => {
      const observed = await observeCandidateActivationIdentity(input);
      assertCandidateActivationIdentity(
        input.expectedCandidate,
        observed,
        "staged candidate changed after installed Home upgrade rehearsal",
      );
      if (sha256(await readFile(evidencePath)) !== written.evidenceSha256) {
        throw new Error("installed Home upgrade evidence receipt changed after write");
      }
    },
    reproveSource: async () => {
      await assertSourceSnapshot(input.repoRoot, input.sourceHead, stagingOutput);
    },
    cleanup: async () => {
      await rm(predecessorOutput, { recursive: true, force: true });
    },
  });
  await assertPathAbsent(predecessorOutput, "private predecessor reconstruction remained before publication");
  await assertSourceSnapshot(input.repoRoot, input.sourceHead, stagingOutput);
  const evidenceSha256 = sha256(await readFile(evidencePath));
  if (evidenceSha256 !== receipt.evidenceSha256) {
    throw new Error("installed Home upgrade evidence receipt changed after final source proof");
  }
  return Object.freeze({ evidenceSha256 });
}

function expectedCandidateActivationBinding(
  candidate: HomeArtifactActivationIdentityBinding["candidate"],
  predecessor: Awaited<ReturnType<typeof reconstructHomePredecessorArtifact>> & Readonly<{
    fixture: Awaited<ReturnType<typeof readFrozenN1Manifest>>;
  }>,
): HomeArtifactActivationIdentityBinding {
  return Object.freeze({
    predecessor: Object.freeze({
      artifactId: predecessor.receipt.manifest.artifactId,
      version: predecessor.receipt.manifest.productVersion,
      buildCommit: predecessor.receipt.manifest.buildCommit,
      archiveSha256: predecessor.receipt.archive.sha256,
      manifestSha256: predecessor.receipt.manifest.sha256,
    }),
    candidate,
    fixture: Object.freeze({
      releaseId: predecessor.fixture.releaseId,
      sourceCommit: predecessor.fixture.sourceCommit,
      canaryDigest: predecessor.fixture.canaryDigest,
    }),
  });
}

async function observeCandidateActivationIdentity(
  input: Readonly<{
    sourceHead: string;
    directory: string;
    archive: string;
  }>,
): Promise<HomeArtifactActivationIdentityBinding["candidate"]> {
  const archiveSha256 = sha256(await readFile(input.archive));
  const verified = await verifyHomeArtifact(input.directory);
  const manifestSha256 = sha256(await readFile(join(input.directory, "manifest.json")));
  if (verified.build.gitCommit !== input.sourceHead) {
    throw new Error("expanded staged candidate identity changed before publication");
  }
  return Object.freeze({
    artifactId: verified.artifact.id,
    version: verified.product.version,
    buildCommit: verified.build.gitCommit,
    archiveSha256,
    manifestSha256,
  });
}

async function captureCandidateActivationIdentity(input: Readonly<{
  directory: string;
  archive: string;
  manifest: HomeArtifactManifest;
}>): Promise<HomeArtifactActivationIdentityBinding["candidate"]> {
  return Object.freeze({
    artifactId: input.manifest.artifact.id,
    version: input.manifest.product.version,
    buildCommit: input.manifest.build.gitCommit,
    archiveSha256: sha256(await readFile(input.archive)),
    manifestSha256: sha256(await readFile(join(input.directory, "manifest.json"))),
  });
}

function assertCandidateActivationIdentity(
  expected: HomeArtifactActivationIdentityBinding["candidate"],
  observed: HomeArtifactActivationIdentityBinding["candidate"],
  message: string,
): void {
  if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error(message);
}

function bindingFromInstalledEvidence(
  evidence: InstalledHomeUpgradeRehearsalResult,
): HomeArtifactActivationIdentityBinding {
  return Object.freeze({
    predecessor: evidence.predecessor,
    candidate: evidence.candidate,
    fixture: evidence.fixture,
  });
}

function assertInstalledEvidenceEnvelope(evidence: InstalledHomeUpgradeRehearsalResult): void {
  const uid = process.getuid?.();
  if (evidence.schema !== "dome.home-installed-upgrade-rehearsal/v1" ||
    evidence.evidence !== "installed-darwin-arm64" ||
    evidence.host.platform !== "darwin" || evidence.host.arch !== "arm64" ||
    uid === undefined || evidence.host.uid !== uid ||
    JSON.stringify(evidence.scenarios) !== JSON.stringify(ACTIVATION_SCENARIOS)) {
    throw new Error("installed Home upgrade evidence envelope is not the exact local rehearsal result");
  }
}

async function assertPathAbsent(path: string, message: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error(message);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

export async function writeArtifactMetadata(
  artifactRoot: string,
  productVersion: string,
  gitCommit = "0000000000000000000000000000000000000000",
): Promise<HomeArtifactManifest> {
  return await writeArtifactMetadataWithClaim(artifactRoot, productVersion, gitCommit, false);
}

async function writeArtifactMetadataForRelease(
  artifactRoot: string,
  productVersion: string,
  gitCommit: string,
): Promise<HomeArtifactManifest> {
  if (productVersion !== HOME_ARTIFACT_RELEASE_CLAIM.version) {
    throw new Error(`Home release metadata requires exact version ${HOME_ARTIFACT_RELEASE_CLAIM.version}`);
  }
  return await writeArtifactMetadataWithClaim(
    artifactRoot,
    productVersion,
    gitCommit,
    HOME_ARTIFACT_RELEASE_CLAIM.upgradeSupported,
  );
}

async function writeArtifactMetadataWithClaim(
  artifactRoot: string,
  productVersion: string,
  gitCommit: string,
  upgradeSupported: boolean,
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
    writerBarrier: Object.freeze({ protocol: HOME_WRITER_BARRIER_PROTOCOL }),
    durableState: Object.freeze({
      protocol: HOME_DURABLE_STATE_PROTOCOL,
      stores: Object.freeze(HOME_STORE_MIGRATIONS.map((store) => Object.freeze({
        ...store,
        migratesFrom: Object.freeze([...store.migratesFrom]),
      }))),
    }),
    distribution: Object.freeze({ signed: false, notarized: false, upgradeSupported }),
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

export async function assertSourceSnapshot(
  repoRoot: string,
  expectedHead: string,
  privateBuildRoot?: string,
): Promise<void> {
  const actualHead = (await run(["git", "rev-parse", "HEAD"], repoRoot)).stdout.trim();
  if (actualHead !== expectedHead) throw new Error("source HEAD changed during artifact build");
  const status = ["git", "status", "--porcelain", "--untracked-files=all"];
  const privateRelative = privateBuildRoot === undefined ? null
    : relative(await canonicalizePotentialPath(repoRoot), await canonicalizePotentialPath(privateBuildRoot));
  if (privateRelative !== null && privateRelative !== "" && privateRelative !== ".." &&
    !privateRelative.startsWith(`..${sep}`) && !isAbsolute(privateRelative)) {
    status.push("--", ".", `:(exclude,top,literal)${privateRelative}`);
  }
  const dirty = (await run(status, repoRoot)).stdout.trim();
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
    const restoreHelp = await run([
      dome, "backup", "restore", "--help",
    ], temporary, lifecycleEnvironment);
    if (!restoreHelp.stdout.includes("Usage: dome backup restore")) {
      throw new Error("artifact packaged backup restore help failed");
    }
    await rehearseHomeServer(dome, vault, temporary);
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
  const args = process.argv.slice(2);
  let outputDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument !== "--output") throw new Error(`unknown option: ${argument}`);
    if (outputDir !== undefined) throw new Error("--output may be supplied only once");
    outputDir = args[index + 1];
    if (outputDir === undefined || outputDir.startsWith("--")) {
      throw new Error("--output requires a directory");
    }
    index += 1;
  }
  const result = await buildHomeArtifact(outputDir === undefined ? {} : { outputDir });
  process.stdout.write(`${JSON.stringify({
    schema: result.manifest.schema,
    artifact: basename(result.archive),
    directory: result.directory,
    archive: result.archive,
    archiveSha256: result.archiveSha256,
    evidence: result.evidence,
    evidenceSha256: result.evidenceSha256,
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
