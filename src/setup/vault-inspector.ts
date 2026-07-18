import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import ignore from "ignore";

import { compareStrings } from "../core/compare";
import { parseCapabilityPolicy } from "../engine/core/capability-policy";
import { findGitRoot } from "../git";
import { SETUP_CONTRACT_CAPS, type VaultAssessment } from "./contracts";
import {
  classifySetupVault,
  SETUP_TARGET_STATES,
  VAULT_KINDS,
  type SetupTargetState,
} from "./classification";
import {
  deriveSetupRepositoryCandidate,
  domePrivateRepositoryPath,
  privateCaseAliasPath,
  sensitiveRepositoryPath,
  SETUP_REPOSITORY_CANDIDATE_KINDS,
  SETUP_REPOSITORY_DISPOSITIONS,
  SETUP_REPOSITORY_MAX_BASELINE_FILE_BYTES,
  SETUP_REPOSITORY_REASONS,
  symlinkRepositoryReason,
  validateSetupRepositoryCandidate,
  type SetupRepositoryCandidate,
} from "./repository-policy";
export {
  SETUP_REPOSITORY_CANDIDATE_KINDS,
  SETUP_REPOSITORY_DISPOSITIONS,
  SETUP_REPOSITORY_REASONS,
  type SetupRepositoryCandidate,
} from "./repository-policy";

export const SETUP_VAULT_INSPECTION_SCHEMA = "dome.setup.vault-source-inspection/v1" as const;

export const SETUP_VAULT_INSPECTION_CAPS = Object.freeze({
  entries: 100_000,
  fileBytes: SETUP_REPOSITORY_MAX_BASELINE_FILE_BYTES,
  totalBytes: 256 * 1024 * 1024,
  commandBytes: 16 * 1024 * 1024,
  commandTimeoutMs: 10_000,
  externalEvidence: 64,
});

export type SetupVaultInspectionCaps = Readonly<{
  [Key in keyof typeof SETUP_VAULT_INSPECTION_CAPS]: number;
}>;

export type SetupFingerprintEvidence = Readonly<{
  id: string;
  sha256: string;
}>;

export type SetupGitCommandResult = Readonly<{
  exitCode: number;
  stdout: Buffer;
  stderr: string;
}>;

export type SetupGitRunner = (
  args: ReadonlyArray<string>,
  cwd: string,
  caps: Pick<SetupVaultInspectionCaps, "commandBytes" | "commandTimeoutMs">,
) => Promise<SetupGitCommandResult>;

export type SetupVaultSourceInspection = Readonly<{
  schema: typeof SETUP_VAULT_INSPECTION_SCHEMA;
  targetPath: string;
  targetState: SetupTargetState;
  kind: VaultAssessment["target"]["kind"];
  git: Readonly<{
    state: VaultAssessment["git"]["state"];
    head: string | null;
    branch: string | null;
    direct: boolean;
    ancestorRoot: string | null;
    operationMarkers: ReadonlyArray<string>;
  }>;
  dome: VaultAssessment["dome"];
  markdown: Readonly<{
    tracked: ReadonlyArray<string>;
    untracked: ReadonlyArray<string>;
  }>;
  repository: Readonly<{
    candidates: ReadonlyArray<SetupRepositoryCandidate>;
    baselineTracked: ReadonlyArray<string>;
  }>;
  blockers: ReadonlyArray<VaultAssessment["blockers"][number]>;
  worktreeFingerprint: string;
}>;

export type InspectSetupVaultOptions = Readonly<{
  caps?: Partial<SetupVaultInspectionCaps> | undefined;
  externalFingerprintEvidence?: ReadonlyArray<SetupFingerprintEvidence> | undefined;
  runGit?: SetupGitRunner | undefined;
  proofCheckpoint?: ((phase: SetupInspectionProofPhase) => Promise<void>) | undefined;
}>;

export type SetupInspectionProofPhase =
  | "target-1"
  | "git-1"
  | "tree-1"
  | "git-2"
  | "tree-2"
  | "git-3";

type FileEvidence = Readonly<{
  path: string;
  kind: "directory" | "file" | "symlink" | "special";
  mode: number;
  bytes: number;
  sha256: string | null;
  gitBlobId: string | null;
  filesystemIdentitySha256: string;
  ignoreCase?: boolean;
  linkTarget: string | null;
  tracking: "tracked" | "untracked" | "ignored" | "other";
  safetyReason: SetupRepositoryCandidate["reason"];
}>;

type GitEvidence = Readonly<{
  state: VaultAssessment["git"]["state"];
  head: string | null;
  branch: string | null;
  direct: boolean;
  ancestorRoot: string | null;
  operationMarkers: ReadonlyArray<string>;
  tracked: ReadonlySet<string>;
  untracked: ReadonlySet<string>;
  ignored: ReadonlySet<string>;
  ignoredPrefixes: ReadonlyArray<string>;
  indexStats: ReadonlyMap<string, GitIndexStat>;
  indexEntries: ReadonlyMap<string, IndexEntry>;
  stagedDirty: boolean;
  gitEntrySha256: string | null;
  indexSha256: string | null;
  dirtySha256: string | null;
  infoExcludeSha256: string | null;
}>;

type IndexEntry = Readonly<{ path: string; mode: string; oid: string }>;
type GitIndexStat = Readonly<{
  ctimeSeconds: number; ctimeNanoseconds: number;
  mtimeSeconds: number; mtimeNanoseconds: number;
  dev: number; ino: number; size: number;
}>;

type BlockerCode = VaultAssessment["blockers"][number]["code"];

type TargetInspection = Readonly<{
  exists: boolean;
  isDirectory: boolean;
  empty: boolean;
  inspectable: boolean;
  proofSha256: string;
}>;

/**
 * Inspect only the selected path. An ancestor repository is conflict evidence,
 * never the selected vault's Git boundary. No path is created or followed.
 */
