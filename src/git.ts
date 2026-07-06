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
  const matrix = await git.statusMatrix({
    fs,
    dir: root,
    filter: (filepath) => !isDomeStatePath(filepath, prefix),
  });
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

/**
 * True when the working tree carries uncommitted work — any tracked file
 * modified/added/deleted, or any non-ignored untracked file. Built on
 * {@link statusMatrix}, so derived `.dome/state/` and gitignored paths are
 * already excluded and never read as dirty. A row is clean only when
 * `[HEAD, WORKDIR, STAGE] === [1, 1, 1]`; any deviation is uncommitted work.
 *
 * Used by `dome serve` to hold the garden phase off the working tree while a
 * human or agent is mid-edit (Dome works at the git commit boundary): the
 * daemon defers garden materialization until the tree is clean again, so it
 * never rewrites a file out from under a live editor.
 *
 * Caveat: `statusMatrix` honors git's index stat-cache, so an edit that leaves a
 * tracked file at the exact same byte size AND within the same mtime-second as
 * its last index entry can read as clean. Real edits change length and cross
 * second boundaries, so this only degrades gracefully (a rare missed defer falls
 * back to today's clobber) rather than causing data loss.
 */
export async function isWorkingTreeDirty(path: string): Promise<boolean> {
  const matrix = await statusMatrix(path);
  return matrix.some(
    ([, head, workdir, stage]) =>
      !(head === 1 && workdir === 1 && stage === 1),
  );
}

