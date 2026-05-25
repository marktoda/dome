import git from "isomorphic-git";
import fs from "node:fs";
import { join } from "node:path";
import { existsSync } from "node:fs";

export async function isGitRepo(path: string): Promise<boolean> {
  return existsSync(join(path, ".git"));
}

export async function initRepo(path: string, branch = "main"): Promise<void> {
  await git.init({ fs, dir: path, defaultBranch: branch });
}

export async function statusMatrix(path: string): Promise<ReadonlyArray<[string, number, number, number]>> {
  return git.statusMatrix({ fs, dir: path });
}

export async function currentSha(path: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs, dir: path, ref: "HEAD" });
  } catch {
    return null;
  }
}

export async function commit(opts: {
  path: string;
  message: string;
  author?: { name: string; email: string };
  files: ReadonlyArray<string>;
}): Promise<string> {
  const { path, message, files } = opts;
  const author = opts.author ?? { name: "Dome", email: "dome@local" };
  for (const f of files) {
    await git.add({ fs, dir: path, filepath: f });
  }
  return git.commit({ fs, dir: path, message, author });
}
