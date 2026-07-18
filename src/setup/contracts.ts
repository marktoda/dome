import { z } from "zod";

export const VAULT_ASSESSMENT_SCHEMA = "dome.setup.vault-assessment/v1" as const;
export const SETUP_PLAN_SCHEMA = "dome.setup.plan/v1" as const;

export const VAULT_KINDS = [
  "new-path",
  "empty-directory",
  "existing-non-git-vault",
  "existing-git-vault",
  "existing-dome-vault",
  "incompatible-active-operation",
  "unsafe-or-ambiguous-state",
] as const;

export const ADAPTATION_ACTION_KINDS = [
  "create-vault-directory",
  "initialize-git",
  "ensure-scaffold-directory",
  "write-scaffold-file",
  "set-content-scope",
  "create-baseline-commit",
  "install-home",
  "select-home-vault",
  "install-home-service",
  "start-home",
] as const;

export const ADAPTATION_ACTION_IDS = [
  "vault-directory",
  "git-repository",
  "dome-directory",
  "dome-state-directory",
  "agents-orientation",
  "gitignore",
  "vault-config",
  "baseline-commit",
  "home-artifact",
  "home-vault-selector",
  "home-service",
  "home-start",
] as const;

export const SETUP_CONTRACT_CAPS = Object.freeze({
  markdownPaths: 100_000,
  scopeGlobs: 64,
  writes: 256,
  writeBytes: 1024 * 1024,
  warnings: 64,
  recoveryCommands: 32,
});

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
const markdownPath = relativePath.refine((value) => value.toLowerCase().endsWith(".md"), "must identify Markdown");
const scopeGlob = nonEmpty.refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.includes(".."), "must be a relative glob");

function sortedUnique<T extends z.ZodType<string>>(item: T) {
  return z.array(item).superRefine((values, context) => {
    if (new Set(values).size !== values.length || values.some((value, index) => index > 0 && values[index - 1]! >= value)) {
      context.addIssue({ code: "custom", message: "must be sorted and unique" });
    }
  });
}

