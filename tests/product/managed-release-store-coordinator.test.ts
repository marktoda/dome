import { expect, test } from "bun:test";
import {
  chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertManagedReleaseStoreOwner,
  managedReleaseStoreCoordinatorPaths,
  withManagedReleaseStoreCoordinator,
  type ManagedReleaseStoreOwner,
} from "../../src/product-host/managed-release-store-coordinator";

test("simultaneous first initialization publishes one complete coordinator and serializes both owners", async () => {
  const { root, home } = await homeFixture("dome-release-coordinator-init-");
  const gate = join(root, "start");
  const moduleUrl = pathToFileURL(resolve(import.meta.dir, "../../src/product-host/managed-release-store-coordinator.ts")).href;
  const script = `
    import { existsSync } from "node:fs";
    import { withManagedReleaseStoreCoordinator } from ${JSON.stringify(moduleUrl)};
    while (!existsSync(process.env.DOME_TEST_GATE)) await Bun.sleep(1);
    const result = await withManagedReleaseStoreCoordinator(process.env.DOME_TEST_HOME, async () => {
      await Bun.sleep(25);
      return "entered";
    }, { waitMs: 1_000 });
    console.log(JSON.stringify(result));
  `;
  const children = Array.from({ length: 2 }, () => Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DOME_TEST_HOME: home, DOME_TEST_GATE: gate },
  }));
  try {
    await writeFile(gate, "go");
    const results = await Promise.all(children.map(async (child) => ({
      exit: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    })));
    if (results.some((result) => result.exit !== 0)) {
      throw new Error(`simultaneous coordinator initialization failed: ${JSON.stringify(results)}`);
    }
    expect(results.map((result) => result.exit)).toEqual([0, 0]);
    expect(results.map((result) => result.stderr)).toEqual(["", ""]);
    expect(results.map((result) => JSON.parse(result.stdout))).toEqual([
      { kind: "owned", value: "entered" },
      { kind: "owned", value: "entered" },
    ]);
    const names = await readdir(managedReleaseStoreCoordinatorPaths(home).directory);
    expect(names).toEqual([basename(managedReleaseStoreCoordinatorPaths(home).database)]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);

test("initialization retry replays durability after database publication", async () => {
  const { root, home } = await homeFixture("dome-release-coordinator-init-retry-");
  const paths = managedReleaseStoreCoordinatorPaths(home);
  const hits = { directory: 0, "parent-entry": 0 };
  const options = {
    waitMs: 0,
    directoryDurabilityCheckpoint: (step: Readonly<{ kind: "directory" | "parent-entry" }>) => {
      hits[step.kind] += 1;
      if (step.kind === "directory" && (hits.directory === 2 || hits.directory === 3)) {
        throw new Error("coordinator directory durability failed");
      }
    },
  };
  try {
    await expect(withManagedReleaseStoreCoordinator(home, async () => "first", options))
      .rejects.toThrow("coordinator directory durability failed");
    expect(await present(paths.database)).toBeTrue();
    expect(await withManagedReleaseStoreCoordinator(home, async () => "retried", options))
      .toEqual({ kind: "owned", value: "retried" });
    expect(hits).toEqual({ directory: 4, "parent-entry": 2 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("zero wait is immediate, bounded wait expires, and SIGKILL releases the kernel mutex", async () => {
  const { root, home } = await homeFixture("dome-release-coordinator-owner-");
  const entered = join(root, "entered");
  const moduleUrl = pathToFileURL(resolve(import.meta.dir, "../../src/product-host/managed-release-store-coordinator.ts")).href;
  const script = `
    import { withManagedReleaseStoreCoordinator } from ${JSON.stringify(moduleUrl)};
    await withManagedReleaseStoreCoordinator(process.env.DOME_TEST_HOME, async () => {
      await Bun.write(process.env.DOME_TEST_ENTERED, "entered");
      for (;;) await Bun.sleep(1_000);
    }, { waitMs: 0 });
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
    const noWaitStarted = performance.now();
    expect((await withManagedReleaseStoreCoordinator(home, async () => "no", { waitMs: 0 })).kind).toBe("busy");
    expect(performance.now() - noWaitStarted).toBeLessThan(100);
    const boundedStarted = performance.now();
    expect((await withManagedReleaseStoreCoordinator(home, async () => "no", { waitMs: 50 })).kind).toBe("busy");
    const boundedElapsed = performance.now() - boundedStarted;
    expect(boundedElapsed).toBeGreaterThanOrEqual(40);
    expect(boundedElapsed).toBeLessThan(250);
    child.kill("SIGKILL");
    expect(await child.exited).not.toBe(0);
    expect(await withManagedReleaseStoreCoordinator(home, async () => "recovered", { waitMs: 1_000 }))
      .toEqual({ kind: "owned", value: "recovered" });
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("callback failure expires its opaque token and releases ownership", async () => {
  const { root, home } = await homeFixture("dome-release-coordinator-throw-");
  let expired!: ManagedReleaseStoreOwner;
  try {
    await expect(withManagedReleaseStoreCoordinator(home, async (owner) => {
      expired = owner;
      throw new Error("callback failed");
    }, { waitMs: 0 })).rejects.toThrow("callback failed");
    expect(() => assertManagedReleaseStoreOwner(expired, home)).toThrow("expired");
    expect(() => assertManagedReleaseStoreOwner({} as ManagedReleaseStoreOwner, home)).toThrow("absent");
    expect(await withManagedReleaseStoreCoordinator(home, async () => "released", { waitMs: 0 }))
      .toEqual({ kind: "owned", value: "released" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("callback failure still attempts every before-release identity proof", async () => {
  const { root, home } = await homeFixture("dome-release-coordinator-throw-reproof-");
  const paths = managedReleaseStoreCoordinatorPaths(home);
  let failure: unknown;
  try {
    try {
      await withManagedReleaseStoreCoordinator(home, async () => {
        await rename(home, `${home}.displaced`);
        await mkdir(home);
        await rename(paths.directory, `${paths.directory}.displaced`);
        await mkdir(paths.directory, { mode: 0o700 });
        throw new Error("callback failed after replacement");
      }, { waitMs: 0 });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    const messages = (failure as AggregateError).errors.map((error) => String(error));
    expect(messages).toHaveLength(4);
    expect(messages[0]).toContain("callback failed after replacement");
    expect(messages[1]).toContain("managed Home root is not a stable direct owned directory");
    expect(messages[2]).toContain("coordinator directory is not stable");
    expect(messages[3]).toContain("ENOENT");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("owner proof is bound to the exact canonical Home root", async () => {
  const first = await homeFixture("dome-release-coordinator-root-a-");
  const secondHome = join(first.root, "Other Home");
  await mkdir(secondHome);
  try {
    await withManagedReleaseStoreCoordinator(first.home, async (owner) => {
      expect(() => assertManagedReleaseStoreOwner(owner, first.home)).not.toThrow();
      expect(() => assertManagedReleaseStoreOwner(owner, secondHome)).toThrow("another Home root");
      return undefined;
    }, { waitMs: 0 });
    const alias = join(first.root, "Home alias");
    await symlink(first.home, alias, "dir");
    await expect(withManagedReleaseStoreCoordinator(alias, async () => undefined, { waitMs: 0 })).rejects.toThrow();
    await expect(withManagedReleaseStoreCoordinator(`${first.home}/../Home`, async () => undefined, { waitMs: 0 }))
      .rejects.toThrow("absolute, normalized, canonical");
  } finally { await rm(first.root, { recursive: true, force: true }); }
});

test("linked, malformed, and non-private coordinator evidence fails closed without repair", async () => {
  for (const damage of ["database-link", "database-hardlink", "directory-link", "malformed", "mode"] as const) {
    const { root, home } = await homeFixture("dome-release-coordinator-damage-");
    const paths = managedReleaseStoreCoordinatorPaths(home);
    try {
      if (damage === "directory-link") {
        const target = join(root, "foreign");
        await mkdir(target, { mode: 0o700 });
        await symlink(target, paths.directory, "dir");
      } else if (damage === "database-hardlink") {
        await withManagedReleaseStoreCoordinator(home, async () => undefined, { waitMs: 0 });
        await link(paths.database, join(root, "coordinator-hardlink.db"));
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

test("coordinator inode replacement is detected before release", async () => {
  const { root, home } = await homeFixture("dome-release-coordinator-inode-");
  const paths = managedReleaseStoreCoordinatorPaths(home);
  try {
    await withManagedReleaseStoreCoordinator(home, async () => undefined, { waitMs: 0 });
    await expect(withManagedReleaseStoreCoordinator(home, async () => {
      const displaced = `${paths.database}.displaced`;
      await rename(paths.database, displaced);
      await copyFile(displaced, paths.database);
      await chmod(paths.database, 0o600);
    }, { waitMs: 0 })).rejects.toThrow("stable private direct owned file");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("production imports, exports, and mentions remain on exact reviewed ownership seams", async () => {
  const sourceRoot = resolve(import.meta.dir, "../../src");
  const expected = new Map<string, string[]>([
    ["withManagedReleaseStoreCoordinator", [
      "product-host/home-installation.ts",
      "product-host/home-upgrade-history.ts",
      "product-host/home-upgrade-transaction.ts",
      "product-host/managed-release-gc.ts",
      "product-host/managed-release-store-coordinator.ts",
    ]],
    ["assertManagedReleaseStoreOwner", [
      "product-host/home-installation.ts",
      "product-host/managed-release-store-coordinator.ts",
    ]],
    ["ManagedReleaseStoreOwner", [
      "product-host/home-installation.ts",
      "product-host/home-upgrade-transaction.ts",
      "product-host/managed-release-store-coordinator.ts",
    ]],
    ["withManagedReleaseArtifactRank", [
      "product-host/home-installation.ts",
      "product-host/managed-release-store-coordinator.ts",
    ]],
    ["ensureManagedReleaseOwned", [
      "product-host/home-installation.ts",
      "product-host/home-upgrade-transaction.ts",
    ]],
    ["repairManagedReleaseOwned", [
      "product-host/home-installation.ts",
      "product-host/home-upgrade-transaction.ts",
    ]],
    ["ensureManagedRelease", ["product-host/home-installation.ts"]],
    ["repairManagedRelease", ["product-host/home-installation.ts"]],
    ["prepareHomeUpgradeCandidate", [
      "product-host/home-upgrade-cutover.ts",
      "product-host/home-upgrade-transaction.ts",
    ]],
    ["prepareHomeUpgrade", ["product-host/home-upgrade-transaction.ts"]],
    ["retireHomeUpgrade", [
      "product-host/home-upgrade-history.ts",
      "product-host/home-upgrade.ts",
    ]],
    ["collectManagedReleaseGarbage", ["product-host/managed-release-gc.ts"]],
    ["manageHomeReleaseCleanup", [
      "cli/commands/home-cleanup.ts",
      "product-host/managed-release-gc.ts",
    ]],
    ["homeInstallationRoot", [
      "product-host/home-installation.ts",
      "product-host/managed-release-gc.ts",
    ]],
    ["publishHomeInstallation", ["product-host/home-installation.ts"]],
    ["publishManagedHomeInstallation", [
      "product-host/home-installation.ts",
      "product-host/home-lifecycle.ts",
    ]],
  ]);
  const inventory = new Map([...expected.keys()].map((symbol) => [symbol, [] as string[]]));
  for (const path of await sourceFiles(sourceRoot)) {
    const source = await readFile(path, "utf8");
    for (const [symbol, modules] of inventory) {
      if (new RegExp(`\\b${symbol}\\b`).test(source)) modules.push(relative(sourceRoot, path));
    }
  }
  expect(Object.fromEntries(inventory)).toEqual(Object.fromEntries(expected));
});

async function homeFixture(prefix: string): Promise<{ readonly root: string; readonly home: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const home = join(root, "Home");
  await mkdir(home);
  return { root, home };
}

async function present(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function sourceFiles(root: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...await sourceFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) paths.push(path);
  }
  return paths.sort();
}
