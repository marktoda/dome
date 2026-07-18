import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  configRoot,
  parseConfigDocument,
  stringifyConfigDocument,
} from "../config-document";
import {
  commit,
  currentBranch,
  currentSha,
  initRepo,
  log,
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
import { canonicalSetupDiscoveryDeps } from "./defaults";
import {
  discoverSetupCompilerInput,
  type SetupDiscoveryDeps,
} from "./discovery";

export const SETUP_DURABLE_BOUNDARIES = [
  "vault-directory-created",
  "git-initialized",
  "owner-baseline-committed",
  "scaffold-directories-created",
  "scaffold-files-written",
  "vault-config-written",
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
      if (prefix === "complete") return completed(plan, digest, await ownedCommitIds(target, digest));
    }

    const context: ApplyContext = {
      plan,
      digest,
      target,
      scaffold,
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
  let commits = await ownedCommitIds(target, digest);

  if (action(plan, "create-vault-directory") !== undefined && prefix === "none") {
    await mkdir(target, { mode: 0o755 });
    await context.afterBoundary("vault-directory-created");
  }
  if (action(plan, "initialize-git") !== undefined && (prefix === "none" || prefix === "directory")) {
    await initRepo(target, "main");
    await context.afterBoundary("git-initialized");
  }

  const baseline = action(plan, "commit-owner-baseline");
  if (baseline !== undefined && commits.baseline === null &&
    prefix !== "baseline" && prefix !== "scaffold-dirty" && prefix !== "complete") {
    commits = {
      ...commits,
      baseline: await commit({
        path: target,
        files: baseline.paths,
        message: phaseMessage(baseline.message, digest, "baseline"),
      }),
    };
    await context.afterBoundary("owner-baseline-committed");
  }

  if (prefix === "scaffold-dirty") await verifyPlannedWritePrefix(context);
  for (const directory of plan.actions.filter((row): row is Extract<AdaptationAction, { kind: "ensure-scaffold-directory" }> =>
    row.kind === "ensure-scaffold-directory")) {
    await ensureDirectory(join(target, directory.path), Number.parseInt(directory.mode, 8));
  }
  if (plan.actions.some((row) => row.kind === "ensure-scaffold-directory")) {
    await context.afterBoundary("scaffold-directories-created");
  }

  for (const write of plan.actions.filter((row): row is Extract<AdaptationAction, { kind: "write-scaffold-file" }> =>
    row.kind === "write-scaffold-file")) {
    const body = write.id === "agents-orientation" ? context.scaffold.agentsOrientation : context.scaffold.gitignore;
    assertWriteEvidence(write, body);
    await writeScaffoldIfAbsent(context, write.path, body);
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
    await applyConfigWrite(context, config, body);
    await context.afterBoundary("vault-config-written");
  }

  if (commits.configuration === null && hasConfigurationWork(plan)) {
    const files = await changedSetupPaths(context);
    if (files.length > 0) {
      commits = {
        ...commits,
        configuration: await commit({
          path: target,
          files,
          message: phaseMessage("Dome setup: configure vault", digest, "configuration"),
        }),
      };
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

  const commits = await ownedCommitIds(target, digest);
  const existingGitPlan = action(plan, "initialize-git") === undefined;
  const existingGitWrites = existingGitPlan && commits.configuration === null
    ? await inspectPlannedWritePrefix(plan, scaffold)
    : null;
  if (existingGitPlan && commits.configuration === null && existingGitWrites?.observed !== true) return "none";
  if (!sameExternalEvidence(plan, freshPlan) || !await sameOwnerEvidence(plan, freshPlan, scaffold)) return "conflict";
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
    const writes = await inspectPlannedWritePrefix(plan, scaffold);
    return writes.valid && await onlyPlannedDirtyPaths(plan)
      ? (await isClean(target) ? "baseline" : "scaffold-dirty")
      : "conflict";
  }

  const head = currentHead;
  const branch = await currentBranch(target);
  if (head !== null || branch !== "main") return "conflict";
  return "git";
}

async function writeScaffoldIfAbsent(context: ApplyContext, path: string, body: string): Promise<void> {
  const destination = join(context.target, path);
  const existing = await safeLstat(destination);
  if (existing !== null) {
    if (wasPresentAtAssessment(context.plan, path)) return;
    if (!existing.isFile() || existing.isSymbolicLink() || await readFile(destination, "utf8") !== body) {
      throw new Error(`setup refused to replace unexpected ${path}`);
    }
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, body, { encoding: "utf8", flag: "wx", mode: 0o644 });
}

async function applyConfigWrite(
  context: ApplyContext,
  action: Extract<AdaptationAction, { kind: "set-content-scope" }>,
  evidenceBody: string,
): Promise<void> {
  const destination = join(context.target, action.write.path);
  if (action.write.operation === "create-file") {
    await writeScaffoldIfAbsent(context, action.write.path, evidenceBody);
    return;
  }
  const existing = await readFile(destination, "utf8");
  const merged = mergeContentScope(existing, evidenceBody);
  if (merged === existing) return;
  await writeFile(destination, merged, { encoding: "utf8", flag: "w", mode: 0o644 });
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
  if (!(await inspectPlannedWritePrefix(context.plan, context.scaffold)).valid) {
    throw new Error("partial setup writes do not match the approved plan");
  }
}

async function inspectPlannedWritePrefix(
  plan: SetupPlan,
  scaffold: SetupScaffoldEvidence,
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
    const actual = await readTextIfRegular(join(plan.assessment.target.path, write.path));
    if (actual !== null) {
      observed = true;
      if (actual !== expected) return { valid: false, observed };
    }
  }
  const config = action(plan, "set-content-scope");
  if (config !== undefined) {
    const actual = await readTextIfRegular(join(plan.assessment.target.path, config.write.path));
    if (actual === null) return { valid: true, observed };
    if (config.write.operation === "create-file") {
      observed = true;
      if (actual !== scaffold.vaultConfig) return { valid: false, observed };
    }
    if (config.write.operation === "merge-managed-config") {
      try {
        if (mergeContentScope(actual, scaffold.contentScopeConfig) === actual) observed = true;
      } catch { return { valid: false, observed: true }; }
    }
  }
  return { valid: true, observed };
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
    if (row.kind === "write-scaffold-file") return [row.path];
    if (row.kind === "set-content-scope") return [row.write.path];
    return [];
  }));
  const originalByPath = new Map(original.assessment.repository.candidates.map((row) => [row.path, row]));
  const freshByPath = new Map(fresh.assessment.repository.candidates.map((row) => [row.path, row]));
  for (const [path, row] of originalByPath) {
    const current = freshByPath.get(path);
    if (current === undefined) return false;
    if (current.kind === row.kind && current.bytes === row.bytes && current.proofSha256 === row.proofSha256) continue;
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
  return new Set([...plan.actions.flatMap((row) => {
    if (row.kind === "write-scaffold-file") return [row.path];
    if (row.kind === "set-content-scope") return [row.write.path];
    return [];
  }), ...plan.assessment.repository.candidates
    .filter((row) => row.disposition === "preserve-untracked")
    .map((row) => row.path)]);
}

