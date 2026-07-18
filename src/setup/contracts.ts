import { z } from "zod";
import {
  canonicalContentScopeSchema,
  type ContentScopeConfig,
} from "../core/content-scope";
import { homeServiceLabelForVault } from "../core/vault-service-identity";
import {
  deepFreezeSetupContract,
  passiveSetupContractSnapshot,
  SETUP_CONTRACT_LIMITS,
} from "./passive-contract";
import {
  classifySetupVault,
  SETUP_TARGET_STATES,
  VAULT_KINDS,
} from "./classification";

export type { ContentScopeConfig };

export const VAULT_ASSESSMENT_SCHEMA = "dome.setup.vault-assessment/v1" as const;
export const SETUP_PLAN_SCHEMA = "dome.setup.plan/v1" as const;

export { VAULT_KINDS } from "./classification";

export const ADAPTATION_ACTION_KINDS = [
  "create-vault-directory",
  "initialize-git",
  "ensure-scaffold-directory",
  "write-scaffold-file",
  "set-content-scope",
  "activate-home",
] as const;

export const ADAPTATION_ACTION_IDS = [
  "vault-directory",
  "git-repository",
  "dome-directory",
  "dome-state-directory",
  "agents-orientation",
  "gitignore",
  "vault-config",
  "home-activation",
] as const;

export const SETUP_CONTRACT_CAPS = SETUP_CONTRACT_LIMITS;

