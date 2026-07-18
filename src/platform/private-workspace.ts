import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

export type PrivateWorkspace = Readonly<{ root: string; dispose(): Promise<void> }>;

/** Own one private child of an existing direct directory until proven cleanup. */
export async function preparePrivateWorkspace(input: Readonly<{
  parent: string;
  prefix: string;
  label: string;
}>): Promise<PrivateWorkspace> {
  if (!/^\.?[a-z0-9-]+-$/.test(input.prefix)) throw new Error(`${input.label} workspace prefix is invalid`);
  const lexicalParent = resolve(input.parent);
  const lexicalInfo = await lstat(lexicalParent);
  if (!lexicalInfo.isDirectory() || lexicalInfo.isSymbolicLink()) {
    throw new Error(`${input.label} workspace parent is not a direct directory`);
  }
  const canonicalParent = await realpath(lexicalParent);
  const canonicalInfo = await lstat(canonicalParent);
  if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink() ||
    canonicalInfo.dev !== lexicalInfo.dev || canonicalInfo.ino !== lexicalInfo.ino) {
    throw new Error(`${input.label} workspace parent identity is inconsistent`);
  }
  const root = await mkdtemp(join(canonicalParent, input.prefix));
  const rootInfo = await lstat(root);
  const currentParent = await lstat(lexicalParent);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
    !currentParent.isDirectory() || currentParent.isSymbolicLink() ||
    currentParent.dev !== lexicalInfo.dev || currentParent.ino !== lexicalInfo.ino ||
    await realpath(lexicalParent) !== canonicalParent) {
    await removeOwnedWorkspace(root, rootInfo, input.label);
    throw new Error(`${input.label} workspace parent changed during creation`);
  }
  let disposed = false;
  return Object.freeze({
    root,
    dispose: async () => {
      if (disposed) return;
      await removeOwnedWorkspace(root, rootInfo, input.label);
      disposed = true;
    },
  });
}

async function removeOwnedWorkspace(
  root: string,
  expected: Awaited<ReturnType<typeof lstat>>,
  label: string,
): Promise<void> {
  let current;
  try { current = await lstat(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!current.isDirectory() || current.isSymbolicLink() ||
    current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`${label} workspace ownership changed; retained at ${root}`);
  }
  await rm(root, { recursive: true, force: true });
  try { await lstat(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} workspace cleanup was incomplete`);
}
