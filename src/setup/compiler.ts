import { createHash } from "node:crypto";

import { valid, satisfies } from "semver";
import { parse as parseYaml } from "yaml";

import {
  canonicalContentScopeSchema,
  type ContentScopeConfig,
} from "../core/content-scope";
import { vaultServiceSlug } from "../surface/service-probe";
import {
  SETUP_PLAN_SCHEMA,
  SETUP_CONTRACT_CAPS,
  VAULT_ASSESSMENT_SCHEMA,
  type AdaptationAction,
  type SetupPlan,
  type VaultAssessment,
  validateSetupPlan,
  validateVaultAssessment,
} from "./contracts";
import {
  validateSetupVaultSourceInspection,
  type SetupVaultSourceInspection,
} from "./vault-inspector";

export const SETUP_PREREQUISITE_POLICY = Object.freeze({
  bun: ">=1.2.13 <2",
  // GIT_NO_LAZY_FETCH first shipped in Git 2.45. Setup depends on it to
  // inspect partial clones without contacting a promisor remote.
  git: ">=2.45.0",
});

export type SetupObservedPrerequisites = Readonly<{
  bun: string | null;
  git: string | null;
}>;

export type SetupProductEvidence = VaultAssessment["product"];
export type SetupInstalledHomeEvidence = VaultAssessment["installedHome"];

export type SetupScaffoldEvidence = Readonly<{
  agentsOrientation: string;
  gitignore: string;
  vaultConfig: string;
}>;

/**
 * Closed discovery result consumed by the pure setup compiler. Discovery owns
 * I/O; this module owns all classification, prerequisite policy, and planning.
 */
export type SetupCompilerInput = Readonly<{
  source: SetupVaultSourceInspection;
  host: Readonly<{ platform: string; architecture: string }>;
  prerequisites: SetupObservedPrerequisites;
  product: SetupProductEvidence;
  installedHome: SetupInstalledHomeEvidence;
  contentScope: ContentScopeConfig;
  scaffold: SetupScaffoldEvidence;
}>;

export function compileSetupAssessment(input: SetupCompilerInput): VaultAssessment {
  validateSetupVaultSourceInspection(input.source);
  const contentScope = canonicalContentScopeSchema.parse(input.contentScope);
  assertScaffoldBindsScope(input.scaffold, contentScope);
  const host = Object.freeze({
    ...input.host,
    supported: input.host.platform === "darwin" && input.host.architecture === "arm64",
  });
  const prerequisites = Object.freeze([
    prerequisite("bun", input.prerequisites.bun),
    prerequisite("git", input.prerequisites.git),
  ]);
  const blockers = new Map<VaultAssessment["blockers"][number]["code"], VaultAssessment["blockers"][number]>();
  for (const blocker of input.source.blockers) blockers.set(blocker.code, blocker);
  if (!host.supported) addBlocker(blockers, {
    code: "unsupported-host",
    message: `Dome Home does not support ${host.platform}/${host.architecture}.`,
    nextAction: "Use a macOS arm64 host, then reassess.",
  });
  if (prerequisites.some((entry) => entry.status === "missing")) addBlocker(blockers, {
    code: "missing-prerequisite",
    message: "Bun and Git must both be installed before Dome setup.",
    nextAction: "Install the missing prerequisite, then reassess.",
  });
  if (prerequisites.some((entry) => entry.status === "unsupported")) addBlocker(blockers, {
    code: "unsupported-prerequisite",
    message: `Dome setup requires Bun ${SETUP_PREREQUISITE_POLICY.bun} and Git ${SETUP_PREREQUISITE_POLICY.git}.`,
    nextAction: "Upgrade the unsupported prerequisite, then reassess.",
  });
  addHomeBlocker(blockers, input.installedHome);

  const blockerRows = [...blockers.values()].sort((left, right) => left.code.localeCompare(right.code));
  const kind = classify(input.source.kind, input.installedHome.state, blockerRows.length > 0);
  const actions = blockerRows.length === 0 ? adaptationActions(input) : [];

  return validateVaultAssessment({
    schema: VAULT_ASSESSMENT_SCHEMA,
    target: { path: input.source.targetPath, kind },
    revision: {
      head: input.source.git.head,
      worktreeFingerprint: fingerprintValidatedInput(input, contentScope),
    },
    host,
    product: input.product,
    prerequisites,
    git: { state: input.source.git.state, branch: input.source.git.branch },
    dome: input.source.dome,
    installedHome: input.installedHome,
    markdown: {
      tracked: [...input.source.markdown.tracked],
      untracked: [...input.source.markdown.untracked],
      proposedScope: cloneContentScope(contentScope),
    },
    actions,
    blockers: blockerRows,
  });
}

/** Binds the plan to both vault bytes and every injected classification input. */
export function setupRevisionFingerprint(input: SetupCompilerInput): string {
  validateSetupVaultSourceInspection(input.source);
  const contentScope = canonicalContentScopeSchema.parse(input.contentScope);
  assertScaffoldBindsScope(input.scaffold, contentScope);
  return fingerprintValidatedInput(input, contentScope);
}

