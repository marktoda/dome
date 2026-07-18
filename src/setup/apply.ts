import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  commitFilesOnHead,
  commitInitialFiles,
  currentBranch,
  currentSha,
  initRepo,
  listTreeEntriesAtCommit,
  readBlob,
  readBlobBytes,
  readCommitRecord,
  recoverIndexAfterExactCommit,
  replayBranchRefDurability,
  statusMatrix,
} from "../git";
import { compileSetupPlan, type SetupCompilerInput, type SetupScaffoldEvidence } from "./compiler";
import {
  SETUP_APPLY_RESULT_SCHEMA,
  type AdaptationAction,
  type SetupApplyResult,
  type SetupConsent,
  type SetupPlan,
  validateSetupApplyResult,
  validateSetupConsent,
  validateSetupPlan,
} from "./contracts";
import { setupPlanSha256 } from "./consent";
import { AnchoredVaultFiles, type AnchoredRegularFile } from "./anchored-files";
import { canonicalSetupDiscoveryDeps } from "./defaults";
import { assertSupportedSetupHost } from "./platform";
import {
  discoverSetupCompilerInput,
  type SetupDiscoveryDeps,
} from "./discovery";

export const SETUP_DURABLE_BOUNDARIES = [
  "vault-directory-created",
  "git-initialized",
  "owner-baseline-ref-advanced",
  "owner-baseline-committed",
  "scaffold-directories-created",
  "agents-orientation-prepared",
  "agents-orientation-published",
  "claude-orientation-prepared",
  "claude-orientation-published",
  "gitignore-prepared",
  "gitignore-published",
  "scaffold-files-written",
  "content-scope-prepared",
  "content-scope-published",
  "content-scope-written",
  "configuration-ref-advanced",
  "configuration-committed",
] as const;
export type SetupDurableBoundary = typeof SETUP_DURABLE_BOUNDARIES[number];

type SetupApplyDeps = Readonly<{
  discovery?: SetupDiscoveryDeps | undefined;
  discover?: ((targetPath: string, deps: SetupDiscoveryDeps) => Promise<SetupCompilerInput>) | undefined;
  afterBoundary?: ((boundary: SetupDurableBoundary) => Promise<void>) | undefined;
  preflightPlatform?: (() => void | Promise<void>) | undefined;
  afterPublicationTransition?: ((
    transition: SetupPublicationTransition,
    relativePath: string,
  ) => Promise<void>) | undefined;
}>;

export type SetupPublicationTransition = "candidate-durable" | "destination-linked-durable";

type ApplyContext = Readonly<{
  plan: SetupPlan;
  digest: string;
  target: string;
  scaffold: SetupScaffoldEvidence;
  discovery: SetupDiscoveryDeps;
  discover: (targetPath: string, deps: SetupDiscoveryDeps) => Promise<SetupCompilerInput>;
  actualWrites: Set<string>;
  filesystem: { current: AnchoredVaultFiles | null };
  afterBoundary: (boundary: SetupDurableBoundary) => Promise<void>;
  afterPublicationTransition: (
    transition: SetupPublicationTransition,
    relativePath: string,
  ) => Promise<void>;
}>;

type RecoveryPrefix = "none" | "directory" | "git" | "baseline" | "scaffold-dirty" | "complete" | "conflict";
const PUBLICATION_WITNESS_MAX_BYTES = 4_096;

/** Production entry point. Tests use createSetupPlanApplier to inject discovery and faults. */
export async function applySetupPlan(plan: SetupPlan, consent: SetupConsent): Promise<SetupApplyResult> {
  return createSetupPlanApplier()(plan, consent);
}

/** Local-substitutable construction seam; the mutation algorithm stays one Module. */
export function createSetupPlanApplier(deps: SetupApplyDeps = {}) {
  const discovery = canonicalSetupDiscoveryDeps(deps.discovery);
  const discover = deps.discover ?? discoverSetupCompilerInput;
  const scaffold = discovery.scaffold;
  if (scaffold === undefined) throw new Error("setup apply requires canonical scaffold evidence");

  return async (planInput: SetupPlan, consentInput: SetupConsent): Promise<SetupApplyResult> => {
    const plan = validateSetupPlan(planInput);
    const consent = validateSetupConsent(consentInput);
    const digest = setupPlanSha256(plan);
    if (consent.planSha256 !== digest) {
      return blocked(digest, "consent-mismatch", "Setup consent does not match this immutable plan.", plan.recoveryCommands);
    }
    if (plan.status === "blocked") {
      return blocked(digest, "plan-blocked", "The approved setup plan is blocked and cannot be applied.", plan.recoveryCommands);
    }
    try { await (deps.preflightPlatform ?? assertSupportedSetupHost)(); }
    catch (error) {
      return blocked(
        digest,
        "mutation-conflict",
        error instanceof Error ? error.message : String(error),
        plan.recoveryCommands,
      );
    }

    const target = resolve(plan.assessment.target.path);
    const freshPlan = compileSetupPlan(await discover(target, discovery));
    const freshDigest = setupPlanSha256(freshPlan);
    let prefix: RecoveryPrefix = "none";
    if (freshDigest !== digest) {
      prefix = await inspectRecoveryPrefix(plan, freshPlan, digest, scaffold);
      if (prefix === "none") return stale(digest, freshPlan);
      if (prefix === "conflict") {
        return blocked(
          digest,
          "mutation-conflict",
          "Setup found a partial transaction plus changes it cannot prove belong to this plan.",
          plan.recoveryCommands,
        );
      }
      if (prefix === "complete") return completed(plan, digest, await admittedCommitIdsFor(plan, digest, scaffold));
    }

    const context: ApplyContext = {
      plan,
      digest,
      target,
      scaffold,
      discovery,
      discover,
      actualWrites: new Set(),
      filesystem: { current: null },
      afterBoundary: deps.afterBoundary ?? (async () => {}),
      afterPublicationTransition: deps.afterPublicationTransition ?? (async () => {}),
    };
    try {
      const commits = await execute(context, prefix);
      const verification = compileSetupPlan(await discover(target, discovery));
      if (verification.assessment.dome.state !== "configured" || !await worktreeMatchesCompletedPlan(plan)) {
        return blocked(
          digest,
          "verification-failed",
          "Vault adaptation finished writing but the resulting setup check is not clean and configured.",
          verification.recoveryCommands,
        );
      }
      return completed(plan, digest, commits);
    } catch (error) {
      // Fault injection deliberately escapes so a new process can prove
      // convergence. Ordinary collisions become a recovery-shaped result.
      if (error instanceof InjectedSetupFault) throw error;
      return blocked(
        digest,
        "mutation-conflict",
        error instanceof Error ? error.message : String(error),
        plan.recoveryCommands,
      );
    } finally {
      await context.filesystem.current?.close();
      context.filesystem.current = null;
    }
  };
}

