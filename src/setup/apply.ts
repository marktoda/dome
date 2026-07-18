import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  configRoot,
  parseConfigDocument,
  stringifyConfigDocument,
} from "../config-document";
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
  "gitignore-prepared",
  "gitignore-published",
  "scaffold-files-written",
  "vault-config-prepared",
  "vault-config-published",
  "vault-config-written",
  "configuration-ref-advanced",
  "configuration-committed",
] as const;
export type SetupDurableBoundary = typeof SETUP_DURABLE_BOUNDARIES[number];

type SetupApplyDeps = Readonly<{
  discovery?: SetupDiscoveryDeps | undefined;
  discover?: ((targetPath: string, deps: SetupDiscoveryDeps) => Promise<SetupCompilerInput>) | undefined;
  afterBoundary?: ((boundary: SetupDurableBoundary) => Promise<void>) | undefined;
}>;

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
}>;

type RecoveryPrefix = "none" | "directory" | "git" | "baseline" | "scaffold-dirty" | "complete" | "conflict";

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
      afterRefAdvance: async () => context.afterBoundary("owner-baseline-ref-advanced"),
    });
    commits = await admittedCommitIdsFor(plan, digest, context.scaffold);
    if (commits.baseline !== oid) throw new Error("owner baseline commit failed exact post-commit admission");
    await context.afterBoundary("owner-baseline-committed");
  }

  if (prefix === "scaffold-dirty") await verifyPlannedWritePrefix(context);
  for (const directory of plan.actions.filter((row): row is Extract<AdaptationAction, { kind: "ensure-scaffold-directory" }> =>
    row.kind === "ensure-scaffold-directory")) {
    await anchored(context).ensureDirectory(directory.path, Number.parseInt(directory.mode, 8));
  }
  if (plan.actions.some((row) => row.kind === "ensure-scaffold-directory")) {
    await context.afterBoundary("scaffold-directories-created");
  }

  for (const write of plan.actions.filter((row): row is Extract<AdaptationAction, { kind: "write-scaffold-file" }> =>
    row.kind === "write-scaffold-file")) {
    const body = write.id === "agents-orientation" ? context.scaffold.agentsOrientation : context.scaffold.gitignore;
    assertWriteEvidence(write, body);
    if (await publishScaffoldIfAbsent(context, write.path, body, write.id === "agents-orientation"
      ? "agents-orientation-prepared" : "gitignore-prepared")) context.actualWrites.add(write.path);
  }
  if (plan.actions.some((row) => row.kind === "write-scaffold-file")) {
    await context.afterBoundary("scaffold-files-written");
  }

  const config = action(plan, "set-content-scope");
  if (config !== undefined) {
    const body = config.write.operation === "create-file"
      ? context.scaffold.vaultConfig
      : context.scaffold.contentScopeConfig;
    assertWriteEvidence(config.write, body);
    if (await applyConfigWrite(context, config, body)) context.actualWrites.add(config.write.path);
    await context.afterBoundary("vault-config-written");
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
          afterRefAdvance: async () => context.afterBoundary("configuration-ref-advanced"),
        })
        : await commitFilesOnHead({
          path: target,
          files,
          message,
          expectedHead: parent,
          expectedBranch,
          retryOnCas: false,
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
  if (existingGitPlan && commits.configuration === null && existingGitWrites?.observed !== true) return "none";
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
    if (!writes.valid || !writes.observed || !await onlyPlannedDirtyPaths(plan)) return writes.observed ? "conflict" : "none";
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
  if (commits.configuration !== null) {
    const record = await readCommitRecord(plan.assessment.target.path, commits.configuration);
    await recoverIndexAfterExactCommit({
      path: plan.assessment.target.path,
      commit: commits.configuration,
      parent: record.parents[0] ?? null,
      files: expectedConfigurationPaths(plan),
    });
  } else if (commits.baseline !== null) {
    await recoverIndexAfterExactCommit({
      path: plan.assessment.target.path,
      commit: commits.baseline,
      parent: null,
      files: action(plan, "commit-owner-baseline")?.paths ?? [],
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
  preparedBoundary: "agents-orientation-prepared" | "gitignore-prepared" | "vault-config-prepared",
): Promise<boolean> {
  const existing = await anchored(context).readRegular(path);
  if (existing !== null) {
    if (wasPresentAtAssessment(context.plan, path)) return false;
    if (existing.body !== body || existing.mode !== 0o644 ||
      !await hasPublishedWitness(context, path, "create", body, 0o644)) {
      throw new Error(`setup refused to replace unexpected ${path}`);
    }
    await replayPublicationDurability(context, path, body, 0o644);
    return true;
  }
  await publishAtomic(context, path, body, 0o644, "create", preparedBoundary);
  return true;
}

async function applyConfigWrite(
  context: ApplyContext,
  action: Extract<AdaptationAction, { kind: "set-content-scope" }>,
  evidenceBody: string,
): Promise<boolean> {
  if (action.write.operation === "create-file") {
    return publishScaffoldIfAbsent(context, action.write.path, evidenceBody, "vault-config-prepared");
  }
  const opened = await requireRegular(context, action.write.path);
  if (opened.nlink !== 1n) throw new Error("setup managed config must have one direct filesystem link");
  const existing = opened.body;
  const merged = mergeContentScope(existing, evidenceBody);
  if (merged === existing) {
    if (!await hasPublishedWitness(context, action.write.path, "replace", existing, opened.mode)) {
      throw new Error(`setup found exact owner config without a plan-owned publication witness`);
    }
    await replayPublicationDurability(context, action.write.path, existing, opened.mode);
    return true;
  }
  await publishAtomic(
    context,
    action.write.path,
    merged,
    opened.mode,
    "replace",
    "vault-config-prepared",
    opened,
  );
  return true;
}

type OpenedFile = AnchoredRegularFile;

async function publishAtomic(
  context: ApplyContext,
  relativePath: string,
  body: string,
  mode: number,
  operation: "create" | "replace",
  preparedBoundary: "agents-orientation-prepared" | "gitignore-prepared" | "vault-config-prepared",
  old?: OpenedFile,
): Promise<void> {
  const files = anchored(context);
  const temp = transactionTempPath(relativePath, context.digest);
  const priorTemp = await files.readRegular(temp);
  if (priorTemp === null) {
    await files.createExclusive(temp, body, mode);
  } else if (priorTemp.body !== body || priorTemp.mode !== mode) {
    throw new Error(`setup temporary publication collision for ${relativePath}`);
  }
  await ensureWitness(context, relativePath, operation, body, mode, "prepared");
  await context.afterBoundary(preparedBoundary);

  if (operation === "create") {
    // The destination was admitted absent before preparation. Even an
    // identical concurrent publication is not attributable to this call and
    // must not be folded into Dome's configuration commit. Crash recovery
    // admits an already-published exact destination before reaching here.
    await files.linkExclusive(temp, relativePath);
  } else {
    if (old === undefined) throw new Error("replace publication requires admitted old bytes");
    const current = await requireRegular(context, relativePath);
    if (!sameOpenedFile(old, current)) throw new Error(`setup detected concurrent replacement of ${relativePath}`);
    await files.rename(temp, relativePath);
  }
  await ensureWitness(context, relativePath, operation, body, mode, "published");
  await context.afterBoundary(publishedBoundary(preparedBoundary));
  await files.syncParent(relativePath);
  if (operation === "create") await files.unlink(temp);
  await files.syncParent(temp);
}

function sameOpenedFile(left: OpenedFile, right: OpenedFile): boolean {
  return left.body === right.body && left.mode === right.mode && left.dev === right.dev && left.ino === right.ino &&
    left.nlink === right.nlink && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function removeExactTempIfPresent(
  context: ApplyContext,
  path: string,
  body: string,
  mode?: number,
): Promise<void> {
  const temp = transactionTempPath(path, context.digest);
  const opened = await anchored(context).readRegular(temp);
  if (opened === null) return;
  if (opened.body !== body || (mode !== undefined && opened.mode !== mode)) {
    throw new Error(`setup temporary publication collision for ${path}`);
  }
  await anchored(context).unlink(temp);
  await anchored(context).syncParent(temp);
}

function transactionTempPath(path: string, digest: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return `${parent === "" ? "" : `${parent}/`}.${name}.dome-setup-${digest.slice(0, 16)}.tmp`;
}

type PublicationOperation = "create" | "replace";
type PublicationPhase = "prepared" | "published";

function anchored(context: ApplyContext): AnchoredVaultFiles {
  const files = context.filesystem.current;
  if (files === null) throw new Error("setup filesystem is not bound to the approved vault");
  return files;
}

async function requireRegular(context: ApplyContext, path: string): Promise<OpenedFile> {
  const opened = await anchored(context).readRegular(path);
  if (opened === null) throw new Error(`setup requires a direct regular file at ${path}`);
  return opened;
}

function publishedBoundary(
  prepared: "agents-orientation-prepared" | "gitignore-prepared" | "vault-config-prepared",
): "agents-orientation-published" | "gitignore-published" | "vault-config-published" {
  if (prepared === "agents-orientation-prepared") return "agents-orientation-published";
  if (prepared === "gitignore-prepared") return "gitignore-published";
  return "vault-config-published";
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
  operation: PublicationOperation,
  body: string,
  mode: number,
  phase: PublicationPhase,
): string {
  return publicationWitnessBody(context.digest, path, operation, body, mode, phase);
}

function publicationWitnessBody(
  digest: string,
  path: string,
  operation: PublicationOperation,
  body: string,
  mode: number,
  phase: PublicationPhase,
): string {
  return `${JSON.stringify({
    schema: "dome.setup.publication-witness/v1",
    planSha256: digest,
    path,
    operation,
    contentSha256: sha256(body),
    mode: mode.toString(8).padStart(4, "0"),
    phase,
  })}\n`;
}

async function ensureWitness(
  context: ApplyContext,
  path: string,
  operation: PublicationOperation,
  body: string,
  mode: number,
  phase: PublicationPhase,
): Promise<void> {
  const files = anchored(context);
  await files.ensureDirectory(".dome", 0o755);
  await files.ensureDirectory(".dome/state", 0o700);
  await files.ensureDirectory(".dome/state/setup", 0o700);
  await files.ensureDirectory(`.dome/state/setup/${context.digest}`, 0o700);
  const relative = witnessPath(context, path, phase);
  const expected = witnessBody(context, path, operation, body, mode, phase);
  const existing = await files.readRegular(relative);
  if (existing === null) await files.createExclusive(relative, expected, 0o600);
  else if (existing.body !== expected || existing.mode !== 0o600) {
    throw new Error(`setup publication witness collision for ${path}`);
  }
  await files.syncParent(relative);
}

async function hasPublishedWitness(
  context: ApplyContext,
  path: string,
  operation: PublicationOperation,
  body: string,
  mode: number,
): Promise<boolean> {
  const expected = witnessBody(context, path, operation, body, mode, "published");
  const witness = await anchored(context).readRegular(witnessPath(context, path, "published"));
  return witness?.body === expected && witness.mode === 0o600;
}

async function replayPublicationDurability(
  context: ApplyContext,
  path: string,
  body: string,
  mode: number,
): Promise<void> {
  const final = await requireRegular(context, path);
  if (final.body !== body || final.mode !== mode) {
    throw new Error(`setup publication changed before durability replay: ${path}`);
  }
  // A retry after link/rename but before the directory fsync must perform the
  // fsync again. Exact final bytes alone are never treated as evidence.
  await anchored(context).syncParent(path);
  await removeExactTempIfPresent(context, path, body, mode);
}

function mergeContentScope(existing: string, fragment: string): string {
  const doc = parseConfigDocument(existing);
  const root = configRoot(doc);
  const fragmentDoc = parseConfigDocument(fragment);
  const scope = configRoot(fragmentDoc).get("content_scope");
  if (root.has("content_scope")) {
    const current = JSON.stringify(root.get("content_scope"));
    const proposed = JSON.stringify(scope);
    if (current !== proposed) throw new Error("setup refused to replace owner-authored content_scope");
    return existing;
  }
  root.set(doc.createNode("content_scope"), doc.createNode(scope));
  return stringifyConfigDocument(doc);
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
    const expected = write.id === "agents-orientation" ? scaffold.agentsOrientation : scaffold.gitignore;
    const actual = await readOptionalRegular(files, write.path);
    if (actual !== null) {
      observed = true;
      if (actual.body !== expected || actual.mode !== 0o644 ||
        !await recoveryWitnessMatches(files, digest, write.path, "create", expected, 0o644, "published")) {
        return { valid: false, observed };
      }
    }
    const temp = await readOptionalRegular(files, transactionTempPath(write.path, digest));
    if (temp !== null) {
      observed = true;
      if (temp.body !== expected || temp.mode !== 0o644 ||
        !await recoveryWitnessMatches(files, digest, write.path, "create", expected, 0o644, "prepared")) {
        return { valid: false, observed };
      }
    }
  }
  const config = action(plan, "set-content-scope");
  if (config !== undefined) {
    const actual = await readOptionalRegular(files, config.write.path);
    const temp = await readOptionalRegular(files, transactionTempPath(config.write.path, digest));
    if (actual === null) {
      if (temp !== null) {
        observed = true;
        if (config.write.operation !== "create-file" || temp.body !== scaffold.vaultConfig || temp.mode !== 0o644 ||
          !await recoveryWitnessMatches(files, digest, config.write.path, "create", scaffold.vaultConfig, 0o644, "prepared")) {
          return { valid: false, observed };
        }
      }
      return { valid: true, observed };
    }
    if (config.write.operation === "create-file") {
      observed = true;
      if (actual.body !== scaffold.vaultConfig || actual.mode !== 0o644 ||
        !await recoveryWitnessMatches(files, digest, config.write.path, "create", scaffold.vaultConfig, 0o644, "published")) {
        return { valid: false, observed };
      }
      if (temp !== null && (temp.body !== scaffold.vaultConfig || temp.mode !== 0o644)) return { valid: false, observed };
    }
    if (config.write.operation === "merge-managed-config") {
      try {
        const merged = mergeContentScope(actual.body, scaffold.contentScopeConfig);
        if (merged === actual.body) {
          observed = true;
          if (!await recoveryWitnessMatches(
            files, digest, config.write.path, "replace", actual.body, actual.mode, "published",
          )) return { valid: false, observed };
        }
        if (temp !== null) {
          observed = true;
          if (temp.body !== merged || temp.mode !== actual.mode ||
            !await recoveryWitnessMatches(
              files, digest, config.write.path, "replace", merged, temp.mode, "prepared",
            )) return { valid: false, observed };
        }
      } catch { return { valid: false, observed: true }; }
    }
  }
  return { valid: true, observed };
}

async function recoveryWitnessMatches(
  files: AnchoredVaultFiles,
  digest: string,
  path: string,
  operation: PublicationOperation,
  body: string,
  mode: number,
  phase: PublicationPhase,
): Promise<boolean> {
  const relative = `.dome/state/setup/${digest}/${sha256(path)}.${phase}.json`;
  try {
    const witness = await files.readRegular(relative);
    return witness?.mode === 0o600 &&
      witness.body === publicationWitnessBody(digest, path, operation, body, mode, phase);
  } catch {
    return false;
  }
}

async function readOptionalRegular(
  files: AnchoredVaultFiles,
  path: string,
): Promise<AnchoredRegularFile | null> {
  try { return await files.readRegular(path); }
  catch (error) {
    if (error instanceof Error && error.message.includes("parent directory is not direct")) return null;
    throw error;
  }
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
  scaffold: SetupScaffoldEvidence,
): Promise<boolean> {
  const setupPaths = new Set(original.actions.flatMap((row) => {
    if (row.kind === "ensure-scaffold-directory") return [row.path];
    if (row.kind === "write-scaffold-file") return [row.path, transactionTempPath(row.path, setupPlanSha256(original))];
    if (row.kind === "set-content-scope") return [
      row.write.path,
      transactionTempPath(row.write.path, setupPlanSha256(original)),
    ];
    return [];
  }));
  const digest = setupPlanSha256(original);
  setupPaths.add(".dome/state");
  setupPaths.add(".dome/state/setup");
  setupPaths.add(`.dome/state/setup/${digest}`);
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
    const config = action(original, "set-content-scope");
    if (config?.write.operation !== "merge-managed-config" || path !== config.write.path) return false;
    const actual = await readTextIfRegular(join(original.assessment.target.path, path));
    if (actual === null) return false;
    try {
      if (mergeContentScope(actual, scaffold.contentScopeConfig) !== actual) return false;
    } catch { return false; }
  }
  return [...freshByPath.keys()].every((path) => originalByPath.has(path) || setupPaths.has(path));
}

async function onlyPlannedDirtyPaths(plan: SetupPlan): Promise<boolean> {
  const allowed = allowedTransactionDirtyPaths(plan);
  return (await statusMatrix(plan.assessment.target.path)).every(([path, head, workdir, stage]) =>
    (head === 1 && workdir === 1 && stage === 1) || allowed.has(path));
}

function allowedTransactionDirtyPaths(plan: SetupPlan): Set<string> {
  const digest = setupPlanSha256(plan);
  return new Set([...plan.actions.flatMap((row) => {
    if (row.kind === "write-scaffold-file") return [row.path, transactionTempPath(row.path, digest)];
    if (row.kind === "set-content-scope") return [row.write.path, transactionTempPath(row.write.path, digest)];
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
  const expected = expectedConfigurationBodies(context.plan, context.scaffold, async (path) =>
    readBlob({ path: context.target, commit: (await currentSha(context.target))!, filepath: path }));
  const bodies = await expected;
  const expectedPaths = [...bodies.keys()].sort();
  if (JSON.stringify([...context.actualWrites].sort()) !== JSON.stringify(expectedPaths)) {
    throw new Error("actual Dome write set does not match the admitted configuration delta");
  }
  const files: Array<{ filepath: string; content: string; mode: "100644" | "100755" }> = [];
  for (const filepath of expectedPaths) {
    const intended = bodies.get(filepath)!;
    const opened = await requireRegular(context, filepath);
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
    expectedConfigurationBodies(plan, scaffold, async (path) =>
      parent === null ? Promise.resolve(null) : readBlob({ path: plan.assessment.target.path, commit: parent, filepath: path })),
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

async function expectedConfigurationBodies(
  plan: SetupPlan,
  scaffold: SetupScaffoldEvidence,
  parentBody: (path: string) => Promise<string | null>,
): Promise<Map<string, string>> {
  const expected = new Map<string, string>();
  for (const write of plan.actions.filter((row): row is Extract<AdaptationAction, { kind: "write-scaffold-file" }> =>
    row.kind === "write-scaffold-file")) {
    if (!wasPresentAtAssessment(plan, write.path)) {
      expected.set(write.path, write.id === "agents-orientation" ? scaffold.agentsOrientation : scaffold.gitignore);
    }
  }
  const config = action(plan, "set-content-scope");
  if (config !== undefined) {
    if (config.write.operation === "create-file") expected.set(config.write.path, scaffold.vaultConfig);
    else {
      const parent = await parentBody(config.write.path);
      if (parent === null) throw new Error("managed config merge parent is unavailable");
      expected.set(config.write.path, mergeContentScope(parent, scaffold.contentScopeConfig));
    }
  }
  return expected;
}

function phaseMessage(subject: string, digest: string, phase: "baseline" | "configuration"): string {
  return `${subject}\n\nDome-Setup-Plan: ${digest}\nDome-Setup-Phase: ${phase}`;
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

async function readTextIfRegular(path: string): Promise<string | null> {
  const stat = await safeLstat(path);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) return null;
  return readFile(path, "utf8");
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
