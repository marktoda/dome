#!/usr/bin/env bun

// Build-time macOS trust boundary for Dome Home. Runtime code consumes the
// resulting manifest and immutable payload; Apple signing/notarization stays
// here, outside the SDK and Product Host import graph.

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import {
  HOME_CODE_SIGNING_PATHS,
  HOME_CREDENTIAL_HELPER_PATH,
  LEGACY_HOME_CODE_SIGNING_PATHS,
  PINNED_AGE_BINARY_SHA256,
  PINNED_AGE_KEYGEN_BINARY_SHA256,
  PINNED_BUN_BINARY_SHA256,
  PINNED_BUN_DEVELOPER_ID_TEAM_ID,
  canonicalHomeEntitlementsSha256,
  type HomeArtifactCodeSigning,
  type HomeArtifactCodeSigningExecutable,
  type HomeArtifactManifest,
  verifyHomeArtifact,
} from "../src/product-host/home-artifact";
import { publishDirectoryExclusive } from "../src/platform/exclusive-rename";
import { assertSourceSnapshot, buildHomeArtifact } from "./home-artifact";

const CODESIGN = "/usr/bin/codesign";
const XCRUN = "/usr/bin/xcrun";
const HDIUTIL = "/usr/bin/hdiutil";
const SPCTL = "/usr/sbin/spctl";

export const HOME_DISTRIBUTION_RECEIPT_SCHEMA = "dome.home-macos-distribution/v1" as const;

export type DistributionCommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type DistributionCommandRunner = (
  argv: ReadonlyArray<string>,
) => Promise<DistributionCommandResult>;

export type FileEvidence = Readonly<{ bytes: number; sha256: string }>;

export type HomeDmgSignatureEvidence = Readonly<{
  teamId: string;
  cdHash: string;
  secureTimestamp: true;
}>;

export const HOME_ACTIVATION_BINDING_SCHEMA = "dome.home-macos-activation-binding/v1" as const;
export type HomeMacosActivationBinding = Readonly<{
  schema: typeof HOME_ACTIVATION_BINDING_SCHEMA;
  predecessor: Readonly<{
    artifactId: string; version: string; buildCommit: string; archiveSha256: string; manifestSha256: string;
  }>;
  candidate: Readonly<{
    artifactId: string; version: string; buildCommit: string; archiveSha256: string; manifestSha256: string;
  }>;
  fixture: Readonly<{ releaseId: string; sourceCommit: string; canaryDigest: string }>;
  scenarios: ReadonlyArray<"ready-success" | "stopped-precommit-crash" | "committed-exact-repair">;
}>;

export type HomeMacosDistributionReceipt = Readonly<{
  schema: typeof HOME_DISTRIBUTION_RECEIPT_SCHEMA;
  product: Readonly<{ version: string; target: "darwin-arm64" }>;
  artifact: Readonly<{
    id: string;
    buildCommit: string;
    archiveSha256: string;
    manifestSha256: string;
    activationEvidenceSha256: string;
    activationBindingSha256: string;
    codeSigning: HomeArtifactCodeSigning;
    codeSigningSha256: string;
  }>;
  container: Readonly<{
    format: "dmg";
    name: string;
    submitted: FileEvidence;
    distributed: FileEvidence;
    signature: HomeDmgSignatureEvidence;
  }>;
  notarization: Readonly<{
    submissionId: string;
    status: "Accepted";
    logSha256: string;
    issues: 0;
    stapled: true;
    assessed: true;
  }>;
}>;

export type HomeMacosDistributionConfig = Readonly<{
  signingIdentity: string;
  teamId: string;
  notaryKeychainProfile: string;
}>;

type HomeArtifactBuildResult = Awaited<ReturnType<typeof buildHomeArtifact>>;

type DistributionArtifactBuilder = (options: Readonly<{
  repoRoot: string;
  outputDir: string;
  beforeManifest(input: Readonly<{
    artifactRoot: string;
    sources: NativeSigningInput["sources"];
  }>): Promise<HomeArtifactCodeSigning>;
}>) => Promise<HomeArtifactBuildResult>;

export type BuildHomeMacosDistributionTestDeps = Readonly<{
  host?: Readonly<{ platform?: NodeJS.Platform; arch?: string }>;
  artifact?: Readonly<{
    buildArtifact?: DistributionArtifactBuilder;
    signArtifact?: (input: NativeSigningInput) => Promise<HomeArtifactCodeSigning>;
    verifyArtifact?: typeof verifyHomeArtifact;
    reproveSource?: typeof assertSourceSnapshot;
  }>;
  distribution?: Readonly<{
    run?: DistributionCommandRunner;
    createDmg?: typeof createNotarizedHomeDmg;
    digest?: (path: string) => Promise<FileEvidence>;
    verifyDistribution?: (envelope: string, input: Readonly<{
      expectedTeamId: string;
      run?: DistributionCommandRunner;
      digest?: (path: string) => Promise<FileEvidence>;
    }>) => Promise<VerifiedHomeMacosDistribution>;
  }>;
  publication?: Readonly<{
    publish?: (source: string, target: string) => Promise<void>;
    syncFile?: (path: string) => Promise<void>;
    syncDirectory?: (path: string) => Promise<void>;
  }>;
}>;

export type BuildHomeMacosDistributionOptions = Readonly<{
  repoRoot?: string;
  outputDir?: string;
  config: HomeMacosDistributionConfig;
}>;

export type BuildHomeMacosDistributionResult = Readonly<{
  envelope: string;
  publicDirectory: string;
  dmg: string;
  receipt: string;
  activationBinding: string;
  privateReleaseEvidence: string;
  receiptSha256: string;
  evidence: HomeMacosDistributionReceipt;
}>;

export class HomeMacosDistributionPublicationError extends Error {
  readonly published: true;
  readonly durability: "uncertain";

  constructor(cause: unknown, published: true, durability: "uncertain") {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "HomeMacosDistributionPublicationError";
    this.published = published;
    this.durability = durability;
  }
}

type DistributionParent = Readonly<{
  lexical: string;
  canonical: string;
  device: number;
  inode: number;
}>;

export function readHomeMacosDistributionConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): HomeMacosDistributionConfig {
  const config = Object.freeze({
    signingIdentity: requiredEnvironment(environment, "DOME_CODESIGN_IDENTITY"),
    teamId: requiredEnvironment(environment, "DOME_APPLE_TEAM_ID"),
    notaryKeychainProfile: requiredEnvironment(environment, "DOME_NOTARY_KEYCHAIN_PROFILE"),
  });
  assertDistributionConfig(config);
  return config;
}

/**
 * Build the signed inner artifact and accepted outer DMG entirely in a private
 * sibling. The absent final directory is published in one no-replace rename
 * only after source, artifact, activation evidence, DMG, and receipt reproof.
 */
export async function buildHomeMacosDistribution(
  options: BuildHomeMacosDistributionOptions,
): Promise<BuildHomeMacosDistributionResult> {
  return await buildHomeMacosDistributionForTests(options, {});
}