export class InjectedSetupFault extends Error {
  constructor(readonly boundary: SetupDurableBoundary) {
    super(`injected setup fault after ${boundary}`);
    this.name = "InjectedSetupFault";
  }
}

export function failSetupAfter(boundary: SetupDurableBoundary) {
  return async (observed: SetupDurableBoundary): Promise<void> => {
    if (observed === boundary) throw new InjectedSetupFault(boundary);
  };
}

async function execute(
  context: ApplyContext,
  prefix: RecoveryPrefix,
): Promise<{ baseline: string | null; configuration: string | null }> {
  const { plan, digest, target } = context;
  let commits = await admittedCommitIdsFor(plan, digest, context.scaffold);

  if (action(plan, "create-vault-directory") !== undefined && prefix === "none") {
    await mkdir(target, { mode: 0o755 });
    await context.afterBoundary("vault-directory-created");
  }
  if (action(plan, "initialize-git") !== undefined && (prefix === "none" || prefix === "directory")) {
    await initRepo(target, "main");
    await context.afterBoundary("git-initialized");
  }
  context.filesystem.current = await AnchoredVaultFiles.open(target);

  const baseline = action(plan, "commit-owner-baseline");
  if (baseline !== undefined && commits.baseline === null &&
    prefix !== "baseline" && prefix !== "scaffold-dirty" && prefix !== "complete") {
    await admitOwnerEvidence(context);
    if (await currentSha(target) !== null || await currentBranch(target) !== "main") {
      throw new Error("owner baseline parent is no longer the approved unborn main branch");
    }
    const files = await Promise.all(baseline.paths.map(async (filepath) => {
      const content = await readFile(join(target, filepath));
      const candidate = plan.assessment.repository.candidates.find((row) => row.path === filepath)!;
      if (candidate.contentSha256 === null || candidate.gitMode === null || sha256(content) !== candidate.contentSha256) {
        throw new Error(`owner baseline changed after admission: ${filepath}`);
      }
      return { filepath, content, mode: candidate.gitMode };
    }));
    const oid = await commitInitialFiles({
      path: target,
      files,
      message: phaseMessage(baseline.message, digest, "baseline"),
      expectedBranch: "main",
      lockOwnerToken: setupGitLockOwner(digest, "baseline"),
      afterRefAdvance: async () => context.afterBoundary("owner-baseline-ref-advanced"),
    });
    commits = await admittedCommitIdsFor(plan, digest, context.scaffold);
    if (commits.baseline !== oid) throw new Error("owner baseline commit failed exact post-commit admission");
    await context.afterBoundary("owner-baseline-committed");
  }

  if (prefix === "scaffold-dirty") await verifyPlannedWritePrefix(context);
  for (const directory of plan.actions.filter((row): row is Extract<AdaptationAction, { kind: "ensure-scaffold-directory" }> =>
    row.kind === "ensure-scaffold-directory")) {
    await anchored(context).ensureDirectory(directory.path, Number.parseInt(directory.mode, 8), true);
  }
  if (plan.actions.some((row) => row.kind === "ensure-scaffold-directory")) {
    await context.afterBoundary("scaffold-directories-created");
  }

  for (const write of plan.actions.filter((row): row is Extract<AdaptationAction, { kind: "write-scaffold-file" }> =>
    row.kind === "write-scaffold-file")) {
    const body = scaffoldWriteBody(write, context.scaffold);
    assertWriteEvidence(write, body);
    if (await publishScaffoldIfAbsent(context, write.path, body, scaffoldPreparedBoundary(write))) {
      context.actualWrites.add(write.path);
    }
  }
  if (plan.actions.some((row) => row.kind === "write-scaffold-file")) {
    await context.afterBoundary("scaffold-files-written");
  }

  const config = action(plan, "set-content-scope");
  if (config !== undefined) {
    const body = contentScopeWriteBody(config, context.scaffold);
    assertWriteEvidence(config.write, body);
    if (await publishScaffoldIfAbsent(
      context,
      config.write.path,
      body,
      "content-scope-prepared",
    )) context.actualWrites.add(config.write.path);
    await context.afterBoundary("content-scope-written");
  }

  if (commits.configuration === null && hasConfigurationWork(plan)) {
    await admitOwnerEvidence(context);
    const files = await exactActualWrites(context);
    if (files.length > 0) {
      const parent = await currentSha(target);
      const expectedParent = commits.baseline ?? plan.assessment.revision.head;
      if (parent !== expectedParent) throw new Error("configuration parent changed after admission");
      const message = phaseMessage("Dome setup: configure vault", digest, "configuration");
      const expectedBranch = action(plan, "initialize-git") === undefined
        ? plan.assessment.git.branch!
        : "main";
      const oid = parent === null
        ? await commitInitialFiles({
          path: target,
          files: files.map((file) => ({ ...file, content: Buffer.from(file.content) })),
          message,
          expectedBranch,
          lockOwnerToken: setupGitLockOwner(digest, "configuration"),
          afterRefAdvance: async () => context.afterBoundary("configuration-ref-advanced"),
        })
        : await commitFilesOnHead({
          path: target,
          files,
          message,
          expectedHead: parent,
          expectedBranch,
          retryOnCas: false,
          lockOwnerToken: setupGitLockOwner(digest, "configuration"),
          afterRefAdvance: async () => context.afterBoundary("configuration-ref-advanced"),
        });
      commits = await admittedCommitIdsFor(plan, digest, context.scaffold);
      if (commits.configuration !== oid) throw new Error("configuration commit failed exact post-commit admission");
      await context.afterBoundary("configuration-committed");
    }
  }
  return commits;
}