export async function inspectSetupVaultSource(
  targetInput: string,
  options: InspectSetupVaultOptions = {},
): Promise<SetupVaultSourceInspection> {
  const targetPath = resolve(targetInput);
  const caps = inspectionCaps(options.caps);
  const blockers = new Map<BlockerCode, VaultAssessment["blockers"][number]>();
  const addBlocker = blockerCollector(blockers);
  const firstBlockers = new Map<BlockerCode, VaultAssessment["blockers"][number]>();
  const addFirstBlocker = blockerCollector(firstBlockers);
  const secondBlockers = new Map<BlockerCode, VaultAssessment["blockers"][number]>();
  const addSecondBlocker = blockerCollector(secondBlockers);

  const initialTarget = await inspectTarget(targetPath, addFirstBlocker);
  await options.proofCheckpoint?.("target-1");
  const runGit = options.runGit ?? runGitReadOnly;
  const initialControlAliases = await inspectRootControlAliases(
    targetPath, initialTarget.inspectable && initialTarget.isDirectory, addFirstBlocker,
  );
  const initialRawGit = await inspectGit(
    targetPath, initialTarget.exists, initialTarget.inspectable, initialControlAliases.length > 0,
    caps, runGit, addFirstBlocker,
  );
  await options.proofCheckpoint?.("git-1");
  const initialTree = initialTarget.inspectable && initialTarget.isDirectory
    ? await inspectTreeSafely(targetPath, initialRawGit, caps, addFirstBlocker)
    : Object.freeze([] as FileEvidence[]);
  await options.proofCheckpoint?.("tree-1");
  const initialGit = finalizeGitDirtyState(initialRawGit, initialTree, addFirstBlocker);
  const middleControlAliases = await inspectRootControlAliases(
    targetPath, initialTarget.inspectable && initialTarget.isDirectory, addSecondBlocker,
  );
  const middleRawGit = await inspectGit(
    targetPath, initialTarget.exists, initialTarget.inspectable, middleControlAliases.length > 0,
    caps, runGit, addSecondBlocker,
  );
  await options.proofCheckpoint?.("git-2");
  const tree = initialTarget.inspectable && initialTarget.isDirectory
    ? await inspectTreeSafely(targetPath, middleRawGit, caps, addSecondBlocker)
    : Object.freeze([] as FileEvidence[]);
  await options.proofCheckpoint?.("tree-2");
  const middleGit = finalizeGitDirtyState(middleRawGit, tree, addSecondBlocker);
  const finalControlAliases = await inspectRootControlAliases(
    targetPath, initialTarget.inspectable && initialTarget.isDirectory, addBlocker,
  );
  const finalRawGit = await inspectGit(
    targetPath, initialTarget.exists, initialTarget.inspectable, finalControlAliases.length > 0,
    caps, runGit, addBlocker,
  );
  await options.proofCheckpoint?.("git-3");
  let git = finalizeGitDirtyState(finalRawGit, tree, addBlocker);
  const target = await inspectTarget(targetPath, addBlocker);
  const stable = JSON.stringify(gitProof(initialGit)) === JSON.stringify(gitProof(middleGit)) &&
    JSON.stringify(gitProof(middleGit)) === JSON.stringify(gitProof(git)) &&
    JSON.stringify(initialControlAliases) === JSON.stringify(middleControlAliases) &&
    JSON.stringify(middleControlAliases) === JSON.stringify(finalControlAliases) &&
    JSON.stringify(initialTree) === JSON.stringify(tree) &&
    initialTarget.proofSha256 === target.proofSha256;
  if (stable) mergeBlockers(secondBlockers, blockers);
  else {
    mergeSafetyBlockers(secondBlockers, blockers);
    for (const code of ["dirty-worktree", "active-git-operation", "detached-head", "unborn-repository"] as const) {
      blockers.delete(code);
    }
    git = Object.freeze({ ...git, state: "ambiguous" });
    addBlocker("ambiguous-state", "The vault changed during setup inspection.",
      "Wait for concurrent changes to finish, then reassess.");
  }
  const dome = await inspectDomeState(targetPath, tree, addBlocker);

  const trackedMarkdown = markdownPaths(git.tracked);
  const untrackedMarkdown = git.direct
    ? markdownPaths(git.untracked)
    : tree.filter((entry) => entry.kind !== "directory" && entry.tracking !== "ignored" && entry.path.endsWith(".md"))
      .map((entry) => entry.path).sort(compareStrings);
  const repositoryCandidates = repositoryInventory(tree, git.direct);
  const baselineTracked = repositoryCandidates
    .filter((candidate) => candidate.disposition === "baseline")
    .map((candidate) => candidate.path);
  if (trackedMarkdown.length > caps.entries || untrackedMarkdown.length > caps.entries) {
    addBlocker("unsafe-path", "Markdown inventory exceeds the setup assessment budget.",
      "Narrow the selected vault boundary, then reassess.");
  }

  const blockerList = Object.freeze([...blockers.values()].sort((left, right) => compareStrings(left.code, right.code)));
  const targetState = setupTargetState(target);
  const kind = classifySetupVault({
    targetState,
    gitState: git.state,
    gitDirect: git.direct,
    domeState: dome.state,
    blockerCodes: blockerList.map((blocker) => blocker.code),
  });
  const external = normalizeExternalEvidence(options.externalFingerprintEvidence ?? [], caps.externalEvidence);
  const fingerprint = hashJson({
    schema: "dome.setup.worktree-fingerprint/v1",
    targetPath,
    target: {
      exists: target.exists,
      isDirectory: target.isDirectory,
      empty: target.empty,
      inspectable: target.inspectable,
      proofSha256: target.proofSha256,
    },
    classification: { kind, blockers: blockerList },
    git: {
      direct: git.direct,
      ancestorRoot: git.ancestorRoot,
      state: git.state,
      head: git.head,
      branch: git.branch,
      operationMarkers: git.operationMarkers,
      tracked: [...git.tracked].sort(compareStrings),
      untracked: [...git.untracked].sort(compareStrings),
      ignored: [...git.ignored].sort(compareStrings),
      gitEntrySha256: git.gitEntrySha256,
      indexSha256: git.indexSha256,
      dirtySha256: git.dirtySha256,
      infoExcludeSha256: git.infoExcludeSha256,
    },
    dome,
    tree,
    external,
  });

  return validateSetupVaultSourceInspection(Object.freeze({
    schema: SETUP_VAULT_INSPECTION_SCHEMA,
    targetPath,
    targetState,
    kind,
    git: Object.freeze({
      state: git.state,
      head: git.head,
      branch: git.branch,
      direct: git.direct,
      ancestorRoot: git.ancestorRoot,
      operationMarkers: git.operationMarkers,
    }),
    dome,
    markdown: Object.freeze({
      tracked: Object.freeze(trackedMarkdown.slice(0, caps.entries)),
      untracked: Object.freeze(untrackedMarkdown.slice(0, caps.entries)),
    }),
    repository: Object.freeze({
      candidates: Object.freeze(repositoryCandidates),
      baselineTracked: Object.freeze(baselineTracked),
    }),
    blockers: blockerList,
    worktreeFingerprint: fingerprint,
  }));
}

/** Validate injected discovery evidence before the setup compiler trusts it. */
export function validateSetupVaultSourceInspection(value: unknown): SetupVaultSourceInspection {
  const source = exactObject(value, "setup source inspection", [
    "schema", "targetPath", "targetState", "kind", "git", "dome", "markdown", "repository", "blockers", "worktreeFingerprint",
  ]);
  if (source["schema"] !== SETUP_VAULT_INSPECTION_SCHEMA) throw new Error("setup source inspection schema is invalid");
  const targetPath = normalizedAbsolutePath(source["targetPath"], "setup source target path");
  if (!SETUP_TARGET_STATES.includes(source["targetState"] as SetupTargetState)) {
    throw new Error("setup source target state is invalid");
  }
  const targetState = source["targetState"] as SetupTargetState;
  if (!VAULT_KINDS.includes(source["kind"] as typeof VAULT_KINDS[number])) {
    throw new Error("setup source classification is invalid");
  }
  const kind = source["kind"] as SetupVaultSourceInspection["kind"];
  const git = exactObject(source["git"], "setup source Git evidence", [
    "state", "head", "branch", "direct", "ancestorRoot", "operationMarkers",
  ]);
  const gitStates = ["absent", "clean", "dirty", "operation-active", "detached", "unborn", "ambiguous"] as const;
  if (!gitStates.includes(git["state"] as typeof gitStates[number]) || typeof git["direct"] !== "boolean") {
    throw new Error("setup source Git state is invalid");
  }
  const state = git["state"] as SetupVaultSourceInspection["git"]["state"];
  const head = git["head"];
  if (head !== null && (typeof head !== "string" || !/^[0-9a-f]{40}$/.test(head))) {
    throw new Error("setup source Git head is invalid");
  }
  const branch = git["branch"];
  if (branch !== null && !boundedText(branch)) throw new Error("setup source Git branch is invalid");
  const ancestorRoot = git["ancestorRoot"] === null ? null :
    normalizedAbsolutePath(git["ancestorRoot"], "setup source ancestor root");
  const markers = sortedUniqueStrings(git["operationMarkers"], "setup source Git operation markers", 64);
  if (git["direct"] && ancestorRoot !== null || !git["direct"] && state !== "absent" && state !== "ambiguous") {
    throw new Error("setup source Git boundary evidence is inconsistent");
  }
  if ((state === "operation-active") !== (markers.length > 0) && state !== "ambiguous") {
    throw new Error("setup source Git operation evidence is inconsistent");
  }
  const shape = head === null ? branch === null ? "none" : "branch" : branch === null ? "head" : "both";
  const expectedShape = state === "absent" ? "none" : state === "unborn" ? "branch" :
    state === "detached" ? "head" : state === "ambiguous" ? shape : "both";
  if (shape !== expectedShape) throw new Error("setup source Git revision evidence is inconsistent");

  const dome = exactObject(source["dome"], "setup source Dome evidence", ["state", "contentScope"]);
  const domeStates = ["absent", "partial", "configured", "incompatible"] as const;
  if (!domeStates.includes(dome["state"] as typeof domeStates[number])) throw new Error("setup source Dome state is invalid");
  const contentScopeStates = ["absent", "configured", "incompatible"] as const;
  if (!contentScopeStates.includes(dome["contentScope"] as typeof contentScopeStates[number])) {
    throw new Error("setup source content-scope state is invalid");
  }
  const markdown = exactObject(source["markdown"], "setup source Markdown evidence", ["tracked", "untracked"]);
  const tracked = validatedMarkdownPaths(markdown["tracked"], "tracked Markdown");
  const untracked = validatedMarkdownPaths(markdown["untracked"], "untracked Markdown");
  const repository = exactObject(source["repository"], "setup source repository evidence", [
    "candidates", "baselineTracked",
  ]);
  const candidates = validatedRepositoryCandidates(repository["candidates"], git["direct"] as boolean);
  const baselineTracked = sortedUniqueSafePaths(
    repository["baselineTracked"], "setup source baseline tracked paths", SETUP_CONTRACT_CAPS.repositoryCandidates,
  );
  const expectedBaseline = candidates.filter((candidate) => candidate.disposition === "baseline")
    .map((candidate) => candidate.path);
  if (JSON.stringify(baselineTracked) !== JSON.stringify(expectedBaseline)) {
    throw new Error("setup source baseline inventory disagrees with repository candidates");
  }
  const blockerCodes = [
    "missing-prerequisite", "dirty-worktree", "active-git-operation",
    "symlink-ambiguity", "unsafe-path", "ambiguous-state", "detached-head",
    "unborn-repository", "unsupported-prerequisite",
  ] as const;
  if (!Array.isArray(source["blockers"]) || source["blockers"].length > 12) {
    throw new Error("setup source blockers are invalid");
  }
  let previousCode = "";
  const observedBlockerCodes: BlockerCode[] = [];
  for (const candidate of source["blockers"]) {
    const blocker = exactObject(candidate, "setup source blocker", ["code", "message", "nextAction"]);
    if (!blockerCodes.includes(blocker["code"] as typeof blockerCodes[number]) ||
      typeof blocker["code"] !== "string" || blocker["code"] <= previousCode ||
      !boundedText(blocker["message"]) || !boundedText(blocker["nextAction"])) {
      throw new Error("setup source blocker is invalid or not canonically ordered");
    }
    previousCode = blocker["code"];
    observedBlockerCodes.push(blocker["code"] as BlockerCode);
  }
  if (typeof source["worktreeFingerprint"] !== "string" || !/^[0-9a-f]{64}$/.test(source["worktreeFingerprint"])) {
    throw new Error("setup source fingerprint is invalid");
  }
  const expectedKind = classifySetupVault({
    targetState,
    gitState: state,
    gitDirect: git["direct"] as boolean,
    domeState: dome["state"] as VaultAssessment["dome"]["state"],
    blockerCodes: observedBlockerCodes,
  });
  if (kind !== expectedKind) {
    throw new Error("setup source classification disagrees with its evidence");
  }
  if ((state === "operation-active") !== observedBlockerCodes.includes("active-git-operation")) {
    throw new Error("setup source active-operation blocker disagrees with Git evidence");
  }
  if ((git["direct"] || dome["state"] === "configured") && targetState !== "existing") {
    throw new Error("setup source repository or Dome config requires an existing target");
  }
  if ((dome["state"] === "absent" || dome["state"] === "partial") && dome["contentScope"] !== "absent" ||
    (dome["state"] === "incompatible") !== (dome["contentScope"] === "incompatible")) {
    throw new Error("setup source content-scope evidence is inconsistent");
  }
  if ((targetState === "missing" || targetState === "empty-directory") && (tracked.length > 0 || untracked.length > 0) ||
    !git["direct"] && tracked.length > 0) {
    throw new Error("setup source Markdown inventory disagrees with its classification");
  }
  if (targetPath !== source["targetPath"]) throw new Error("setup source target path is not canonical");
  return value as SetupVaultSourceInspection;
}

