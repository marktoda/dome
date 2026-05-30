// The single isomorphic-git boundary in the codebase. Every caller that
// needs git functionality imports from here, NOT from "isomorphic-git"
// directly. Each wrapper is a thin passthrough that internally resolves
// the working-tree root, so callers can pass a vault path that may sit
// inside an outer git repo (the dogfood case where dome/docs/ is itself
// a vault) without each call site reimplementing the walk-up.

import git from "isomorphic-git";
import fs from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { existsSync, lstatSync, statSync } from "node:fs";
import { walkUpForAncestor } from "./path-walk";

/**
 * True iff `path` sits inside a git working tree. Walks up from `path` looking
 * for `.git/` — matches git's own discovery semantics. Supports both:
 *   - Vault is its own git repo (`.git/` at vault root) — the typical user case
 *   - Vault is a subdirectory of an outer git repo (`.git/` is an ancestor) —
 *     the dogfood case where `docs/` lives inside the SDK repo
 * Returns the discovered git-root path, or null if none exists at or above
 * `path`. The boolean form is `(await findGitRoot(path)) !== null`.
 *
 * Validation: a `.git` *directory* is only accepted as a real git root when
 * it contains `HEAD` (the minimal ref a freshly-init'd repo has). A partial
 * `.git/` left behind by a crashed git operation — `objects/` and `index`
 * but no HEAD — would otherwise short-circuit the walk-up and surface as
 * an isomorphic-git null deref deep inside the helpers. A `.git` *file*
 * (worktree/submodule gitlink) is accepted unconditionally; isomorphic-git
 * follows the gitlink content to resolve the actual gitdir.
 */
export async function findGitRoot(path: string): Promise<string | null> {
  return walkUpForAncestor(path, (dir) => isValidGitEntry(join(dir, ".git")));
}

function isValidGitEntry(gitPath: string): boolean {
  if (!existsSync(gitPath)) return false;
  // .git as a file = gitlink (worktrees, submodules) — accept; isomorphic-git
  // follows the gitlink. .git as a directory must contain HEAD to be real.
  const stat = statSync(gitPath);
  if (stat.isFile()) return true;
  return existsSync(join(gitPath, "HEAD"));
}

export async function isGitRepo(path: string): Promise<boolean> {
  return (await findGitRoot(path)) !== null;
}

/**
 * Resolve the git-root path that contains `path` and the prefix (relative
 * path from gitRoot to `path`, using POSIX separators) that translates
 * vault-relative filepaths to outer-worktree-relative filepaths for
 * isomorphic-git.
 *
 * - Standalone vault (`.git/` at vault root): root === path, prefix === "".
 * - Dogfood vault (vault is a subdir of an outer git): root walks up to the
 *   outer worktree; prefix is the POSIX-normalized relative subdir.
 *
 * Throws if no git root exists at or above `path`. VAULT_IS_GIT_REPO is
 * supposed to have already gated this at openVault, but the throw exists
 * so a regression there surfaces here with a clear message instead of an
 * isomorphic-git internal null deref.
 */
async function resolveGitContext(path: string): Promise<{ root: string; prefix: string }> {
  const root = await findGitRoot(path);
  if (root === null) {
    throw new Error(`git operation invoked against non-git path: ${path}`);
  }
  const absPath = resolve(path);
  const rel = relative(root, absPath).split(/[\\/]/).filter((s) => s.length > 0).join("/");
  return { root, prefix: rel };
}

export async function initRepo(path: string, branch = "main"): Promise<void> {
  await git.init({ fs, dir: path, defaultBranch: branch });
}

/**
 * Working-tree status. In dogfood mode, isomorphic-git returns paths under
 * the outer worktree; this helper filters to the vault subtree and strips
 * the subdir prefix so callers see paths relative to `path` (the vault root)
 * regardless of where `.git/` lives.
 */