async function inspectRecoveryPrefix(
  plan: SetupPlan,
  freshPlan: SetupPlan,
  digest: string,
  scaffold: SetupScaffoldEvidence,
): Promise<RecoveryPrefix> {
  const target = plan.assessment.target.path;
  const stat = await safeLstat(target);
  if (stat === null) return "none";
  if (!stat.isDirectory() || stat.isSymbolicLink()) return "conflict";

  const gitStat = await safeLstat(join(target, ".git"));
  if (gitStat === null) {
    if (plan.assessment.target.state !== "missing") return "none";
    return await directoryIsEmpty(target) ? "directory" : "conflict";
  }
  if (gitStat.isSymbolicLink() ||
    (action(plan, "initialize-git") !== undefined && !gitStat.isDirectory()) ||
    (action(plan, "initialize-git") === undefined && !gitStat.isDirectory() && !gitStat.isFile())) return "conflict";

  let commits: { baseline: string | null; configuration: string | null };
  try { commits = await admittedCommitIdsFor(plan, digest, scaffold); }
  catch { return "conflict"; }
  const existingGitPlan = action(plan, "initialize-git") === undefined;
  const existingGitWrites = (existingGitPlan || commits.baseline !== null || commits.configuration !== null)
    ? await inspectPlannedWritePrefix(plan, scaffold, digest)
    : null;
  if (existingGitPlan && commits.configuration === null && existingGitWrites?.observed !== true) {
    const reservedState = await safeLstat(join(
      target,
      ".dome/state/setup",
      digest,
      "candidates",
    ));
    if (reservedState === null) return "none";
    if (!reservedState.isDirectory() || reservedState.isSymbolicLink()) return "conflict";
  }
  if (commits.configuration !== null &&
    (existingGitWrites?.valid !== true || existingGitWrites.observed !== true)) return "conflict";
  if (!sameExternalEvidence(plan, freshPlan) || !await sameOwnerEvidence(plan, freshPlan, scaffold)) return "conflict";
  try { await restoreAdmittedIndex(plan, commits); }
  catch { return "conflict"; }
  if (commits.configuration !== null) {
    return await currentSha(target) === commits.configuration && await worktreeMatchesCompletedPlan(plan)
      ? "complete" : "conflict";
  }
  const expectedOriginalHead = plan.assessment.revision.head;
  const currentHead = await currentSha(target);
  const currentBranchName = await currentBranch(target);
  if (existingGitPlan) {
    if (currentHead !== expectedOriginalHead || currentBranchName !== plan.assessment.git.branch) return "conflict";
    const writes = existingGitWrites!;
    if (!writes.valid || !await onlyPlannedDirtyPaths(plan)) return "conflict";
    return "scaffold-dirty";
  }
  if (commits.baseline !== null) {
    if (currentHead !== commits.baseline) return "conflict";
    const writes = await inspectPlannedWritePrefix(plan, scaffold, digest);
    return writes.valid && await onlyPlannedDirtyPaths(plan)
      ? (await isClean(target) ? "baseline" : "scaffold-dirty")
      : "conflict";
  }

  const head = currentHead;
  const branch = await currentBranch(target);
  if (head !== null || branch !== "main") return "conflict";
  return "git";
}

async function restoreAdmittedIndex(
  plan: SetupPlan,
  commits: { baseline: string | null; configuration: string | null },
): Promise<void> {
  const branch = action(plan, "initialize-git") === undefined
    ? plan.assessment.git.branch!
    : "main";
  if (commits.configuration !== null) {
    await replayBranchRefDurability({
      path: plan.assessment.target.path,
      branch,
      value: commits.configuration,
      lockOwnerToken: setupGitLockOwner(setupPlanSha256(plan), "configuration"),
    });
    const record = await readCommitRecord(plan.assessment.target.path, commits.configuration);
    await recoverIndexAfterExactCommit({
      path: plan.assessment.target.path,
      commit: commits.configuration,
      parent: record.parents[0] ?? null,
      files: expectedConfigurationPaths(plan),
      lockOwnerToken: setupGitLockOwner(setupPlanSha256(plan), "configuration"),
    });
  } else if (commits.baseline !== null) {
    await replayBranchRefDurability({
      path: plan.assessment.target.path,
      branch,
      value: commits.baseline,
      lockOwnerToken: setupGitLockOwner(setupPlanSha256(plan), "baseline"),
    });
    await recoverIndexAfterExactCommit({
      path: plan.assessment.target.path,
      commit: commits.baseline,
      parent: null,
      files: action(plan, "commit-owner-baseline")?.paths ?? [],
      lockOwnerToken: setupGitLockOwner(setupPlanSha256(plan), "baseline"),
    });
  }
}

function expectedConfigurationPaths(plan: SetupPlan): string[] {
  return plan.actions.flatMap((row) => {
    if (row.kind === "write-scaffold-file" && !wasPresentAtAssessment(plan, row.path)) return [row.path];
    if (row.kind === "set-content-scope") return [row.write.path];
    return [];
  }).sort();
}

async function publishScaffoldIfAbsent(
  context: ApplyContext,
  path: string,
  body: string,
  preparedBoundary: SetupPreparedBoundary,
): Promise<boolean> {
  const existing = await anchored(context).readRegular(path, bodyReadLimit(body));
  if (existing !== null) {
    if (wasPresentAtAssessment(context.plan, path)) return false;
    await promoteLinkedPreparedPublication(context, path, body, 0o644, existing);
    if (existing.body !== body || existing.mode !== 0o644 ||
      !await hasPublishedWitness(context, path, body, 0o644, existing)) {
      throw new Error(`setup refused to replace unexpected ${path}`);
    }
    await replayPublicationDurability(context, path, body, 0o644);
    return true;
  }
  await publishAtomic(context, path, body, 0o644, preparedBoundary);
  return true;
}

