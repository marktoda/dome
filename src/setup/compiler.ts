import { createHash } from "node:crypto";

import { valid, satisfies } from "semver";

import {
  canonicalContentScopeSchema,
  type ContentScopeConfig,
} from "../core/content-scope";
import { compareStrings } from "../core/compare";
import { resolveCapabilityPolicyDocuments } from "../engine/core/capability-policy";
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
import { classifySetupVault } from "./classification";

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
  contentScopeConfig: string;
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
  // Host is observation only in the vault-adaptation slice. Product-host
  // admission belongs to the deferred Home activation milestone.
  const host = Object.freeze({ ...input.host });
  const prerequisites = Object.freeze([
    prerequisite("bun", input.prerequisites.bun),
    prerequisite("git", input.prerequisites.git),
  ]);
  const blockers = new Map<VaultAssessment["blockers"][number]["code"], VaultAssessment["blockers"][number]>();
  for (const blocker of input.source.blockers) blockers.set(blocker.code, blocker);
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

  const blockerRows = [...blockers.values()].sort((left, right) => compareStrings(left.code, right.code));
  const kind = classifySetupVault({
    targetState: input.source.targetState,
    gitState: input.source.git.state,
    gitDirect: input.source.git.direct,
    domeState: input.source.dome.state,
    blockerCodes: blockerRows.map((blocker) => blocker.code),
  });

  return validateVaultAssessment({
    schema: VAULT_ASSESSMENT_SCHEMA,
    target: { path: input.source.targetPath, state: input.source.targetState, kind },
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
    repository: {
      candidates: input.source.repository.candidates.map((candidate) => ({ ...candidate })),
      baselineTracked: [...input.source.repository.baselineTracked],
    },
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
      contentScopeConfigSha256: sha256(input.scaffold.contentScopeConfig),
    },
  })).digest("hex");
}

export function compileSetupPlan(input: SetupCompilerInput): SetupPlan {
  const assessment = compileSetupAssessment(input);
  const blocked = assessment.blockers.length > 0;
  const actions = blocked ? [] : adaptationActions(input);
  const existingContent = assessment.target.kind.startsWith("existing-");
  const warnings: SetupPlan["warnings"] = [];
  if (assessment.dome.state === "configured" && assessment.dome.contentScope === "absent") warnings.push({
    code: "content-scope-migration",
    message: "This existing Dome config has no content scope; review the separate managed scope document before applying.",
  });
  if (existingContent) warnings.push({
    code: "review-content-scope",
    message: "Review the proposed Markdown scope before applying setup to existing owner content.",
  });
  return validateSetupPlan({
    schema: SETUP_PLAN_SCHEMA,
    scope: "vault-adaptation",
    status: blocked ? "blocked" : "ready",
    assessment,
    actions,
    optionalSteps: blocked ? [] : [
      { kind: "configure-integration", description: "Optionally connect calendar or Slack sources after setup." },
      { kind: "configure-model", description: "Optionally configure a local model provider after setup." },
    ],
    deferredSteps: [{
      kind: "activate-home",
      milestone: "M6",
      description: "Install or upgrade Dome Home only through the separately consented Home activation transaction.",
    }],
    recoveryCommands: [`dome setup --dry-run ${JSON.stringify(assessment.target.path)}`],
    warnings,
  });
}

function prerequisite(id: "bun" | "git", version: string | null): VaultAssessment["prerequisites"][number] {
  if (version === null) return Object.freeze({ id, status: "missing" as const, version: null });
  const range = SETUP_PREREQUISITE_POLICY[id];
  const supported = valid(version) !== null && satisfies(version, range, { includePrerelease: true });
  return Object.freeze({ id, status: supported ? "available" as const : "unsupported" as const, version });
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
  if (input.source.targetState === "missing") actions.push({
    kind: "create-vault-directory", id: "vault-directory", path: target, mode: "0755", ifMissing: true,
  });
  if (input.source.git.state === "absent") actions.push({
    kind: "initialize-git", id: "git-repository", repositoryPath: target, ifMissing: true,
  });
  if (input.source.git.state === "absent" && input.source.repository.baselineTracked.length > 0) actions.push({
    kind: "commit-owner-baseline",
    id: "owner-baseline",
    paths: [...input.source.repository.baselineTracked],
    message: "Dome setup: preserve owner baseline",
  });
  if (needsDomeScaffold) {
    actions.push(
      { kind: "ensure-scaffold-directory", id: "dome-directory", path: ".dome", mode: "0755", ifMissing: true },
      { kind: "ensure-scaffold-directory", id: "dome-state-directory", path: ".dome/state", mode: "0700", ifMissing: true },
      scaffoldAction("agents-orientation", "AGENTS.md", input.scaffold.agentsOrientation),
      scaffoldAction("gitignore", ".gitignore", input.scaffold.gitignore),
      {
        kind: "set-content-scope",
        id: "content-scope",
        scope: cloneContentScope(input.contentScope),
        write: fileWrite(".dome/config.yaml", input.scaffold.vaultConfig),
      },
    );
  } else if (input.source.dome.contentScope === "absent") {
    actions.push({
      kind: "set-content-scope",
      id: "content-scope",
      scope: cloneContentScope(input.contentScope),
      write: fileWrite(".dome/content-scope.yaml", input.scaffold.contentScopeConfig),
    });
  }
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

function fileWrite<Path extends ".dome/config.yaml" | ".dome/content-scope.yaml" | "AGENTS.md" | ".gitignore">(
  path: Path,
  body: string,
) {
  const bytes = Buffer.byteLength(body);
  return Object.freeze({
    path,
    operation: "create-file" as const,
    bytes,
    sha256: sha256(body),
    mode: "0644" as const,
    ifMissing: true as const,
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
  for (const [name, documents] of [
    ["vault config", {
      base: { body: scaffold.vaultConfig, path: "setup vault config" },
      contentScope: null,
    }],
    ["content-scope overlay", {
      base: { body: "grants: standard\n", path: "setup overlay base" },
      contentScope: { body: scaffold.contentScopeConfig, path: "setup content-scope overlay" },
    }],
  ] as const) {
    const parsed = resolveCapabilityPolicyDocuments(documents);
    if (!parsed.ok) throw new Error(`setup ${name} scaffold is not valid runtime config: ${parsed.error}`);
    if (parsed.value.contentScope === null || stableJson(parsed.value.contentScope) !== stableJson(scope)) {
      throw new Error(`setup ${name} scaffold does not encode the proposed content scope`);
    }
  }
}

function withoutPath(write: ReturnType<typeof fileWrite>) {
  return {
    bytes: write.bytes,
    sha256: write.sha256,
    mode: write.mode,
    ifMissing: true as const,
  };
}
