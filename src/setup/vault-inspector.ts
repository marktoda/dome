import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

import { compareStrings } from "../core/compare";
import { parseCapabilityPolicy } from "../engine/core/capability-policy";
import { findGitRoot } from "../git";
import type { VaultAssessment } from "./contracts";

export const SETUP_VAULT_INSPECTION_SCHEMA = "dome.setup.vault-source-inspection/v1" as const;

export const SETUP_VAULT_INSPECTION_CAPS = Object.freeze({
  entries: 100_000,
  fileBytes: 16 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  commandBytes: 16 * 1024 * 1024,
  commandTimeoutMs: 10_000,
});

export type SetupVaultInspectionCaps = typeof SETUP_VAULT_INSPECTION_CAPS;

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
  blockers: ReadonlyArray<VaultAssessment["blockers"][number]>;
  worktreeFingerprint: string;
}>;

export type InspectSetupVaultOptions = Readonly<{
  caps?: Partial<SetupVaultInspectionCaps> | undefined;
  externalFingerprintEvidence?: ReadonlyArray<SetupFingerprintEvidence> | undefined;
  runGit?: SetupGitRunner | undefined;
}>;

type FileEvidence = Readonly<{
  path: string;
  kind: "directory" | "file" | "symlink" | "special";
  mode: number;
  bytes: number;
  sha256: string | null;
  linkTarget: string | null;
  tracking: "tracked" | "untracked" | "ignored" | "other";
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
  gitEntrySha256: string | null;
  indexSha256: string | null;
  statusSha256: string | null;
  infoExcludeSha256: string | null;
}>;

type BlockerCode = VaultAssessment["blockers"][number]["code"];

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
  const addBlocker = (code: BlockerCode, message: string, nextAction: string): void => {
    blockers.set(code, Object.freeze({ code, message, nextAction }));
  };

  const target = await inspectTarget(targetPath, addBlocker);
  const git = await inspectGit(targetPath, target.exists, target.inspectable, caps, options.runGit ?? runGitReadOnly, addBlocker);
  const tree = target.inspectable && target.isDirectory
    ? await inspectTree(targetPath, git, caps, addBlocker)
    : Object.freeze([] as FileEvidence[]);
  const dome = await inspectDomeState(targetPath, tree, addBlocker);

  const trackedMarkdown = markdownPaths(git.tracked);
  const untrackedMarkdown = git.direct
    ? markdownPaths(git.untracked)
    : tree.filter((entry) => entry.kind !== "directory" && entry.path.toLowerCase().endsWith(".md"))
      .map((entry) => entry.path).sort(compareStrings);
  if (trackedMarkdown.length > caps.entries || untrackedMarkdown.length > caps.entries) {
    addBlocker("unsafe-path", "Markdown inventory exceeds the setup assessment budget.",
      "Narrow the selected vault boundary, then reassess.");
  }

  const blockerList = Object.freeze([...blockers.values()].sort((left, right) => compareStrings(left.code, right.code)));
  const kind = classifyTarget(target, git, dome, blockerList);
  const external = normalizeExternalEvidence(options.externalFingerprintEvidence ?? []);
  const fingerprint = hashJson({
    schema: "dome.setup.worktree-fingerprint/v1",
    targetPath,
    target: { exists: target.exists, isDirectory: target.isDirectory, empty: target.empty, inspectable: target.inspectable },
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
      statusSha256: git.statusSha256,
      infoExcludeSha256: git.infoExcludeSha256,
    },
    dome,
    tree,
    external,
  });

  return Object.freeze({
    schema: SETUP_VAULT_INSPECTION_SCHEMA,
    targetPath,
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
    blockers: blockerList,
    worktreeFingerprint: fingerprint,
  });
}

async function inspectTarget(
  targetPath: string,
  addBlocker: (code: BlockerCode, message: string, nextAction: string) => void,
): Promise<Readonly<{ exists: boolean; isDirectory: boolean; empty: boolean; inspectable: boolean }>> {
  const pathIssue = await firstUnsafePathComponent(targetPath);
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
      return Object.freeze({ exists: true, isDirectory: false, empty: false, inspectable: false });
    } catch (error) {
      if (!hasCode(error, "ENOENT") && !hasCode(error, "ENOTDIR")) throw error;
      return Object.freeze({ exists: false, isDirectory: false, empty: true, inspectable: false });
    }
  }
  let info: Awaited<ReturnType<typeof lstat>>;
  try { info = await lstat(targetPath); }
  catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    return Object.freeze({ exists: false, isDirectory: false, empty: true, inspectable: true });
  }
  if (!info.isDirectory()) {
    addBlocker("unsafe-path", "The selected vault is not a directory.",
      "Choose a directory, then reassess.");
    return Object.freeze({ exists: true, isDirectory: false, empty: false, inspectable: false });
  }
  return Object.freeze({
    exists: true,
    isDirectory: true,
    empty: (await readdir(targetPath)).length === 0,
    inspectable: true,
  });
}