/** Internal orchestration seam; production callers use buildHomeMacosDistribution(options). */
export async function buildHomeMacosDistributionForTests(
  options: BuildHomeMacosDistributionOptions,
  deps: BuildHomeMacosDistributionTestDeps = {},
): Promise<BuildHomeMacosDistributionResult> {
  const host = deps.host ?? {};
  const artifactDeps = deps.artifact ?? {};
  const distributionDeps = deps.distribution ?? {};
  const publicationDeps = deps.publication ?? {};
  if ((host.platform ?? process.platform) !== "darwin" || (host.arch ?? process.arch) !== "arm64") {
    throw new Error(`Dome Home distribution must be built on darwin-arm64`);
  }
  assertDistributionConfig(options.config);
  const repoRoot = resolve(options.repoRoot ?? resolve(import.meta.dir, ".."));
  const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { readonly version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("Dome package version is missing");
  }
  const requestedOutput = resolve(
    options.outputDir ?? join(repoRoot, "dist", `dome-home-${pkg.version}-darwin-arm64-distribution`),
  );
  const parent = await prepareDistributionParent(dirname(requestedOutput));
  const outputDir = join(parent.canonical, basename(requestedOutput));
  await assertDistributionTargetAbsent(outputDir);
  const privateRoot = await mkdtemp(join(parent.canonical, ".dome-home-distribution-"));
  const artifactOutput = join(privateRoot, "artifact");
  const candidate = join(privateRoot, "envelope");
  const publicCandidate = join(candidate, "public");
  const privateCandidate = join(candidate, "private");
  let primaryError: unknown;
  try {
    const signArtifact = artifactDeps.signArtifact ?? (async (input) => await signHomeArtifactNativeCode(
      input,
      distributionDeps.run === undefined ? {} : { run: distributionDeps.run },
    ));
    const artifact = await (artifactDeps.buildArtifact ?? buildHomeArtifact)({
      repoRoot,
      outputDir: artifactOutput,
      beforeManifest: async (input) => await signArtifact({
        ...input,
        domeTeamId: options.config.teamId,
        signingIdentity: options.config.signingIdentity,
      }),
    });
    if (artifact.manifest.product.version !== pkg.version) {
      throw new Error("signed artifact version does not match the source package");
    }
    const artifactName = basename(artifact.directory);
    const dmgPayload = join(privateRoot, "dmg-payload");
    const signedArtifactRoot = join(dmgPayload, "artifact");
    const payloadRelease = join(dmgPayload, "release");
    await mkdir(dmgPayload, { mode: 0o700 });
    await rename(artifact.directory, signedArtifactRoot);
    await mkdir(payloadRelease, { mode: 0o700 });
    await mkdir(publicCandidate, { recursive: true, mode: 0o755 });
    await mkdir(privateCandidate, { recursive: true, mode: 0o700 });
    const dmgName = `${artifactName}.dmg`;
    const dmgPath = join(publicCandidate, dmgName);
    const activationName = `${artifactName}.activation-binding.json`;
    const activationPath = join(publicCandidate, activationName);
    const rawActivationBytes = await readFile(artifact.evidence);
    let rawActivation: unknown;
    try { rawActivation = JSON.parse(rawActivationBytes.toString("utf8")); }
    catch { throw new Error("private installed activation evidence is invalid JSON"); }
    const activationBinding = createHomeMacosActivationBinding(rawActivation);
    if (activationBinding.candidate.artifactId !== artifact.manifest.artifact.id ||
      activationBinding.candidate.version !== artifact.manifest.product.version ||
      activationBinding.candidate.buildCommit !== artifact.manifest.build.gitCommit ||
      activationBinding.candidate.archiveSha256 !== artifact.archiveSha256) {
      throw new Error("installed activation evidence does not bind the signed artifact");
    }
    const activationText = `${JSON.stringify(activationBinding, null, 2)}\n`;
    await writeFile(activationPath, activationText, { mode: 0o644, flag: "wx" });
    await writeFile(join(payloadRelease, "activation-binding.json"), activationText, { mode: 0o600, flag: "wx" });
    const privateEvidenceCandidate = join(privateCandidate, "release-evidence.json");
    await writeFile(privateEvidenceCandidate, rawActivationBytes, { mode: 0o600, flag: "wx" });
    const createDmg = distributionDeps.createDmg ?? createNotarizedHomeDmg;
    const receipt = await createDmg({
      payloadRoot: dmgPayload,
      artifactRoot: signedArtifactRoot,
      manifest: artifact.manifest,
      activationEvidencePath: artifact.evidence,
      activationBinding,
      archiveSha256: artifact.archiveSha256,
      dmgPath,
      volumeName: `Dome Home ${artifact.manifest.product.version}`,
      signingIdentity: options.config.signingIdentity,
      teamId: options.config.teamId,
      notaryKeychainProfile: options.config.notaryKeychainProfile,
    }, {
      ...(distributionDeps.run === undefined ? {} : { run: distributionDeps.run }),
      ...(distributionDeps.digest === undefined ? {} : { digest: distributionDeps.digest }),
    });
    const receiptName = `${artifactName}.distribution-receipt.json`;
    const receiptPath = join(publicCandidate, receiptName);
    const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
    await writeFile(receiptPath, receiptText, { mode: 0o644, flag: "wx" });

    const verified = await (artifactDeps.verifyArtifact ?? verifyHomeArtifact)(signedArtifactRoot);
    if (JSON.stringify(verified) !== JSON.stringify(artifact.manifest) ||
      JSON.stringify(verified.codeSigning) !== JSON.stringify(receipt.artifact.codeSigning)) {
      throw new Error("signed Home artifact changed before distribution publication");
    }
    const digest = distributionDeps.digest ?? fileEvidence;
    const [archive, activation, binding, manifest, dmg, writtenReceipt] = await Promise.all([
      digest(artifact.archive),
      digest(artifact.evidence),
      digest(activationPath),
      digest(join(signedArtifactRoot, "manifest.json")),
      digest(dmgPath),
      digest(receiptPath),
    ]);
    if (archive.sha256 !== artifact.archiveSha256 || activation.sha256 !== artifact.evidenceSha256 ||
      activation.sha256 !== receipt.artifact.activationEvidenceSha256 ||
      binding.sha256 !== receipt.artifact.activationBindingSha256 ||
      manifest.sha256 !== receipt.artifact.manifestSha256 ||
      dmg.sha256 !== receipt.container.distributed.sha256 || dmg.bytes !== receipt.container.distributed.bytes ||
      await readFile(receiptPath, "utf8") !== receiptText) {
      throw new Error("Home distribution evidence changed before publication");
    }
    const decodedReceipt = JSON.parse(await readFile(receiptPath, "utf8")) as unknown;
    if (JSON.stringify(decodedReceipt) !== JSON.stringify(receipt)) {
      throw new Error("Home distribution receipt did not round-trip exactly");
    }
    await (artifactDeps.reproveSource ?? assertSourceSnapshot)(repoRoot, artifact.manifest.build.gitCommit, privateRoot);
    await reproveDistributionParent(parent);
    const verifyDistribution = distributionDeps.verifyDistribution ?? (async (envelope, input) =>
      await verifyHomeMacosDistributionForTests(
        envelope,
        { expectedTeamId: input.expectedTeamId },
        {
          ...(input.run === undefined ? {} : { run: input.run }),
          ...(input.digest === undefined ? {} : { digest: input.digest }),
        },
      ));
    const verificationDeps = {
      ...(distributionDeps.run === undefined ? {} : { run: distributionDeps.run }),
      ...(distributionDeps.digest === undefined ? {} : { digest: distributionDeps.digest }),
      expectedTeamId: options.config.teamId,
    };
    await verifyDistribution(candidate, verificationDeps);
    const syncFile = publicationDeps.syncFile ?? syncRegularFile;
    const syncDirectory = publicationDeps.syncDirectory ?? syncDirectDirectory;
    await Promise.all([syncFile(dmgPath), syncFile(receiptPath), syncFile(activationPath)]);
    await syncFile(privateEvidenceCandidate);
    await syncDirectory(publicCandidate);
    await syncDirectory(privateCandidate);
    await syncDirectory(candidate);
    await reproveDistributionParent(parent);
    await assertDistributionTargetAbsent(outputDir);
    const publish = publicationDeps.publish ?? (async (source, target) => {
      await publishDirectoryExclusive({ source, target });
    });
    try {
      await publish(candidate, outputDir);
    } catch (error) {
      if (await pathPresent(candidate)) throw error;
      if (await pathPresent(outputDir)) {
        throw new HomeMacosDistributionPublicationError(error, true, "uncertain");
      }
      throw error;
    }
    try {
      await syncDirectory(parent.canonical);
      await reproveDistributionParent(parent);
      await verifyDistribution(outputDir, verificationDeps);
    } catch (error) {
      throw new HomeMacosDistributionPublicationError(error, true, "uncertain");
    }
    return Object.freeze({
      envelope: outputDir,
      publicDirectory: join(outputDir, "public"),
      dmg: join(outputDir, "public", dmgName),
      receipt: join(outputDir, "public", receiptName),
      activationBinding: join(outputDir, "public", activationName),
      privateReleaseEvidence: join(outputDir, "private", "release-evidence.json"),
      receiptSha256: writtenReceipt.sha256,
      evidence: receipt,
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try { await rm(privateRoot, { recursive: true, force: true }); }
    catch (cleanupError) {
      if (primaryError === undefined) throw cleanupError;
    }
  }
}

export type NativeSigningInput = Readonly<{
  artifactRoot: string;
  sources: Readonly<{ bun: string; age: string; ageKeygen: string; homeCredentialHelper?: string }>;
  domeTeamId: string;
  signingIdentity: string;
}>;

type NativeSigningDeps = Readonly<{
  run?: DistributionCommandRunner;
  inventoryMachO?: (root: string) => Promise<ReadonlyArray<string>>;
  digest?: (path: string) => Promise<FileEvidence>;
}>;

/**
 * Sign the two ad-hoc age tools plus the Home credential helper when present,
 * and preserve Bun's upstream Developer-ID signature. The returned evidence
 * is the only way a manifest may claim `distribution.signed: true`.
 */
export async function signHomeArtifactNativeCode(
  input: NativeSigningInput,
  deps: NativeSigningDeps = {},
): Promise<HomeArtifactCodeSigning> {
  assertTeamId(input.domeTeamId, "Dome signing team");
  if (!input.signingIdentity.startsWith("Developer ID Application:")) {
    throw new Error("Dome signing identity must be a Developer ID Application identity");
  }
  const run = deps.run ?? runCommand;
  const digest = deps.digest ?? fileEvidence;
  const inventory = await (deps.inventoryMachO ?? inventoryMachO)(input.artifactRoot);
  const currentInventory = JSON.stringify(inventory) === JSON.stringify(HOME_CODE_SIGNING_PATHS);
  const legacyInventory = JSON.stringify(inventory) === JSON.stringify(LEGACY_HOME_CODE_SIGNING_PATHS);
  if (!currentInventory && !legacyInventory) {
    throw new Error(`Home artifact Mach-O inventory is not exact: ${inventory.join(", ") || "empty"}`);
  }
  if (currentInventory && input.sources.homeCredentialHelper === undefined) {
    throw new Error("Home credential helper source is required for the current signing capability");
  }

  const bunSource = await digest(input.sources.bun);
  const bunShipped = await digest(join(input.artifactRoot, "runtime", "bun"));
  if (bunSource.sha256 !== PINNED_BUN_BINARY_SHA256 || bunShipped.sha256 !== bunSource.sha256) {
    throw new Error("Home artifact must preserve the exact pinned Bun bytes before signing");
  }
  const bun = await inspectSignature({
    path: join(input.artifactRoot, "runtime", "bun"),
    relativePath: "runtime/bun",
    sourceSha256: bunSource.sha256,
    shippedSha256: bunShipped.sha256,
    expectedTeamId: PINNED_BUN_DEVELOPER_ID_TEAM_ID,
  }, run);

  const domeSources = Object.freeze([
    Object.freeze({
      path: "runtime/age" as const,
      source: input.sources.age,
      pinned: PINNED_AGE_BINARY_SHA256,
      identifier: undefined,
    }),
    Object.freeze({
      path: "runtime/age-keygen" as const,
      source: input.sources.ageKeygen,
      pinned: PINNED_AGE_KEYGEN_BINARY_SHA256,
      identifier: undefined,
    }),
    ...(input.sources.homeCredentialHelper === undefined ? [] : [Object.freeze({
      path: HOME_CREDENTIAL_HELPER_PATH,
      source: input.sources.homeCredentialHelper,
      pinned: undefined,
      identifier: "com.dome.home.keychain-helper",
    })]),
  ]);
  const signed: HomeArtifactCodeSigningExecutable[] = [];
  const sourceHashes = new Map<string, string>();
  for (const item of domeSources) {
    const source = await digest(item.source);
    sourceHashes.set(item.path, source.sha256);
    const target = join(input.artifactRoot, ...item.path.split("/"));
    const before = await digest(target);
    if ((item.pinned !== undefined && source.sha256 !== item.pinned) || before.sha256 !== source.sha256) {
      throw new Error(`${item.path} is not the exact expected source binary before signing`);
    }
    await checked(run, [
      CODESIGN,
      "--force",
      "--options", "runtime",
      "--timestamp",
      "--sign", input.signingIdentity,
      ...(item.identifier === undefined ? [] : ["--identifier", item.identifier]),
      target,
    ], `sign ${item.path}`, [input.signingIdentity]);
    const after = await digest(target);
    if (after.sha256 === before.sha256) {
      throw new Error(`${item.path} bytes did not change after Developer ID signing`);
    }
    signed.push(await inspectSignature({
      path: target,
      relativePath: item.path,
      sourceSha256: source.sha256,
      shippedSha256: after.sha256,
      expectedTeamId: input.domeTeamId,
      ...(item.identifier === undefined ? {} : { expectedIdentifier: item.identifier }),
    }, run));
  }

  const finalInventory = await (deps.inventoryMachO ?? inventoryMachO)(input.artifactRoot);
  const expectedInventory = currentInventory ? HOME_CODE_SIGNING_PATHS : LEGACY_HOME_CODE_SIGNING_PATHS;
  if (JSON.stringify(finalInventory) !== JSON.stringify(expectedInventory)) {
    throw new Error(`signed Home artifact Mach-O inventory is not exact: ${finalInventory.join(", ") || "empty"}`);
  }
  for (const item of domeSources) {
    const source = await digest(item.source);
    if (source.sha256 !== sourceHashes.get(item.path)) {
      throw new Error(`${item.path} source bytes changed during signing`);
    }
  }

  return Object.freeze({
    executables: Object.freeze([signed[0]!, signed[1]!, bun, ...(signed[2] === undefined ? [] : [signed[2]])]),
  });
}

type DistributionInput = Readonly<{
  payloadRoot: string;
  artifactRoot: string;
  manifest: HomeArtifactManifest;
  activationEvidencePath: string;
  activationBinding: HomeMacosActivationBinding;
  archiveSha256: string;
  dmgPath: string;
  volumeName: string;
  signingIdentity: string;
  teamId: string;
  notaryKeychainProfile: string;
}>;

type DistributionDeps = Readonly<{
  run?: DistributionCommandRunner;
  digest?: (path: string) => Promise<FileEvidence>;
}>;

/**
 * Create and validate the outer release envelope. The caller owns private
 * staging and atomic publication; this function returns only after Apple has
 * accepted the exact submitted DMG and the distributed bytes carry a valid
 * stapled ticket.
 */
export async function createNotarizedHomeDmg(
  input: DistributionInput,
  deps: DistributionDeps = {},
): Promise<HomeMacosDistributionReceipt> {
  const run = deps.run ?? runCommand;
  const digest = deps.digest ?? fileEvidence;
  const codeSigning = input.manifest.codeSigning;
  if (input.manifest.distribution.signed !== true || codeSigning === undefined ||
    input.manifest.distribution.notarized !== false) {
    throw new Error("notarized Home distribution requires a signed inner artifact with outer-only notarization truth");
  }
  if (!input.signingIdentity.startsWith("Developer ID Application:")) {
    throw new Error("DMG signing identity must be a Developer ID Application identity");
  }
  if (input.notaryKeychainProfile.length === 0 || input.notaryKeychainProfile.includes("\0")) {
    throw new Error("notary keychain profile is required");
  }
  if (basename(input.dmgPath) !== input.dmgPath.split(sep).at(-1) || !input.dmgPath.endsWith(".dmg")) {
    throw new Error("Home distribution output must be a .dmg path");
  }

  await checked(run, [
    HDIUTIL, "create",
    "-format", "UDZO",
    "-fs", "HFS+",
    "-volname", input.volumeName,
    "-srcfolder", input.payloadRoot,
    input.dmgPath,
  ], "create Home DMG");
  await checked(run, [
    CODESIGN, "--force", "--timestamp", "--sign", input.signingIdentity, input.dmgPath,
  ], "sign Home DMG", [input.signingIdentity]);
  await checked(run, [CODESIGN, "--verify", "--strict", "--verbose=2", input.dmgPath], "verify signed Home DMG");
  const submittedSignature = await inspectDmgSignature(input.dmgPath, input.teamId, run);

  const submitted = await digest(input.dmgPath);
  const submission = await checked(run, [
    XCRUN, "notarytool", "submit", input.dmgPath,
    "--keychain-profile", input.notaryKeychainProfile,
    "--wait", "--output-format", "json", "--no-progress",
  ], "submit Home DMG for notarization", [input.notaryKeychainProfile]);
  const notary = parseAcceptedSubmission(submission.stdout);
  const log = await checked(run, [
    XCRUN, "notarytool", "log", notary.id,
    "--keychain-profile", input.notaryKeychainProfile,
  ], "read Home notarization log", [input.notaryKeychainProfile]);
  parseAcceptedNotaryLog(log.stdout, Object.freeze({
    submissionId: notary.id,
    archiveFilename: basename(input.dmgPath),
    sha256: submitted.sha256,
  }));

  await checked(run, [XCRUN, "stapler", "staple", "-v", input.dmgPath], "staple Home DMG");
  await checked(run, [XCRUN, "stapler", "validate", "-v", input.dmgPath], "validate Home DMG ticket");
  await checked(run, [CODESIGN, "--verify", "--strict", "--verbose=2", input.dmgPath], "reverify stapled Home DMG");
  const distributedSignature = await inspectDmgSignature(input.dmgPath, input.teamId, run);
  if (JSON.stringify(distributedSignature) !== JSON.stringify(submittedSignature)) {
    throw new Error("stapling changed the Home DMG native signature identity");
  }
  await checked(run, [HDIUTIL, "verify", input.dmgPath], "verify Home DMG UDIF structure");
  const assessmentStatus = await checked(run, [SPCTL, "--status"], "read Gatekeeper assessment status");
  if (!/assessments enabled/i.test(`${assessmentStatus.stdout}\n${assessmentStatus.stderr}`)) {
    throw new Error("Gatekeeper assessments are disabled");
  }
  await checked(run, [
    SPCTL, "--assess", "--ignore-cache", "--no-cache", "--type", "open",
    "--context", "context:primary-signature", "--verbose=4", input.dmgPath,
  ], "assess Home DMG with Gatekeeper");
  const distributed = await digest(input.dmgPath);
  if (submitted.sha256 === distributed.sha256) {
    throw new Error("stapling did not change the Home DMG bytes");
  }

  const manifest = await digest(join(input.artifactRoot, "manifest.json"));
  const activation = await digest(input.activationEvidencePath);
  const activationBindingSha256 = sha256(Buffer.from(`${JSON.stringify(input.activationBinding, null, 2)}\n`));
  const codeSigningSha256 = sha256(Buffer.from(JSON.stringify(codeSigning)));
  return Object.freeze({
    schema: HOME_DISTRIBUTION_RECEIPT_SCHEMA,
    product: Object.freeze({ version: input.manifest.product.version, target: "darwin-arm64" }),
    artifact: Object.freeze({
      id: input.manifest.artifact.id,
      buildCommit: input.manifest.build.gitCommit,
      archiveSha256: input.archiveSha256,
      manifestSha256: manifest.sha256,
      activationEvidenceSha256: activation.sha256,
      activationBindingSha256,
      codeSigning,
      codeSigningSha256,
    }),
    container: Object.freeze({
      format: "dmg",
      name: basename(input.dmgPath),
      submitted,
      distributed,
      signature: distributedSignature,
    }),
    notarization: Object.freeze({
      submissionId: notary.id,
      status: "Accepted",
      logSha256: sha256(Buffer.from(log.stdout)),
      issues: 0,
      stapled: true,
      assessed: true,
    }),
  });
}

export type VerifiedHomeMacosDistribution = Readonly<{
  receipt: HomeMacosDistributionReceipt;
  activationBinding: HomeMacosActivationBinding;
  dmgPath: string;
  receiptPath: string;
  activationBindingPath: string;
}>;

export async function verifyHomeMacosDistribution(
  envelope: string,
  options: Readonly<{ expectedTeamId: string }>,
): Promise<VerifiedHomeMacosDistribution> {
  return await verifyHomeMacosDistributionForTests(envelope, options, {});
}

export async function verifyHomeMacosDistributionForTests(
  envelopeInput: string,
  options: Readonly<{ expectedTeamId: string }>,
  deps: Readonly<{
    run?: DistributionCommandRunner;
    digest?: (path: string) => Promise<FileEvidence>;
    verifyMountedArtifact?: (root: string) => Promise<Readonly<{
      manifest: HomeArtifactManifest;
      manifestSha256: string;
    }>>;
  }> = {},
): Promise<VerifiedHomeMacosDistribution> {
  assertTeamId(options.expectedTeamId, "expected distribution team");
  const envelope = resolve(envelopeInput);
  const rootInfo = await lstat(envelope);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Home macOS distribution envelope must be a direct directory");
  }
  const envelopeEntries = await readdir(envelope, { withFileTypes: true });
  const envelopeNames = envelopeEntries.map((entry) => entry.name).sort();
  if (envelopeEntries.length !== 2 || JSON.stringify(envelopeNames) !== JSON.stringify(["private", "public"]) ||
    envelopeEntries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error("Home macOS distribution envelope inventory is not exact");
  }
  const directory = join(envelope, "public");
  const privateDirectory = join(envelope, "private");
  const privateEntries = await readdir(privateDirectory, { withFileTypes: true });
  if (privateEntries.length !== 1 || privateEntries[0]?.name !== "release-evidence.json" ||
    !privateEntries[0].isFile() || privateEntries[0].isSymbolicLink() ||
    ((await lstat(join(privateDirectory, "release-evidence.json"))).mode & 0o777) !== 0o600) {
    throw new Error("Home macOS distribution private inventory is not exact");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) || entries.length !== 3) {
    throw new Error("Home macOS distribution inventory is not the exact three regular files");
  }
  const names = entries.map((entry) => entry.name).sort();
  const dmgName = names.find((name) => name.endsWith(".dmg"));
  const receiptName = names.find((name) => name.endsWith(".distribution-receipt.json"));
  const activationName = names.find((name) => name.endsWith(".activation-binding.json"));
  if (dmgName === undefined || receiptName === undefined || activationName === undefined) {
    throw new Error("Home macOS distribution inventory names are invalid");
  }
  const stem = dmgName.slice(0, -4);
  if (receiptName !== `${stem}.distribution-receipt.json` || activationName !== `${stem}.activation-binding.json`) {
    throw new Error("Home macOS distribution inventory is not cross-named");
  }
  const dmgPath = join(directory, dmgName);
  const receiptPath = join(directory, receiptName);
  const activationBindingPath = join(directory, activationName);
  const receipt = parseHomeMacosDistributionReceipt(await readBoundedJson(receiptPath, 4 * 1024 * 1024));
  const activationBinding = parseHomeMacosActivationBinding(await readBoundedJson(
    activationBindingPath,
    1024 * 1024,
  ));
  const digest = deps.digest ?? fileEvidence;
  const privateEvidencePath = join(privateDirectory, "release-evidence.json");
  const [dmg, activation, privateEvidence] = await Promise.all([
    digest(dmgPath), digest(activationBindingPath), digest(privateEvidencePath),
  ]);
  const privateBinding = createHomeMacosActivationBinding(await readBoundedJson(privateEvidencePath, 4 * 1024 * 1024));
  if (receipt.container.name !== dmgName || JSON.stringify(receipt.container.distributed) !== JSON.stringify(dmg) ||
    receipt.artifact.activationBindingSha256 !== activation.sha256 ||
    receipt.artifact.activationEvidenceSha256 !== privateEvidence.sha256 ||
    JSON.stringify(privateBinding) !== JSON.stringify(activationBinding) ||
    receipt.artifact.id !== activationBinding.candidate.artifactId ||
    receipt.product.version !== activationBinding.candidate.version ||
    receipt.artifact.buildCommit !== activationBinding.candidate.buildCommit ||
    receipt.artifact.archiveSha256 !== activationBinding.candidate.archiveSha256 ||
    receipt.artifact.manifestSha256 !== activationBinding.candidate.manifestSha256 ||
    receipt.artifact.codeSigningSha256 !== sha256(Buffer.from(JSON.stringify(receipt.artifact.codeSigning)))) {
    throw new Error("Home macOS distribution receipt cross-binding is invalid");
  }
  if (receipt.container.signature.teamId !== options.expectedTeamId) {
    throw new Error("Home macOS distribution is signed by the wrong team");
  }
  const run = deps.run ?? runCommand;
  await checked(run, [CODESIGN, "--verify", "--strict", "--verbose=2", dmgPath], "verify distributed Home DMG");
  const signature = await inspectDmgSignature(dmgPath, receipt.container.signature.teamId, run);
  if (JSON.stringify(signature) !== JSON.stringify(receipt.container.signature)) {
    throw new Error("Home macOS distribution native signature differs from its receipt");
  }
  await checked(run, [XCRUN, "stapler", "validate", "-v", dmgPath], "validate distributed Home DMG ticket");
  await checked(run, [HDIUTIL, "verify", dmgPath], "verify distributed Home DMG UDIF structure");
  const status = await checked(run, [SPCTL, "--status"], "read Gatekeeper assessment status");
  if (!/assessments enabled/i.test(`${status.stdout}\n${status.stderr}`)) {
    throw new Error("Gatekeeper assessments are disabled");
  }
  await checked(run, [
    SPCTL, "--assess", "--ignore-cache", "--no-cache", "--type", "open",
    "--context", "context:primary-signature", "--verbose=4", dmgPath,
  ], "assess distributed Home DMG with Gatekeeper");
  await verifyEmbeddedHomeArtifact(dmgPath, receipt, activationBinding, run, deps.verifyMountedArtifact);
  return Object.freeze({ receipt, activationBinding, dmgPath, receiptPath, activationBindingPath });
}