function fingerprintValidatedInput(input: SetupCompilerInput, contentScope: ContentScopeConfig): string {
  return createHash("sha256").update(stableJson({
    source: input.source,
    host: input.host,
    prerequisites: input.prerequisites,
    product: input.product,
    installedHome: input.installedHome,
    contentScope,
    scaffold: {
      agentsOrientationSha256: sha256(input.scaffold.agentsOrientation),
      gitignoreSha256: sha256(input.scaffold.gitignore),
      vaultConfigSha256: sha256(input.scaffold.vaultConfig),
    },
  })).digest("hex");
}

export function compileSetupPlan(input: SetupCompilerInput): SetupPlan {
  const assessment = compileSetupAssessment(input);
  const blocked = assessment.blockers.length > 0;
  const writes: SetupPlan["writes"] = [];
  if (!blocked) for (const action of assessment.actions) {
    if (action.kind === "write-scaffold-file") writes.push({
      id: action.id,
      path: action.path,
      operation: "create-file" as const,
      bytes: action.bytes,
      sha256: action.sha256,
      mode: action.mode,
      ifMissing: action.ifMissing,
    });
    if (action.kind === "set-content-scope") writes.push({ id: action.id, ...action.write });
  }
  const baseline = assessment.actions.find((action): action is Extract<AdaptationAction, {
    kind: "create-baseline-commit";
  }> => action.kind === "create-baseline-commit");
  const commits: SetupPlan["commits"] = blocked ? [] : [
    ...(baseline === undefined ? [] : [{
      kind: "baseline" as const,
      message: baseline.message,
      paths: baseline.paths,
    }]),
    ...(writes.length === 0 ? [] : [{
      kind: "configuration" as const,
      message: "Configure Dome vault",
      paths: [...new Set(writes.map((write) => write.path))].sort(),
    }]),
  ];
  const serviceActions: SetupPlan["serviceActions"] = [];
  if (!blocked) for (const action of assessment.actions) {
    if (action.kind === "install-home") serviceActions.push({
      kind: action.kind,
      artifactId: action.artifactId,
      disposition: action.disposition,
    });
    if (action.kind === "select-home-vault") serviceActions.push({ kind: action.kind, vaultPath: action.vaultPath });
    if (action.kind === "install-home-service") serviceActions.push({
      kind: action.kind,
      serviceLabel: action.serviceLabel,
      ifMissing: action.ifMissing,
    });
    if (action.kind === "start-home") serviceActions.push({ kind: action.kind, serviceLabel: action.serviceLabel });
  }
  const existingContent = assessment.target.kind.startsWith("existing-");
  return validateSetupPlan({
    schema: SETUP_PLAN_SCHEMA,
    status: blocked ? "blocked" : "ready",
    assessment,
    writes,
    commits,
    serviceActions,
    optionalSteps: blocked ? [] : [
      { kind: "configure-integration", description: "Optionally connect calendar or Slack sources after setup." },
      { kind: "configure-model", description: "Optionally configure a local model provider after setup." },
    ],
    recoveryCommands: [`dome setup --dry-run ${JSON.stringify(assessment.target.path)}`],
    warnings: existingContent ? [{
      code: "review-content-scope",
      message: "Review the proposed Markdown scope before applying setup to existing owner content.",
    }] : [],
  });
}

function prerequisite(id: "bun" | "git", version: string | null): VaultAssessment["prerequisites"][number] {
  if (version === null) return Object.freeze({ id, status: "missing" as const, version: null });
  const range = SETUP_PREREQUISITE_POLICY[id];
  const supported = valid(version) !== null && satisfies(version, range, { includePrerelease: true });
  return Object.freeze({ id, status: supported ? "available" as const : "unsupported" as const, version });
}

function classify(
  sourceKind: SetupVaultSourceInspection["kind"],
  installedHome: SetupInstalledHomeEvidence["state"],
  blocked: boolean,
): VaultAssessment["target"]["kind"] {
  if (!blocked) return sourceKind;
  if (sourceKind === "incompatible-active-operation" || installedHome === "upgrade-active") {
    return "incompatible-active-operation";
  }
  return "unsafe-or-ambiguous-state";
}

function addHomeBlocker(
  blockers: Map<VaultAssessment["blockers"][number]["code"], VaultAssessment["blockers"][number]>,
  home: SetupInstalledHomeEvidence,
): void {
  if (home.state === "upgrade-active") addBlocker(blockers, {
    code: "active-home-upgrade",
    message: "A Dome Home upgrade is active.",
    nextAction: "Complete or recover the Home upgrade, then reassess.",
  });
  if (home.state === "foreign-owner") addBlocker(blockers, {
    code: "conflicting-home-owner",
    message: "Dome Home is selected for a different vault owner.",
    nextAction: "Resolve the existing Home vault selection, then reassess.",
  });
  if (home.state === "ambiguous") addBlocker(blockers, {
    code: "ambiguous-state",
    message: "Installed Dome Home evidence is incomplete or inconsistent.",
    nextAction: "Repair or remove the ambiguous Home installation, then reassess.",
  });
}