function exactObject(value: unknown, label: string, expectedKeys: ReadonlyArray<string>): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort(compareStrings);
  const expected = [...expectedKeys].sort(compareStrings);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} has unknown or missing fields`);
  return value as Record<string, unknown>;
}

function normalizedAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0") || resolve(value) !== value) {
    throw new Error(`${label} is not a normalized absolute path`);
  }
  return value;
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 8_192 &&
    value.trim().length > 0 && !value.includes("\0");
}

function sortedUniqueStrings(value: unknown, label: string, maximum: number): ReadonlyArray<string> {
  if (!Array.isArray(value) || value.length > maximum || value.some((entry) => !boundedText(entry)) ||
    value.some((entry, index) => index > 0 && value[index - 1]! >= entry)) {
    throw new Error(`${label} must be a bounded sorted unique string array`);
  }
  return value as ReadonlyArray<string>;
}

function validatedMarkdownPaths(value: unknown, label: string): ReadonlyArray<string> {
  const paths = sortedUniqueStrings(value, label, SETUP_CONTRACT_CAPS.markdownPaths);
  if (paths.some((path) => path.startsWith("/") || path.includes("\\") || path.includes("\0") ||
    !path.endsWith(".md") || path.split("/").some((part) => part === "" || part === "." || part === ".."))) {
    throw new Error(`${label} contains an invalid path`);
  }
  return paths;
}

function sortedUniqueSafePaths(value: unknown, label: string, maximum: number): ReadonlyArray<string> {
  const paths = sortedUniqueStrings(value, label, maximum);
  if (paths.some((path) => !safeRelativePath(path))) throw new Error(`${label} contains an invalid path`);
  return paths;
}

function validatedRepositoryCandidates(value: unknown, gitDirect: boolean): ReadonlyArray<SetupRepositoryCandidate> {
  if (!Array.isArray(value) || value.length > SETUP_CONTRACT_CAPS.repositoryCandidates) {
    throw new Error("setup source repository candidates exceed their budget");
  }
  let previous = "";
  const candidates: SetupRepositoryCandidate[] = [];
  for (const raw of value) {
    const candidate = exactObject(raw, "setup source repository candidate", [
      "path", "kind", "bytes", "proofSha256", "tracking", "disposition", "reason",
    ]);
    const path = candidate["path"];
    if (typeof path !== "string" || !safeRelativePath(path) || path <= previous) {
      throw new Error("setup source repository candidates are invalid or not canonically ordered");
    }
    if (!SETUP_REPOSITORY_CANDIDATE_KINDS.includes(candidate["kind"] as SetupRepositoryCandidate["kind"]) ||
      !SETUP_REPOSITORY_DISPOSITIONS.includes(candidate["disposition"] as SetupRepositoryCandidate["disposition"]) ||
      !SETUP_REPOSITORY_REASONS.includes(candidate["reason"] as SetupRepositoryCandidate["reason"]) ||
      !["tracked", "untracked", "ignored", "other"].includes(String(candidate["tracking"])) ||
      !Number.isSafeInteger(candidate["bytes"]) || (candidate["bytes"] as number) < 0 ||
      typeof candidate["proofSha256"] !== "string" || !/^[0-9a-f]{64}$/.test(candidate["proofSha256"])) {
      throw new Error("setup source repository candidate is invalid");
    }
    const normalized = candidate as SetupRepositoryCandidate;
    validateSetupRepositoryCandidate(normalized, gitDirect);
    candidates.push(normalized);
    previous = path;
  }
  return candidates;
}

async function inspectTarget(
  targetPath: string,
  addBlocker: (code: BlockerCode, message: string, nextAction: string) => void,
): Promise<TargetInspection> {
  const componentProof = await inspectSelectedPathComponents(targetPath);
  const pathIssue = componentProof.issue;
  if (pathIssue !== null) {
    if (pathIssue.kind === "symlink") {
      addBlocker("symlink-ambiguity", `The selected vault path is redirected at ${pathIssue.path}.`,
        "Choose a path whose components are direct directories, then reassess.");
    } else {
      addBlocker("unsafe-path", `The selected vault path crosses the non-directory ${pathIssue.path}.`,
        "Choose a path beneath direct directories, then reassess.");
    }
    try {
      await lstat(targetPath);
      return targetInspection(componentProof.evidence, {
        exists: true, isDirectory: false, empty: false, inspectable: false,
      });
    } catch (error) {
      if (!hasCode(error, "ENOENT") && !hasCode(error, "ENOTDIR")) throw error;
      return targetInspection(componentProof.evidence, {
        exists: false, isDirectory: false, empty: true, inspectable: false,
      });
    }
  }
  let info: Awaited<ReturnType<typeof lstat>>;
  try { info = await lstat(targetPath); }
  catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    return targetInspection(componentProof.evidence, {
      exists: false, isDirectory: false, empty: true, inspectable: true,
    });
  }
  if (!info.isDirectory()) {
    addBlocker("unsafe-path", "The selected vault is not a directory.",
      "Choose a directory, then reassess.");
    return targetInspection(componentProof.evidence, {
      exists: true, isDirectory: false, empty: false, inspectable: false,
    });
  }
  const empty = (await readdir(targetPath)).length === 0;
  const after = await lstat(targetPath);
  if (!sameFilesystemIdentity(info, after)) {
    addBlocker("ambiguous-state", "The selected vault changed during target inspection.",
      "Wait for concurrent changes to finish, then reassess.");
  }
  return targetInspection(componentProof.evidence, {
    exists: true,
    isDirectory: true,
    empty,
    inspectable: true,
  });
}

function targetInspection(
  componentEvidence: ReadonlyArray<unknown>,
  value: Omit<TargetInspection, "proofSha256">,
): TargetInspection {
  return Object.freeze({ ...value, proofSha256: hashJson({ componentEvidence, ...value }) });
}

async function inspectRootControlAliases(
  targetPath: string,
  inspectableDirectory: boolean,
  addBlocker: (code: BlockerCode, message: string, nextAction: string) => void,
): Promise<ReadonlyArray<string>> {
  if (!inspectableDirectory) return Object.freeze([]);
  try {
    const aliases = (await readdir(targetPath)).filter((name) => {
      const lower = name.toLowerCase();
      return (lower === ".git" || lower === ".dome") && name !== lower;
    }).sort(compareStrings);
    for (const alias of aliases) {
      addBlocker("unsafe-path", `The vault contains a case-variant private path at ${alias}.`,
        "Rename or remove the case-variant .dome/.git path, then reassess.");
    }
    return Object.freeze(aliases);
  } catch (error) {
    addBlocker("ambiguous-state", `The vault root cannot be checked for private aliases: ${message(error)}`,
      "Wait for concurrent changes or repair the vault root, then reassess.");
    return Object.freeze(["<unreadable>"]);
  }
}

async function inspectGit(
  targetPath: string,
  targetExists: boolean,
  targetInspectable: boolean,
  privateControlAlias: boolean,
  caps: SetupVaultInspectionCaps,
  runGit: SetupGitRunner,
  addBlocker: (code: BlockerCode, message: string, nextAction: string) => void,
): Promise<GitEvidence> {
  const empty = (ancestorRoot: string | null = null): GitEvidence => Object.freeze({
    state: "absent", head: null, branch: null, direct: false, ancestorRoot,
    operationMarkers: Object.freeze([]), tracked: new Set<string>(), untracked: new Set<string>(), ignored: new Set<string>(),
    ignoredPrefixes: Object.freeze([]), indexStats: new Map<string, GitIndexStat>(),
    indexEntries: new Map<string, IndexEntry>(), stagedDirty: false,
    gitEntrySha256: null, indexSha256: null, dirtySha256: null,
    infoExcludeSha256: null,
  });
  if (!targetInspectable) return empty();
  if (privateControlAlias) return empty();
  if (!targetExists) {
    const ancestor = await findAncestorGitRoot(dirname(targetPath), addBlocker);
    if (ancestor !== null) addAncestorBlocker(ancestor, addBlocker);
    return empty(ancestor);
  }
  const gitEntry = join(targetPath, ".git");
  let gitEntryInfo: Awaited<ReturnType<typeof lstat>>;
  try { gitEntryInfo = await lstat(gitEntry); }
  catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    const ancestor = await findAncestorGitRoot(dirname(targetPath), addBlocker);
    if (ancestor !== null) addAncestorBlocker(ancestor, addBlocker);
    return empty(ancestor);
  }
  if (gitEntryInfo.isSymbolicLink() || (!gitEntryInfo.isDirectory() && !gitEntryInfo.isFile())) {
    addBlocker("ambiguous-state", "The direct .git entry is redirected or unsupported.",
      "Repair or remove the ambiguous .git entry, then reassess.");
    return Object.freeze({ ...empty(), state: "ambiguous" });
  }

  let gitEntrySha256: string | null = null;
  let operationMarkers: string[] = [];
  try {
    if (gitEntryInfo.isFile()) gitEntrySha256 = await optionalFileHash(gitEntry, caps);
    const top = await requiredGitText(runGit, ["rev-parse", "--show-toplevel"], targetPath, caps);
    const canonicalTop = await realpath(top);
    const canonicalTarget = await realpath(targetPath);
    if (canonicalTop !== canonicalTarget) throw new Error("Git reports a different worktree root");
    const gitDirText = await requiredGitText(runGit, ["rev-parse", "--absolute-git-dir"], targetPath, caps);
    const gitDir = resolve(gitDirText);
    if (await firstUnsafePathComponent(gitDir) !== null) throw new Error("Git directory is redirected");
    const gitDirInfo = await lstat(gitDir);
    if (gitDirInfo.isSymbolicLink() || !gitDirInfo.isDirectory()) {
      throw new Error("Git directory is redirected");
    }
    const commonDirText = await requiredGitText(runGit, ["rev-parse", "--git-common-dir"], targetPath, caps);
    const commonDir = resolve(targetPath, commonDirText);
    if (await firstUnsafePathComponent(commonDir) !== null) throw new Error("Git common directory is redirected");
    const commonDirInfo = await lstat(commonDir);
    if (commonDirInfo.isSymbolicLink() || !commonDirInfo.isDirectory()) {
      throw new Error("Git common directory is redirected");
    }
    operationMarkers = await inspectGitOperations(gitDir, commonDir);
    const branchResult = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], targetPath, caps);
    const headResult = await runGit(["rev-parse", "--verify", "HEAD"], targetPath, caps);
    const branch = branchResult.exitCode === 0 ? oneLine(branchResult.stdout, "Git branch") : null;
    const head = headResult.exitCode === 0 ? oneLine(headResult.stdout, "Git HEAD") : null;
    if (head !== null && !/^[0-9a-f]{40}$/.test(head)) throw new Error("Git HEAD is malformed");
    if (branchResult.exitCode !== 0 && branchResult.exitCode !== 1) throw new Error("Git symbolic HEAD is unavailable");
    if (headResult.exitCode !== 0 && headResult.exitCode !== 128) throw new Error("Git HEAD is unavailable");

    const stage = await requiredGit(runGit, ["ls-files", "--stage", "-z"], targetPath, caps);
    const trackedOutput = await requiredGit(runGit, ["ls-files", "-z"], targetPath, caps);
    const untrackedOutput = await requiredGit(runGit,
      ["ls-files", "--others", "--exclude-standard", "-z"], targetPath, caps);
    const ignoredOutput = await requiredGit(runGit,
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], targetPath, caps);
    const ignoredDirectoryOutput = await requiredGit(runGit,
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], targetPath, caps);
    const indexStatsOutput = await requiredGit(runGit, ["ls-files", "--debug", "-z"], targetPath, caps);
    const tracked = nulPaths(trackedOutput.stdout, caps.entries, "tracked Git inventory");
    const untracked = nulPaths(untrackedOutput.stdout, caps.entries, "untracked Git inventory");
    const ignored = nulPaths(ignoredOutput.stdout, caps.entries, "ignored Git inventory");
    const ignoredPrefixes = nulDirectoryPrefixes(ignoredDirectoryOutput.stdout, caps.entries, "ignored Git directories");
    const indexStats = parseGitIndexStats(indexStatsOutput.stdout, caps.entries);
    const index = parseIndex(stage.stdout, caps.entries);
    if (indexStats.size !== index.entries.size || [...index.entries.keys()].some((path) => !indexStats.has(path))) {
      throw new Error("Git index stat inventory disagrees with staged inventory");
    }
    if (index.unmerged) {
      operationMarkers.push("unmerged-index");
    }
    operationMarkers.sort(compareStrings);
    const infoExcludeSha256 = await optionalFileHash(join(commonDir, "info", "exclude"), caps);
    const headTree = head === null
      ? new Map<string, IndexEntry>()
      : parseHeadTree((await requiredGit(runGit,
        ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], targetPath, caps)).stdout, caps.entries);
    const stagedDirty = !sameIndexEntries(index.entries, headTree);
    if (operationMarkers.length > 0) {
      addBlocker("active-git-operation", "A Git operation or conflict is active in the selected vault.",
        "Finish or abort the Git operation, then reassess.");
    }
    let state: VaultAssessment["git"]["state"];
    if (operationMarkers.length > 0) state = "operation-active";
    else if (head === null && branch !== null) state = "unborn";
    else if (head !== null && branch === null) state = "detached";
    else if (head === null || branch === null) state = "ambiguous";
    else state = "clean";
    if (state === "detached") addBlocker("detached-head", "The selected repository has a detached HEAD.",
      "Check out the intended branch, then reassess.");
    if (state === "unborn") addBlocker("unborn-repository", "The selected repository has no first commit.",
      "Create or remove the incomplete repository, then reassess.");
    if (state === "ambiguous") addBlocker("ambiguous-state", "Git HEAD and branch evidence is inconsistent.",
      "Repair the repository state, then reassess.");
    return Object.freeze({
      state, head, branch, direct: true, ancestorRoot: null,
      operationMarkers: Object.freeze(operationMarkers), tracked, untracked, ignored,
      ignoredPrefixes: Object.freeze(ignoredPrefixes), indexStats, indexEntries: index.entries, stagedDirty,
      gitEntrySha256, indexSha256: sha256(stage.stdout), dirtySha256: null,
      infoExcludeSha256,
    });
  } catch (error) {
    if (operationMarkers.length > 0) {
      addBlocker("ambiguous-state", `Git failed after operation markers were observed: ${message(error)}`,
        "Repair or finish the Git operation, then reassess.");
      return Object.freeze({
        ...empty(), state: "ambiguous", direct: true, gitEntrySha256,
        operationMarkers: Object.freeze(operationMarkers.sort(compareStrings)),
      });
    }
    addBlocker("ambiguous-state", `The direct Git repository cannot be inspected: ${message(error)}`,
      "Repair the repository, then reassess.");
    return Object.freeze({ ...empty(), state: "ambiguous", direct: true, gitEntrySha256 });
  }
}

function finalizeGitDirtyState(
  git: GitEvidence,
  tree: ReadonlyArray<FileEvidence>,
  addBlocker: (code: BlockerCode, message: string, nextAction: string) => void,
): GitEvidence {
  const treeByPath = new Map(tree.map((entry) => [entry.path, entry]));
  let unstagedDirty = false;
  for (const indexEntry of git.indexEntries.values()) {
    const worktreeEntry = treeByPath.get(indexEntry.path);
    const worktreeMode = worktreeEntry?.kind === "symlink" ? "120000" :
      worktreeEntry?.kind === "file" ? ((worktreeEntry.mode & 0o111) === 0 ? "100644" : "100755") : null;
    // Ordinary files carry an exact Dome-side blob hash. Sensitive-name files
    // carry the index oid only when their content-free index stat tuple still
    // matches; a null sensitive proof is therefore dirty without reading it.
    const contentMismatch = worktreeEntry?.gitBlobId !== null
      ? worktreeEntry?.gitBlobId !== indexEntry.oid
      : worktreeEntry?.tracking === "tracked" && worktreeEntry.safetyReason === "sensitive-name";
    if (contentMismatch ||
      worktreeMode !== indexEntry.mode) {
      unstagedDirty = true;
      break;
    }
  }
  const dirty = git.stagedDirty || unstagedDirty || git.untracked.size > 0;
  const dirtySha256 = hashJson({
    stagedDirty: git.stagedDirty,
    unstagedDirty,
    untracked: [...git.untracked].sort(compareStrings),
  });
  if (git.state !== "clean" || !dirty) return Object.freeze({ ...git, dirtySha256 });
  addBlocker("dirty-worktree", "The selected Git worktree has tracked, staged, or untracked changes.",
    "Commit, stash, or remove the changes, then reassess.");
  return Object.freeze({ ...git, state: "dirty", dirtySha256 });
}

function gitProof(git: GitEvidence): unknown {
  return {
    ...git,
    tracked: [...git.tracked].sort(compareStrings),
    untracked: [...git.untracked].sort(compareStrings),
    ignored: [...git.ignored].sort(compareStrings),
    indexStats: [...git.indexStats.entries()].sort(([left], [right]) => compareStrings(left, right)),
    indexEntries: [...git.indexEntries.values()].sort((left, right) => compareStrings(left.path, right.path)),
  };
}

async function inspectTreeSafely(
  root: string,
  git: GitEvidence,
  caps: SetupVaultInspectionCaps,
  addBlocker: (code: BlockerCode, message: string, nextAction: string) => void,
): Promise<ReadonlyArray<FileEvidence>> {
  try { return await inspectTree(root, git, caps, addBlocker); }
  catch (error) {
    addBlocker("ambiguous-state", `The vault tree cannot be inspected coherently: ${message(error)}`,
      "Wait for concurrent changes or unsafe path changes to finish, then reassess.");
    return Object.freeze([]);
  }
}

async function inspectTree(
  root: string,
  git: GitEvidence,
  caps: SetupVaultInspectionCaps,
  addBlocker: (code: BlockerCode, message: string, nextAction: string) => void,
): Promise<ReadonlyArray<FileEvidence>> {
  const entries: FileEvidence[] = [];
  let hashedBytes = 0;
  const visit = async (
    directory: string,
    prefix: string,
    expected?: Awaited<ReturnType<typeof lstat>>,
    inheritedIgnore: ReadonlyArray<NonGitIgnorePolicy> = [],
  ): Promise<void> => {
    const pathBefore = await lstat(directory);
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const directoryBefore = await directoryHandle.stat();
      if (!directoryBefore.isDirectory() || pathBefore.isSymbolicLink() ||
        !sameFilesystemIdentity(pathBefore, directoryBefore) ||
        (expected !== undefined && !sameFilesystemIdentity(expected, directoryBefore))) {
        throw new Error(`directory changed during setup inspection: ${directory}`);
      }
      if (prefix === "") {
        entries.push(Object.freeze({ path: "", kind: "directory", mode: directoryBefore.mode & 0o777,
          bytes: 0, sha256: null, gitBlobId: null,
          filesystemIdentitySha256: filesystemIdentityHash(directoryBefore), linkTarget: null, tracking: "other",
          safetyReason: "directory-not-tracked" }));
      }
      const localIgnore = git.direct ? null : await loadNonGitIgnorePolicy(
        directory, prefix, caps, caps.totalBytes - hashedBytes, addBlocker,
      );
      if (localIgnore !== null) hashedBytes += localIgnore.bytes.length;
      const ignoreStack = localIgnore === null ? inheritedIgnore : Object.freeze([...inheritedIgnore, localIgnore]);
      const names = (await readdir(directory)).sort(compareStrings);
      for (const name of names) {
        const path = prefix === "" ? name : `${prefix}/${name}`;
        if (path === ".git") continue;
        if (!safeRelativePath(path)) {
          addBlocker("unsafe-path", "The vault contains a path Dome cannot represent safely.",
            "Rename the unsafe path, then reassess.");
          continue;
        }
        if (entries.length >= caps.entries) {
          addBlocker("unsafe-path", "The vault exceeds the setup entry budget.",
            "Narrow the selected vault boundary, then reassess.");
          return;
        }
        const absolute = join(root, ...path.split("/"));
        const info = await lstat(absolute);
        const tracking = trackingFor(path, info.isDirectory(), git, ignoreStack);
        const mode = info.mode & 0o777;
        if (privateCaseAliasPath(path)) {
          const kind = info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" :
            info.isFile() ? "file" : "special";
          entries.push(Object.freeze({ path, kind, mode, bytes: kind === "directory" ? 0 : info.size, sha256: null,
            gitBlobId: null, filesystemIdentitySha256: filesystemIdentityHash(info), linkTarget: null, tracking,
            safetyReason: "private-case-alias" }));
          addBlocker("unsafe-path", `The vault contains a case-variant private path at ${path}.`,
            "Rename or remove the case-variant .dome/.git path, then reassess.");
          continue;
        }
        if (name === ".git" && prefix !== "") {
          addBlocker("unsafe-path", `The vault contains a nested Git control path at ${path}.`,
            "Remove the nested repository marker or choose one repository boundary, then reassess.");
          if (info.isFile() && !info.isSymbolicLink()) {
            entries.push(Object.freeze({ path, kind: "file", mode, bytes: info.size, sha256: null,
              gitBlobId: null, filesystemIdentitySha256: filesystemIdentityHash(info), linkTarget: null, tracking,
              safetyReason: "nested-repository" }));
            continue;
          }
        }
        if (path === ".dome/state") {
          if (info.isDirectory() && !info.isSymbolicLink()) {
            entries.push(Object.freeze({ path, kind: "directory", mode, bytes: 0, sha256: null,
              gitBlobId: null, filesystemIdentitySha256: filesystemIdentityHash(info), linkTarget: null, tracking,
              safetyReason: "dome-private" }));
          } else if (info.isSymbolicLink()) {
            entries.push(Object.freeze({ path, kind: "symlink", mode, bytes: info.size,
              sha256: null, gitBlobId: null,
              filesystemIdentitySha256: filesystemIdentityHash(info), linkTarget: null, tracking,
              safetyReason: "dome-private" }));
            addBlocker("symlink-ambiguity", "The reserved .dome/state path is a symbolic link.",
              "Replace it with a direct private directory, then reassess.");
            addBlocker("unsafe-path", "The reserved .dome/state path is not a direct directory.",
              "Replace it with a direct private directory, then reassess.");
          } else {
            entries.push(Object.freeze({ path, kind: info.isFile() ? "file" : "special", mode, bytes: info.size,
              sha256: null, gitBlobId: null, filesystemIdentitySha256: filesystemIdentityHash(info),
              linkTarget: null, tracking, safetyReason: "dome-private" }));
            addBlocker("unsafe-path", "The reserved .dome/state path is not a direct directory.",
              "Replace it with a direct private directory, then reassess.");
          }
          continue;
        }
        const ownIgnore = name === ".gitignore" && localIgnore?.prefix === prefix ? localIgnore : null;
        if (ownIgnore !== null) {
          if (!info.isFile() || info.isSymbolicLink() ||
            filesystemIdentityHash(info) !== ownIgnore.filesystemIdentitySha256) {
            throw new Error(".gitignore changed during setup inspection");
          }
          entries.push(Object.freeze({ path, kind: "file", mode, bytes: info.size,
            sha256: ownIgnore.sha256, gitBlobId: gitBlobId(ownIgnore.bytes),
            filesystemIdentitySha256: filesystemIdentityHash(info), linkTarget: null, tracking,
            ignoreCase: ownIgnore.ignoreCase,
            safetyReason: tracking === "ignored" ? "ignored-by-owner" : "safe-owner-file" }));
          continue;
        }
        if (info.isSymbolicLink()) {
          const linkTarget = await readStableLinkTarget(absolute, info);
          entries.push(Object.freeze({ path, kind: "symlink", mode, bytes: Buffer.byteLength(linkTarget),
            sha256: sha256(Buffer.from(linkTarget)), gitBlobId: gitBlobId(Buffer.from(linkTarget)),
            filesystemIdentitySha256: filesystemIdentityHash(info), linkTarget, tracking,
            safetyReason: symlinkRepositoryReason(path, linkTarget) }));
          addBlocker("symlink-ambiguity", `The vault contains a symbolic link at ${path}.`,
            "Remove or explicitly replace the link, then reassess.");
          continue;
        }
        if (info.isDirectory()) {
          entries.push(Object.freeze({ path, kind: "directory", mode, bytes: 0, sha256: null,
            gitBlobId: null, filesystemIdentitySha256: filesystemIdentityHash(info), linkTarget: null, tracking,
            safetyReason: name === ".git" ? "nested-repository" :
              tracking === "ignored" ? "ignored-by-owner" : "directory-not-tracked" }));
          if (name === ".git") {
            addBlocker("unsafe-path", `The vault contains a nested repository at ${path}.`,
              "Choose one repository boundary, then reassess.");
            continue;
          }
          if (tracking === "ignored") continue;
          await visit(absolute, path, info, ignoreStack);
          continue;
        }
        if (!info.isFile()) {
          entries.push(Object.freeze({ path, kind: "special", mode, bytes: info.size, sha256: null,
            gitBlobId: null, filesystemIdentitySha256: filesystemIdentityHash(info), linkTarget: null, tracking,
            safetyReason: "special-file" }));
          addBlocker("unsafe-path", `The vault contains a special file at ${path}.`,
            "Remove the special file from the vault boundary, then reassess.");
          continue;
        }
        if (info.nlink !== 1) {
          entries.push(Object.freeze({ path, kind: "file", mode, bytes: info.size, sha256: null,
            gitBlobId: null, filesystemIdentitySha256: filesystemIdentityHash(info), linkTarget: null, tracking,
            safetyReason: "hard-linked-file" }));
          addBlocker("unsafe-path", `The vault contains a hard-linked file at ${path}.`,
            "Replace the hard link with a direct file, then reassess.");
          continue;
        }
        if (tracking === "ignored") {
          entries.push(Object.freeze({ path, kind: "file", mode, bytes: info.size, sha256: null,
            gitBlobId: null, filesystemIdentitySha256: filesystemIdentityHash(info), linkTarget: null, tracking,
            safetyReason: "ignored-by-owner" }));
          continue;
        }
        if (sensitiveRepositoryPath(path)) {
          const indexStat = git.indexStats.get(path);
          const contentFreeBlobId = tracking === "tracked" && indexStat !== undefined &&
            await gitIndexStatMatches(absolute, info, indexStat)
            ? git.indexEntries.get(path)?.oid ?? null
            : null;
          entries.push(Object.freeze({ path, kind: "file", mode, bytes: info.size, sha256: null,
            gitBlobId: contentFreeBlobId, filesystemIdentitySha256: filesystemIdentityHash(info), linkTarget: null, tracking,
            safetyReason: "sensitive-name" }));
          continue;
        }
        if (info.size > caps.fileBytes || hashedBytes + info.size > caps.totalBytes) {
          entries.push(Object.freeze({ path, kind: "file", mode, bytes: info.size, sha256: null,
            gitBlobId: null, filesystemIdentitySha256: filesystemIdentityHash(info), linkTarget: null, tracking,
            safetyReason: "large-file" }));
          addBlocker("unsafe-path", "The vault exceeds the setup content-hashing budget.",
            "Exclude or relocate large files, then reassess.");
          continue;
        }
        const bytes = await readDirectFile(absolute, info);
        hashedBytes += info.size;
        entries.push(Object.freeze({ path, kind: "file", mode, bytes: info.size, sha256: sha256(bytes),
          gitBlobId: gitBlobId(bytes), filesystemIdentitySha256: filesystemIdentityHash(info),
          linkTarget: null, tracking, safetyReason: domePrivateRepositoryPath(path) ? "dome-private" : "safe-owner-file" }));
      }
      const directoryAfter = await lstat(directory);
      const descriptorAfter = await directoryHandle.stat();
      if (!sameFilesystemIdentity(directoryBefore, directoryAfter) ||
        !sameFilesystemIdentity(directoryBefore, descriptorAfter)) {
        throw new Error(`directory changed during setup inspection: ${directory}`);
      }
    } finally {
      await directoryHandle.close();
    }
  };
  await visit(root, "", undefined, []);
  entries.sort((left, right) => compareStrings(left.path, right.path));
  return Object.freeze(entries);
}

async function inspectDomeState(
  targetPath: string,
  tree: ReadonlyArray<FileEvidence>,
  addBlocker: (code: BlockerCode, message: string, nextAction: string) => void,
): Promise<VaultAssessment["dome"]> {
  const config = tree.find((entry) => entry.path === ".dome/config.yaml");
  if (config === undefined) {
    return Object.freeze({
      state: tree.some((entry) => entry.path === ".dome" || entry.path.startsWith(".dome/")) ? "partial" : "absent",
      contentScope: "absent",
    });
  }
  if (config.kind !== "file" || config.sha256 === null) {
    addBlocker("ambiguous-state", "Dome configuration is not a bounded direct file.",
      "Repair .dome/config.yaml, then reassess.");
    return Object.freeze({ state: "incompatible", contentScope: "incompatible" });
  }
  const configPath = join(targetPath, ".dome", "config.yaml");
  const current = await lstat(configPath);
  if (!current.isFile() || current.isSymbolicLink() || current.size !== config.bytes ||
    filesystemIdentityHash(current) !== config.filesystemIdentitySha256) {
    addBlocker("ambiguous-state", "Dome configuration changed during setup inspection.",
      "Wait for concurrent changes to finish, then reassess.");
    return Object.freeze({ state: "incompatible", contentScope: "incompatible" });
  }
  const bytes = await readDirectFile(configPath, current);
  if (sha256(bytes) !== config.sha256) {
    addBlocker("ambiguous-state", "Dome configuration changed during setup inspection.",
      "Wait for concurrent changes to finish, then reassess.");
    return Object.freeze({ state: "incompatible", contentScope: "incompatible" });
  }
  const body = bytes.toString("utf8");
  const parsed = parseCapabilityPolicy(body, ".dome/config.yaml");
  if (!parsed.ok) {
    addBlocker("ambiguous-state", "Dome configuration is invalid.",
      "Repair .dome/config.yaml, then reassess.");
    return Object.freeze({ state: "incompatible", contentScope: "incompatible" });
  }
  return Object.freeze({
    state: "configured",
    contentScope: parsed.value.contentScope === null ? "absent" : "configured",
  });
}

function setupTargetState(target: Readonly<{ exists: boolean; isDirectory: boolean; empty: boolean }>): SetupTargetState {
  if (!target.exists) return "missing";
  if (target.isDirectory && target.empty) return "empty-directory";
  return "existing";
}

function markdownPaths(paths: ReadonlySet<string>): string[] {
  return [...paths].filter((path) => path.endsWith(".md")).sort(compareStrings);
}

function repositoryInventory(tree: ReadonlyArray<FileEvidence>, gitDirect: boolean): SetupRepositoryCandidate[] {
  return tree.filter((entry) => entry.path !== "").map((entry) => deriveSetupRepositoryCandidate({
    path: entry.path,
    kind: entry.kind,
    bytes: entry.bytes,
    proofSha256: repositoryEntryProof(entry),
    tracking: entry.tracking,
    gitDirect,
    observedReason: entry.safetyReason,
  })).sort((left, right) => compareStrings(left.path, right.path));
}

function repositoryEntryProof(entry: FileEvidence): string {
  return hashJson({
    path: entry.path,
    kind: entry.kind,
    mode: entry.mode,
    bytes: entry.bytes,
    sha256: entry.sha256,
    gitBlobId: entry.gitBlobId,
    filesystemIdentitySha256: entry.filesystemIdentitySha256,
    linkTarget: entry.linkTarget,
  });
}

type NonGitIgnorePolicy = Readonly<{
  prefix: string;
  rules: ReturnType<typeof ignore>;
  bytes: Buffer;
  sha256: string;
  filesystemIdentitySha256: string;
  ignoreCase: boolean;
}>;

async function loadNonGitIgnorePolicy(
  directory: string,
  prefix: string,
  caps: SetupVaultInspectionCaps,
  remainingBytes: number,
  addBlocker: (code: BlockerCode, message: string, nextAction: string) => void,
): Promise<NonGitIgnorePolicy | null> {
  const path = join(directory, ".gitignore");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > caps.fileBytes ||
      info.size > remainingBytes) {
      addBlocker("unsafe-path", "The owner .gitignore is not a bounded direct file.",
        "Repair or remove .gitignore, then reassess.");
      return null;
    }
    const ignoreCase = await detectIgnoreCase(path, info);
    const bytes = await readDirectFile(path, info);
    const body = bytes.toString("utf8");
    if (body.includes("\uFFFD") || body.includes("\0")) throw new Error(".gitignore is not valid bounded UTF-8 text");
    const rules = ignore({ ignorecase: ignoreCase }).add(body);
    return Object.freeze({ prefix, rules, bytes, sha256: sha256(bytes),
      filesystemIdentitySha256: filesystemIdentityHash(info), ignoreCase });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    addBlocker("ambiguous-state", `The owner .gitignore cannot be evaluated safely: ${message(error)}`,
      "Repair .gitignore, then reassess.");
    return null;
  }
}

async function detectIgnoreCase(
  gitignorePath: string,
  canonical: Awaited<ReturnType<typeof lstat>>,
): Promise<boolean> {
  const exactCanonical = await lstat(gitignorePath, { bigint: true });
  if (!exactCanonical.isFile() || exactCanonical.isSymbolicLink() ||
    Number(exactCanonical.dev) !== Number(canonical.dev) || Number(exactCanonical.ino) !== Number(canonical.ino) ||
    exactCanonical.size !== BigInt(canonical.size) || Number(exactCanonical.mode) !== Number(canonical.mode)) {
    throw new Error(".gitignore changed during case-behavior inspection");
  }
  try {
    const alias = await lstat(join(dirname(gitignorePath), ".GITIGNORE"), { bigint: true });
    if (sameExactFilesystemObject(exactCanonical, alias)) return true;
    throw new Error(".gitignore has a distinct case-variant collision");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

/** Live directory-entry identity must never inherit Git index's uint32 truncation. */
export function sameExactFilesystemObject(
  left: Readonly<{ dev: bigint; ino: bigint }>,
  right: Readonly<{ dev: bigint; ino: bigint }>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function trackingFor(
  path: string,
  directory: boolean,
  git: GitEvidence,
  nonGitIgnore: ReadonlyArray<NonGitIgnorePolicy>,
): FileEvidence["tracking"] {
  if (git.tracked.has(path)) return "tracked";
  if (git.untracked.has(path)) return "untracked";
  if (git.ignored.has(path) || git.ignoredPrefixes.some((prefix) => path.startsWith(prefix))) return "ignored";
  if (!git.direct && ignoredByOwner(path, directory, nonGitIgnore)) return "ignored";
  return "other";
}

/** Match the same root-to-leaf rule precedence used by GitIgnoreManager. */
function ignoredByOwner(
  path: string,
  directory: boolean,
  policies: ReadonlyArray<NonGitIgnorePolicy>,
): boolean {
  let ignored = false;
  for (const policy of policies) {
    const relative = policy.prefix === "" ? path : path.slice(policy.prefix.length + 1);
    if (relative === "" || relative.startsWith("../")) continue;
    const candidate = directory ? `${relative}/` : relative;
    const parent = dirname(relative);
    if (parent !== "." && policy.rules.ignores(`${parent}/`)) return true;
    const result = policy.rules.test(candidate);
    ignored = ignored ? !result.unignored : result.ignored;
  }
  return ignored;
}

async function inspectGitOperations(gitDir: string, commonDir: string): Promise<string[]> {
  const worktreeMarkers = [
    "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "REBASE_HEAD",
    "rebase-apply", "rebase-merge", "sequencer", "index.lock", "HEAD.lock",
  ];
  const present: string[] = [];
  for (const marker of worktreeMarkers) {
    try { await lstat(join(gitDir, marker)); present.push(marker); }
    catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  }
  for (const marker of ["packed-refs.lock", "shallow.lock"]) {
    try { await lstat(join(commonDir, marker)); present.push(`common:${marker}`); }
    catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  }
  return present;
}

function parseIndex(bytes: Buffer, cap: number): Readonly<{
  entries: ReadonlyMap<string, IndexEntry>;
  unmerged: boolean;
}> {
  let unmerged = false;
  const entries = new Map<string, IndexEntry>();
  const rows = nulStrings(bytes, cap, "Git index");
  for (const row of rows) {
    const match = /^(\d{6}) ([0-9a-f]{40}) ([0-3])\t([\s\S]+)$/.exec(row);
    if (match === null) throw new Error("Git index inventory is malformed");
    const path = match[4]!;
    if (!safeRelativePath(path) || entries.has(path)) throw new Error("Git index inventory contains an unsafe or duplicate path");
    if (match[3] !== "0") unmerged = true;
    if (match[1] === "160000") throw new Error("Gitlink entries are not supported during setup");
    if (match[3] === "0") entries.set(path, Object.freeze({ path, mode: match[1]!, oid: match[2]! }));
  }
  return Object.freeze({ entries, unmerged });
}

function parseGitIndexStats(bytes: Buffer, cap: number): ReadonlyMap<string, GitIndexStat> {
  if (bytes.length === 0) return new Map<string, GitIndexStat>();
  const decoded = bytes.toString("utf8");
  if (decoded.includes("\uFFFD")) throw new Error("Git index stat inventory contains undecodable paths");
  const firstNul = decoded.indexOf("\0");
  if (firstNul < 1) throw new Error("Git index stat inventory is malformed");
  let path = decoded.slice(0, firstNul);
  let position = firstNul + 1;
  const stats = new Map<string, GitIndexStat>();
  for (;;) {
    const nextNul = decoded.indexOf("\0", position);
    let metadata: string;
    let nextPath: string | null;
    if (nextNul === -1) {
      metadata = decoded.slice(position);
      nextPath = null;
    } else {
      const segment = decoded.slice(position, nextNul);
      const separator = segment.lastIndexOf("\n");
      if (separator < 0) throw new Error("Git index stat inventory is malformed");
      metadata = segment.slice(0, separator + 1);
      nextPath = segment.slice(separator + 1);
    }
    if (!safeRelativePath(path) || stats.has(path)) throw new Error("Git index stat inventory contains an unsafe or duplicate path");
    const match = /^  ctime: (\d+):(\d+)\n  mtime: (\d+):(\d+)\n  dev: (\d+)\tino: (\d+)\n  uid: \d+\tgid: \d+\n  size: (\d+)\tflags: [0-9a-f]+\n$/.exec(metadata);
    if (match === null) throw new Error("Git index stat inventory metadata is malformed");
    const values = match.slice(1).map(Number);
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error("Git index stat inventory exceeds numeric bounds");
    }
    stats.set(path, Object.freeze({
      ctimeSeconds: values[0]!, ctimeNanoseconds: values[1]!,
      mtimeSeconds: values[2]!, mtimeNanoseconds: values[3]!,
      dev: values[4]!, ino: values[5]!, size: values[6]!,
    }));
    if (stats.size > cap) throw new Error("Git index stat inventory exceeds its entry budget");
    if (nextPath === null) break;
    path = nextPath;
    position = nextNul + 1;
  }
  return stats;
}

async function gitIndexStatMatches(
  path: string,
  before: Awaited<ReturnType<typeof lstat>>,
  index: GitIndexStat,
): Promise<boolean> {
  const current = await lstat(path, { bigint: true });
  const stableIdentity = unsigned32(current.dev) === unsigned32(before.dev) &&
    unsigned32(current.ino) === unsigned32(before.ino) && current.size === BigInt(before.size) &&
    Number(current.mode) === Number(before.mode);
  return stableIdentity &&
    current.mtimeNs === BigInt(index.mtimeSeconds) * 1_000_000_000n + BigInt(index.mtimeNanoseconds) &&
    current.ctimeNs === BigInt(index.ctimeSeconds) * 1_000_000_000n + BigInt(index.ctimeNanoseconds) &&
    unsigned32(current.dev) === index.dev && unsigned32(current.ino) === index.ino &&
    current.size === BigInt(index.size);
}

function unsigned32(value: number | bigint): number {
  return Number((typeof value === "bigint" ? value : BigInt(Math.trunc(value))) & 0xffff_ffffn);
}

function parseHeadTree(bytes: Buffer, cap: number): ReadonlyMap<string, IndexEntry> {
  const entries = new Map<string, IndexEntry>();
  for (const row of nulStrings(bytes, cap, "Git HEAD tree")) {
    const match = /^(\d{6}) (blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/.exec(row);
    if (match === null) throw new Error("Git HEAD tree inventory is malformed");
    const path = match[4]!;
    if (!safeRelativePath(path) || entries.has(path) || match[2] === "commit") {
      throw new Error("Git HEAD tree contains an unsafe, duplicate, or gitlink path");
    }
    entries.set(path, Object.freeze({ path, mode: match[1]!, oid: match[3]! }));
  }
  return entries;
}

function sameIndexEntries(
  left: ReadonlyMap<string, IndexEntry>,
  right: ReadonlyMap<string, IndexEntry>,
): boolean {
  return JSON.stringify([...left.values()].sort((a, b) => compareStrings(a.path, b.path))) ===
    JSON.stringify([...right.values()].sort((a, b) => compareStrings(a.path, b.path)));
}

function nulDirectoryPrefixes(bytes: Buffer, cap: number, label: string): string[] {
  const prefixes: string[] = [];
  for (const path of nulStrings(bytes, cap, label)) {
    if (path.endsWith("/")) {
      if (path.endsWith("//") || !safeRelativePath(path.slice(0, -1))) {
        throw new Error(`${label} contains an unsafe directory path`);
      }
      prefixes.push(path);
    } else if (!safeRelativePath(path)) {
      throw new Error(`${label} contains an unsafe path`);
    }
  }
  return prefixes.sort(compareStrings);
}

function nulPaths(bytes: Buffer, cap: number, label: string): Set<string> {
  const paths = nulStrings(bytes, cap, label);
  for (const path of paths) {
    if (!safeRelativePath(path)) throw new Error(`${label} contains an unsafe path`);
  }
  return new Set(paths);
}

function nulStrings(bytes: Buffer, cap: number, label: string): string[] {
  const decoded = bytes.toString("utf8");
  if (decoded.includes("\uFFFD")) throw new Error(`${label} contains undecodable paths`);
  const values = decoded.split("\0");
  if (values.at(-1) === "") values.pop();
  if (values.length > cap) throw new Error(`${label} exceeds its entry budget`);
  return values;
}

async function hashDirectFile(path: string, before: Awaited<ReturnType<typeof lstat>>): Promise<string> {
  return sha256(await readDirectFile(path, before));
}

async function readDirectFile(path: string, before: Awaited<ReturnType<typeof lstat>>): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFilesystemIdentity(before, opened)) {
      throw new Error(`file changed during setup inspection: ${path}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFilesystemIdentity(opened, after)) {
      throw new Error(`file changed during setup inspection: ${path}`);
    }
    return bytes;
  } finally { await handle.close(); }
}

