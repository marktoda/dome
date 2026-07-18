import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export type PrivateDirectoryPublication = Readonly<{
  stage: string;
  target: string;
  publish(adapter: (source: string, target: string) => Promise<void>): Promise<void>;
  dispose(): Promise<void>;
}>;

/**
 * Own one private same-filesystem directory until an exclusive publisher
 * moves it to an absent target. Parent identity and target absence are proved
 * both before work and immediately before publication; cleanup is inode-bound.
 */
export async function preparePrivateDirectoryPublication(input: Readonly<{
  target: string;
  prefix: string;
  label: string;
}>): Promise<PrivateDirectoryPublication> {
  if (!/^\.[a-z0-9-]+-$/.test(input.prefix)) throw new Error("private publication prefix is invalid");
  const requested = resolve(input.target);
  await assertAbsent(requested, input.label);
  const lexicalParent = dirname(requested);
  await mkdir(lexicalParent, { recursive: true });
  const lexicalInfo = await lstat(lexicalParent);
  if (!lexicalInfo.isDirectory() || lexicalInfo.isSymbolicLink()) {
    throw new Error(`${input.label} output parent must be a direct non-symlink directory: ${lexicalParent}`);
  }
  const canonicalParent = await realpath(lexicalParent);
  const canonicalInfo = await lstat(canonicalParent);
  if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink() ||
    canonicalInfo.dev !== lexicalInfo.dev || canonicalInfo.ino !== lexicalInfo.ino) {
    throw new Error(`${input.label} output parent identity is inconsistent: ${lexicalParent}`);
  }
  const target = join(canonicalParent, basename(requested));
  await assertAbsent(target, input.label);
  const stage = await mkdtemp(join(canonicalParent, input.prefix));
  const stageInfo = await lstat(stage);
  let disposed = false;
  return Object.freeze({
    stage,
    target,
    publish: async (adapter) => {
      const current = await lstat(lexicalParent);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== lexicalInfo.dev ||
        current.ino !== lexicalInfo.ino || await realpath(lexicalParent) !== canonicalParent) {
        throw new Error(`${input.label} output parent changed during candidate assembly: ${lexicalParent}`);
      }
      await assertAbsent(target, input.label);
      await adapter(stage, target);
    },
    dispose: async () => {
      if (disposed) return;
      try {
        const current = await lstat(stage);
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== stageInfo.dev || current.ino !== stageInfo.ino) {
          disposed = true;
          return;
        }
        await rm(stage, { recursive: true, force: true });
        disposed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { disposed = true; return; }
        throw error;
      }
    },
  });
}

async function assertAbsent(path: string, label: string): Promise<void> {
  try {
    const info = await lstat(path);
    const kind = info.isSymbolicLink() ? "symbolic link" : info.isDirectory() ? "directory" :
      info.isFile() ? "file" : "filesystem entry";
    throw new Error(`${label} output path already exists as a ${kind}: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