export function parseHomeMacosDistributionReceipt(value: unknown): HomeMacosDistributionReceipt {
  const root = exactRecord(value, "Home macOS distribution receipt", ["schema", "product", "artifact", "container", "notarization"]);
  if (root["schema"] !== HOME_DISTRIBUTION_RECEIPT_SCHEMA) throw new Error("unsupported Home distribution receipt schema");
  const product = exactRecord(root["product"], "Home distribution product", ["version", "target"]);
  const artifact = exactRecord(root["artifact"], "Home distribution artifact", [
    "id", "buildCommit", "archiveSha256", "manifestSha256", "activationEvidenceSha256",
    "activationBindingSha256", "codeSigning", "codeSigningSha256",
  ]);
  const container = exactRecord(root["container"], "Home distribution container", [
    "format", "name", "submitted", "distributed", "signature",
  ]);
  const notarization = exactRecord(root["notarization"], "Home distribution notarization", [
    "submissionId", "status", "logSha256", "issues", "stapled", "assessed",
  ]);
  const codeSigning = parseReceiptCodeSigning(artifact["codeSigning"]);
  const submitted = parseFileEvidence(container["submitted"]);
  const distributed = parseFileEvidence(container["distributed"]);
  const signature = parseDmgSignature(container["signature"]);
  const age = codeSigning.executables[0]!;
  const ageKeygen = codeSigning.executables[1]!;
  const bun = codeSigning.executables[2]!;
  if (!boundedString(product["version"]) || product["target"] !== "darwin-arm64" ||
    !sha(artifact["id"]) || !objectId(artifact["buildCommit"]) || !sha(artifact["archiveSha256"]) ||
    !sha(artifact["manifestSha256"]) || !sha(artifact["activationEvidenceSha256"]) ||
    !sha(artifact["activationBindingSha256"]) || !sha(artifact["codeSigningSha256"]) ||
    artifact["codeSigningSha256"] !== sha256(Buffer.from(JSON.stringify(codeSigning))) ||
    container["format"] !== "dmg" || typeof container["name"] !== "string" ||
    basename(container["name"]) !== container["name"] || !container["name"].endsWith(".dmg") ||
    submitted.sha256 === distributed.sha256 ||
    age.sourceSha256 !== PINNED_AGE_BINARY_SHA256 || age.sourceSha256 === age.shippedSha256 ||
    ageKeygen.sourceSha256 !== PINNED_AGE_KEYGEN_BINARY_SHA256 || ageKeygen.sourceSha256 === ageKeygen.shippedSha256 ||
    age.teamId !== signature.teamId || ageKeygen.teamId !== signature.teamId ||
    bun.sourceSha256 !== PINNED_BUN_BINARY_SHA256 || bun.shippedSha256 !== PINNED_BUN_BINARY_SHA256 ||
    bun.teamId !== PINNED_BUN_DEVELOPER_ID_TEAM_ID ||
    notarization["status"] !== "Accepted" || typeof notarization["submissionId"] !== "string" ||
    !uuid(notarization["submissionId"]) || !sha(notarization["logSha256"]) || notarization["issues"] !== 0 ||
    notarization["stapled"] !== true || notarization["assessed"] !== true) {
    throw new Error("Home macOS distribution receipt semantics are invalid");
  }
  return Object.freeze({
    schema: HOME_DISTRIBUTION_RECEIPT_SCHEMA,
    product: Object.freeze({ version: product["version"], target: "darwin-arm64" }),
    artifact: Object.freeze({
      id: artifact["id"], buildCommit: artifact["buildCommit"], archiveSha256: artifact["archiveSha256"],
      manifestSha256: artifact["manifestSha256"], activationEvidenceSha256: artifact["activationEvidenceSha256"],
      activationBindingSha256: artifact["activationBindingSha256"], codeSigning,
      codeSigningSha256: artifact["codeSigningSha256"],
    }),
    container: Object.freeze({
      format: "dmg", name: container["name"], submitted, distributed, signature,
    }),
    notarization: Object.freeze({
      submissionId: notarization["submissionId"], status: "Accepted", logSha256: notarization["logSha256"],
      issues: 0, stapled: true, assessed: true,
    }),
  });
}