async function readStableLinkTarget(
  path: string,
  before: Awaited<ReturnType<typeof lstat>>,
): Promise<string> {
  const target = await readlink(path);
  const after = await lstat(path);
  if (!after.isSymbolicLink() || !sameFilesystemIdentity(before, after)) {
    throw new Error(`symbolic link changed during setup inspection: ${path}`);
  }
  return target;
}

function sameFilesystemIdentity(
  before: Pick<Awaited<ReturnType<typeof lstat>>, "dev" | "ino" | "mode" | "size" | "mtimeMs" | "ctimeMs" | "nlink">,
  after: Pick<Awaited<ReturnType<typeof lstat>>, "dev" | "ino" | "mode" | "size" | "mtimeMs" | "ctimeMs" | "nlink">,
): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode &&
    before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs &&
    before.nlink === after.nlink;
}

function filesystemIdentityHash(
  info: Pick<Awaited<ReturnType<typeof lstat>>, "dev" | "ino" | "mode" | "size" | "mtimeMs" | "ctimeMs" | "nlink">,
): string {
  return hashJson({
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    nlink: info.nlink,
  });
}

function pathComponentIdentityHash(
  info: Pick<Awaited<ReturnType<typeof lstat>>, "dev" | "ino" | "mode">,
): string {
  return hashJson({ dev: info.dev, ino: info.ino, mode: info.mode });
}