const sha1 = z.string().regex(/^[0-9a-f]{40}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const nonEmpty = z.string().min(1).max(8_192)
  .refine((value) => value.trim().length > 0 && !value.includes("\0"), "must contain visible text and no NUL");
const version = z.string().max(128).regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const absolutePath = nonEmpty.refine(
  (value) => value.startsWith("/") && !value.includes("//") && !value.split("/").some((part) => part === "." || part === ".."),
  "must be a normalized absolute path",
);
const relativePath = nonEmpty.refine(
  (value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").some((part) => part === "" || part === "." || part === ".."),
  "must be a normalized relative path",
);
const markdownPath = relativePath.refine((value) => value.endsWith(".md"), "must identify lowercase-suffix Markdown");

function sortedUnique<T extends z.ZodType<string>>(item: T) {
  return z.array(item).superRefine((values, context) => {
    if (new Set(values).size !== values.length || values.some((value, index) => index > 0 && values[index - 1]! >= value)) {
      context.addIssue({ code: "custom", message: "must be sorted and unique" });
    }
  });
}

const contentScopeSchema = canonicalContentScopeSchema;

const scaffoldFileId = z.enum(["gitignore", "agents-orientation"]);
const scaffoldDirectoryId = z.enum(["dome-directory", "dome-state-directory"]);
const serviceLabel = z.string().regex(/^com\.dome\.home\.[a-z0-9][a-z0-9-]*$/);
const contentScopeWriteSchema = z.object({
  path: z.literal(".dome/config.yaml"),
  operation: z.enum(["create-file", "merge-managed-config"]),
  bytes: z.number().int().nonnegative().max(SETUP_CONTRACT_CAPS.writeBytes),
  sha256,
  mode: z.literal("0644"),
  ifMissing: z.boolean(),
}).strict().refine(
  (write) => (write.operation === "create-file") === write.ifMissing,
  { message: "create-file must be if-missing; managed merge must target an existing config" },
);

const actionSchemas = [
  z.object({
    kind: z.literal("create-vault-directory"), id: z.literal("vault-directory"), path: absolutePath,
    mode: z.literal("0755"), ifMissing: z.literal(true),
  }).strict(),
  z.object({
    kind: z.literal("initialize-git"), id: z.literal("git-repository"), repositoryPath: absolutePath,
    ifMissing: z.literal(true),
  }).strict(),
  z.object({
    kind: z.literal("ensure-scaffold-directory"), id: scaffoldDirectoryId, path: relativePath,
    mode: z.enum(["0700", "0755"]), ifMissing: z.literal(true),
  }).strict(),
  z.object({
    kind: z.literal("write-scaffold-file"), id: scaffoldFileId, path: relativePath,
    bytes: z.number().int().nonnegative().max(SETUP_CONTRACT_CAPS.writeBytes),
    sha256, mode: z.literal("0644"), ifMissing: z.literal(true),
  }).strict(),
  z.object({
    kind: z.literal("set-content-scope"), id: z.literal("vault-config"), scope: contentScopeSchema,
    write: contentScopeWriteSchema,
  }).strict(),
  z.object({
    kind: z.literal("activate-home"),
    id: z.literal("home-activation"),
    artifactId: sha256,
    disposition: z.enum(["install-or-resume", "upgrade"]),
    vaultPath: absolutePath,
    serviceLabel,
    installServiceIfMissing: z.literal(true),
  }).strict(),
] as const;

export const adaptationActionSchema = z.discriminatedUnion("kind", actionSchemas);
export type AdaptationAction = z.infer<typeof adaptationActionSchema>;

const blockerSchema = z.object({
  code: z.enum([
    "unsupported-host",
    "missing-prerequisite",
    "dirty-worktree",
    "active-git-operation",
    "active-home-upgrade",
    "conflicting-home-owner",
    "symlink-ambiguity",
    "unsafe-path",
    "ambiguous-state",
    "detached-head",
    "unborn-repository",
    "unsupported-prerequisite",
  ]),
  message: nonEmpty,
  nextAction: nonEmpty,
}).strict();

const assessmentSchemaBase = z.object({
  schema: z.literal(VAULT_ASSESSMENT_SCHEMA),
  target: z.object({ path: absolutePath, state: z.enum(SETUP_TARGET_STATES), kind: z.enum(VAULT_KINDS) }).strict(),
  revision: z.object({
    head: sha1.nullable(),
    worktreeFingerprint: sha256,
  }).strict(),
  host: z.object({
    platform: nonEmpty,
    architecture: nonEmpty,
    supported: z.boolean(),
  }).strict(),
  product: z.object({
    packageName: z.literal("@marktoda/dome"),
    packageVersion: version,
    sourceCommit: sha1,
    productManifestSha256: sha256,
    packagedHome: z.object({
      artifactId: sha256,
      productVersion: version,
      buildCommit: sha1,
      manifestSha256: sha256,
    }).strict(),
  }).strict(),
  prerequisites: z.array(z.object({
    id: z.enum(["bun", "git"]),
    status: z.enum(["available", "missing", "unsupported"]),
    version: nonEmpty.nullable(),
  }).strict()).length(2),
  git: z.object({
    state: z.enum(["absent", "clean", "dirty", "operation-active", "detached", "unborn", "ambiguous"]),
    branch: nonEmpty.nullable(),
  }).strict(),
  dome: z.object({
    state: z.enum(["absent", "partial", "configured", "incompatible"]),
    contentScope: z.enum(["absent", "configured", "incompatible"]),
  }).strict(),
  installedHome: z.object({
    state: z.enum(["absent", "owned", "foreign-owner", "upgrade-active", "ambiguous"]),
    artifactId: sha256.nullable(),
    productVersion: version.nullable(),
    buildCommit: sha1.nullable(),
    manifestSha256: sha256.nullable(),
    selectedVaultPath: absolutePath.nullable(),
  }).strict(),
  markdown: z.object({
    tracked: sortedUnique(markdownPath).max(SETUP_CONTRACT_CAPS.markdownPaths),
    untracked: sortedUnique(markdownPath).max(SETUP_CONTRACT_CAPS.markdownPaths),
    proposedScope: contentScopeSchema,
  }).strict(),
  blockers: z.array(blockerSchema).max(SETUP_CONTRACT_CAPS.blockers),
}).strict();

export const vaultAssessmentSchema = assessmentSchemaBase.superRefine((assessment, context) => {
  const expectedRevisionShape = assessment.git.state === "absent" ? "no-head-no-branch" :
    assessment.git.state === "unborn" ? "no-head-with-branch" :
      assessment.git.state === "detached" ? "head-no-branch" :
        assessment.git.state === "ambiguous" ? "any" : "head-with-branch";
  const actualRevisionShape = assessment.revision.head === null ?
    assessment.git.branch === null ? "no-head-no-branch" : "no-head-with-branch" :
    assessment.git.branch === null ? "head-no-branch" : "head-with-branch";
  if (expectedRevisionShape !== "any" && expectedRevisionShape !== actualRevisionShape) {
    context.addIssue({ code: "custom", path: ["revision"], message: `must match Git state ${assessment.git.state}` });
  }
  if (assessment.product.packagedHome.productVersion !== assessment.product.packageVersion ||
    assessment.product.packagedHome.buildCommit !== assessment.product.sourceCommit) {
    context.addIssue({ code: "custom", path: ["product", "packagedHome"], message: "must match the packaged product version and source commit" });
  }
  const prerequisiteIds = assessment.prerequisites.map((entry) => entry.id);
  if (JSON.stringify(prerequisiteIds) !== JSON.stringify(["bun", "git"])) {
    context.addIssue({ code: "custom", path: ["prerequisites"], message: "must contain bun and git exactly once in canonical order" });
  }
  for (const [index, entry] of assessment.prerequisites.entries()) {
    if ((entry.status === "missing") !== (entry.version === null)) {
      context.addIssue({
        code: "custom",
        path: ["prerequisites", index, "version"],
        message: "must be null exactly when missing and observed otherwise",
      });
    }
  }
  const blockerCodes = assessment.blockers.map((blocker) => blocker.code);
  if (new Set(blockerCodes).size !== blockerCodes.length || blockerCodes.some((code, index) => index > 0 && blockerCodes[index - 1]! >= code)) {
    context.addIssue({ code: "custom", path: ["blockers"], message: "must be sorted and unique by code" });
  }
  const expectedKind = classifySetupVault({
    targetState: assessment.target.state,
    gitState: assessment.git.state,
    gitDirect: assessment.git.state !== "absent",
    domeState: assessment.dome.state,
    blockerCodes,
    installedHomeState: assessment.installedHome.state,
  });
  if (assessment.target.kind !== expectedKind) {
    context.addIssue({ code: "custom", path: ["target", "kind"], message: `must equal ${expectedKind} for the observed evidence` });
  }
  if (assessment.host.supported === assessment.blockers.some((blocker) => blocker.code === "unsupported-host")) {
    context.addIssue({ code: "custom", path: ["host", "supported"], message: "must agree with unsupported-host blocker" });
  }
  requireBlocker(assessment.prerequisites.some((entry) => entry.status === "missing"), "missing-prerequisite", assessment, context);
  requireBlocker(
    assessment.prerequisites.some((entry) => entry.status === "unsupported"),
    "unsupported-prerequisite",
    assessment,
    context,
  );
  requireBlocker(assessment.git.state === "dirty", "dirty-worktree", assessment, context);
  requireBlocker(assessment.git.state === "operation-active", "active-git-operation", assessment, context);
  requireBlocker(assessment.git.state === "detached", "detached-head", assessment, context);
  requireBlocker(assessment.git.state === "unborn", "unborn-repository", assessment, context);
  requireBlocker(assessment.installedHome.state === "upgrade-active", "active-home-upgrade", assessment, context);
  requireBlocker(assessment.installedHome.state === "foreign-owner", "conflicting-home-owner", assessment, context);
  requireBlocker(
    assessment.git.state === "ambiguous" || assessment.installedHome.state === "ambiguous" || assessment.dome.state === "incompatible",
    "ambiguous-state",
    assessment,
    context,
  );
  const installedIdentity = [
    assessment.installedHome.artifactId,
    assessment.installedHome.productVersion,
    assessment.installedHome.buildCommit,
    assessment.installedHome.manifestSha256,
  ];
  if (assessment.installedHome.state === "owned" &&
    (installedIdentity.some((value) => value === null) || assessment.installedHome.selectedVaultPath === null)) {
    context.addIssue({ code: "custom", path: ["installedHome"], message: "owned Home evidence must identify its artifact, build, and vault" });
  }
  if (assessment.installedHome.state === "owned" && assessment.installedHome.selectedVaultPath !== assessment.target.path) {
    context.addIssue({
      code: "custom",
      path: ["installedHome", "selectedVaultPath"],
      message: "owned Home evidence must select the assessed vault; another vault is foreign ownership",
    });
  }
  if (assessment.installedHome.state === "absent" &&
    (installedIdentity.some((value) => value !== null) || assessment.installedHome.selectedVaultPath !== null)) {
    context.addIssue({ code: "custom", path: ["installedHome"], message: "absent Home evidence cannot identify an artifact, build, or vault" });
  }
  if ((assessment.target.state === "missing" || assessment.target.state === "empty-directory") &&
    (assessment.markdown.tracked.length > 0 || assessment.markdown.untracked.length > 0)) {
    context.addIssue({ code: "custom", path: ["markdown"], message: "a new or empty target cannot contain Markdown" });
  }
  if (assessment.git.state === "absent" && assessment.markdown.tracked.length > 0) {
    context.addIssue({ code: "custom", path: ["markdown", "tracked"], message: "a non-Git target cannot contain tracked Markdown" });
  }
  if (assessment.dome.state === "configured" && assessment.target.state !== "existing") {
    context.addIssue({ code: "custom", path: ["target", "state"], message: "configured Dome evidence requires an existing target" });
  }
  if ((assessment.dome.state === "absent" || assessment.dome.state === "partial") &&
    assessment.dome.contentScope !== "absent") {
    context.addIssue({ code: "custom", path: ["dome", "contentScope"], message: "cannot exist without Dome config" });
  }
  if ((assessment.dome.state === "incompatible") !== (assessment.dome.contentScope === "incompatible")) {
    context.addIssue({
      code: "custom",
      path: ["dome", "contentScope"],
      message: "must be incompatible exactly when Dome config is incompatible",
    });
  }
});

export type VaultAssessment = z.infer<typeof vaultAssessmentSchema>;

const setupPlanSchemaBase = z.object({
  schema: z.literal(SETUP_PLAN_SCHEMA),
  status: z.enum(["ready", "blocked"]),
  assessment: vaultAssessmentSchema,
  actions: z.array(adaptationActionSchema).max(SETUP_CONTRACT_CAPS.actions),
  optionalSteps: z.array(z.object({
    kind: z.enum(["configure-model", "configure-integration"]),
    description: nonEmpty,
  }).strict()).max(SETUP_CONTRACT_CAPS.optionalSteps),
  recoveryCommands: sortedUnique(nonEmpty).max(SETUP_CONTRACT_CAPS.recoveryCommands),
  warnings: z.array(z.object({ code: nonEmpty, message: nonEmpty }).strict()).max(SETUP_CONTRACT_CAPS.warnings),
}).strict();

export const setupPlanSchema = setupPlanSchemaBase.superRefine((plan, context) => {
  const shouldBeBlocked = plan.assessment.blockers.length > 0;
  if ((plan.status === "blocked") !== shouldBeBlocked) {
    context.addIssue({ code: "custom", path: ["status"], message: "must agree with assessment blockers" });
  }
  if (shouldBeBlocked && plan.actions.length > 0) {
    context.addIssue({ code: "custom", path: ["actions"], message: "a blocked plan must contain no applicable actions" });
  }
  const actionIds = plan.actions.map((action) => action.id);
  const actionOrder = new Map(ADAPTATION_ACTION_IDS.map((id, index) => [id, index]));
  if (new Set(actionIds).size !== actionIds.length || actionIds.some((id, index) =>
    index > 0 && actionOrder.get(actionIds[index - 1]!)! >= actionOrder.get(id)!
  )) {
    context.addIssue({ code: "custom", path: ["actions"], message: "must contain unique action IDs in canonical order" });
  }
  const expectedActionIds = expectedSetupActionIds(plan.assessment);
  if (JSON.stringify(actionIds) !== JSON.stringify(expectedActionIds)) {
    context.addIssue({ code: "custom", path: ["actions"], message: "must exactly match the assessed setup work" });
  }
  sortedByUniqueKey(plan.optionalSteps, (entry) => entry.kind, ["optionalSteps"], context);
  sortedByUniqueKey(plan.warnings, (entry) => entry.code, ["warnings"], context);
  const writePaths: string[] = [];
  for (const [index, action] of plan.actions.entries()) {
    const path = ["actions", index] as const;
    if (action.kind === "create-vault-directory" && action.path !== plan.assessment.target.path) {
      context.addIssue({ code: "custom", path: [...path, "path"], message: "must equal the assessed vault path" });
    }
    if (action.kind === "initialize-git" && action.repositoryPath !== plan.assessment.target.path) {
      context.addIssue({ code: "custom", path: [...path, "repositoryPath"], message: "must equal the assessed vault path" });
    }
    if (action.kind === "ensure-scaffold-directory") {
      const expected = action.id === "dome-directory" ? { path: ".dome", mode: "0755" } :
        { path: ".dome/state", mode: "0700" };
      if (action.path !== expected.path || action.mode !== expected.mode) {
        context.addIssue({ code: "custom", path: [...path], message: `${action.id} has non-canonical path or mode` });
      }
    }
    if (action.kind === "write-scaffold-file") {
      writePaths.push(action.path);
      const expectedPath = action.id === "agents-orientation" ? "AGENTS.md" : ".gitignore";
      if (action.path !== expectedPath) {
        context.addIssue({ code: "custom", path: [...path, "path"], message: `${action.id} has a non-canonical path` });
      }
    }
    if (action.kind === "set-content-scope") {
      writePaths.push(action.write.path);
      if (JSON.stringify(action.scope) !== JSON.stringify(plan.assessment.markdown.proposedScope)) {
        context.addIssue({ code: "custom", path: [...path, "scope"], message: "must match the proposed Markdown scope" });
      }
    }
    if (action.kind === "activate-home") validateHomeActivation(plan.assessment, action, path, context);
  }
  if (new Set(writePaths).size !== writePaths.length) {
    context.addIssue({ code: "custom", path: ["actions"], message: "must not write the same path twice" });
  }
  const scopeAction = plan.actions.find((action): action is Extract<AdaptationAction, { kind: "set-content-scope" }> =>
    action.kind === "set-content-scope"
  );
  if (scopeAction !== undefined) {
    const expectedOperation = plan.assessment.dome.state === "configured" ? "merge-managed-config" : "create-file";
    if (scopeAction.write.operation !== expectedOperation) {
      context.addIssue({ code: "custom", path: ["actions"], message: "content-scope write operation must match config presence" });
    }
  }
});

export type SetupPlan = z.infer<typeof setupPlanSchema>;

function expectedSetupActionIds(assessment: VaultAssessment): ReadonlyArray<AdaptationAction["id"]> {
  if (assessment.blockers.length > 0) return [];
  const ids: AdaptationAction["id"][] = [];
  if (assessment.target.state === "missing") ids.push("vault-directory");
  if (assessment.git.state === "absent") ids.push("git-repository");
  if (assessment.dome.state !== "configured") {
    ids.push("dome-directory", "dome-state-directory", "agents-orientation", "gitignore", "vault-config");
  } else if (assessment.dome.contentScope === "absent") {
    ids.push("vault-config");
  }
  ids.push("home-activation");
  return ids;
}

function validateHomeActivation(
  assessment: VaultAssessment,
  action: Extract<AdaptationAction, { kind: "activate-home" }>,
  path: ReadonlyArray<string | number>,
  context: z.RefinementCtx,
): void {
  const candidate = assessment.product.packagedHome;
  if (action.artifactId !== candidate.artifactId || action.vaultPath !== assessment.target.path ||
    action.serviceLabel !== homeServiceLabelForVault(assessment.target.path)) {
    context.addIssue({ code: "custom", path: [...path], message: "must activate the packaged Home for the assessed vault" });
  }
  const installedMatchesCandidate = assessment.installedHome.state === "owned" &&
    assessment.installedHome.artifactId === candidate.artifactId &&
    assessment.installedHome.productVersion === candidate.productVersion &&
    assessment.installedHome.buildCommit === candidate.buildCommit &&
    assessment.installedHome.manifestSha256 === candidate.manifestSha256;
  const expectedDisposition = installedMatchesCandidate || assessment.installedHome.state === "absent" ?
    "install-or-resume" : assessment.installedHome.state === "owned" ? "upgrade" : null;
  if (action.disposition !== expectedDisposition) {
    context.addIssue({ code: "custom", path: [...path, "disposition"], message: "must match installed Home identity" });
  }
}

export function validateVaultAssessment(value: unknown): VaultAssessment {
  const snapshot = passiveSetupContractSnapshot(value, "vault assessment");
  return deepFreezeSetupContract(vaultAssessmentSchema.parse(snapshot));
}

export function validateSetupPlan(value: unknown): SetupPlan {
  const snapshot = passiveSetupContractSnapshot(value, "setup plan");
  return deepFreezeSetupContract(setupPlanSchema.parse(snapshot));
}

function sortedByUniqueKey<T>(
  values: ReadonlyArray<T>,
  key: (value: T) => string,
  path: ReadonlyArray<string | number>,
  context: z.RefinementCtx,
): void {
  const keys = values.map(key);
  if (new Set(keys).size !== keys.length || keys.some((value, index) => index > 0 && keys[index - 1]! >= value)) {
    context.addIssue({ code: "custom", path: [...path], message: "must be sorted and unique" });
  }
}

function requireBlocker(
  condition: boolean,
  code: VaultAssessment["blockers"][number]["code"],
  assessment: z.infer<typeof assessmentSchemaBase>,
  context: z.RefinementCtx,
): void {
  if (condition !== assessment.blockers.some((blocker) => blocker.code === code)) {
    context.addIssue({ code: "custom", path: ["blockers"], message: `must agree with ${code} evidence` });
  }
}