async function publishAtomic(
  context: ApplyContext,
  relativePath: string,
  body: string,
  mode: number,
  preparedBoundary: SetupPreparedBoundary,
): Promise<void> {
  const files = anchored(context);
  let identity = await readWitnessIdentity(context, relativePath, body, mode, "prepared");
  if (identity === null) {
    await ensureCandidateDirectory(context);
    const temp = publicationCandidatePath(context.digest, relativePath);
    await files.createExclusive(temp, body, mode);
    await files.syncParent(temp);
    await context.afterPublicationTransition("candidate-durable", temp);
    const candidate = await requireRegular(context, temp);
    identity = publicationIdentity(temp, candidate);
    await ensureWitness(context, relativePath, body, mode, "prepared", identity);
  } else {
    await requireOwnedCandidate(context, relativePath, body, mode, identity);
  }
  await context.afterBoundary(preparedBoundary);

  // The destination was admitted absent before preparation. Even an
  // identical concurrent publication is not attributable to this call and
  // must not be folded into Dome's configuration commit. Crash recovery
  // admits an already-published exact destination before reaching here.
  await files.linkExclusive(identity.candidatePath, relativePath);
  await files.syncParent(relativePath);
  await context.afterPublicationTransition("destination-linked-durable", relativePath);
  const published = await requireRegular(context, relativePath, body);
  if (!samePublicationIdentity(published, identity) || published.body !== body || published.mode !== mode) {
    throw new Error(`setup refused changed publication candidate for ${relativePath}`);
  }
  await ensureWitness(context, relativePath, body, mode, "published", identity);
  await context.afterBoundary(publishedBoundary(preparedBoundary));
  await removeOwnedCandidate(context, relativePath, body, mode, identity);
}

async function removeOwnedCandidate(
  context: ApplyContext,
  path: string,
  body: string,
  mode: number,
  identity: PublicationIdentity,
): Promise<void> {
  const opened = await anchored(context).readRegular(identity.candidatePath, bodyReadLimit(body));
  if (opened === null) return;
  if (!samePublicationIdentity(opened, identity) || opened.body !== body || opened.mode !== mode) {
    throw new Error(`setup temporary publication collision for ${path}`);
  }
  await anchored(context).unlink(identity.candidatePath);
  await anchored(context).syncParent(identity.candidatePath);
}

function publicationCandidatePath(digest: string, path: string): string {
  return `.dome/state/setup/${digest}/candidates/${sha256(path)}-${randomBytes(12).toString("hex")}.tmp`;
}

type PublicationPhase = "prepared" | "published";
type PublicationIdentity = Readonly<{
  candidatePath: string;
  dev: string;
  ino: string;
}>;

function publicationIdentity(
  candidatePath: string,
  file: AnchoredRegularFile,
): PublicationIdentity {
  return Object.freeze({
    candidatePath,
    dev: file.dev.toString(),
    ino: file.ino.toString(),
  });
}

function samePublicationIdentity(
  file: AnchoredRegularFile,
  identity: PublicationIdentity,
): boolean {
  return file.dev.toString() === identity.dev && file.ino.toString() === identity.ino;
}

function anchored(context: ApplyContext): AnchoredVaultFiles {
  const files = context.filesystem.current;
  if (files === null) throw new Error("setup filesystem is not bound to the approved vault");
  return files;
}

async function requireRegular(
  context: ApplyContext,
  path: string,
  expectedBody?: string,
): Promise<AnchoredRegularFile> {
  const opened = await anchored(context).readRegular(
    path,
    expectedBody === undefined ? {} : bodyReadLimit(expectedBody),
  );
  if (opened === null) throw new Error(`setup requires a direct regular file at ${path}`);
  return opened;
}

type SetupPreparedBoundary =
  | "agents-orientation-prepared"
  | "claude-orientation-prepared"
  | "gitignore-prepared"
  | "content-scope-prepared";

function publishedBoundary(prepared: SetupPreparedBoundary): SetupDurableBoundary {
  if (prepared === "agents-orientation-prepared") return "agents-orientation-published";
  if (prepared === "claude-orientation-prepared") return "claude-orientation-published";
  if (prepared === "gitignore-prepared") return "gitignore-published";
  return "content-scope-published";
}

function witnessPath(
  context: ApplyContext,
  path: string,
  phase: PublicationPhase,
): string {
  return `.dome/state/setup/${context.digest}/${sha256(path)}.${phase}.json`;
}

function witnessBody(
  context: ApplyContext,
  path: string,
  body: string,
  mode: number,
  phase: PublicationPhase,
  identity: PublicationIdentity,
): string {
  return publicationWitnessBody(context.digest, path, body, mode, phase, identity);
}

function publicationWitnessBody(
  digest: string,
  path: string,
  body: string,
  mode: number,
  phase: PublicationPhase,
  identity: PublicationIdentity,
): string {
  return `${JSON.stringify({
    schema: "dome.setup.publication-witness/v1",
    planSha256: digest,
    path,
    operation: "create",
    contentSha256: sha256(body),
    mode: mode.toString(8).padStart(4, "0"),
    phase,
    candidatePath: identity.candidatePath,
    candidateDev: identity.dev,
    candidateIno: identity.ino,
  })}\n`;
}

async function ensureWitness(
  context: ApplyContext,
  path: string,
  body: string,
  mode: number,
  phase: PublicationPhase,
  identity: PublicationIdentity,
): Promise<void> {
  const files = anchored(context);
  await files.ensureDirectory(".dome", 0o755);
  await files.ensureDirectory(".dome/state", 0o700, true);
  await files.ensureDirectory(".dome/state/setup", 0o700, true);
  await files.ensureDirectory(`.dome/state/setup/${context.digest}`, 0o700, true);
  const relative = witnessPath(context, path, phase);
  const expected = witnessBody(context, path, body, mode, phase, identity);
  const existing = await files.readRegular(relative, { maxBytes: PUBLICATION_WITNESS_MAX_BYTES });
  if (existing === null) await files.createExclusive(relative, expected, 0o600);
  else if (existing.body !== expected || existing.mode !== 0o600) {
    throw new Error(`setup publication witness collision for ${path}`);
  }
  await files.syncParent(relative);
}

async function hasPublishedWitness(
  context: ApplyContext,
  path: string,
  body: string,
  mode: number,
  final: AnchoredRegularFile,
): Promise<boolean> {
  const identity = await readWitnessIdentity(context, path, body, mode, "published");
  return identity !== null && samePublicationIdentity(final, identity);
}