async function optionalFileHash(path: string, caps: SetupVaultInspectionCaps): Promise<string | null> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try { info = await lstat(path); }
  catch (error) { if (hasCode(error, "ENOENT")) return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > caps.fileBytes) {
    throw new Error("Git control-file evidence is unsafe");
  }
  return await hashDirectFile(path, info);
}

async function requiredGit(
  runner: SetupGitRunner,
  args: ReadonlyArray<string>,
  cwd: string,
  caps: SetupVaultInspectionCaps,
): Promise<SetupGitCommandResult> {
  const result = await runner(args, cwd, caps);
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  return result;
}

async function requiredGitText(
  runner: SetupGitRunner,
  args: ReadonlyArray<string>,
  cwd: string,
  caps: SetupVaultInspectionCaps,
): Promise<string> {
  return oneLine((await requiredGit(runner, args, cwd, caps)).stdout, `git ${args[0]}`);
}

function oneLine(bytes: Buffer, label: string): string {
  const value = bytes.toString("utf8").trim();
  if (value === "" || value.includes("\n") || value.includes("\0")) throw new Error(`${label} output is invalid`);
  return value;
}

async function runGitReadOnly(
  args: ReadonlyArray<string>,
  cwd: string,
  caps: Pick<SetupVaultInspectionCaps, "commandBytes" | "commandTimeoutMs">,
): Promise<SetupGitCommandResult> {
  const child = Bun.spawn([
    "git",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "core.pager=cat",
    "-c", "core.excludesFile=/dev/null",
    "-c", "core.attributesFile=/dev/null",
    ...args,
  ], {
    cwd,
    env: cleanGitEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const settled = Promise.all([
    collectBounded(child.stdout, caps.commandBytes, "Git stdout"),
    collectBounded(child.stderr, Math.min(caps.commandBytes, 1024 * 1024), "Git stderr"),
    child.exited,
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Git inspection timed out")), caps.commandTimeoutMs);
    });
    const [stdout, stderr, exitCode] = await Promise.race([settled, timeout]);
    return Object.freeze({ stdout, stderr: stderr.toString("utf8"), exitCode });
  } catch (error) {
    try { child.kill("SIGKILL"); } catch {}
    await Promise.race([settled.catch(() => undefined), Bun.sleep(2_000)]);
    throw error;
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function collectBounded(stream: ReadableStream<Uint8Array>, maximum: number, label: string): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks, total);
      total += next.value.byteLength;
      if (total > maximum) throw new Error(`${label} exceeds its byte budget`);
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
}

function cleanGitEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_PAGER: "cat",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    LC_ALL: "C",
    LANG: "C",
  };
  if (process.env.TMPDIR !== undefined) environment.TMPDIR = process.env.TMPDIR;
  return environment;
}