async function inspectGit(
  targetPath: string,
  targetExists: boolean,
  targetInspectable: boolean,
  caps: SetupVaultInspectionCaps,
  runGit: SetupGitRunner,
  addBlocker: (code: BlockerCode, message: string, nextAction: string) => void,
): Promise<GitEvidence> {
  const empty = (ancestorRoot: string | null = null): GitEvidence => Object.freeze({
    state: "absent", head: null, branch: null, direct: false, ancestorRoot,
    operationMarkers: Object.freeze([]), tracked: new Set<string>(), untracked: new Set<string>(), ignored: new Set<string>(),
    ignoredPrefixes: Object.freeze([]), gitEntrySha256: null, indexSha256: null, statusSha256: null,
    infoExcludeSha256: null,
  });
  if (!targetInspectable) return empty();
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
    if (operationMarkers.length > 0) {
      addBlocker("active-git-operation", "A Git operation or conflict is active in the selected vault.",
        "Finish or abort the Git operation, then reassess.");
    }
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
    const status = await requiredGit(runGit,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"], targetPath, caps);
    const tracked = nulPaths(trackedOutput.stdout, caps.entries, "tracked Git inventory");
    const untracked = nulPaths(untrackedOutput.stdout, caps.entries, "untracked Git inventory");
    const ignored = nulPaths(ignoredOutput.stdout, caps.entries, "ignored Git inventory");
    const ignoredPrefixes = [...nulPaths(ignoredDirectoryOutput.stdout, caps.entries, "ignored Git directories")]
      .filter((path) => path.endsWith("/")).sort(compareStrings);
    const unmerged = parseStage(stage.stdout, caps.entries);
    if (unmerged) {
      operationMarkers.push("unmerged-index");
      addBlocker("active-git-operation", "A Git operation or conflict is active in the selected vault.",
        "Finish or abort the Git operation, then reassess.");
    }
    operationMarkers.sort(compareStrings);
    const dirty = status.stdout.byteLength > 0;
    if (dirty && operationMarkers.length === 0) {
      addBlocker("dirty-worktree", "The selected Git worktree has tracked, staged, or untracked changes.",
        "Commit, stash, or remove the changes, then reassess.");
    }
    let state: VaultAssessment["git"]["state"];
    if (operationMarkers.length > 0) state = "operation-active";
    else if (head === null && branch !== null) state = "unborn";
    else if (head !== null && branch === null) state = "detached";
    else if (head === null || branch === null) state = "ambiguous";
    else if (dirty) state = "dirty";
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
      ignoredPrefixes: Object.freeze(ignoredPrefixes), gitEntrySha256, indexSha256: sha256(stage.stdout),
      statusSha256: sha256(status.stdout), infoExcludeSha256: await optionalFileHash(join(commonDir, "info", "exclude"), caps),
    });
  } catch (error) {
    if (operationMarkers.length > 0) {
      return Object.freeze({
        ...empty(), state: "operation-active", direct: true, gitEntrySha256,
        operationMarkers: Object.freeze(operationMarkers.sort(compareStrings)),
      });
    }
    addBlocker("ambiguous-state", `The direct Git repository cannot be inspected: ${message(error)}`,
      "Repair the repository, then reassess.");
    return Object.freeze({ ...empty(), state: "ambiguous", direct: true, gitEntrySha256 });
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
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const names = (await readdir(directory)).sort(compareStrings);
    for (const name of names) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      if (path === ".git" || path.startsWith(".git/") || path === ".dome/state" || path.startsWith(".dome/state/")) continue;
      if (path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
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
      const tracking = trackingFor(path, git);
      const mode = info.mode & 0o777;
      if (info.isSymbolicLink()) {
        const linkTarget = await readlink(absolute);
        entries.push(Object.freeze({ path, kind: "symlink", mode, bytes: Buffer.byteLength(linkTarget),
          sha256: sha256(Buffer.from(linkTarget)), linkTarget, tracking }));
        addBlocker("symlink-ambiguity", `The vault contains a symbolic link at ${path}.`,
          "Remove or explicitly replace the link, then reassess.");
        continue;
      }
      if (info.isDirectory()) {
        entries.push(Object.freeze({ path, kind: "directory", mode, bytes: 0, sha256: null, linkTarget: null, tracking }));
        if (name === ".git") {
          addBlocker("unsafe-path", `The vault contains a nested repository at ${path}.`,
            "Choose one repository boundary, then reassess.");
          continue;
        }
        if (git.ignoredPrefixes.some((candidate) => path === candidate.slice(0, -1) || path.startsWith(candidate))) continue;
        await visit(absolute, path);
        continue;
      }
      if (!info.isFile()) {
        entries.push(Object.freeze({ path, kind: "special", mode, bytes: info.size, sha256: null, linkTarget: null, tracking }));
        addBlocker("unsafe-path", `The vault contains a special file at ${path}.`,
          "Remove the special file from the vault boundary, then reassess.");
        continue;
      }
      if (info.nlink !== 1) addBlocker("unsafe-path", `The vault contains a hard-linked file at ${path}.`,
        "Replace the hard link with a direct file, then reassess.");
      if (tracking === "ignored") {
        entries.push(Object.freeze({ path, kind: "file", mode, bytes: info.size, sha256: null, linkTarget: null, tracking }));
        continue;
      }
      if (info.size > caps.fileBytes || hashedBytes + info.size > caps.totalBytes) {
        entries.push(Object.freeze({ path, kind: "file", mode, bytes: info.size, sha256: null, linkTarget: null, tracking }));
        addBlocker("unsafe-path", "The vault exceeds the setup content-hashing budget.",
          "Exclude or relocate large files, then reassess.");
        continue;
      }
      const evidence = await hashDirectFile(absolute, info);
      hashedBytes += info.size;
      entries.push(Object.freeze({ path, kind: "file", mode, bytes: info.size, sha256: evidence,
        linkTarget: null, tracking }));
    }
  };
  await visit(root, "");
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
    return Object.freeze({ state: tree.some((entry) => entry.path === ".dome" || entry.path.startsWith(".dome/")) ? "partial" : "absent" });
  }
  if (config.kind !== "file" || config.sha256 === null) {
    addBlocker("ambiguous-state", "Dome configuration is not a bounded direct file.",
      "Repair .dome/config.yaml, then reassess.");
    return Object.freeze({ state: "incompatible" });
  }
  const configPath = join(targetPath, ".dome", "config.yaml");
  const current = await lstat(configPath);
  if (!current.isFile() || current.isSymbolicLink() || current.size !== config.bytes) {
    addBlocker("ambiguous-state", "Dome configuration changed during setup inspection.",
      "Wait for concurrent changes to finish, then reassess.");
    return Object.freeze({ state: "incompatible" });
  }
  const bytes = await readDirectFile(configPath, current);
  if (sha256(bytes) !== config.sha256) {
    addBlocker("ambiguous-state", "Dome configuration changed during setup inspection.",
      "Wait for concurrent changes to finish, then reassess.");
    return Object.freeze({ state: "incompatible" });
  }
  const body = bytes.toString("utf8");
  const parsed = parseCapabilityPolicy(body, ".dome/config.yaml");
  if (!parsed.ok) {
    addBlocker("ambiguous-state", "Dome configuration is invalid.",
      "Repair .dome/config.yaml, then reassess.");
    return Object.freeze({ state: "incompatible" });
  }
  return Object.freeze({ state: "configured" });
}

