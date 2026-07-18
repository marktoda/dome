import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AnchoredVaultFiles } from "../../src/setup/anchored-files";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(path);
  return path;
}

describe("AnchoredVaultFiles", () => {
  test("a failing pre-mutation hook acquires no file descriptor and publishes nothing", async () => {
    const vault = await temporary("dome-anchored-hook-");
    const files = await AnchoredVaultFiles.open(vault, {
      beforeFinalMutation: async () => { throw new Error("injected before mutation"); },
    });
    try {
      const fdRoot = process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd";
      const before = (await readdir(fdRoot)).length;
      await expect(files.createExclusive("never-created", "bytes\n", 0o644))
        .rejects.toThrow("injected before mutation");
      expect(await Bun.file(join(vault, "never-created")).exists()).toBeFalse();
      expect((await readdir(fdRoot)).length).toBe(before);
    } finally {
      await files.close();
    }
  });

  test("contains an ancestor symlink swap inside the held vault directory", async () => {
    const vault = await temporary("dome-anchored-vault-");
    const outside = await temporary("dome-anchored-outside-");
    await mkdir(join(vault, ".dome"));
    let armed = false;
    const files = await AnchoredVaultFiles.open(vault, {
      beforeFinalMutation: async () => {
        if (!armed) return;
        armed = false;
        await rename(join(vault, ".dome"), join(vault, ".dome-held"));
        await symlink(outside, join(vault, ".dome"), "dir");
      },
    });
    try {
      await files.createExclusive(".dome/.config.tmp", "approved\n", 0o644);
      armed = true;
      await expect(files.linkExclusive(".dome/.config.tmp", ".dome/config.yaml"))
        .rejects.toThrow(/parent directory is not direct|directory identity changed/);
      expect(await Bun.file(join(outside, "config.yaml")).exists()).toBeFalse();
      expect(await readFile(join(vault, ".dome-held/.config.tmp"), "utf8")).toBe("approved\n");
      expect(await readFile(join(vault, ".dome-held/config.yaml"), "utf8")).toBe("approved\n");
    } finally {
      await files.close();
    }
  });

  test("contains a replacement when an ancestor name is swapped after binding", async () => {
    const vault = await temporary("dome-anchored-replace-");
    const outside = await temporary("dome-anchored-replace-outside-");
    await mkdir(join(vault, ".dome"));
    await Bun.write(join(vault, ".dome/config.yaml"), "owner\n");
    let armed = false;
    const files = await AnchoredVaultFiles.open(vault, {
      beforeFinalMutation: async () => {
        if (!armed) return;
        armed = false;
        await rename(join(vault, ".dome"), join(vault, ".dome-held"));
        await symlink(outside, join(vault, ".dome"), "dir");
      },
    });
    try {
      await files.createExclusive(".dome/.config.tmp", "merged\n", 0o644);
      armed = true;
      await expect(files.rename(".dome/.config.tmp", ".dome/config.yaml"))
        .rejects.toThrow(/directory identity changed/);
      expect(await Bun.file(join(outside, "config.yaml")).exists()).toBeFalse();
      expect(await readFile(join(vault, ".dome-held/config.yaml"), "utf8")).toBe("merged\n");
    } finally {
      await files.close();
    }
  });
});