async function ensureCandidateDirectory(context: ApplyContext): Promise<void> {
  const files = anchored(context);
  await files.ensureDirectory(".dome", 0o755);
  await files.ensureDirectory(".dome/state", 0o700, true);
  await files.ensureDirectory(".dome/state/setup", 0o700, true);
  await files.ensureDirectory(`.dome/state/setup/${context.digest}`, 0o700, true);
  await files.ensureDirectory(`.dome/state/setup/${context.digest}/candidates`, 0o700, true);
}

async function readWitnessIdentity(
  context: ApplyContext,
  path: string,
  body: string,
  mode: number,
  phase: PublicationPhase,
): Promise<PublicationIdentity | null> {
  const witness = await readOptionalRegular(
    anchored(context),
    witnessPath(context, path, phase),
    { maxBytes: PUBLICATION_WITNESS_MAX_BYTES },
  );
  if (witness === null) return null;
  if (witness.mode !== 0o600) throw new Error(`setup publication witness collision for ${path}`);
  const identity = decodePublicationWitness(
    witness.body,
    context.digest,
    path,
    body,
    mode,
    phase,
  );
  if (identity === null) throw new Error(`setup publication witness collision for ${path}`);
  return identity;
}

function decodePublicationWitness(
  witnessBodyValue: string,
  digest: string,
  path: string,
  body: string,
  mode: number,
  phase: PublicationPhase,
): PublicationIdentity | null {
  let parsed: unknown;
  try { parsed = JSON.parse(witnessBodyValue); }
  catch { return null; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  const identity: PublicationIdentity = Object.freeze({
    candidatePath: typeof row.candidatePath === "string" ? row.candidatePath : "",
    dev: typeof row.candidateDev === "string" ? row.candidateDev : "",
    ino: typeof row.candidateIno === "string" ? row.candidateIno : "",
  });
  const prefix = `.dome/state/setup/${digest}/candidates/${sha256(path)}-`;
  if (!identity.candidatePath.startsWith(prefix) || !/^[0-9a-f]{24}\.tmp$/.test(identity.candidatePath.slice(prefix.length)) ||
    witnessBodyValue !== publicationWitnessBody(digest, path, body, mode, phase, identity)) {
    return null;
  }
  return identity;
}

async function requireOwnedCandidate(
  context: ApplyContext,
  path: string,
  body: string,
  mode: number,
  identity: PublicationIdentity,
): Promise<AnchoredRegularFile> {
  const candidate = await requireRegular(context, identity.candidatePath, body);
  if (!samePublicationIdentity(candidate, identity) || candidate.body !== body || candidate.mode !== mode) {
    throw new Error(`setup temporary publication collision for ${path}`);
  }
  return candidate;
}

async function promoteLinkedPreparedPublication(
  context: ApplyContext,
  path: string,
  body: string,
  mode: number,
  final: AnchoredRegularFile,
): Promise<void> {
  if (await hasPublishedWitness(context, path, body, mode, final)) return;
  const identity = await readWitnessIdentity(context, path, body, mode, "prepared");
  if (identity === null) return;
  const candidate = await requireOwnedCandidate(context, path, body, mode, identity);
  if (!samePublicationIdentity(final, identity) || !samePublicationIdentity(candidate, identity)) return;
  await ensureWitness(context, path, body, mode, "published", identity);
}

async function replayPublicationDurability(
  context: ApplyContext,
  path: string,
  body: string,
  mode: number,
): Promise<void> {
  const final = await requireRegular(context, path, body);
  if (final.body !== body || final.mode !== mode) {
    throw new Error(`setup publication changed before durability replay: ${path}`);
  }
  // A retry after link but before the directory fsync must perform the
  // fsync again. Exact final bytes alone are never treated as evidence.
  await anchored(context).syncParent(path);
  const identity = await readWitnessIdentity(context, path, body, mode, "published");
  if (identity === null || !samePublicationIdentity(final, identity)) {
    throw new Error(`setup publication identity changed before durability replay: ${path}`);
  }
  await removeOwnedCandidate(context, path, body, mode, identity);
}

async function verifyPlannedWritePrefix(context: ApplyContext): Promise<void> {
  if (!(await inspectPlannedWritePrefix(context.plan, context.scaffold, context.digest)).valid) {
    throw new Error("partial setup writes do not match the approved plan");
  }
}

async function inspectPlannedWritePrefix(
  plan: SetupPlan,
  scaffold: SetupScaffoldEvidence,
  digest: string,
): Promise<{ valid: boolean; observed: boolean }> {
  const files = await AnchoredVaultFiles.open(plan.assessment.target.path);
  try {
    return await inspectPlannedWritePrefixAnchored(plan, scaffold, digest, files);
  } finally {
    await files.close();
  }
}

async function inspectPlannedWritePrefixAnchored(
  plan: SetupPlan,
  scaffold: SetupScaffoldEvidence,
  digest: string,
  files: AnchoredVaultFiles,
): Promise<{ valid: boolean; observed: boolean }> {
  let observed = false;
  for (const directory of plan.actions.filter((row): row is Extract<AdaptationAction, { kind: "ensure-scaffold-directory" }> =>
    row.kind === "ensure-scaffold-directory")) {
    const stat = await safeLstat(join(plan.assessment.target.path, directory.path));
    if (stat !== null) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) return { valid: false, observed: true };
      if (!wasPresentAtAssessment(plan, directory.path)) observed = true;
    }
  }
  for (const write of plan.actions.filter((row): row is Extract<AdaptationAction, { kind: "write-scaffold-file" }> =>
    row.kind === "write-scaffold-file")) {
    if (wasPresentAtAssessment(plan, write.path)) continue;
    const expected = scaffoldWriteBody(write, scaffold);
    const actual = await readOptionalRegular(files, write.path, bodyReadLimit(expected));
    if (actual !== null) {
      observed = true;
      if (actual.body !== expected || actual.mode !== 0o644 ||
        !await recoveryPublishedOrLinked(files, digest, write.path, expected, 0o644, actual)) {
        return { valid: false, observed };
      }
    }
    if (actual === null && await recoveryPreparedWitnessMatches(
      files, digest, write.path, expected, 0o644,
    )) {
      observed = true;
    }
  }
  const config = action(plan, "set-content-scope");
  if (config !== undefined) {
    const expected = contentScopeWriteBody(config, scaffold);
    const actual = await readOptionalRegular(files, config.write.path, bodyReadLimit(expected));
    if (actual === null) {
      if (await recoveryPreparedWitnessMatches(
        files, digest, config.write.path, expected, 0o644,
      )) {
        observed = true;
      }
      return { valid: true, observed };
    }
    observed = true;
    if (actual.body !== expected || actual.mode !== 0o644 ||
      !await recoveryPublishedOrLinked(
        files, digest, config.write.path, expected, 0o644, actual,
      )) {
      return { valid: false, observed };
    }
  }
  return { valid: true, observed };
}