async function verifyEmbeddedHomeArtifact(
  dmgPath: string,
  receipt: HomeMacosDistributionReceipt,
  activation: HomeMacosActivationBinding,
  run: DistributionCommandRunner,
  verifyMountedArtifact?: (root: string) => Promise<Readonly<{
    manifest: HomeArtifactManifest;
    manifestSha256: string;
  }>>,
): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "dome-home-dmg-verify-"));
  const mount = join(temporary, "mount");
  await mkdir(mount, { mode: 0o700 });
  let attached = false;
  let primary: unknown;
  try {
    await checked(run, [
      HDIUTIL, "attach", "-readonly", "-nobrowse", "-mountpoint", mount, "-plist", dmgPath,
    ], "mount Home DMG read-only");
    attached = true;
    const embedded = await inspectMountedHomePayload(mount, verifyMountedArtifact);
    if (embedded.manifest.artifact.id !== receipt.artifact.id ||
      embedded.manifest.product.version !== receipt.product.version ||
      embedded.manifest.build.gitCommit !== receipt.artifact.buildCommit ||
      embedded.manifestSha256 !== receipt.artifact.manifestSha256 ||
      embedded.activationBindingSha256 !== receipt.artifact.activationBindingSha256 ||
      JSON.stringify(embedded.activationBinding) !== JSON.stringify(activation) ||
      JSON.stringify(embedded.manifest.codeSigning) !== JSON.stringify(receipt.artifact.codeSigning) ||
      embedded.manifest.artifact.id !== activation.candidate.artifactId ||
      embedded.manifest.product.version !== activation.candidate.version ||
      embedded.manifest.build.gitCommit !== activation.candidate.buildCommit) {
      throw new Error("embedded Home artifact does not match the distribution envelope");
    }
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    if (attached) {
      try { await checked(run, [HDIUTIL, "detach", mount], "detach Home DMG"); }
      catch (detachError) { if (primary === undefined) throw detachError; }
    }
    try { await rm(temporary, { recursive: true, force: true }); }
    catch (cleanupError) { if (primary === undefined) throw cleanupError; }
  }
}

