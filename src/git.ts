// The single isomorphic-git boundary in the codebase. Every caller that
// needs git functionality imports from here, NOT from "isomorphic-git"
// directly. Each wrapper is a one-line passthrough; this module exists to
// (a) localize the dependency so a future swap is one file, (b) make the
// real surface explicit (only what we actually use).

import git from "isomorphic-git";
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";

/**
 * True iff `path` sits inside a git working tree. Walks up from `path` looking
 * for `.git/` — matches git's own discovery semantics. Supports both:
 *   - Vault is its own git repo (`.git/` at vault root) — the typical user case
 *   - Vault is a subdirectory of an outer git repo (`.git/` is an ancestor) —
 *     the dogfood case where `docs/` lives inside the SDK repo
 * Returns the discovered git-root path, or null if none exists at or above
 * `path`. The boolean form is `(await findGitRoot(path)) !== null`.
 */
export async function findGitRoot(path: string): Promise<string | null> {
  let current = resolve(path);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function isGitRepo(path: string): Promise<boolean> {
  return (await findGitRoot(path)) !== null;
}

export async function initRepo(path: string, branch = "main"): Promise<void> {
  await git.init({ fs, dir: path, defaultBranch: branch });
}

export async function statusMatrix(path: string): Promise<Awaited<ReturnType<typeof git.statusMatrix>>> {
  return git.statusMatrix({ fs, dir: path });
}

export async function currentSha(path: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs, dir: path, ref: "HEAD" });
  } catch {
    return null;
  }
}

export async function add(path: string, filepath: string): Promise<void> {
  await git.add({ fs, dir: path, filepath });
}

export async function commit(opts: {
  path: string;
  message: string;
  author?: { name: string; email: string };
  files?: ReadonlyArray<string>;
}): Promise<string> {
  const { path, message, files } = opts;
  const author = opts.author ?? { name: "Dome", email: "dome@local" };
  if (files !== undefined) {
    for (const f of files) {
      try {
        await git.add({ fs, dir: path, filepath: f });
      } catch {
        // Ignore add-failure for paths that may have been deleted; the
        // commit will still capture deletions present in the index.
      }
    }
  }
  return git.commit({ fs, dir: path, message, author });
}

export async function readTree(opts: { path: string; oid: string }): Promise<Awaited<ReturnType<typeof git.readTree>>> {
  return git.readTree({ fs, dir: opts.path, oid: opts.oid });
}

export async function resolveRef(opts: { path: string; ref?: string }): Promise<string> {
  return git.resolveRef({ fs, dir: opts.path, ref: opts.ref ?? "HEAD" });
}

export async function log(opts: {
  path: string;
  depth?: number;
  ref?: string;
}): Promise<Awaited<ReturnType<typeof git.log>>> {
  return git.log({
    fs,
    dir: opts.path,
    ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
    ...(opts.ref !== undefined ? { ref: opts.ref } : {}),
  });
}