async function changedSetupPaths(context: ApplyContext): Promise<string[]> {
  const changed = new Set(
    (await statusMatrix(context.target))
      .filter(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1))
      .map(([path]) => path),
  );
  const planned = context.plan.actions.flatMap((row) => {
    if (row.kind === "write-scaffold-file") return [row.path];
    if (row.kind === "set-content-scope") return [row.write.path];
    return [];
  });
  const allowed = allowedTransactionDirtyPaths(context.plan);
  const unexpected = [...changed].filter((path) => !allowed.has(path));
  if (unexpected.length > 0) throw new Error(`setup found unexpected dirty paths: ${unexpected.join(", ")}`);
  return planned.filter((path) => changed.has(path));
}

async function ownedCommitIds(target: string, digest: string): Promise<{ baseline: string | null; configuration: string | null }> {
  let rows: Awaited<ReturnType<typeof log>> = [];
  try { rows = await log({ path: target, depth: 4 }); } catch {}
  let baseline: string | null = null;
  let configuration: string | null = null;
  for (const row of rows) {
    if (!row.commit.message.includes(`Dome-Setup-Plan: ${digest}`)) continue;
    if (row.commit.message.includes("Dome-Setup-Phase: baseline")) baseline ??= row.oid;
    if (row.commit.message.includes("Dome-Setup-Phase: configuration")) configuration ??= row.oid;
  }
  return { baseline, configuration };
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

async function ensureDirectory(path: string, mode: number): Promise<void> {
  const existing = await safeLstat(path);
  if (existing !== null) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`setup directory collision at ${path}`);
    return;
  }
  await mkdir(path, { recursive: false, mode });
  await chmod(path, mode);
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
