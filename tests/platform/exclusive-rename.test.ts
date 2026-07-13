import { describe, expect, test } from "bun:test";
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publishDirectoryExclusive, publishPathExclusive } from "../../src/platform/exclusive-rename";

describe("exclusive path publication", () => {
  test("publishes atomically without replacing an existing target", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-exclusive-rename-"));
    try {
      const source = join(root, "source");
      const target = join(root, "target");
      await mkdir(source);
      await writeFile(join(source, "payload"), "restored\n");
      await publishDirectoryExclusive({ source, target });
      expect(await readFile(join(target, "payload"), "utf8")).toBe("restored\n");

      const loser = join(root, "loser");
      await mkdir(loser);
      await writeFile(join(loser, "payload"), "loser\n");
      await expect(publishDirectoryExclusive({ source: loser, target })).rejects.toThrow("target may already exist");
      expect(await readFile(join(target, "payload"), "utf8")).toBe("restored\n");
      expect(await readFile(join(loser, "payload"), "utf8")).toBe("loser\n");

      const emptyTarget = join(root, "empty-target");
      const emptyLoser = join(root, "empty-loser");
      await mkdir(emptyTarget);
      await mkdir(emptyLoser);
      await expect(publishDirectoryExclusive({ source: emptyLoser, target: emptyTarget })).rejects.toThrow("target may already exist");
      expect((await lstat(emptyTarget)).isDirectory()).toBeTrue();
      expect((await lstat(emptyLoser)).isDirectory()).toBeTrue();

      const danglingTarget = join(root, "dangling-target");
      const danglingLoser = join(root, "dangling-loser");
      await symlink(join(root, "missing"), danglingTarget);
      await mkdir(danglingLoser);
      await expect(publishDirectoryExclusive({ source: danglingLoser, target: danglingTarget })).rejects.toThrow("target may already exist");
      expect(await readlink(danglingTarget)).toBe(join(root, "missing"));
      expect((await lstat(danglingLoser)).isDirectory()).toBeTrue();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("publishes a file without replacing another file", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-exclusive-file-"));
    try {
      const source = join(root, "source");
      const target = join(root, "target");
      await writeFile(source, "winner\n");
      await publishPathExclusive({ source, target });
      expect(await readFile(target, "utf8")).toBe("winner\n");

      const loser = join(root, "loser");
      await writeFile(loser, "loser\n");
      await expect(publishPathExclusive({ source: loser, target })).rejects.toThrow("target may already exist");
      expect(await readFile(target, "utf8")).toBe("winner\n");
      expect(await readFile(loser, "utf8")).toBe("loser\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("refuses platforms without a proven no-replace primitive", async () => {
    await expect(publishDirectoryExclusive({ source: "/tmp/source", target: "/tmp/target", platform: "linux" }))
      .rejects.toThrow("supported only on macOS");
  });
});