const contentScopeSchema = z.object({
  include: sortedUnique(scopeGlob).min(1).max(SETUP_CONTRACT_CAPS.scopeGlobs),
  exclude: sortedUnique(scopeGlob).max(SETUP_CONTRACT_CAPS.scopeGlobs),
}).strict();

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
    kind: z.literal("create-baseline-commit"), id: z.literal("baseline-commit"),
    message: nonEmpty,
    paths: sortedUnique(relativePath).min(1).max(SETUP_CONTRACT_CAPS.markdownPaths),
  }).strict(),
  z.object({ kind: z.literal("install-home"), id: z.literal("home-artifact"), artifactId: sha256 }).strict(),
  z.object({
    kind: z.literal("select-home-vault"), id: z.literal("home-vault-selector"), vaultPath: absolutePath,
  }).strict(),
  z.object({
    kind: z.literal("install-home-service"), id: z.literal("home-service"), serviceLabel,
    ifMissing: z.literal(true),
  }).strict(),
  z.object({ kind: z.literal("start-home"), id: z.literal("home-start"), serviceLabel }).strict(),
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
  target: z.object({ path: absolutePath, kind: z.enum(VAULT_KINDS) }).strict(),
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
  actions: z.array(adaptationActionSchema).max(ADAPTATION_ACTION_IDS.length),
  blockers: z.array(blockerSchema).max(12),
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
  const actionIds = assessment.actions.map((action) => action.id);
  const actionOrder = new Map(ADAPTATION_ACTION_IDS.map((id, index) => [id, index]));
  if (new Set(actionIds).size !== actionIds.length || actionIds.some((id, index) =>
    index > 0 && actionOrder.get(actionIds[index - 1]!)! >= actionOrder.get(id)!
  )) {
    context.addIssue({ code: "custom", path: ["actions"], message: "must contain unique action IDs in canonical order" });
  }
  for (const [index, action] of assessment.actions.entries()) {
    const path = ["actions", index] as const;
    if (action.kind === "create-vault-directory" && action.path !== assessment.target.path) {
      context.addIssue({ code: "custom", path: [...path, "path"], message: "must equal the assessed vault path" });
    }
    if (action.kind === "initialize-git" && action.repositoryPath !== assessment.target.path) {
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
      const expectedPath = action.id === "agents-orientation" ? "AGENTS.md" : ".gitignore";
      if (action.path !== expectedPath) {
        context.addIssue({ code: "custom", path: [...path, "path"], message: `${action.id} has a non-canonical path` });
      }
    }
    if (action.kind === "set-content-scope" && JSON.stringify(action.scope) !== JSON.stringify(assessment.markdown.proposedScope)) {
      context.addIssue({ code: "custom", path: [...path, "scope"], message: "must match the proposed Markdown scope" });
    }
    if (action.kind === "install-home" && action.artifactId !== assessment.product.packagedHome.artifactId) {
      context.addIssue({ code: "custom", path: [...path, "artifactId"], message: "must select the packaged Home artifact" });
    }
    if (action.kind === "select-home-vault" && action.vaultPath !== assessment.target.path) {
      context.addIssue({ code: "custom", path: [...path, "vaultPath"], message: "must select the assessed vault" });
    }
  }
  const blockerCodes = assessment.blockers.map((blocker) => blocker.code);
  if (new Set(blockerCodes).size !== blockerCodes.length || blockerCodes.some((code, index) => index > 0 && blockerCodes[index - 1]! >= code)) {
    context.addIssue({ code: "custom", path: ["blockers"], message: "must be sorted and unique by code" });
  }
  const blockedKind = assessment.target.kind === "incompatible-active-operation" || assessment.target.kind === "unsafe-or-ambiguous-state";
  if (blockedKind !== (assessment.blockers.length > 0)) {
    context.addIssue({ code: "custom", path: ["blockers"], message: "must agree with the vault classification" });
  }
  if (assessment.blockers.length > 0 && assessment.actions.length > 0) {
    context.addIssue({ code: "custom", path: ["actions"], message: "must be empty while assessment is blocked" });
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
  if (assessment.installedHome.state === "absent" &&
    (installedIdentity.some((value) => value !== null) || assessment.installedHome.selectedVaultPath !== null)) {
    context.addIssue({ code: "custom", path: ["installedHome"], message: "absent Home evidence cannot identify an artifact, build, or vault" });
  }
  if ((assessment.target.kind === "new-path" || assessment.target.kind === "empty-directory") &&
    (assessment.markdown.tracked.length > 0 || assessment.markdown.untracked.length > 0)) {
    context.addIssue({ code: "custom", path: ["markdown"], message: "a new or empty target cannot contain Markdown" });
  }
  if (assessment.target.kind === "existing-non-git-vault" && assessment.markdown.tracked.length > 0) {
    context.addIssue({ code: "custom", path: ["markdown", "tracked"], message: "a non-Git target cannot contain tracked Markdown" });
  }
  if (assessment.target.kind === "existing-dome-vault" && assessment.dome.state !== "configured") {
    context.addIssue({ code: "custom", path: ["dome", "state"], message: "an existing Dome vault must be configured" });
  }
  const targetRequiresGit = assessment.target.kind === "existing-git-vault" || assessment.target.kind === "existing-dome-vault";
  const targetForbidsGit = assessment.target.kind === "new-path" || assessment.target.kind === "empty-directory" ||
    assessment.target.kind === "existing-non-git-vault";
  if ((targetRequiresGit && assessment.git.state === "absent") || (targetForbidsGit && assessment.git.state !== "absent")) {
    context.addIssue({ code: "custom", path: ["git", "state"], message: "must agree with the vault classification" });
  }
  if (assessment.target.kind === "new-path" !== assessment.actions.some((action) => action.kind === "create-vault-directory")) {
    context.addIssue({ code: "custom", path: ["actions"], message: "must create the vault directory exactly for a new path" });
  }
  const canInitializeGit = assessment.target.kind === "new-path" || assessment.target.kind === "empty-directory" ||
    assessment.target.kind === "existing-non-git-vault";
  if (assessment.actions.some((action) => action.kind === "initialize-git") !== canInitializeGit) {
    context.addIssue({ code: "custom", path: ["actions"], message: "must initialize Git exactly for a compatible non-Git target" });
  }
  const serviceLabels = assessment.actions.flatMap((action) =>
    action.kind === "install-home-service" || action.kind === "start-home" ? [action.serviceLabel] : []
  );
  if (new Set(serviceLabels).size > 1) {
    context.addIssue({ code: "custom", path: ["actions"], message: "Home install and start actions must use one service label" });
  }
});

