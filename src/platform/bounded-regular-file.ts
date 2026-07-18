import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";

export type BoundedRegularFileRead = Readonly<{
  path: string;
  maxBytes: number;
  expectedBytes?: number;
  invalidMessage: string;
  changedMessage: string;
  expectedMessage: string;
}>;

type BoundedRegularFileReadDependencies = Readonly<{
  /** Deterministic race hook; production never supplies it. */
  afterLexicalStat?(): Promise<void>;
}>;

/** Read one direct regular file through a single stable, bounded descriptor. */
export async function readBoundedStableRegularFile(
  input: BoundedRegularFileRead,
  dependencies: BoundedRegularFileReadDependencies = {},
): Promise<Buffer> {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 ||
    (input.expectedBytes !== undefined &&
      (!Number.isSafeInteger(input.expectedBytes) || input.expectedBytes < 1 || input.expectedBytes > input.maxBytes))) {
    throw new Error(input.invalidMessage);
  }
  const path = resolve(input.path);
  const lexical = await lstat(path);
  if (!lexical.isFile() || lexical.isSymbolicLink()) throw new Error(input.invalidMessage);
  await dependencies.afterLexicalStat?.();
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new Error(input.invalidMessage); }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== lexical.dev || before.ino !== lexical.ino ||
      !Number.isSafeInteger(before.size) || before.size < 1 || before.size > input.maxBytes) {
      throw new Error(input.invalidMessage);
    }
    if (input.expectedBytes !== undefined && before.size !== input.expectedBytes) {
      throw new Error(input.expectedMessage);
    }
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead <= 0) throw new Error(input.changedMessage);
      offset += read.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead !== 0) {
      throw new Error(input.changedMessage);
    }
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error(input.changedMessage);
    }
    return bytes;
  } finally { await handle.close(); }
}