async function recoveryPreparedWitnessMatches(
  files: AnchoredVaultFiles,
  digest: string,
  path: string,
  body: string,
  mode: number,
): Promise<boolean> {
  const relative = `.dome/state/setup/${digest}/${sha256(path)}.prepared.json`;
  try {
    const witness = await files.readRegular(relative, { maxBytes: PUBLICATION_WITNESS_MAX_BYTES });
    if (witness === null || witness.mode !== 0o600) return false;
    const identity = decodePublicationWitness(witness.body, digest, path, body, mode, "prepared");
    if (identity === null) return false;
    const candidate = await files.readRegular(identity.candidatePath, bodyReadLimit(body));
    return candidate !== null && candidate.body === body && candidate.mode === mode &&
      samePublicationIdentity(candidate, identity);
  } catch {
    return false;
  }
}

async function recoveryPublishedOrLinked(
  files: AnchoredVaultFiles,
  digest: string,
  path: string,
  body: string,
  mode: number,
  final: AnchoredRegularFile,
): Promise<boolean> {
  const publishedRelative = `.dome/state/setup/${digest}/${sha256(path)}.published.json`;
  try {
    const published = await files.readRegular(
      publishedRelative,
      { maxBytes: PUBLICATION_WITNESS_MAX_BYTES },
    );
    if (published !== null && published.mode === 0o600) {
      const identity = decodePublicationWitness(published.body, digest, path, body, mode, "published");
      if (identity !== null && samePublicationIdentity(final, identity)) return true;
    }
  } catch {
    return false;
  }
  const relative = `.dome/state/setup/${digest}/${sha256(path)}.prepared.json`;
  try {
    const witness = await files.readRegular(relative, { maxBytes: PUBLICATION_WITNESS_MAX_BYTES });
    if (witness === null || witness.mode !== 0o600) return false;
    const identity = decodePublicationWitness(witness.body, digest, path, body, mode, "prepared");
    if (identity === null || !samePublicationIdentity(final, identity)) return false;
    const candidate = await files.readRegular(identity.candidatePath, bodyReadLimit(body));
    return candidate !== null && candidate.body === body && candidate.mode === mode &&
      samePublicationIdentity(candidate, identity);
  } catch {
    return false;
  }
}

async function readOptionalRegular(
  files: AnchoredVaultFiles,
  path: string,
  options: Readonly<{ maxBytes?: number | undefined }> = {},
): Promise<AnchoredRegularFile | null> {
  try { return await files.readRegular(path, options); }
  catch (error) {
    if (error instanceof Error && error.message.includes("parent directory is not direct")) return null;
    throw error;
  }
}

function bodyReadLimit(body: string): Readonly<{ maxBytes: number }> {
  return { maxBytes: Buffer.byteLength(body, "utf8") };
}

function sameExternalEvidence(original: SetupPlan, fresh: SetupPlan): boolean {
  return JSON.stringify({
    host: original.assessment.host,
    product: original.assessment.product,
    prerequisites: original.assessment.prerequisites,
    installedHome: original.assessment.installedHome,
    proposedScope: original.assessment.markdown.proposedScope,
  }) === JSON.stringify({
    host: fresh.assessment.host,
    product: fresh.assessment.product,
    prerequisites: fresh.assessment.prerequisites,
    installedHome: fresh.assessment.installedHome,
    proposedScope: fresh.assessment.markdown.proposedScope,
  });
}

async function sameOwnerEvidence(
  original: SetupPlan,
  fresh: SetupPlan,
  _scaffold: SetupScaffoldEvidence,
): Promise<boolean> {
  const setupPaths = new Set(original.actions.flatMap((row) => {
    if (row.kind === "ensure-scaffold-directory") return [row.path];
    if (row.kind === "write-scaffold-file") return [row.path];
    if (row.kind === "set-content-scope") return [row.write.path];
    return [];
  }));
  const digest = setupPlanSha256(original);
  const candidateDirectory = `.dome/state/setup/${digest}/candidates`;
  setupPaths.add(".dome/state");
  setupPaths.add(".dome/state/setup");
  setupPaths.add(`.dome/state/setup/${digest}`);
  setupPaths.add(candidateDirectory);
  for (const path of original.actions.flatMap((row) => {
    if (row.kind === "write-scaffold-file") return [row.path];
    if (row.kind === "set-content-scope") return [row.write.path];
    return [];
  })) {
    setupPaths.add(`.dome/state/setup/${digest}/${sha256(path)}.prepared.json`);
    setupPaths.add(`.dome/state/setup/${digest}/${sha256(path)}.published.json`);
  }
  const originalByPath = new Map(original.assessment.repository.candidates.map((row) => [row.path, row]));
  const freshByPath = new Map(fresh.assessment.repository.candidates.map((row) => [row.path, row]));
  for (const [path, row] of originalByPath) {
    const current = freshByPath.get(path);
    if (current === undefined) return false;
    if (current.kind === row.kind && current.bytes === row.bytes && current.proofSha256 === row.proofSha256) continue;
    if (row.kind === "directory" && [...setupPaths].some((owned) => owned.startsWith(`${path}/`))) continue;
    return false;
  }
  return [...freshByPath.keys()].every((path) =>
    originalByPath.has(path) || setupPaths.has(path) || path.startsWith(`${candidateDirectory}/`));
}