function normalizeExternalEvidence(
  values: ReadonlyArray<SetupFingerprintEvidence>,
  maximum: number,
): ReadonlyArray<SetupFingerprintEvidence> {
  if (values.length > maximum) throw new RangeError("external setup fingerprint evidence exceeds its entry budget");
  const normalized = values.map((value) => {
    if (!/^[a-z0-9][a-z0-9.-]{0,127}$/.test(value.id) || !/^[0-9a-f]{64}$/.test(value.sha256)) {
      throw new TypeError("external setup fingerprint evidence is invalid");
    }
    return Object.freeze({ ...value });
  }).sort((left, right) => compareStrings(left.id, right.id));
  if (new Set(normalized.map((value) => value.id)).size !== normalized.length) {
    throw new TypeError("external setup fingerprint evidence IDs must be unique");
  }
  return Object.freeze(normalized);
}

function inspectionCaps(overrides: Partial<SetupVaultInspectionCaps> | undefined): SetupVaultInspectionCaps {
  const caps = Object.freeze({ ...SETUP_VAULT_INSPECTION_CAPS, ...overrides });
  for (const [name, value] of Object.entries(caps)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`setup inspection cap ${name} must be a positive integer`);
    if (value > SETUP_VAULT_INSPECTION_CAPS[name as keyof SetupVaultInspectionCaps]) {
      throw new RangeError(`setup inspection cap ${name} may only lower the production limit`);
    }
  }
  return caps;
}

