// The single isomorphic-git boundary in the codebase. Every caller that
// needs git functionality imports from here, NOT from "isomorphic-git"
// directly. Each wrapper is a thin passthrough that internally resolves
// the working-tree root, so callers can pass a vault path that may sit
// inside an outer git repo (the dogfood case where dome/docs/ is itself
// a vault) without each call site reimplementing the walk-up.

import git from "isomorphic-git";
import fs from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
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
export async function statusMatrix(path: string): Promise<Awaited<ReturnType<typeof git.statusMatrix>>> {
  const { root, prefix } = await resolveGitContext(path);
  const matrix = await git.statusMatrix({ fs, dir: root });
  if (prefix === "") return matrix;
  const prefixSlash = `${prefix}/`;
  const result: Awaited<ReturnType<typeof git.statusMatrix>> = [];
  for (const row of matrix) {
    const [filepath, ...rest] = row;
    if (filepath.startsWith(prefixSlash)) {
      result.push([filepath.slice(prefixSlash.length), ...rest] as typeof row);
    }
  }
  return result;
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

export async function commit(opts: {
  path: string;
  message: string;
  author?: { name: string; email: string };
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
        // Ignore add-failure for paths that may have been deleted; the
        // commit will still capture deletions present in the index.
      }
    }
  }
  return git.commit({ fs, dir: root, message, author });
}

export async function readTree(opts: { path: string; oid: string }): Promise<Awaited<ReturnType<typeof git.readTree>>> {
  const { root } = await resolveGitContext(opts.path);
  return git.readTree({ fs, dir: root, oid: opts.oid });
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
