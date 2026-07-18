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
  // Copy every caller-owned primitive before the first await. Validation and
  // use must observe one immutable request even if a caller retains the input.
  const pathInput = input.path;
  const maxBytes = input.maxBytes;
  const expectedBytes = input.expectedBytes;
  const invalidMessage = input.invalidMessage;
  const changedMessage = input.changedMessage;
  const expectedMessage = input.expectedMessage;
  const afterLexicalStat = dependencies.afterLexicalStat;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
    (expectedBytes !== undefined &&
      (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > maxBytes))) {
    throw new Error(invalidMessage);
  }
  const path = resolve(pathInput);
  const lexical = await lstat(path);
  if (!lexical.isFile() || lexical.isSymbolicLink()) throw new Error(invalidMessage);
  await afterLexicalStat?.();
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new Error(invalidMessage); }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== lexical.dev || before.ino !== lexical.ino ||
      !Number.isSafeInteger(before.size) || before.size < 1 || before.size > maxBytes) {
      throw new Error(invalidMessage);
    }
    if (expectedBytes !== undefined && before.size !== expectedBytes) {
      throw new Error(expectedMessage);
    }
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead <= 0) throw new Error(changedMessage);
      offset += read.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead !== 0) {
      throw new Error(changedMessage);
    }
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error(changedMessage);
    }
    return bytes;
  } finally { await handle.close(); }
}