async function inspectMountedHomePayload(
  mount: string,
  verifyMountedArtifact?: (artifactRoot: string) => Promise<Readonly<{
    manifest: HomeArtifactManifest;
    manifestSha256: string;
  }>>,
): Promise<Readonly<{
  manifest: HomeArtifactManifest;
  manifestSha256: string;
  activationBinding: HomeMacosActivationBinding;
  activationBindingSha256: string;
}>> {
  const rootEntries = await readdir(mount, { withFileTypes: true });
  if (JSON.stringify(rootEntries.map((entry) => entry.name).sort()) !== JSON.stringify(["artifact", "release"]) ||
    rootEntries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error("mounted Home DMG inventory is not exact");
  }
  const artifactRoot = join(mount, "artifact");
  const releaseRoot = join(mount, "release");
  const releaseEntries = await readdir(releaseRoot, { withFileTypes: true });
  if (releaseEntries.length !== 1 || releaseEntries[0]?.name !== "activation-binding.json" ||
    !releaseEntries[0].isFile() || releaseEntries[0].isSymbolicLink()) {
    throw new Error("mounted Home DMG release inventory is not exact");
  }
  const activationPath = join(releaseRoot, "activation-binding.json");
  const [artifact, activationEvidence, activationBinding] = await Promise.all([
    verifyMountedArtifact === undefined
      ? Promise.all([
        verifyHomeArtifact(artifactRoot),
        fileEvidence(join(artifactRoot, "manifest.json")),
      ]).then(([manifest, manifestEvidence]) => Object.freeze({
        manifest,
        manifestSha256: manifestEvidence.sha256,
      }))
      : verifyMountedArtifact(artifactRoot),
    fileEvidence(activationPath),
    readBoundedJson(activationPath, 1024 * 1024).then(parseHomeMacosActivationBinding),
  ]);
  return Object.freeze({
    manifest: artifact.manifest,
    manifestSha256: artifact.manifestSha256,
    activationBinding,
    activationBindingSha256: activationEvidence.sha256,
  });
}