export async function statusMatrix(
  path: string,
): Promise<Awaited<ReturnType<typeof git.statusMatrix>>> {
  const { root, prefix } = await resolveGitContext(path);
  const matrix = await git.statusMatrix({ fs, dir: root });
  const ignored = await ignoredUntrackedPaths(
    root,
    matrix
      .filter(
        ([, head, workdir, stage]) =>
          head === 0 && (workdir !== 0 || stage !== 0),
      )
      .map(([filepath]) => filepath),
  );
  const prefixSlash = `${prefix}/`;
  const result: Awaited<ReturnType<typeof git.statusMatrix>> = [];
  for (const row of matrix) {
    const [filepath, head, workdir, stage] = row;
    if (
      head === 0 &&
      (workdir !== 0 || stage !== 0) &&
      ignored.has(filepath)
    ) {
      continue;
    }
    if (prefix === "") {
      result.push(row);
    } else if (filepath.startsWith(prefixSlash)) {
      result.push([filepath.slice(prefixSlash.length), head, workdir, stage]);
    }
  }
  return result;
}

async function ignoredUntrackedPaths(
  root: string,
  filepaths: ReadonlyArray<string>,
): Promise<ReadonlySet<string>> {
  if (filepaths.length === 0) return new Set();
  const pathspecByFilepath = new Map(
    filepaths.map((filepath) => [filepath, ignoreCheckPathspec(root, filepath)]),
  );
  const pathspecs = [...new Set(pathspecByFilepath.values())];

  const proc = Bun.spawn(["git", "-C", root, "check-ignore", "--stdin"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(pathspecs.join("\n"));
  proc.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error(
      `git check-ignore failed for ${root}: ${stderr.trim() || `exit ${exitCode}`}`,
    );
  }
  const ignoredPathspecs = new Set(
    stdout.split(/\r?\n/).filter((line) => line.length > 0),
  );
  return new Set(
    filepaths.filter((filepath) =>
      ignoredPathspecs.has(pathspecByFilepath.get(filepath) ?? filepath),
    ),
  );
}

function ignoreCheckPathspec(root: string, filepath: string): string {
  const parts = filepath.split("/");
  let pathspec = "";
  for (const part of parts) {
    pathspec = pathspec === "" ? part : posix.join(pathspec, part);
    try {
      if (lstatSync(join(root, ...pathspec.split("/"))).isSymbolicLink()) {
        return pathspec;
      }
    } catch {
      return filepath;
    }
  }
  return filepath;
}

export async function currentSha(path: string): Promise<string | null> {
  try {
    const { root } = await resolveGitContext(path);
    return await git.resolveRef({ fs, dir: root, ref: "HEAD" });
  } catch {
    return null;
  }
}

export async function add(path: string, filepath: string): Promise<void> {
  const { root, prefix } = await resolveGitContext(path);
  const fullpath = prefix === "" ? filepath : posix.join(prefix, filepath);
  await git.add({ fs, dir: root, filepath: fullpath });
}

export type CommitIdentity = {
  readonly name: string;
  readonly email: string;
  readonly timestamp?: number;
};

export async function commit(opts: {
  path: string;
  message: string;
  author?: CommitIdentity;
  committer?: CommitIdentity;
  files?: ReadonlyArray<string>;
}): Promise<string> {
  const { path, message, files } = opts;
  const { root, prefix } = await resolveGitContext(path);
  const author = opts.author ?? { name: "Dome", email: "dome@local" };
  if (files !== undefined) {
    for (const f of files) {
      const fullpath = prefix === "" ? f : posix.join(prefix, f);
      try {
        await git.add({ fs, dir: root, filepath: fullpath });
      } catch {
        // `git.add` fails for deleted paths. Stage the removal explicitly so
        // callers can pass a path list that contains both writes and deletes.
        try {
          await git.remove({ fs, dir: root, filepath: fullpath });
        } catch {
          // If the path was neither present in the working tree nor tracked in
          // the index, there is nothing to stage.
        }
      }
    }
  }
  return git.commit({
    fs,
    dir: root,
    message,
    author,
    ...(opts.committer !== undefined ? { committer: opts.committer } : {}),
  });
}

export async function readTree(opts: { path: string; oid: string }): Promise<Awaited<ReturnType<typeof git.readTree>>> {
  const { root, prefix } = await resolveGitContext(opts.path);
  const commitTree = await treeOidIfCommit(root, opts.oid);
  if (commitTree === null) {
    return git.readTree({ fs, dir: root, oid: opts.oid });
  }
  return readPrefixedTree({
    root,
    treeOid: commitTree,
    prefix,
  });
}

/**
 * Read a blob's content as a UTF-8 string, given the commit OID and the
 * vault-relative path. Returns null when the path doesn't resolve to a blob
 * inside the commit's tree (missing file, directory, or symlink — the latter
 * surfaces as null because we don't follow links).
 *
 * Dogfood-mode safe: the `filepath` arg to isomorphic-git is relative to the
 * git root, so we POSIX-join the vault subdir prefix before delegating. Vault
 * callers see a vault-relative path; the helper handles the translation.
 *
 * Errors that aren't "not found" (e.g., a corrupt object, an I/O failure)
 * propagate — the caller can decide whether to treat as missing or fail.
 */
export async function readBlob(opts: {
  path: string;
  commit: string;
  filepath: string;
}): Promise<string | null> {
  const { root, prefix } = await resolveGitContext(opts.path);
  const fullpath = prefix === "" ? opts.filepath : posix.join(prefix, opts.filepath);
  try {
    const result = await git.readBlob({
      fs,
      dir: root,
      oid: opts.commit,
      filepath: fullpath,
    });
    return Buffer.from(result.blob).toString("utf8");
  } catch (e) {
    // isomorphic-git throws NotFoundError when the path doesn't exist in the
    // tree; treat that as "no such file" (null). Any other error propagates.
    if (e instanceof Error && /not found|ENOENT|NotFoundError/i.test(e.message)) {
      return null;
    }
    if (typeof e === "object" && e !== null && "code" in e) {
      const code = (e as { code: unknown }).code;
      if (code === "NotFoundError") return null;
    }
    throw e;
  }
}

async function treeOidIfCommit(
  root: string,
  oid: string,
): Promise<string | null> {
  try {
    const result = await git.readCommit({ fs, dir: root, oid });
    return result.commit.tree;
  } catch {
    return null;
  }
}

async function readPrefixedTree(opts: {
  root: string;
  treeOid: string;
  prefix: string;
}): Promise<Awaited<ReturnType<typeof git.readTree>>> {
  if (opts.prefix === "") {
    return git.readTree({ fs, dir: opts.root, oid: opts.treeOid });
  }

  let current = await git.readTree({
    fs,
    dir: opts.root,
    oid: opts.treeOid,
  });
  for (const segment of opts.prefix.split("/")) {
    const entry = current.tree.find(
      (candidate) => candidate.path === segment && candidate.type === "tree",
    );
    if (entry === undefined) {
      throw new Error(
        `vault prefix '${opts.prefix}' does not exist in commit tree`,
      );
    }
    current = await git.readTree({
      fs,
      dir: opts.root,
      oid: entry.oid,
    });
  }
  return current;
}

export async function resolveRef(opts: { path: string; ref?: string }): Promise<string> {
  const { root } = await resolveGitContext(opts.path);
  return git.resolveRef({ fs, dir: root, ref: opts.ref ?? "HEAD" });
}

export async function log(opts: {
  path: string;
  depth?: number;
  ref?: string;
}): Promise<Awaited<ReturnType<typeof git.log>>> {
  const { root } = await resolveGitContext(opts.path);
  return git.log({
    fs,
    dir: root,
    ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
    ...(opts.ref !== undefined ? { ref: opts.ref } : {}),
  });
}

export type FileInfoAtCommit = {
  readonly lastChangedCommit: string;
  readonly lastChangedAt: string;
};

type CommitFileInfoCache = {
  readonly trackedPaths: ReadonlySet<string>;
  readonly infoByPath: ReadonlyMap<string, FileInfoAtCommit>;
};

const FILE_INFO_CACHE_MAX_COMMITS = 32;
const fileInfoCacheByCommit = new Map<string, Promise<CommitFileInfoCache>>();

/**
 * Return git-backed metadata for a vault-relative file at `commit`.
 *
 * This is intentionally narrower than exposing `git.log` to processors:
 * callers get the single fact a snapshot can answer deterministically
 * ("which commit last changed this readable path, and when was that commit
 * made?") without learning about refs, branches, or repository layout.
 */
export async function fileInfoAtCommit(opts: {
  path: string;
  commit: string;
  filepath: string;
}): Promise<FileInfoAtCommit | null> {
  const { root, prefix } = await resolveGitContext(opts.path);
  const fullpath = prefix === "" ? opts.filepath : posix.join(prefix, opts.filepath);
  const cache = await fileInfoCacheForCommit({ root, prefix, commit: opts.commit });
  if (!cache.trackedPaths.has(fullpath)) return null;
  return cache.infoByPath.get(fullpath) ?? null;
}

async function fileInfoCacheForCommit(opts: {
  readonly root: string;
  readonly prefix: string;
  readonly commit: string;
}): Promise<CommitFileInfoCache> {
  const key = `${opts.root}\0${opts.prefix}\0${opts.commit}`;
  const existing = fileInfoCacheByCommit.get(key);
  if (existing !== undefined) return existing;

  const promise = buildFileInfoCacheForCommit(opts);
  rememberFileInfoCache(key, promise);
  try {
    return await promise;
  } catch (e) {
    fileInfoCacheByCommit.delete(key);
    throw e;
  }
}

async function buildFileInfoCacheForCommit(opts: {
  readonly root: string;
  readonly prefix: string;
  readonly commit: string;
}): Promise<CommitFileInfoCache> {
  try {
    const trackedPaths = await trackedPathsAtCommit(opts);
    const infoByPath = await latestFileInfoByPath(opts);
    return Object.freeze({
      trackedPaths,
      infoByPath,
    });
  } catch (e) {
    if (e instanceof Error && /not found|ENOENT|NotFoundError/i.test(e.message)) {
      return emptyFileInfoCache();
    }
    if (typeof e === "object" && e !== null && "code" in e) {
      const code = (e as { code: unknown }).code;
      if (code === "NotFoundError") {
        return emptyFileInfoCache();
      }
    }
    throw e;
  }
}

function rememberFileInfoCache(
  key: string,
  cache: Promise<CommitFileInfoCache>,
): void {
  fileInfoCacheByCommit.set(key, cache);
  while (fileInfoCacheByCommit.size > FILE_INFO_CACHE_MAX_COMMITS) {
    const oldest = fileInfoCacheByCommit.keys().next().value;
    if (oldest === undefined || oldest === key) return;
    fileInfoCacheByCommit.delete(oldest);
  }
}

function emptyFileInfoCache(): CommitFileInfoCache {
  return Object.freeze({
    trackedPaths: Object.freeze(new Set<string>()),
    infoByPath: Object.freeze(new Map<string, FileInfoAtCommit>()),
  });
}

async function trackedPathsAtCommit(opts: {
  readonly root: string;
  readonly prefix: string;
  readonly commit: string;
}): Promise<ReadonlySet<string>> {
  const args = [
    "-C",
    opts.root,
    "ls-tree",
    "-rz",
    "-r",
    "--name-only",
    opts.commit,
  ];
  if (opts.prefix !== "") {
    args.push("--", opts.prefix);
  }
  const output = await runNativeGit(args);
  return Object.freeze(
    new Set(splitNul(output).filter((path) => path.length > 0)),
  );
}

async function latestFileInfoByPath(opts: {
  readonly root: string;
  readonly prefix: string;
  readonly commit: string;
}): Promise<ReadonlyMap<string, FileInfoAtCommit>> {
  const args = [
    "-C",
    opts.root,
    "log",
    "--pretty=format:%x1e%H%x1f%ct%x00",
    "--name-only",
    "-z",
    "--diff-filter=ACMRT",
    opts.commit,
  ];
  if (opts.prefix !== "") {
    args.push("--", opts.prefix);
  }
  const output = await runNativeGit(args);
  const entries = new Map<string, FileInfoAtCommit>();
  for (const record of output.split("\x1e")) {
    if (record.length === 0) continue;
    const headerEnd = record.indexOf("\0");
    if (headerEnd === -1) continue;
    const header = record.slice(0, headerEnd);
    const [commitOid, timestamp] = header.split("\x1f");
    if (commitOid === undefined || timestamp === undefined) continue;
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) continue;
    const info = Object.freeze({
      lastChangedCommit: commitOid,
      lastChangedAt: new Date(seconds * 1000).toISOString(),
    });
    for (const rawPath of splitNul(record.slice(headerEnd + 1))) {
      const path = rawPath.startsWith("\n") ? rawPath.slice(1) : rawPath;
      if (path.length === 0 || entries.has(path)) continue;
      entries.set(path, info);
    }
  }
  return Object.freeze(entries);
}