function addAncestorBlocker(
  ancestor: string,
  addBlocker: (code: BlockerCode, message: string, nextAction: string) => void,
): void {
  addBlocker("unsafe-path", `The selected vault is nested inside the repository at ${ancestor}.`,
    "Choose the repository root or an independent directory, then reassess.");
}

function blockerCollector(
  blockers: Map<BlockerCode, VaultAssessment["blockers"][number]>,
): (code: BlockerCode, message: string, nextAction: string) => void {
  return (code, message, nextAction) => {
    blockers.set(code, Object.freeze({ code, message, nextAction }));
  };
}

function mergeBlockers(
  source: ReadonlyMap<BlockerCode, VaultAssessment["blockers"][number]>,
  target: Map<BlockerCode, VaultAssessment["blockers"][number]>,
): void {
  for (const [code, blocker] of source) target.set(code, blocker);
}

function mergeSafetyBlockers(
  source: ReadonlyMap<BlockerCode, VaultAssessment["blockers"][number]>,
  target: Map<BlockerCode, VaultAssessment["blockers"][number]>,
): void {
  for (const code of ["symlink-ambiguity", "unsafe-path"] as const) {
    const blocker = source.get(code);
    if (blocker !== undefined) target.set(code, blocker);
  }
}

async function firstUnsafePathComponent(
  path: string,
): Promise<Readonly<{ path: string; kind: "symlink" | "non-directory" }> | null> {
  return (await inspectSelectedPathComponents(path)).issue;
}