function isDomeStatePath(filepath: string, prefix: string): boolean {
  const domeState = prefix === "" ? ".dome/state" : `${prefix}/.dome/state`;
  return filepath === domeState || filepath.startsWith(`${domeState}/`);
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

/**
 * Commit exactly one file change on top of HEAD without consulting the index.
 *
 * `commit({files})` above commits the whole index, so a caller that wants to
 * land one new file while the user has *other staged-but-uncommitted* changes
 * would sweep that staged work into its commit. This helper builds the commit
 * tree directly — HEAD's tree plus the single spliced blob — so nothing else
 * can ride along, staged or not. Used by `dome capture` per
 * docs/wiki/specs/cli.md §"dome capture" ("a dirty working tree, including
 * already-staged-but-uncommitted changes, is not swept into the capture
 * commit").
 *
 * Contract:
 *   - The caller must already have written `content` to the working tree at
 *     `filepath`; this helper stages that one path (so the index matches the
 *     new HEAD for it) and never touches any other index entry.
 *   - HEAD must resolve (at least one commit) and must be on a branch —
 *     callers gate on both.
 *   - The current branch ref advances to the new commit via compare-and-swap;
 *     other staged work stays staged, dirty files stay dirty.
 *
 * Concurrency: a `dome serve` host may adopt between this helper's HEAD read
 * and its ref advance — the engine moves `refs/heads/<branch>` forward to a
 * closure commit (see src/engine/core/adopt.ts Phase 12c). An unconditional branch
 * write here would force the branch *backwards* past that closure commit,
 * leaving the adopted ref a non-ancestor of HEAD and putting the engine in a
 * hard error loop ("adopted ref ... is not an ancestor"). So the commit is
 * built with `noUpdateBranch` and the branch advances through the same CAS
 * `writeRef({expectedOld})` shape the engine uses; on CAS failure the splice
 * is rebuilt on the new head and retried (bounded).
 *
 * Dogfood-mode safe: `filepath` is vault-relative and translated through the
 * vault prefix like every other helper here.
 */
const COMMIT_SINGLE_FILE_MAX_ATTEMPTS = 5;

export async function commitSingleFileOnHead(opts: {
  path: string;
  filepath: string;
  content: string;
  message: string;
  author?: CommitIdentity;
  /**
   * Test seam: awaited after the candidate commit object is written but
   * before the branch ref CAS, once per attempt. Lets tests advance the
   * branch concurrently to exercise the retry path deterministically.
   */
  beforeRefAdvance?: (attempt: number) => Promise<void>;
}): Promise<string> {
  return commitFilesOnHead({
    path: opts.path,
    files: [{ filepath: opts.filepath, content: opts.content }],
    message: opts.message,
    ...(opts.author !== undefined ? { author: opts.author } : {}),
    ...(opts.beforeRefAdvance !== undefined
      ? { beforeRefAdvance: opts.beforeRefAdvance }
      : {}),
  });
}

/**
 * Commit a set of files against the CURRENT branch's HEAD tree — the
 * multi-file generalization of {@link commitSingleFileOnHead}, and the
 * commit-or-nothing seam behind `performCapture` (one file) and
 * `performSettle` (up to two: the settled origin line + a Done-today bullet
 * in today's daily). Each file's blob is spliced into the HEAD tree in one
 * atomic commit; nothing else — staged or dirty — rides along, because the
 * base is HEAD's tree, not the index. The branch ref advance is a
 * compare-and-swap that retries onto a concurrently-advanced head (the serve
 * host's adoption), so a daemon poll racing the write never clobbers or is
 * clobbered. `files` must be non-empty; passing the same path twice keeps the
 * last write. A `null` content entry removes that path from the tree instead
 * of writing a blob — this helper is tree-only either way: it never reads or
 * mutates the working tree copy of a deleted path (callers that also want
 * the on-disk file gone, e.g. the janitor's archive-move, unlink it
 * themselves before or after calling in).
 */
export async function commitFilesOnHead(opts: {
  path: string;
  files: ReadonlyArray<{
    readonly filepath: string;
    /** `null` removes the path from the tree (see `spliceRemoveFromTree`). */
    readonly content: string | null;
  }>;
  message: string;
  author?: CommitIdentity;
  beforeRefAdvance?: (attempt: number) => Promise<void>;
}): Promise<string> {
  if (opts.files.length === 0) {
    throw new Error("commitFilesOnHead: no files to commit");
  }
  const { root, prefix } = await resolveGitContext(opts.path);
  const fulls = opts.files.map((f) => ({
    full: prefix === "" ? f.filepath : posix.join(prefix, f.filepath),
    content: f.content,
  }));
  const branch = await git.currentBranch({ fs, dir: root, fullname: true });
  if (branch === undefined) {
    throw new Error("commitFilesOnHead: HEAD is detached; callers gate on a branch");
  }
  const author = opts.author ?? { name: "Dome", email: "dome@local" };

  let head = await git.resolveRef({ fs, dir: root, ref: "HEAD" });
  for (let attempt = 1; attempt <= COMMIT_SINGLE_FILE_MAX_ATTEMPTS; attempt += 1) {
    const { commit: headCommit } = await git.readCommit({ fs, dir: root, oid: head });
    let treeOid = headCommit.tree;
    for (const f of fulls) {
      const segments = f.full.split("/").filter((s) => s.length > 0);
      if (f.content === null) {
        treeOid = await spliceRemoveFromTree({ root, treeOid, segments });
        continue;
      }
      const blobOid = await git.writeBlob({
        fs,
        dir: root,
        blob: new TextEncoder().encode(f.content),
      });
      treeOid = await spliceBlobIntoTree({
        root,
        treeOid,
        segments,
        blobOid,
      });
    }
    // Write the commit object without touching the branch; the ref advance
    // below is the only branch mutation, and it is compare-and-swap.
    const commitOid = await git.commit({
      fs,
      dir: root,
      message: opts.message,
      author,
      tree: treeOid,
      parent: [head],
      noUpdateBranch: true,
    });
    if (opts.beforeRefAdvance !== undefined) {
      await opts.beforeRefAdvance(attempt);
    }
    try {
      await writeRef({ path: opts.path, ref: branch, value: commitOid, expectedOld: head });
    } catch (e) {
      // CAS lost: someone (typically the serve host's adoption) moved the
      // branch since `head` was read. Re-resolve and rebuild the splice on
      // the new head; the orphaned candidate commit is unreferenced and gets
      // GC'd. A failure with an unmoved head is a real error — rethrow.
      const current = await git.resolveRef({ fs, dir: root, ref: branch });
      if (current === head) throw e;
      head = current;
      continue;
    }
    // Keep the index in sync for the touched paths so the working tree reads
    // clean after the commit. Writes: the caller already wrote `content` to
    // disk, so `git.add` picks it up. Deletes: this helper is tree-only (see
    // module header) and never touches the working tree itself, but the
    // caller may have already unlinked the path on disk before calling in —
    // `git.remove` stages that removal from the index either way; if the
    // path was never tracked there is nothing to stage.
    for (const f of fulls) {
      if (f.content === null) {
        try {
          await git.remove({ fs, dir: root, filepath: f.full });
        } catch {
          // Not present in the index — nothing to stage.
        }
        continue;
      }
      await git.add({ fs, dir: root, filepath: f.full });
    }
    return commitOid;
  }
  throw new Error(
    `commitFilesOnHead: ${branch} kept advancing concurrently; ` +
      `gave up after ${COMMIT_SINGLE_FILE_MAX_ATTEMPTS} attempts`,
  );
}

/**
 * Return the OID of `treeOid` with the blob spliced in at the nested path
 * `segments`, writing every intermediate tree object. Missing intermediate
 * directories are created; an existing entry at any segment is replaced.
 * isomorphic-git's `writeTree` sorts entries into git's canonical tree order
 * on serialization, so insertion order here is irrelevant.
 */
async function spliceBlobIntoTree(opts: {
  readonly root: string;
  readonly treeOid: string;
  readonly segments: ReadonlyArray<string>;
  readonly blobOid: string;
}): Promise<string> {
  const [segment, ...rest] = opts.segments;
  if (segment === undefined) {
    throw new Error("commitSingleFileOnHead: empty filepath");
  }
  const { tree } = await git.readTree({ fs, dir: opts.root, oid: opts.treeOid });
  const entries = tree.filter((entry) => entry.path !== segment);
  if (rest.length === 0) {
    entries.push({ mode: "100644", path: segment, oid: opts.blobOid, type: "blob" });
  } else {
    const existing = tree.find(
      (entry) => entry.path === segment && entry.type === "tree",
    );
    const childOid =
      existing?.oid ?? (await git.writeTree({ fs, dir: opts.root, tree: [] }));
    const newChild = await spliceBlobIntoTree({
      root: opts.root,
      treeOid: childOid,
      segments: rest,
      blobOid: opts.blobOid,
    });
    entries.push({ mode: "040000", path: segment, oid: newChild, type: "tree" });
  }
  return git.writeTree({ fs, dir: opts.root, tree: entries });
}

/**
 * Return the OID of `treeOid` with the entry at the nested path `segments`
 * removed, writing every intermediate tree object that actually changed.
 * Mirrors {@link spliceBlobIntoTree}'s recursive descent in reverse:
 *
 *   - A `segments` path absent anywhere along the descent is a no-op — the
 *     input `treeOid` is returned unchanged (idempotent re-removal).
 *   - Removing the last entry of a subtree removes that subtree's own entry
 *     from ITS parent in turn (propagated recursively up the call stack), so
 *     no empty tree objects are left behind in the written tree.
 */
async function spliceRemoveFromTree(opts: {
  readonly root: string;
  readonly treeOid: string;
  readonly segments: ReadonlyArray<string>;
}): Promise<string> {
  const [segment, ...rest] = opts.segments;
  if (segment === undefined) {
    throw new Error("commitFilesOnHead: empty filepath");
  }
  const { tree } = await git.readTree({ fs, dir: opts.root, oid: opts.treeOid });
  const existing = tree.find((entry) => entry.path === segment);
  if (existing === undefined) {
    // Path absent at this level — nothing to remove.
    return opts.treeOid;
  }
  if (rest.length === 0) {
    const entries = tree.filter((entry) => entry.path !== segment);
    return git.writeTree({ fs, dir: opts.root, tree: entries });
  }
  if (existing.type !== "tree") {
    // The remaining segments expect a subdirectory here, but this entry is a
    // blob (or other non-tree) — the target path doesn't exist. No-op.
    return opts.treeOid;
  }
  const newChildOid = await spliceRemoveFromTree({
    root: opts.root,
    treeOid: existing.oid,
    segments: rest,
  });
  if (newChildOid === existing.oid) {
    // Nothing changed further down (path was absent) — propagate the no-op.
    return opts.treeOid;
  }
  const entries = tree.filter((entry) => entry.path !== segment);
  const { tree: childEntries } = await git.readTree({ fs, dir: opts.root, oid: newChildOid });
  if (childEntries.length > 0) {
    entries.push({ mode: existing.mode, path: segment, oid: newChildOid, type: "tree" });
  }
  // else: the subtree is now empty — drop its entry from the parent instead
  // of writing an empty tree object.
  return git.writeTree({ fs, dir: opts.root, tree: entries });
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

/**
 * Read a blob's content as a UTF-8 string given the blob's own object OID
 * (not a commit + filepath). Skips the commit→tree→per-path-segment walk that
 * {@link readBlob} performs on every call: a caller that already knows a
 * path's blob OID (e.g. from a single up-front tree walk) can read the object
 * directly. This is the fast path behind `Snapshot.readFile` when the tree
 * index is materialized — for an `all-readable-markdown` inspection over a
 * large vault it turns O(files × tree-depth) repeated tree decompressions into
 * one tree walk plus O(files) direct object reads (~14× faster at 2k files).
 *
 * Returns null on a not-found object (mirrors {@link readBlob}); other errors
 * (corrupt object, I/O failure) propagate.
 */
export async function readBlobByOid(opts: {
  path: string;
  oid: string;
}): Promise<string | null> {
  const { root } = await resolveGitContext(opts.path);
  try {
    const result = await git.readBlob({ fs, dir: root, oid: opts.oid });
    return Buffer.from(result.blob).toString("utf8");
  } catch (e) {
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
  /**
   * The most recent commit touching the path whose message does NOT carry a
   * `Dome-Run:` trailer (i.e. is not an engine/Dome-authored closure commit
   * per src/engine-commit.ts). `null` when every commit touching the path is
   * Dome-authored. Daily open-loop freshness ranking prefers this over
   * `lastChangedAt` so an engine rewrite (e.g. ^block-anchor stamping) cannot
   * reset a task's human-edit recency. `lastChangedAt`/`lastChangedCommit`
   * keep their true-latest-commit meaning for every other consumer.
   */
  readonly lastHumanChangedCommit: string | null;
  readonly lastHumanChangedAt: string | null;
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
  // The third header field is the Dome-Run trailer value (joined by %x0c
  // when multiple), non-empty iff the commit is a Dome-authored closure
  // commit per src/engine-commit.ts. It rides ahead of the %x00 that
  // delimits the header from the -z name-only list, so the existing parse is
  // unchanged. Verified against git 2.50.x.
  const args = [
    "-C",
    opts.root,
    "log",
    "--pretty=format:%x1e%H%x1f%ct%x1f%(trailers:key=Dome-Run,valueonly,separator=%x0c)%x00",
    "--name-only",
    "-z",
    "--diff-filter=ACMRT",
    opts.commit,
  ];
  if (opts.prefix !== "") {
    args.push("--", opts.prefix);
  }
  const output = await runNativeGit(args);
  // Per path we record the first (most recent) commit as lastChanged*, and
  // the first non-Dome commit as lastHumanChanged*. We walk newest→oldest, so
  // a mutable accumulator lets us fill the human fields lazily without a
  // second pass.
  type Accumulator = {
    lastChangedCommit: string;
    lastChangedAt: string;
    lastHumanChangedCommit: string | null;
    lastHumanChangedAt: string | null;
  };
  const accumulators = new Map<string, Accumulator>();
  for (const record of output.split("\x1e")) {
    if (record.length === 0) continue;
    const headerEnd = record.indexOf("\0");
    if (headerEnd === -1) continue;
    const header = record.slice(0, headerEnd);
    const [commitOid, timestamp, domeRunTrailer] = header.split("\x1f");
    if (commitOid === undefined || timestamp === undefined) continue;
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) continue;
    const at = new Date(seconds * 1000).toISOString();
    const isDomeAuthored =
      domeRunTrailer !== undefined && domeRunTrailer.length > 0;
    for (const rawPath of splitNul(record.slice(headerEnd + 1))) {
      const path = rawPath.startsWith("\n") ? rawPath.slice(1) : rawPath;
      if (path.length === 0) continue;
      let acc = accumulators.get(path);
      if (acc === undefined) {
        acc = {
          lastChangedCommit: commitOid,
          lastChangedAt: at,
          lastHumanChangedCommit: isDomeAuthored ? null : commitOid,
          lastHumanChangedAt: isDomeAuthored ? null : at,
        };
        accumulators.set(path, acc);
      } else if (!isDomeAuthored && acc.lastHumanChangedCommit === null) {
        acc.lastHumanChangedCommit = commitOid;
        acc.lastHumanChangedAt = at;
      }
    }
  }
  const entries = new Map<string, FileInfoAtCommit>();
  for (const [path, acc] of accumulators) {
    entries.set(path, Object.freeze({ ...acc }));
  }
  return Object.freeze(entries);
}

/**
 * One commit record from `logWithTrailers`. `body` is the raw `%b` body —
 * for engine commits it still carries the Dome-* trailer block; consumers
 * that render narratives strip it (src/surface/activity.ts). `domeRun` /
 * `domeExtension` are the parsed trailer values (null when absent), so
 * callers never re-parse trailers out of the body text.
 */
export type TrailerLogEntry = {
  readonly sha: string;
  /** ISO-8601 committer timestamp (`%ct`). */
  readonly at: string;
  readonly subject: string;
  readonly body: string;
  readonly domeRun: string | null;
  readonly domeExtension: string | null;
};

/**
 * Read commit history (newest-first) with the Dome-Run / Dome-Extension
 * trailers pre-parsed — the read surface behind `dome log`. Same native-git
 * trailer technique as `latestFileInfoByPath` above: `%x1e` record
 * separator, `%x1f` field separators, `%(trailers:key=...,valueonly)` for
 * the trailer values (verified against git 2.50.x). `%b` rides last in the
 * record so its embedded newlines never collide with the field separators.
 *
 * Scoped to the vault prefix when the vault sits inside an outer repo (the
 * dogfood case), exactly like the other native-git helpers. Returns an
 * empty array for a repo with no commits yet.
 */
export async function logWithTrailers(opts: {
  readonly path: string;
  readonly limit?: number;
  /** Anything `git log --since` accepts (ISO dates included). */
  readonly since?: string;
}): Promise<ReadonlyArray<TrailerLogEntry>> {
  const { root, prefix } = await resolveGitContext(opts.path);
  const args = [
    "-C",
    root,
    "log",
    "--pretty=format:%x1e%H%x1f%ct%x1f"
      + "%(trailers:key=Dome-Run,valueonly,separator=%x0c)%x1f"
      + "%(trailers:key=Dome-Extension,valueonly,separator=%x0c)%x1f"
      + "%s%x1f%b",
  ];
  if (opts.limit !== undefined) {
    args.push("-n", String(opts.limit));
  }
  if (opts.since !== undefined) {
    args.push(`--since=${opts.since}`);
  }
  args.push("HEAD");
  if (prefix !== "") {
    args.push("--", prefix);
  }

  let output: string;
  try {
    output = await runNativeGit(args);
  } catch (e) {
    // A freshly-init'd repo has no HEAD to log from; that is "no activity",
    // not an error.
    if (
      e instanceof Error &&
      /unknown revision|bad revision|does not have any commits/i.test(e.message)
    ) {
      return Object.freeze([]);
    }
    throw e;
  }

  const entries: TrailerLogEntry[] = [];
  for (const record of output.split("\x1e")) {
    if (record.length === 0) continue;
    const parts = record.split("\x1f");
    if (parts.length < 6) continue;
    const [sha, timestamp, runTrailer, extensionTrailer, subject] = parts;
    // `%b` is the final field; rejoin defensively in case a body ever
    // contains the unit separator itself.
    const body = parts.slice(5).join("\x1f");
    if (sha === undefined || timestamp === undefined || subject === undefined) {
      continue;
    }
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) continue;
    entries.push(
      Object.freeze({
        sha,
        at: new Date(seconds * 1000).toISOString(),
        subject,
        body: body.replace(/\n+$/, ""),
        domeRun: firstTrailerValue(runTrailer),
        domeExtension: firstTrailerValue(extensionTrailer),
      }),
    );
  }
  return Object.freeze(entries);
}

/**
 * The paths a commit changed vs its first parent, **vault-relative**.
 * `--root` makes the initial commit diff against the empty tree so all its
 * files are returned.  Git spawning stays in this module via `runNativeGit`,
 * mirroring `logWithTrailers`.
 *
 * Dogfood-mode safe: when the vault lives inside an outer git repo (non-empty
 * `prefix`), we pass `--relative=<prefix>` to `git diff-tree` which both
 * restricts output to paths under the prefix AND strips it — so callers always
 * receive vault-relative paths regardless of where `.git/` lives. When the
 * vault IS the git root (empty prefix) the flag is omitted and behaviour is
 * identical to before. Pattern mirrors `latestFileInfoByPath` / `logWithTrailers`
 * which both append `-- <prefix>` when prefix is non-empty.
 */
export async function changedPathsForCommit(opts: {
  readonly path: string;
  readonly sha: string;
}): Promise<ReadonlyArray<string>> {
  const { root, prefix } = await resolveGitContext(opts.path);
  const args = [
    "-C",
    root,
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    "--root",
  ];
  if (prefix !== "") {
    args.push(`--relative=${prefix}`);
  }
  args.push(opts.sha);
  const out = await runNativeGit(args);
  return Object.freeze(
    out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  );
}

/**
 * First value of a `%(trailers:...,valueonly,separator=%x0c)` field —
 * engine commits carry exactly one of each Dome-* trailer, so additional
 * values (a hand-crafted duplicate trailer) are ignored rather than joined.
 */
function firstTrailerValue(field: string | undefined): string | null {
  if (field === undefined) return null;
  const first = field.split("\x0c")[0]?.trim() ?? "";
  return first.length === 0 ? null : first;
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
export type ReadRefResult =
  | { readonly kind: "found"; readonly value: string }
  | { readonly kind: "missing" };

export async function readRefResult(opts: {
  path: string;
  ref: string;
}): Promise<ReadRefResult> {
  try {
    const { root } = await resolveGitContext(opts.path);
    return Object.freeze({
      kind: "found" as const,
      value: await git.resolveRef({ fs, dir: root, ref: opts.ref }),
    });
  } catch (error) {
    if (isMissingRefError(error)) {
      return Object.freeze({ kind: "missing" as const });
    }
    throw error;
  }
}

export async function readRef(opts: { path: string; ref: string }): Promise<string | null> {
  const result = await readRefResult(opts);
  return result.kind === "found" ? result.value : null;
}

/**
 * Bounded retry for the CAS `update-ref` path below. Live-vault evidence: 14
 * days of serve logs show 2 hard "Failed to advance ... cannot lock ref"
 * adoption failures where a concurrent Dome host (or a foreground git
 * operation) held the ref's `.lock` file at the moment this ran. That is a
 * transient filesystem lock, not a real conflict, so it is retried here
 * instead of surfacing as a hard failure.
 *
 * `REF_LOCK_RETRY_LIMIT` retries after the initial attempt (6 tries total).
 * The n-th retry (1-indexed) waits `100ms * 2^(n-1)` — 100ms, 200ms, 400ms,
 * 800ms, 1.6s — plus up to `REF_LOCK_JITTER_FRACTION` extra on top. Jitter is
 * strictly additive (never below the un-jittered base) and its max (25% of
 * the base) is well under the 2x step to the next base, so growth is
 * monotonic regardless of the random draw.
 */
const REF_LOCK_RETRY_LIMIT = 5;
const REF_LOCK_BASE_DELAY_MS = 100;
const REF_LOCK_JITTER_FRACTION = 0.25;

/**
 * True iff `error` is git's ref-*lock*-contention shape: a held or stale
 * `.lock` file from a concurrent git process sitting on the same ref —
 * `cannot lock ref '<ref>': Unable to create '<path>.lock': File exists.`
 *
 * Deliberately narrower than matching on "cannot lock ref" alone: git reuses
 * that same prefix for a real compare-and-swap conflict — `cannot lock ref
 * '<ref>': is at <X> but expected <Y>` — when the ref moved out from under an
 * `expectedOld` check. That shape is a genuine divergence, not a transient
 * lock, and must not be retried here (it is either a caller bug or a race
 * `commitFilesOnHead` already handles by rebuilding onto the new head).
 */
function isRefLockContentionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    /unable to create '[^']+\.lock'/i.test(error.message) &&
    /file exists/i.test(error.message)
  );
}

