import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink } from "node:fs/promises";
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

  test("repairs only the exact managed directory leaf and closes idempotently", async () => {
    const vault = await temporary("dome-anchored-directory-");
    await mkdir(join(vault, ".dome"), { mode: 0o755 });
    await mkdir(join(vault, ".dome/state"), { mode: 0o755 });
    const files = await AnchoredVaultFiles.open(vault);
    await files.ensureDirectory(".dome/state", 0o700, true);
    expect((await stat(join(vault, ".dome"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(vault, ".dome/state"))).mode & 0o777).toBe(0o700);
    await files.close();
    await files.close();
  });

  test("closes held descriptors when interrupted immediately after mkdir", async () => {
    const vault = await temporary("dome-anchored-mkdir-");
    await mkdir(join(vault, ".dome"), { mode: 0o755 });
    const files = await AnchoredVaultFiles.open(vault, {
      beforeFinalMutation: async (operation) => {
        if (operation === "directory-created") throw new Error("injected after mkdir");
      },
    });
    const fdRoot = process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd";
    const before = (await readdir(fdRoot)).length;
    await expect(files.ensureDirectory(".dome/state", 0o700, true)).rejects.toThrow("after mkdir");
    expect((await readdir(fdRoot)).length).toBe(before);
    await files.close();
    await chmod(join(vault, ".dome/state"), 0o755);

    const retry = await AnchoredVaultFiles.open(vault);
    try {
      await retry.ensureDirectory(".dome/state", 0o700, true);
      expect((await stat(join(vault, ".dome/state"))).mode & 0o777).toBe(0o700);
    } finally {
      await retry.close();
    }
  });
});