async function onlyPlannedDirtyPaths(plan: SetupPlan): Promise<boolean> {
  const allowed = allowedTransactionDirtyPaths(plan);
  return (await statusMatrix(plan.assessment.target.path)).every(([path, head, workdir, stage]) =>
    (head === 1 && workdir === 1 && stage === 1) || allowed.has(path));
}

function allowedTransactionDirtyPaths(plan: SetupPlan): Set<string> {
  return new Set([...plan.actions.flatMap((row) => {
    if (row.kind === "write-scaffold-file") return [row.path];
    if (row.kind === "set-content-scope") return [row.write.path];
    return [];
  }), ...plan.assessment.repository.candidates
    .filter((row) => row.disposition === "preserve-untracked")
    .map((row) => row.path)]);
}

async function exactActualWrites(context: ApplyContext): Promise<Array<{
  filepath: string;
  content: string;
  mode: "100644" | "100755";
}>> {
  const bodies = expectedConfigurationBodies(context.plan, context.scaffold);
  const expectedPaths = [...bodies.keys()].sort();
  if (JSON.stringify([...context.actualWrites].sort()) !== JSON.stringify(expectedPaths)) {
    throw new Error("actual Dome write set does not match the admitted configuration delta");
  }
  const files: Array<{ filepath: string; content: string; mode: "100644" | "100755" }> = [];
  for (const filepath of expectedPaths) {
    const intended = bodies.get(filepath)!;
    const opened = await requireRegular(context, filepath, intended);
    if (opened.body !== intended) throw new Error(`Dome write changed before commit: ${filepath}`);
    files.push({ filepath, content: intended, mode: (opened.mode & 0o111) === 0 ? "100644" : "100755" });
  }
  return files;
}

async function admitOwnerEvidence(context: ApplyContext): Promise<void> {
  const fresh = compileSetupPlan(await context.discover(context.target, context.discovery));
  if (!sameExternalEvidence(context.plan, fresh)) throw new Error("product evidence changed after setup admission");
  if (!await sameOwnerEvidence(context.plan, fresh, context.scaffold)) {
    throw new Error("owner evidence changed after setup admission");
  }
  if (!(await inspectPlannedWritePrefix(context.plan, context.scaffold, context.digest)).valid) {
    throw new Error("planned setup publication changed after admission");
  }
}

async function admittedCommitIdsFor(
  plan: SetupPlan,
  digest: string,
  scaffold: SetupScaffoldEvidence,
): Promise<{ baseline: string | null; configuration: string | null }> {
  const head = await currentSha(plan.assessment.target.path);
  if (head === null) return { baseline: null, configuration: null };
  const expectedBranch = action(plan, "initialize-git") === undefined
    ? plan.assessment.git.branch
    : "main";
  if (await currentBranch(plan.assessment.target.path) !== expectedBranch) {
    throw new Error("setup commit is not on the approved branch");
  }
  const record = await readCommitRecord(plan.assessment.target.path, head);
  const phase = exactSetupCommitPhase(record, digest);
  if (phase === null) return { baseline: null, configuration: null };
  if (phase === "baseline") {
    await admitBaselineCommit(plan, record);
    return { baseline: head, configuration: null };
  }
  let baseline: string | null = null;
  const baselineAction = action(plan, "commit-owner-baseline");
  if (baselineAction !== undefined) {
    const parentRecord = await readCommitRecord(plan.assessment.target.path, record.parents[0]!);
    if (exactSetupCommitPhase(parentRecord, digest) !== "baseline") {
      throw new Error("configuration setup commit has no exact baseline parent");
    }
    await admitBaselineCommit(plan, parentRecord);
    baseline = parentRecord.oid;
  } else if (plan.assessment.revision.head === null) {
    if (record.parents.length !== 0) throw new Error("initial configuration setup commit must be a root commit");
  } else {
    if (record.parents.length !== 1 || record.parents[0] !== plan.assessment.revision.head) {
      throw new Error("configuration setup commit parent differs from the approved HEAD");
    }
  }
  await admitConfigurationCommit(plan, scaffold, record);
  return { baseline, configuration: head };
}

type CommitRecord = Awaited<ReturnType<typeof readCommitRecord>>;

function exactSetupCommitPhase(record: CommitRecord, digest: string): "baseline" | "configuration" | null {
  const marker = `Dome-Setup-Plan: ${digest}`;
  if (!record.message.includes(marker)) return null;
  if (record.author.name !== "Dome" || record.author.email !== "dome@local" ||
    record.committer.name !== "Dome" || record.committer.email !== "dome@local") {
    throw new Error("setup commit identity is not attributable to Dome");
  }
  for (const phase of ["baseline", "configuration"] as const) {
    const subject = phase === "baseline" ? "Dome setup: preserve owner baseline" : "Dome setup: configure vault";
    if (record.message.replace(/\n$/, "") === phaseMessage(subject, digest, phase)) return phase;
  }
  throw new Error("setup commit trailers or subject are not exact");
}

async function admitBaselineCommit(plan: SetupPlan, record: CommitRecord): Promise<void> {
  if (record.parents.length !== 0) throw new Error("owner baseline setup commit must be a root commit");
  const baseline = action(plan, "commit-owner-baseline");
  if (baseline === undefined) throw new Error("plan does not admit an owner baseline commit");
  const entries = await listTreeEntriesAtCommit(plan.assessment.target.path, record.oid);
  if (JSON.stringify(entries.map((row) => row.path)) !== JSON.stringify(baseline.paths)) {
    throw new Error("owner baseline commit tree contains unapproved paths");
  }
  for (const entry of entries) {
    const candidate = plan.assessment.repository.candidates.find((row) => row.path === entry.path)!;
    const body = await readBlobBytes({ path: plan.assessment.target.path, commit: record.oid, filepath: entry.path });
    if (entry.type !== "blob" || entry.mode !== candidate.gitMode || body === null ||
      candidate.contentSha256 === null || candidate.gitMode === null || sha256(body) !== candidate.contentSha256) {
      throw new Error(`owner baseline commit does not match approved bytes: ${entry.path}`);
    }
  }
}