function parseFileEvidence(value: unknown): FileEvidence {
  const row = exactRecord(value, "distribution file evidence", ["bytes", "sha256"]);
  if (!Number.isSafeInteger(row["bytes"]) || (row["bytes"] as number) < 0 || !sha(row["sha256"])) {
    throw new Error("distribution file evidence is invalid");
  }
  return Object.freeze({ bytes: row["bytes"] as number, sha256: row["sha256"] });
}

function parseDmgSignature(value: unknown): HomeDmgSignatureEvidence {
  const row = exactRecord(value, "Home DMG signature evidence", ["teamId", "cdHash", "secureTimestamp"]);
  if (typeof row["teamId"] !== "string" || !/^[A-Z0-9]{10}$/.test(row["teamId"]) ||
    typeof row["cdHash"] !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(row["cdHash"]) ||
    row["secureTimestamp"] !== true) throw new Error("Home DMG signature evidence is invalid");
  return Object.freeze({ teamId: row["teamId"], cdHash: row["cdHash"], secureTimestamp: true });
}

function parseReceiptCodeSigning(value: unknown): HomeArtifactCodeSigning {
  const root = exactRecord(value, "receipt code signing", ["executables"]);
  if (!Array.isArray(root["executables"]) ||
    (root["executables"].length !== LEGACY_HOME_CODE_SIGNING_PATHS.length &&
      root["executables"].length !== HOME_CODE_SIGNING_PATHS.length)) {
    throw new Error("receipt code signing inventory is invalid");
  }
  const expectedPaths = root["executables"].length === LEGACY_HOME_CODE_SIGNING_PATHS.length
    ? LEGACY_HOME_CODE_SIGNING_PATHS
    : HOME_CODE_SIGNING_PATHS;
  const executables = root["executables"].map((value, index) => {
    const row = exactRecord(value, "receipt signed executable", [
      "path", "sourceSha256", "shippedSha256", "teamId", "cdHash", "hardenedRuntime",
      "secureTimestamp", "entitlementsSha256",
    ]);
    if (row["path"] !== expectedPaths[index] || !sha(row["sourceSha256"]) ||
      !sha(row["shippedSha256"]) || typeof row["teamId"] !== "string" ||
      !/^[A-Z0-9]{10}$/.test(row["teamId"]) || typeof row["cdHash"] !== "string" ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(row["cdHash"]) || row["hardenedRuntime"] !== true ||
      row["secureTimestamp"] !== true || !sha(row["entitlementsSha256"])) {
      throw new Error("receipt signed executable evidence is invalid");
    }
    return Object.freeze(row) as unknown as HomeArtifactCodeSigningExecutable;
  });
  return Object.freeze({ executables: Object.freeze(executables) });
}