export type VaultAssessment = z.infer<typeof vaultAssessmentSchema>;

const writeSchema = z.object({
  id: z.enum(["gitignore", "agents-orientation", "vault-config"]),
  path: relativePath,
  operation: z.enum(["create-file", "merge-managed-config", "append-managed-block"]),
  bytes: z.number().int().nonnegative().max(SETUP_CONTRACT_CAPS.writeBytes),
  sha256,
  mode: z.literal("0644"),
  ifMissing: z.boolean(),
}).strict();

const setupPlanSchemaBase = z.object({
  schema: z.literal(SETUP_PLAN_SCHEMA),
  status: z.enum(["ready", "blocked"]),
  assessment: vaultAssessmentSchema,
  writes: z.array(writeSchema).max(SETUP_CONTRACT_CAPS.writes),
  commits: z.array(z.object({
    kind: z.enum(["baseline", "configuration"]),
    message: nonEmpty,
    paths: sortedUnique(relativePath).min(1).max(SETUP_CONTRACT_CAPS.markdownPaths),
  }).strict()).max(2),
  serviceActions: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("install-home"), artifactId: sha256 }).strict(),
    z.object({ kind: z.literal("select-home-vault"), vaultPath: absolutePath }).strict(),
    z.object({
      kind: z.literal("install-home-service"), serviceLabel, ifMissing: z.literal(true),
    }).strict(),
    z.object({ kind: z.literal("start-home"), serviceLabel }).strict(),
  ])).max(4),
  optionalSteps: z.array(z.object({
    kind: z.enum(["configure-model", "configure-integration"]),
    description: nonEmpty,
  }).strict()).max(2),
  recoveryCommands: sortedUnique(nonEmpty).max(SETUP_CONTRACT_CAPS.recoveryCommands),
  warnings: z.array(z.object({ code: nonEmpty, message: nonEmpty }).strict()).max(SETUP_CONTRACT_CAPS.warnings),
}).strict();