async function inspectSelectedPathComponents(path: string): Promise<Readonly<{
  issue: Readonly<{ path: string; kind: "symlink" | "non-directory" }> | null;
  evidence: ReadonlyArray<Readonly<{ path: string; kind: string; identitySha256: string | null }>>;
}>> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const components = absolute.slice(root.length).split("/").filter(Boolean);
  let current = root;
  const evidence: Array<Readonly<{ path: string; kind: string; identitySha256: string | null }>> = [];
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    try {
      const info = await lstat(current);
      const kind = info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" :
        info.isFile() ? "file" : "special";
      const identitySha256 = index === components.length - 1 ? filesystemIdentityHash(info) :
        pathComponentIdentityHash(info);
      evidence.push(Object.freeze({ path: current, kind, identitySha256 }));
      if (info.isSymbolicLink()) {
        return Object.freeze({ issue: Object.freeze({ path: current, kind: "symlink" }), evidence: Object.freeze(evidence) });
      }
      if (index < components.length - 1 && !info.isDirectory()) {
        return Object.freeze({
          issue: Object.freeze({ path: current, kind: "non-directory" }),
          evidence: Object.freeze(evidence),
        });
      }
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        evidence.push(Object.freeze({ path: current, kind: "missing", identitySha256: null }));
        return Object.freeze({ issue: null, evidence: Object.freeze(evidence) });
      }
      throw error;
    }
  }
  return Object.freeze({ issue: null, evidence: Object.freeze(evidence) });
}

async function findAncestorGitRoot(
  path: string,
  addBlocker: (code: BlockerCode, message: string, nextAction: string) => void,
): Promise<string | null> {
  try { return await findGitRoot(path); }
  catch (error) {
    addBlocker("ambiguous-state", `An ancestor Git boundary cannot be inspected: ${message(error)}`,
      "Repair the ancestor repository or choose an independent directory, then reassess.");
    return null;
  }
}

function safeRelativePath(path: string): boolean {
  return path !== "" && !path.startsWith("/") && !path.includes("\\") && !/[\u0000-\u001f\u007f]/.test(path) &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

function hashJson(value: unknown): string { return sha256(Buffer.from(JSON.stringify(value))); }
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function gitBlobId(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { readonly code?: unknown }).code === code;
}
