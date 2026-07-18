import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
import { Parser, type ReadEntry } from "tar";

import {
  PRODUCT_PACKAGE_CAPS,
  assertProductPackageSafePath,
  type ProductPackageFile,
} from "../../src/product-package/manifest";

/**
 * Stream-verify an npm tgz without extracting it. node-tar owns format parsing;
 * this seam admits only the exact package/ regular-file inventory already
 * closed by the product manifest, and hashes every member body independently.
 */
export async function verifyPackedProductArchive(input: Readonly<{
  archive: string;
  compressedBytes: number;
  expected: ReadonlyArray<ProductPackageFile>;
}>): Promise<void> {
  if (!Number.isSafeInteger(input.compressedBytes) || input.compressedBytes < 1 ||
    input.compressedBytes > PRODUCT_PACKAGE_CAPS.packedBytes) {
    throw new Error("product package archive compressed size is invalid");
  }
  const path = resolve(input.archive);
  const lexical = await lstat(path);
  if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.size !== input.compressedBytes) {
    throw new Error("product package archive is not the expected bounded regular file");
  }
  const expected = new Map(input.expected.map((entry) => [entry.path, entry]));
  if (expected.size !== input.expected.length || expected.size > PRODUCT_PACKAGE_CAPS.packedEntries) {
    throw new Error("product package archive expectation is duplicate or oversized");
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  let failure: Error | undefined;
  const parser = new Parser({
    strict: true,
    noResume: true,
    maxMetaEntrySize: 64 * 1024,
    maxDecompressionRatio: 32,
    onReadEntry: (entry) => {
      try {
        admitEntry(entry);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        entry.resume();
        parser.abort(failure);
      }
    },
  });
  const completion = new Promise<void>((resolveCompletion, reject) => {
    parser.once("error", reject);
    parser.once("end", resolveCompletion);
  });
  function admitEntry(entry: ReadEntry): void {
    if (entry.type !== "File" && entry.type !== "OldFile") {
      throw new Error(`product package archive contains unsupported member type: ${entry.type}`);
    }
    if (!entry.path.startsWith("package/")) throw new Error(`product package archive member has no package root: ${entry.path}`);
    const path = entry.path.slice("package/".length);
    assertProductPackageSafePath(path);
    if (path.split("/").length > 64) throw new Error(`product package archive path is too deep: ${path}`);
    if (seen.has(path)) throw new Error(`product package archive contains duplicate member: ${path}`);
    const evidence = expected.get(path);
    if (evidence === undefined) throw new Error(`product package archive contains unexpected member: ${path}`);
    const expectedMode = Number.parseInt(evidence.mode, 8);
    if (entry.mode !== expectedMode) throw new Error(`product package archive mode differs from closed evidence: ${path}`);
    if (entry.size !== evidence.bytes) throw new Error(`product package archive size differs from closed evidence: ${path}`);
    seen.add(path);
    totalBytes += entry.size;
    if (seen.size > PRODUCT_PACKAGE_CAPS.packedEntries || totalBytes > PRODUCT_PACKAGE_CAPS.unpackedBytes) {
      throw new Error("product package archive exceeds its entry or byte budget");
    }
    const hash = createHash("sha256");
    let bodyBytes = 0;
    entry.on("data", (chunk: Buffer) => {
      bodyBytes += chunk.byteLength;
      if (bodyBytes > evidence.bytes) {
        failure = new Error(`product package archive member exceeded its closed size: ${path}`);
        parser.abort(failure);
        return;
      }
      hash.update(chunk);
    });
    entry.once("end", () => {
      if (failure !== undefined) return;
      if (bodyBytes !== evidence.bytes || hash.digest("hex") !== evidence.sha256) {
        failure = new Error(`product package archive content differs from closed evidence: ${path}`);
        parser.abort(failure);
      }
    });
    entry.resume();
  }

  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== lexical.dev || before.ino !== lexical.ino || before.size !== lexical.size) {
      throw new Error("product package archive identity changed before its bounded read");
    }
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const length = Math.min(chunk.byteLength, before.size - offset);
      const read = await handle.read(chunk, 0, length, offset);
      if (read.bytesRead <= 0) throw new Error("product package archive changed during its bounded read");
      offset += read.bytesRead;
      if (!parser.write(chunk.subarray(0, read.bytesRead))) {
        await new Promise<void>((resolveDrain, reject) => {
          parser.once("drain", resolveDrain);
          parser.once("error", reject);
        });
      }
    }
    parser.end();
    await completion;
    if (failure !== undefined) throw failure;
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error("product package archive changed during its bounded read");
    }
  } finally {
    await handle.close();
  }
  if (seen.size !== expected.size) {
    const missing = [...expected.keys()].find((path) => !seen.has(path));
    throw new Error(`product package archive is missing closed member: ${missing ?? "unknown"}`);
  }
}