export const setupPlanSchema = setupPlanSchemaBase.superRefine((plan, context) => {
  const shouldBeBlocked = plan.assessment.blockers.length > 0;
  if ((plan.status === "blocked") !== shouldBeBlocked) {
    context.addIssue({ code: "custom", path: ["status"], message: "must agree with assessment blockers" });
  }
  if (shouldBeBlocked && (plan.writes.length > 0 || plan.commits.length > 0 || plan.serviceActions.length > 0)) {
    context.addIssue({ code: "custom", message: "a blocked plan must contain no applicable writes, commits, or service actions" });
  }
  sortedByUniqueKey(plan.writes, (entry) => entry.id, ["writes"], context);
  uniqueByKey(plan.writes, (entry) => entry.path, ["writes"], context);
  orderedUnique(plan.commits, (entry) => entry.kind, ["baseline", "configuration"], ["commits"], context);
  orderedUnique(
    plan.serviceActions,
    (entry) => entry.kind,
    ["install-home", "select-home-vault", "install-home-service", "start-home"],
    ["serviceActions"],
    context,
  );
  sortedByUniqueKey(plan.optionalSteps, (entry) => entry.kind, ["optionalSteps"], context);
  sortedByUniqueKey(plan.warnings, (entry) => entry.code, ["warnings"], context);
  const expectedScaffoldWrites = plan.assessment.actions
    .filter((action): action is Extract<AdaptationAction, { kind: "write-scaffold-file" }> =>
      action.kind === "write-scaffold-file"
    )
    .map((action) => ({
      id: action.id,
      path: action.path,
      operation: "create-file" as const,
      bytes: action.bytes,
      sha256: action.sha256,
      mode: action.mode,
      ifMissing: action.ifMissing,
    }));
  const actualScaffoldWrites = plan.writes.filter((write) => write.id !== "vault-config");
  if (JSON.stringify(actualScaffoldWrites) !== JSON.stringify(expectedScaffoldWrites)) {
    context.addIssue({ code: "custom", path: ["writes"], message: "must exactly project scaffold-file assessment actions" });
  }
  const scopeAction = plan.assessment.actions.find((action): action is Extract<AdaptationAction, {
    kind: "set-content-scope";
  }> => action.kind === "set-content-scope");
  const scopeWrite = plan.writes.find((write) => write.id === "vault-config");
  if ((scopeAction === undefined) !== (scopeWrite === undefined) ||
    (scopeAction !== undefined && scopeWrite !== undefined && JSON.stringify(scopeWrite) !== JSON.stringify({
      id: scopeWrite.id,
      ...scopeAction.write,
    }))) {
    context.addIssue({ code: "custom", path: ["writes"], message: "must bind content-scope to its exact vault-config write" });
  }
  const baselineAction = plan.assessment.actions.find((action): action is Extract<AdaptationAction, {
    kind: "create-baseline-commit";
  }> => action.kind === "create-baseline-commit");
  const baselineCommit = plan.commits.find((commit) => commit.kind === "baseline");
  if ((baselineAction === undefined) !== (baselineCommit === undefined) ||
    (baselineAction !== undefined && baselineCommit !== undefined &&
      (baselineAction.message !== baselineCommit.message || JSON.stringify(baselineAction.paths) !== JSON.stringify(baselineCommit.paths)))) {
    context.addIssue({ code: "custom", path: ["commits"], message: "must exactly project the baseline-commit assessment action" });
  }
  const configurationCommit = plan.commits.find((commit) => commit.kind === "configuration");
  const applicableWritePaths = [...new Set(plan.writes.map((write) => write.path))].sort();
  if ((configurationCommit !== undefined) !== (plan.writes.length > 0)) {
    context.addIssue({ code: "custom", path: ["commits"], message: "configuration commit must exist exactly when plan writes apply" });
  } else if (configurationCommit !== undefined &&
    JSON.stringify(configurationCommit.paths) !== JSON.stringify(applicableWritePaths)) {
    context.addIssue({ code: "custom", path: ["commits"], message: "configuration commit paths must equal applicable plan writes" });
  }
  const expectedServices: Array<(typeof plan.serviceActions)[number]> = [];
  for (const action of plan.assessment.actions) {
    if (action.kind === "install-home") expectedServices.push({ kind: action.kind, artifactId: action.artifactId });
    if (action.kind === "select-home-vault") expectedServices.push({ kind: action.kind, vaultPath: action.vaultPath });
    if (action.kind === "install-home-service") expectedServices.push({
      kind: action.kind, serviceLabel: action.serviceLabel, ifMissing: action.ifMissing,
    });
    if (action.kind === "start-home") expectedServices.push({ kind: action.kind, serviceLabel: action.serviceLabel });
  }
  if (JSON.stringify(plan.serviceActions) !== JSON.stringify(expectedServices)) {
    context.addIssue({ code: "custom", path: ["serviceActions"], message: "must exactly project Home assessment actions" });
  }
});

export type SetupPlan = z.infer<typeof setupPlanSchema>;

export function validateVaultAssessment(value: unknown): VaultAssessment {
  return vaultAssessmentSchema.parse(value);
}

export function validateSetupPlan(value: unknown): SetupPlan {
  return setupPlanSchema.parse(value);
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

function uniqueByKey<T>(
  values: ReadonlyArray<T>,
  key: (value: T) => string,
  path: ReadonlyArray<string | number>,
  context: z.RefinementCtx,
): void {
  const keys = values.map(key);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", path: [...path], message: "must not contain duplicate target paths" });
  }
}

function orderedUnique<T, K extends string>(
  values: ReadonlyArray<T>,
  key: (value: T) => K,
  order: ReadonlyArray<K>,
  path: ReadonlyArray<string | number>,
  context: z.RefinementCtx,
): void {
  const keys = values.map(key);
  const positions = new Map(order.map((value, index) => [value, index]));
  if (new Set(keys).size !== keys.length || keys.some((value, index) =>
    index > 0 && positions.get(keys[index - 1]!)! >= positions.get(value)!
  )) {
    context.addIssue({ code: "custom", path: [...path], message: "must be unique and in canonical operation order" });
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
