import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  managedReleaseStoreCoordinatorPaths,
  withManagedReleaseStoreCoordinator,
} from "../../src/product-host/managed-release-store-coordinator";

test("SQLite ownership excludes another process and SIGKILL releases the kernel mutex", async () => {
  const root = await mkdtemp(join(tmpdir(), "dome-release-coordinator-"));
  const home = join(root, "Home");
  const entered = join(root, "entered");
  await mkdir(home);
  const moduleUrl = pathToFileURL(resolve(import.meta.dir, "../../src/product-host/managed-release-store-coordinator.ts")).href;
  const script = `
    import { withManagedReleaseStoreCoordinator } from ${JSON.stringify(moduleUrl)};
    const result = await withManagedReleaseStoreCoordinator(process.env.DOME_TEST_HOME, async () => {
      await Bun.write(process.env.DOME_TEST_ENTERED, "entered");
      for (;;) await Bun.sleep(1_000);
    }, { waitMs: 0 });
    if (result.kind !== "owned") throw new Error("child did not acquire");
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DOME_TEST_HOME: home, DOME_TEST_ENTERED: entered },
  });
  try {
    const deadline = Date.now() + 5_000;
    while (!await present(entered) && Date.now() < deadline) await Bun.sleep(10);
    expect(await present(entered)).toBeTrue();
    expect((await withManagedReleaseStoreCoordinator(home, async () => "impossible", { waitMs: 0 })).kind).toBe("busy");
    const kill = setTimeout(() => child.kill("SIGKILL"), 50);
    try {
      expect(await withManagedReleaseStoreCoordinator(home, async () => "recovered", { waitMs: 1_000 }))
        .toEqual({ kind: "owned", value: "recovered" });
    } finally { clearTimeout(kill); }
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("linked, malformed, and non-private coordinator evidence fails closed without repair", async () => {
  for (const damage of ["database-link", "directory-link", "malformed", "mode"] as const) {
    const root = await mkdtemp(join(tmpdir(), "dome-release-coordinator-damage-"));
    const home = join(root, "Home");
    await mkdir(home);
    const paths = managedReleaseStoreCoordinatorPaths(home);
    try {
      if (damage === "directory-link") {
        const target = join(root, "foreign");
        await mkdir(target, { mode: 0o700 });
        await symlink(target, paths.directory, "dir");
      } else {
        await mkdir(paths.directory, { mode: 0o700 });
        if (damage === "database-link") {
          const foreign = join(root, "foreign.db");
          await writeFile(foreign, "foreign", { mode: 0o600 });
          await symlink(foreign, paths.database);
        } else {
          await writeFile(paths.database, "not sqlite", { mode: damage === "mode" ? 0o644 : 0o600 });
          if (damage === "mode") await chmod(paths.database, 0o644);
        }
      }
      await expect(withManagedReleaseStoreCoordinator(home, async () => "must-not-enter", { waitMs: 0 })).rejects.toThrow();
      if (damage === "malformed") expect(await readFile(paths.database, "utf8")).toBe("not sqlite");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

async function present(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