/** The backoff delay in ms for the `retryNumber`-th retry (1-indexed). */
function refLockRetryDelayMs(retryNumber: number): number {
  const base = REF_LOCK_BASE_DELAY_MS * 2 ** (retryNumber - 1);
  return base + Math.random() * base * REF_LOCK_JITTER_FRACTION;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Write `ref` to point at `value` (a commit OID). Used to advance
 * `refs/dome/adopted/<branch>` per ADOPTED_REF_IS_SEMANTIC_CURSOR. The caller
 * is responsible for any fast-forward / divergence semantics; this is a
 * mechanical writer.
 */
export async function writeRef(opts: {
  path: string;
  ref: string;
  value: string;
  /**
   * When set, the update is compare-and-swap:
   * - string: ref must currently equal this OID.
   * - null: ref must not exist.
   */
  expectedOld?: string | null;
  /**
   * Test seam: overrides the delay used between ref-lock-contention retries.
   * Defaults to a real timer-based sleep; tests inject a fake so the backoff
   * shape can be asserted without waiting in real time.
   */
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const { root } = await resolveGitContext(opts.path);
  if ("expectedOld" in opts) {
    const expected = opts.expectedOld ?? "0000000000000000000000000000000000000000";
    const sleep = opts.sleep ?? defaultSleep;
    for (let attempt = 1; attempt <= REF_LOCK_RETRY_LIMIT + 1; attempt += 1) {
      try {
        await runNativeGit(["-C", root, "update-ref", opts.ref, opts.value, expected]);
        return;
      } catch (error) {
        const retriesExhausted = attempt > REF_LOCK_RETRY_LIMIT;
        if (!isRefLockContentionError(error) || retriesExhausted) {
          // Non-lock errors throw immediately (zero retries); lock errors
          // that outlast the retry budget surface as-is, not rewrapped.
          throw error;
        }
        await sleep(refLockRetryDelayMs(attempt));
      }
    }
    return;
  }
  await git.writeRef({ fs, dir: root, ref: opts.ref, value: opts.value, force: true });
}

function isMissingRefError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (
      code === "NotFoundError" ||
      code === "ResolveRefError" ||
      code === "MissingNameError"
    ) {
      return true;
    }
  }
  if (error instanceof Error) {
    return /could not resolve|not found|unknown ref|ambiguous argument/i.test(
      error.message,
    );
  }
  return false;
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
 * Count commits reachable from `tip` but not from `exclude` — the native
 * `git rev-list --count <exclude>..<tip>`. Unlike `countCommitsSince`, this
 * works across divergent histories (neither side needs to be an ancestor of
 * the other), which is exactly the adopted-ref-divergence case: the orphaned
 * engine/human commits are `HEAD..adopted`. Returns null when the count
 * cannot be derived (unknown OIDs, corrupt graph) — callers must treat null
 * as "unknown", never as 0.
 */
export async function countCommitsOnlyIn(opts: {
  path: string;
  tip: string;
  exclude: string;
}): Promise<number | null> {
  try {
    const { root } = await resolveGitContext(opts.path);
    const output = await runNativeGit([
      "-C",
      root,
      "rev-list",
      "--count",
      `${opts.exclude}..${opts.tip}`,
    ]);
    const count = Number.parseInt(output.trim(), 10);
    return Number.isFinite(count) && count >= 0 ? count : null;
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