function addBlocker(
  blockers: Map<VaultAssessment["blockers"][number]["code"], VaultAssessment["blockers"][number]>,
  blocker: VaultAssessment["blockers"][number],
): void {
  if (!blockers.has(blocker.code)) blockers.set(blocker.code, Object.freeze(blocker));
}

function adaptationActions(input: SetupCompilerInput): AdaptationAction[] {
  const actions: AdaptationAction[] = [];
  const target = input.source.targetPath;
  const needsDomeScaffold = input.source.dome.state !== "configured";
  if (input.source.kind === "new-path") actions.push({
    kind: "create-vault-directory", id: "vault-directory", path: target, mode: "0755", ifMissing: true,
  });
  if (input.source.git.state === "absent") actions.push({
    kind: "initialize-git", id: "git-repository", repositoryPath: target, ifMissing: true,
  });
  if (needsDomeScaffold) {
    actions.push(
      { kind: "ensure-scaffold-directory", id: "dome-directory", path: ".dome", mode: "0755", ifMissing: true },
      { kind: "ensure-scaffold-directory", id: "dome-state-directory", path: ".dome/state", mode: "0700", ifMissing: true },
      scaffoldAction("agents-orientation", "AGENTS.md", input.scaffold.agentsOrientation),
      scaffoldAction("gitignore", ".gitignore", input.scaffold.gitignore),
      {
        kind: "set-content-scope",
        id: "vault-config",
        scope: cloneContentScope(input.contentScope),
        write: fileWrite(".dome/config.yaml", input.scaffold.vaultConfig),
      },
    );
  }
  if (input.source.git.state === "absent" && input.source.markdown.untracked.length > 0) actions.push({
    kind: "create-baseline-commit",
    id: "baseline-commit",
    message: "Preserve existing vault content before Dome setup",
    paths: [...input.source.markdown.untracked],
  });
  const candidate = input.product.packagedHome;
  const sameCandidate = input.installedHome.state === "owned" &&
    input.installedHome.artifactId === candidate.artifactId &&
    input.installedHome.productVersion === candidate.productVersion &&
    input.installedHome.buildCommit === candidate.buildCommit &&
    input.installedHome.manifestSha256 === candidate.manifestSha256;
  const disposition = input.installedHome.state === "owned" && !sameCandidate ? "upgrade" as const : "install-or-resume" as const;
  const serviceLabel = `com.dome.home.${vaultServiceSlug(target)}`;
  actions.push(
    { kind: "install-home", id: "home-artifact", artifactId: candidate.artifactId, disposition },
    { kind: "select-home-vault", id: "home-vault-selector", vaultPath: target },
    { kind: "install-home-service", id: "home-service", serviceLabel, ifMissing: true },
    { kind: "start-home", id: "home-start", serviceLabel },
  );
  return actions;
}

function scaffoldAction(
  id: "agents-orientation" | "gitignore",
  path: "AGENTS.md" | ".gitignore",
  body: string,
): Extract<AdaptationAction, { kind: "write-scaffold-file" }> {
  const write = fileWrite(path, body);
  return { kind: "write-scaffold-file", id, path, ...withoutPath(write) };
}

function fileWrite<Path extends ".dome/config.yaml" | "AGENTS.md" | ".gitignore">(path: Path, body: string) {
  const bytes = Buffer.byteLength(body);
  return Object.freeze({
    path,
    operation: "create-file" as const,
    bytes,
    sha256: sha256(body),
    mode: "0644" as const,
    ifMissing: true,
  });
}

function cloneContentScope(scope: ContentScopeConfig): VaultAssessment["markdown"]["proposedScope"] {
  return { version: scope.version, include: [...scope.include], exclude: [...scope.exclude] };
}

function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertScaffoldBindsScope(scaffold: SetupScaffoldEvidence, scope: ContentScopeConfig): void {
  for (const [name, body] of Object.entries(scaffold)) {
    if (Buffer.byteLength(body) > SETUP_CONTRACT_CAPS.writeBytes) {
      throw new Error(`setup ${name} scaffold exceeds the write budget`);
    }
  }
  let decoded: unknown;
  try { decoded = parseYaml(scaffold.vaultConfig); }
  catch { throw new Error("setup vault config scaffold is invalid YAML"); }
  const rawPersisted = typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
    ? (decoded as Record<string, unknown>)["content_scope"]
    : undefined;
  const persisted = canonicalContentScopeSchema.safeParse(rawPersisted);
  if (!persisted.success || stableJson(persisted.data) !== stableJson(scope)) {
    throw new Error("setup vault config scaffold does not encode the proposed content scope");
  }
}

function withoutPath(write: ReturnType<typeof fileWrite>) {
  return {
    bytes: write.bytes,
    sha256: write.sha256,
    mode: write.mode,
    ifMissing: write.ifMissing,
  };
}