async function runNativeGit(args: ReadonlyArray<string>): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${stderr.trim() || `exit ${exitCode}`}`,
    );
  }
  return Buffer.from(stdout).toString("utf8");
}

function splitNul(output: string): ReadonlyArray<string> {
  return output.split("\0").filter((part) => part.length > 0);
}

/**
 * Resolve a ref name to its current commit OID. Returns null when the ref
 * doesn't exist (the canonical "uninitialized" signal for the adopted ref).
 * isomorphic-git throws on unknown refs; this wrapper turns the throw into a
 * null so callers don't need a try/catch at every read site.
 */
export async function readRef(opts: { path: string; ref: string }): Promise<string | null> {
  try {
    const { root } = await resolveGitContext(opts.path);
    return await git.resolveRef({ fs, dir: root, ref: opts.ref });
  } catch {
    return null;
  }
}

/**
 * Write `ref` to point at `value` (a commit OID). Used to advance
 * `refs/dome/adopted/<branch>` per ADOPTED_REF_IS_SEMANTIC_CURSOR. The caller
 * is responsible for any fast-forward / divergence semantics; this is a
 * mechanical writer.
 */
export async function writeRef(opts: { path: string; ref: string; value: string }): Promise<void> {
  const { root } = await resolveGitContext(opts.path);
  await git.writeRef({ fs, dir: root, ref: opts.ref, value: opts.value, force: true });
}

/**
 * Materialize selected vault-relative paths from `ref` into the working tree
 * without changing HEAD. In dogfood mode, the path list is translated through
 * the vault prefix before reaching isomorphic-git.
 */
export async function checkoutPathsAtRef(opts: {
  path: string;
  ref: string;
  filepaths: ReadonlyArray<string>;
  dryRun?: boolean;
  force?: boolean;
}): Promise<void> {
  if (opts.filepaths.length === 0) return;
  const { root, prefix } = await resolveGitContext(opts.path);
  const fullpaths = opts.filepaths.map((filepath) =>
    prefix === "" ? filepath : posix.join(prefix, filepath),
  );
  await git.checkout({
    fs,
    dir: root,
    ref: opts.ref,
    filepaths: fullpaths,
    noUpdateHead: true,
    force: opts.force ?? false,
    dryRun: opts.dryRun ?? false,
  });
}

/**
 * True when `ancestor` is in `descendant`'s ancestry — i.e., advancing
 * `ancestor → descendant` is a fast-forward. Used by `setAdoptedRef` to
 * decide whether the new HEAD descends from the current adopted commit
 * before advancing. Returns false on any error (treat unknown-ref or
 * detached-commit cases as "not an ancestor" — refuse to advance).
 */
export async function isAncestor(opts: {
  path: string;
  ancestor: string;
  descendant: string;
}): Promise<boolean> {
  try {
    const { root } = await resolveGitContext(opts.path);
    return await git.isDescendent({ fs, dir: root, oid: opts.descendant, ancestor: opts.ancestor });
  } catch {
    return false;
  }
}

/**
 * Count commits reachable from `descendant` before `ancestor` is encountered.
 * Returns null when the relationship cannot be proven from the local graph
 * (unknown refs, divergent history, or a bounded walk that never finds the
 * ancestor). This is the status/read-side companion to `isAncestor`.
 */
export async function countCommitsSince(opts: {
  path: string;
  ancestor: string;
  descendant: string;
  maxDepth?: number;
}): Promise<number | null> {
  if (opts.ancestor === opts.descendant) return 0;
  try {
    const { root } = await resolveGitContext(opts.path);
    const commits = await git.log({
      fs,
      dir: root,
      ref: opts.descendant,
      force: true,
      ...(opts.maxDepth !== undefined ? { depth: opts.maxDepth } : {}),
    });
    let count = 0;
    for (const entry of commits) {
      if (entry.oid === opts.ancestor) return count;
      count += 1;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the current branch name (the symbolic ref `HEAD` points to).
 * Returns null when HEAD is detached (commit-OID-only HEAD; no branch
 * association). Vaults with detached HEAD cannot use the adopted-ref
 * substrate because there's no `<branch>` to namespace under; callers
 * surface this as "uninitialized" or a validation error.
 */
export async function currentBranch(path: string): Promise<string | null> {
  try {
    const { root } = await resolveGitContext(path);
    const name = await git.currentBranch({ fs, dir: root, fullname: false });
    return name ?? null;
  } catch {
    return null;
  }
}