type SignatureInspection = Readonly<{
  path: string;
  relativePath: HomeArtifactCodeSigningExecutable["path"];
  sourceSha256: string;
  shippedSha256: string;
  expectedTeamId: string;
  expectedIdentifier?: string;
}>;

async function inspectSignature(
  input: SignatureInspection,
  run: DistributionCommandRunner,
): Promise<HomeArtifactCodeSigningExecutable> {
  await checked(run, [CODESIGN, "--verify", "--strict", "--verbose=2", input.path], `verify ${input.relativePath}`);
  const detail = await checked(run, [CODESIGN, "--display", "--verbose=4", input.path], `inspect ${input.relativePath}`);
  const text = `${detail.stdout}\n${detail.stderr}`;
  const teamId = capture(text, /^TeamIdentifier=([A-Z0-9]{10})$/m, `${input.relativePath} team identifier`);
  const cdHash = capture(text, /^CDHash=([a-f0-9]{40}(?:[a-f0-9]{24})?)$/m, `${input.relativePath} CDHash`);
  if (teamId !== input.expectedTeamId) throw new Error(`${input.relativePath} is signed by unexpected team ${teamId}`);
  if (input.expectedIdentifier !== undefined &&
    !text.split(/\r?\n/).includes(`Identifier=${input.expectedIdentifier}`)) {
    throw new Error(`${input.relativePath} has an unexpected signing identifier`);
  }
  if (!/^CodeDirectory .*flags=.*\bruntime\b/m.test(text)) {
    throw new Error(`${input.relativePath} does not enable hardened runtime`);
  }
  if (!/^Timestamp=.+$/m.test(text)) throw new Error(`${input.relativePath} has no secure timestamp`);
  const entitlements = await checked(run, [
    CODESIGN, "--display", "--entitlements", "-", "--xml", input.path,
  ], `inspect ${input.relativePath} entitlements`);
  return Object.freeze({
    path: input.relativePath,
    sourceSha256: input.sourceSha256,
    shippedSha256: input.shippedSha256,
    teamId,
    cdHash,
    hardenedRuntime: true,
    secureTimestamp: true,
    entitlementsSha256: canonicalHomeEntitlementsSha256(entitlements.stdout),
  });
}