async function admitConfigurationCommit(
  plan: SetupPlan,
  scaffold: SetupScaffoldEvidence,
  record: CommitRecord,
): Promise<void> {
  const parent = record.parents[0] ?? null;
  const [before, after, expected] = await Promise.all([
    parent === null ? Promise.resolve([]) : listTreeEntriesAtCommit(plan.assessment.target.path, parent),
    listTreeEntriesAtCommit(plan.assessment.target.path, record.oid),
    Promise.resolve(expectedConfigurationBodies(plan, scaffold)),
  ]);
  const beforeByPath = new Map(before.map((row) => [row.path, row]));
  const afterByPath = new Map(after.map((row) => [row.path, row]));
  const changed = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])]
    .filter((path) => JSON.stringify(beforeByPath.get(path)) !== JSON.stringify(afterByPath.get(path)))
    .sort();
  if (JSON.stringify(changed) !== JSON.stringify([...expected.keys()].sort())) {
    throw new Error("configuration setup commit tree delta is not exact");
  }
  for (const [path, body] of expected) {
    const entry = afterByPath.get(path);
    const committed = await readBlob({ path: plan.assessment.target.path, commit: record.oid, filepath: path });
    const parentEntry = beforeByPath.get(path);
    const expectedMode = parentEntry?.mode === "100755" ? "100755" : "100644";
    if (entry?.type !== "blob" || entry.mode !== expectedMode || committed !== body) {
      throw new Error(`configuration setup commit has wrong bytes or mode: ${path}`);
    }
  }
}

function expectedConfigurationBodies(
  plan: SetupPlan,
  scaffold: SetupScaffoldEvidence,
): Map<string, string> {
  const expected = new Map<string, string>();
  for (const write of plan.actions.filter((row): row is Extract<AdaptationAction, { kind: "write-scaffold-file" }> =>
    row.kind === "write-scaffold-file")) {
    if (!wasPresentAtAssessment(plan, write.path)) {
      expected.set(write.path, scaffoldWriteBody(write, scaffold));
    }
  }
  const config = action(plan, "set-content-scope");
  if (config !== undefined) {
    expected.set(config.write.path, contentScopeWriteBody(config, scaffold));
  }
  return expected;
}

function contentScopeWriteBody(
  config: Extract<AdaptationAction, { kind: "set-content-scope" }>,
  scaffold: SetupScaffoldEvidence,
): string {
  return config.write.path === ".dome/config.yaml"
    ? scaffold.vaultConfig
    : scaffold.contentScopeConfig;
}

function scaffoldWriteBody(
  write: Extract<AdaptationAction, { kind: "write-scaffold-file" }>,
  scaffold: SetupScaffoldEvidence,
): string {
  if (write.id === "agents-orientation") return scaffold.agentsOrientation;
  if (write.id === "claude-orientation") return scaffold.claudeOrientation;
  return scaffold.gitignore;
}

function scaffoldPreparedBoundary(
  write: Extract<AdaptationAction, { kind: "write-scaffold-file" }>,
): SetupPreparedBoundary {
  if (write.id === "agents-orientation") return "agents-orientation-prepared";
  if (write.id === "claude-orientation") return "claude-orientation-prepared";
  return "gitignore-prepared";
}

function phaseMessage(subject: string, digest: string, phase: "baseline" | "configuration"): string {
  return `${subject}\n\nDome-Setup-Plan: ${digest}\nDome-Setup-Phase: ${phase}`;
}

function setupGitLockOwner(digest: string, phase: "baseline" | "configuration"): string {
  return `dome.setup:${digest}:${phase}`;
}

function action<K extends AdaptationAction["kind"]>(plan: SetupPlan, kind: K): Extract<AdaptationAction, { kind: K }> | undefined {
  return plan.actions.find((row): row is Extract<AdaptationAction, { kind: K }> => row.kind === kind);
}

function hasConfigurationWork(plan: SetupPlan): boolean {
  return plan.actions.some((row) => row.kind === "write-scaffold-file" || row.kind === "set-content-scope");
}

function wasPresentAtAssessment(plan: SetupPlan, path: string): boolean {
  return plan.assessment.repository.candidates.some((row) => row.path === path);
}

function assertWriteEvidence(write: { bytes: number; sha256: string }, body: string): void {
  if (Buffer.byteLength(body) !== write.bytes || createHash("sha256").update(body).digest("hex") !== write.sha256) {
    throw new Error("canonical setup bytes do not match the approved write evidence");
  }
}

function sha256(body: string | Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

async function safeLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try { return await lstat(path); }
  catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function directoryIsEmpty(path: string): Promise<boolean> {
  return (await readdir(path)).length === 0;
}

async function isClean(path: string): Promise<boolean> {
  return (await statusMatrix(path)).every(([, head, workdir, stage]) => head === 1 && workdir === 1 && stage === 1);
}

async function worktreeMatchesCompletedPlan(plan: SetupPlan): Promise<boolean> {
  const permitted = new Set(plan.assessment.repository.candidates
    .filter((row) => row.disposition === "preserve-untracked")
    .map((row) => row.path));
  return (await statusMatrix(plan.assessment.target.path)).every(([path, head, workdir, stage]) =>
    (head === 1 && workdir === 1 && stage === 1) || permitted.has(path));
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function completed(
  plan: SetupPlan,
  digest: string,
  commits: { baseline: string | null; configuration: string | null },
): SetupApplyResult {
  return validateSetupApplyResult({
    schema: SETUP_APPLY_RESULT_SCHEMA,
    status: "completed",
    planSha256: digest,
    targetPath: plan.assessment.target.path,
    commits,
  });
}

function stale(digest: string, freshPlan: SetupPlan): SetupApplyResult {
  return validateSetupApplyResult({
    schema: SETUP_APPLY_RESULT_SCHEMA,
    status: "stale",
    planSha256: digest,
    freshPlan,
  });
}

function blocked(
  digest: string,
  code: "plan-blocked" | "consent-mismatch" | "mutation-conflict" | "verification-failed",
  message: string,
  commands: ReadonlyArray<string>,
): SetupApplyResult {
  return validateSetupApplyResult({
    schema: SETUP_APPLY_RESULT_SCHEMA,
    status: "blocked",
    planSha256: digest,
    recovery: { code, message, commands: [...commands] },
  });
}