function classifyTarget(
  target: Readonly<{ exists: boolean; isDirectory: boolean; empty: boolean }>,
  git: GitEvidence,
  dome: VaultAssessment["dome"],
  blockers: ReadonlyArray<VaultAssessment["blockers"][number]>,
): VaultAssessment["target"]["kind"] {
  if (git.state === "operation-active") return "incompatible-active-operation";
  if (blockers.length > 0) return "unsafe-or-ambiguous-state";
  if (git.direct) return dome.state === "configured" ? "existing-dome-vault" : "existing-git-vault";
  if (!target.exists) return "new-path";
  if (target.isDirectory && target.empty) return "empty-directory";
  return "existing-non-git-vault";
}

function markdownPaths(paths: ReadonlySet<string>): string[] {
  return [...paths].filter((path) => path.toLowerCase().endsWith(".md")).sort(compareStrings);
}

function trackingFor(path: string, git: GitEvidence): FileEvidence["tracking"] {
  if (git.tracked.has(path)) return "tracked";
  if (git.untracked.has(path)) return "untracked";
  if (git.ignored.has(path) || git.ignoredPrefixes.some((prefix) => path.startsWith(prefix))) return "ignored";
  return "other";
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

function parseStage(bytes: Buffer, cap: number): boolean {
  let unmerged = false;
  const rows = nulStrings(bytes, cap, "Git index");
  for (const row of rows) {
    const match = /^(\d{6}) ([0-9a-f]{40}) ([0-3])\t([\s\S]+)$/.exec(row);
    if (match === null) throw new Error("Git index inventory is malformed");
    if (match[3] !== "0") unmerged = true;
    if (match[1] === "160000") throw new Error("Gitlink entries are not supported during setup");
  }
  return unmerged;
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
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(`file changed during setup inspection: ${path}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error(`file changed during setup inspection: ${path}`);
    }
    return bytes;
  } finally { await handle.close(); }
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
  const denied = new Set([
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]);
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !denied.has(key))),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    LC_ALL: "C",
  } as Record<string, string>;
}

function normalizeExternalEvidence(values: ReadonlyArray<SetupFingerprintEvidence>): ReadonlyArray<SetupFingerprintEvidence> {
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

async function firstUnsafePathComponent(
  path: string,
): Promise<Readonly<{ path: string; kind: "symlink" | "non-directory" }> | null> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const components = absolute.slice(root.length).split("/").filter(Boolean);
  let current = root;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) return Object.freeze({ path: current, kind: "symlink" });
      if (index < components.length - 1 && !info.isDirectory()) {
        return Object.freeze({ path: current, kind: "non-directory" });
      }
    } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw error;
    }
  }
  return null;
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
  return path !== "" && !path.startsWith("/") && !path.includes("\\") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

function hashJson(value: unknown): string { return sha256(Buffer.from(JSON.stringify(value))); }
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { readonly code?: unknown }).code === code;
}