async function inspectDmgSignature(
  path: string,
  expectedTeamId: string,
  run: DistributionCommandRunner,
): Promise<HomeDmgSignatureEvidence> {
  const detail = await checked(run, [CODESIGN, "--display", "--verbose=4", path], "inspect Home DMG signature");
  const text = `${detail.stdout}\n${detail.stderr}`;
  const teamId = capture(text, /^TeamIdentifier=([A-Z0-9]{10})$/m, "Home DMG team identifier");
  const cdHash = capture(text, /^CDHash=([a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?)$/m, "Home DMG CDHash")
    .toLowerCase();
  if (teamId !== expectedTeamId || !/^Timestamp=.+$/m.test(text)) {
    throw new Error("Home DMG native signature evidence is invalid");
  }
  return Object.freeze({ teamId, cdHash, secureTimestamp: true });
}

function parseAcceptedSubmission(stdout: string): Readonly<{ id: string }> {
  let value: unknown;
  try { value = JSON.parse(stdout); }
  catch { throw new Error("notarytool submit returned invalid JSON"); }
  if (!isRecord(value) || value["status"] !== "Accepted" ||
    typeof value["id"] !== "string" || !uuid(value["id"])) {
    throw new Error("Apple notarization did not return an accepted submission");
  }
  return Object.freeze({ id: value["id"] });
}

export function createHomeMacosActivationBinding(raw: unknown): HomeMacosActivationBinding {
  const root = exactRecord(raw, "installed activation evidence", [
    "schema", "evidence", "host", "fixture", "predecessor", "candidate", "scenarios",
  ]);
  if (root["schema"] !== "dome.home-installed-upgrade-rehearsal/v1" ||
    root["evidence"] !== "installed-darwin-arm64") {
    throw new Error("installed activation evidence envelope is invalid");
  }
  const host = exactRecord(root["host"], "installed activation host", ["platform", "arch", "uid"]);
  if (host["platform"] !== "darwin" || host["arch"] !== "arm64" ||
    !Number.isSafeInteger(host["uid"]) || (host["uid"] as number) < 0) {
    throw new Error("installed activation host evidence is invalid");
  }
  const scenarios = parseActivationScenarios(root["scenarios"]);
  return Object.freeze({
    schema: HOME_ACTIVATION_BINDING_SCHEMA,
    predecessor: parseActivationIdentity(root["predecessor"], "predecessor"),
    candidate: parseActivationIdentity(root["candidate"], "candidate"),
    fixture: parseActivationFixture(root["fixture"]),
    scenarios,
  });
}

export function parseHomeMacosActivationBinding(value: unknown): HomeMacosActivationBinding {
  const root = exactRecord(value, "Home activation binding", [
    "schema", "predecessor", "candidate", "fixture", "scenarios",
  ]);
  if (root["schema"] !== HOME_ACTIVATION_BINDING_SCHEMA) {
    throw new Error("unsupported Home activation binding schema");
  }
  return Object.freeze({
    schema: HOME_ACTIVATION_BINDING_SCHEMA,
    predecessor: parseActivationIdentity(root["predecessor"], "predecessor"),
    candidate: parseActivationIdentity(root["candidate"], "candidate"),
    fixture: parseActivationFixture(root["fixture"]),
    scenarios: parseActivationScenarios(root["scenarios"]),
  });
}

function parseActivationIdentity(value: unknown, label: string): HomeMacosActivationBinding["candidate"] {
  const row = exactRecord(value, `${label} activation identity`, [
    "artifactId", "version", "buildCommit", "archiveSha256", "manifestSha256",
  ]);
  if (!sha(row["artifactId"]) || !boundedString(row["version"]) || !objectId(row["buildCommit"]) ||
    !sha(row["archiveSha256"]) || !sha(row["manifestSha256"])) {
    throw new Error(`${label} activation identity is invalid`);
  }
  return Object.freeze({
    artifactId: row["artifactId"],
    version: row["version"],
    buildCommit: row["buildCommit"],
    archiveSha256: row["archiveSha256"],
    manifestSha256: row["manifestSha256"],
  });
}

function parseActivationFixture(value: unknown): HomeMacosActivationBinding["fixture"] {
  const row = exactRecord(value, "activation fixture", ["releaseId", "sourceCommit", "canaryDigest"]);
  if (!boundedString(row["releaseId"]) || !objectId(row["sourceCommit"]) || !sha(row["canaryDigest"])) {
    throw new Error("activation fixture is invalid");
  }
  return Object.freeze({
    releaseId: row["releaseId"], sourceCommit: row["sourceCommit"], canaryDigest: row["canaryDigest"],
  });
}

function parseActivationScenarios(value: unknown): HomeMacosActivationBinding["scenarios"] {
  const expected = ["ready-success", "stopped-precommit-crash", "committed-exact-repair"] as const;
  if (!Array.isArray(value) || JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error("activation scenarios are not exact");
  }
  return Object.freeze([...expected]);
}

function parseAcceptedNotaryLog(
  stdout: string,
  expected: Readonly<{ submissionId: string; archiveFilename: string; sha256: string }>,
): void {
  let value: unknown;
  try { value = JSON.parse(stdout); }
  catch { throw new Error("notarytool log returned invalid JSON"); }
  if (!isRecord(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([
    "archiveFilename", "issues", "jobId", "logFormatVersion", "sha256", "status", "statusCode",
    "statusSummary", "ticketContents", "uploadDate",
  ])) throw new Error("Apple notarization log has unknown or missing fields");
  const issues = value["issues"];
  const ticketContents = value["ticketContents"];
  if (value["logFormatVersion"] !== 1 || typeof value["jobId"] !== "string" ||
    value["jobId"].toLowerCase() !== expected.submissionId.toLowerCase() ||
    value["status"] !== "Accepted" || value["statusSummary"] !== "Ready for distribution" ||
    value["statusCode"] !== 0 || typeof value["uploadDate"] !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value["uploadDate"]) ||
    value["archiveFilename"] !== expected.archiveFilename || value["sha256"] !== expected.sha256 ||
    !(issues === null || (Array.isArray(issues) && issues.length === 0)) ||
    !Array.isArray(ticketContents) || ticketContents.length === 0 || ticketContents.some((item) => {
      if (!isRecord(item)) return true;
      const keys = JSON.stringify(Object.keys(item).sort());
      if (keys !== JSON.stringify(["cdhash", "digestAlgorithm", "path"]) &&
        keys !== JSON.stringify(["arch", "cdhash", "digestAlgorithm", "path"])) return true;
      return !boundedString(item["path"]) || item["digestAlgorithm"] !== "SHA-256" ||
        typeof item["cdhash"] !== "string" || !/^[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?$/.test(item["cdhash"]) ||
        ("arch" in item && !boundedString(item["arch"]));
    })) {
    throw new Error("Apple notarization log does not bind the accepted Home DMG");
  }
}

async function checked(
  run: DistributionCommandRunner,
  argv: ReadonlyArray<string>,
  label: string,
  sensitive: ReadonlyArray<string> = [],
): Promise<DistributionCommandResult> {
  const result = await run(Object.freeze([...argv]));
  if (result.exitCode !== 0) {
    const detail = redactDiagnostic(result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`, sensitive);
    throw new Error(`${label} failed: ${detail}`);
  }
  return result;
}

async function runCommand(argv: ReadonlyArray<string>): Promise<DistributionCommandResult> {
  const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return Object.freeze({ exitCode, stdout, stderr });
}

export async function inventoryMachO(root: string): Promise<ReadonlyArray<string>> {
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && await isMachO(absolute)) {
        found.push(relative(root, absolute).split(sep).join("/"));
      } else if (entry.isSymbolicLink()) {
        const target = resolve(dirname(absolute), await readlink(absolute));
        try {
          if ((await lstat(target)).isFile() && await isMachO(target)) {
            throw new Error(`Home artifact contains a symlink alias to native code: ${relative(root, absolute)}`);
          }
        } catch (error) {
          if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
        }
      }
    }
  }
  await visit(root);
  return Object.freeze(found.sort());
}

async function isMachO(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(4);
    const result = await handle.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead !== 4) return false;
    return new Set([
      "feedface", "feedfacf", "cefaedfe", "cffaedfe",
      "cafebabe", "bebafeca", "cafebabf", "bfbafeca",
    ]).has(bytes.toString("hex"));
  } finally { await handle.close(); }
}

async function fileEvidence(path: string): Promise<FileEvidence> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`distribution evidence path is not a file: ${path}`);
  return Object.freeze({ bytes: info.size, sha256: sha256(await readFile(path)) });
}

async function readBoundedJson(path: string, maximumBytes: number): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes) {
    throw new Error(`distribution JSON is not a bounded direct file: ${basename(path)}`);
  }
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; }
  catch { throw new Error(`distribution JSON is invalid: ${basename(path)}`); }
}

function capture(text: string, pattern: RegExp, label: string): string {
  const value = pattern.exec(text)?.[1];
  if (value === undefined) throw new Error(`codesign did not report ${label}`);
  return value;
}

function assertTeamId(value: string, label: string): void {
  if (!/^[A-Z0-9]{10}$/.test(value)) throw new Error(`${label} must be a ten-character Apple team id`);
}

function uuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}

function sha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(value: unknown, label: string, keys: ReadonlyArray<string>): Record<string, unknown> {
  if (!isRecord(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  return value;
}

function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\0\r\n]/.test(value);
}

function objectId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);
}

function redactDiagnostic(value: string, sensitive: ReadonlyArray<string> = []): string {
  let redacted = value
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(DOME_NOTARY_KEYCHAIN_PROFILE|DOME_CODESIGN_IDENTITY)=\S+/g, "$1=[REDACTED]");
  for (const secret of sensitive) {
    if (secret !== "") redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted.length <= 2_048 ? redacted : `${redacted.slice(0, 2_047)}…`;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function requiredEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function assertDistributionConfig(config: HomeMacosDistributionConfig): void {
  assertTeamId(config.teamId, "Dome signing team");
  if (config.signingIdentity.length > 512 || /[\0\r\n]/.test(config.signingIdentity) ||
    !config.signingIdentity.startsWith("Developer ID Application:") ||
    !config.signingIdentity.endsWith(`(${config.teamId})`)) {
    throw new Error("DOME_CODESIGN_IDENTITY must be a Developer ID Application identity for DOME_APPLE_TEAM_ID");
  }
  if (config.notaryKeychainProfile.length > 256 || /[\0\r\n]/.test(config.notaryKeychainProfile)) {
    throw new Error("DOME_NOTARY_KEYCHAIN_PROFILE is invalid");
  }
}

async function prepareDistributionParent(parentInput: string): Promise<DistributionParent> {
  await mkdir(parentInput, { recursive: true });
  const info = await lstat(parentInput);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Home distribution output parent must be a direct directory: ${parentInput}`);
  }
  const canonical = await realpath(parentInput);
  const canonicalInfo = await lstat(canonical);
  if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink() ||
    canonicalInfo.dev !== info.dev || canonicalInfo.ino !== info.ino) {
    throw new Error(`Home distribution output parent identity is inconsistent: ${parentInput}`);
  }
  return Object.freeze({ lexical: parentInput, canonical, device: info.dev, inode: info.ino });
}

async function reproveDistributionParent(parent: DistributionParent): Promise<void> {
  const info = await lstat(parent.lexical);
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== parent.device || info.ino !== parent.inode ||
    await realpath(parent.lexical) !== parent.canonical) {
    throw new Error(`Home distribution output parent changed during publication: ${parent.lexical}`);
  }
}

async function assertDistributionTargetAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error(`Home distribution output path already exists: ${path}`);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

async function pathPresent(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function syncRegularFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`distribution sync path is not a direct file: ${path}`);
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`distribution sync path is not a direct directory: ${path}`);
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
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
  const result = await buildHomeMacosDistribution({
    config: readHomeMacosDistributionConfig(),
    ...(outputDir === undefined ? {} : { outputDir }),
  });
  process.stdout.write(`${JSON.stringify({
    schema: result.evidence.schema,
    envelope: result.envelope,
    publicDirectory: result.publicDirectory,
    dmg: result.dmg,
    receipt: result.receipt,
    activationBinding: result.activationBinding,
    privateReleaseEvidence: result.privateReleaseEvidence,
    receiptSha256: result.receiptSha256,
    artifactId: result.evidence.artifact.id,
    dmgSha256: result.evidence.container.distributed.sha256,
    notarizationStatus: result.evidence.notarization.status,
  }, null, 2)}\n`);
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(`${redactDiagnostic(error instanceof Error ? error.message : String(error), [
        process.env["DOME_NOTARY_KEYCHAIN_PROFILE"] ?? "",
        process.env["DOME_CODESIGN_IDENTITY"] ?? "",
      ])}\n`);
      process.exit(1);
    },
  );
}
