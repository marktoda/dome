import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractTarTree, inspectTar, writeTarTree } from "../../src/backup/tar";

describe("backup normalized ustar", () => {
  test("streams files and requires the exact two-block terminator", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-tar-"));
    try {
      const tree = join(root, "tree");
      await mkdir(tree);
      await writeFile(join(tree, "hello.txt"), "hello");
      const archive = join(root, "payload.tar");
      await writeTarTree(tree, archive);
      expect(await inspectTar(archive)).toEqual([expect.objectContaining({ path: "hello.txt", size: 5 })]);
      const bytes = await readFile(archive);
      await writeFile(join(root, "trailing.tar"), Buffer.concat([bytes, Buffer.from("x")]));
      await expect(inspectTar(join(root, "trailing.tar"))).rejects.toThrow("trailing data");
      await writeFile(join(root, "one-zero.tar"), bytes.subarray(0, bytes.length - 512));
      await expect(inspectTar(join(root, "one-zero.tar"))).rejects.toThrow("second zero");
      const nonzeroPadding = Buffer.from(bytes);
      nonzeroPadding[512 + 5] = 1;
      await writeFile(join(root, "padding.tar"), nonzeroPadding);
      await expect(inspectTar(join(root, "padding.tar"))).rejects.toThrow("padding is not zero-filled");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects malformed UTF-8 and duplicate paths before extraction", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-tar-adversarial-"));
    try {
      const tree = join(root, "tree");
      await mkdir(tree);
      await writeFile(join(tree, "a"), "1");
      await writeFile(join(tree, "b"), "2");
      const archive = join(root, "payload.tar");
      await writeTarTree(tree, archive);
      const original = await readFile(archive);

      const badUtf8 = Buffer.from(original);
      badUtf8[0] = 0xff;
      rewriteChecksum(badUtf8, 0);
      await writeFile(join(root, "utf8.tar"), badUtf8);
      await expect(inspectTar(join(root, "utf8.tar"))).rejects.toThrow();

      const duplicate = Buffer.from(original);
      // First file occupies header + one padded body, so the second header is 1024.
      duplicate.fill(0, 1024, 1124);
      duplicate.write("a", 1024, "utf8");
      rewriteChecksum(duplicate, 1024);
      await writeFile(join(root, "duplicate.tar"), duplicate);
      await expect(inspectTar(join(root, "duplicate.tar"))).rejects.toThrow("duplicate entry");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("extracts many files in one archive traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-tar-many-"));
    try {
      const tree = join(root, "tree");
      await mkdir(tree);
      for (let index = 0; index < 250; index += 1) {
        await writeFile(join(tree, `file-${String(index).padStart(3, "0")}.txt`), `value-${index}`);
      }
      const archive = join(root, "payload.tar");
      await writeTarTree(tree, archive);
      let archiveOpens = 0;
      const openArchive = (async (path: Parameters<typeof open>[0], flags: Parameters<typeof open>[1]) => {
        archiveOpens += 1;
        return await open(path, flags);
      }) as typeof open;
      const destination = join(root, "extracted");
      const entries = await extractTarTree(archive, destination, { openArchive });
      expect(archiveOpens).toBe(1);
      expect(entries).toHaveLength(250);
      expect(await readFile(join(destination, "file-249.txt"), "utf8")).toBe("value-249");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

function rewriteChecksum(buffer: Buffer, offset: number): void {
  buffer.fill(0x20, offset + 148, offset + 156);
  let sum = 0;
  for (let index = offset; index < offset + 512; index += 1) sum += buffer[index] ?? 0;
  buffer.write(`${sum.toString(8).padStart(6, "0")}\0 `, offset + 148, "ascii");
}
