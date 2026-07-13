import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireOperationalWriterLease,
  inspectOperationalWriterBarrier,
} from "../../src/operational-state/writer-barrier";
import { homeInstallationPaths } from "../../src/product-host/home-installation";
import {
  engageHomeUpgradeBarrier,
  readHomeUpgradeBarrier,
  releaseHomeUpgradeBarrier,
  withHomeUpgradeBarrierOwnership,
} from "../../src/product-host/home-upgrade-barrier";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Home upgrade writer barrier", () => {
  test("invalid external layout refuses before vault admission is closed", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dome-home-barrier-preflight-")));
    roots.push(root);
    const vault = join(root, "vault");
    await mkdir(join(vault, ".dome", "state"), { recursive: true });
    const deps = { applicationSupportDir: join(root, "missing", "Dome", "Home") };
    await expect(engageHomeUpgradeBarrier({
      vaultPath: vault,
      transactionId: "preflight",
    }, deps)).rejects.toThrow("must be installed");
    const admitted = await acquireOperationalWriterLease({ vaultPath: vault, command: "after-preflight" });
    expect(admitted.ok).toBeTrue();
    if (admitted.ok) admitted.lease.close();
  });

  test("persists external ownership and clears coordinator last after terminal validation", async () => {
    const f = await fixture();
    const marker = await engageHomeUpgradeBarrier({
      vaultPath: f.vault,
      transactionId: "upgrade-1",
      now: new Date("2026-07-13T00:00:00.000Z"),
    }, f.deps);
    expect(marker.transactionId).toBe("upgrade-1");
    expect((await readHomeUpgradeBarrier(f.vault, f.deps))?.engagedAt).toBe(marker.engagedAt);

    const denied = await acquireOperationalWriterLease({ vaultPath: f.vault, command: "test" });
    expect(denied.ok).toBeFalse();
    await expect(releaseHomeUpgradeBarrier({
      vaultPath: f.vault,
      transactionId: "wrong-owner",
      validateTerminal: async () => {},
    }, f.deps)).rejects.toThrow("owned");

    let terminal = false;
    await expect(releaseHomeUpgradeBarrier({
      vaultPath: f.vault,
      transactionId: "upgrade-1",
      validateTerminal: async () => {
        if (!terminal) throw new Error("not terminal");
      },
    }, f.deps)).rejects.toThrow("not terminal");
    expect((await inspectOperationalWriterBarrier(f.vault)).blocked).toBeTrue();

    terminal = true;
    await releaseHomeUpgradeBarrier({
      vaultPath: f.vault,
      transactionId: "upgrade-1",
      validateTerminal: async () => {
        if (!terminal) throw new Error("not terminal");
      },
    }, f.deps);
    expect(await readHomeUpgradeBarrier(f.vault, f.deps)).toBeNull();
    expect((await inspectOperationalWriterBarrier(f.vault)).blocked).toBeFalse();
    const admitted = await acquireOperationalWriterLease({ vaultPath: f.vault, command: "test" });
    expect(admitted.ok).toBeTrue();
    if (admitted.ok) admitted.lease.close();
  });

  test("strict marker parsing rejects unknown fields and non-private mode", async () => {
    const f = await fixture();
    await engageHomeUpgradeBarrier({ vaultPath: f.vault, transactionId: "upgrade-2" }, f.deps);
    const path = join(homeInstallationPaths(f.vault, f.deps).installations, "upgrade", "writer-barrier.json");
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({ ...parsed, surprise: true })}\n`, { mode: 0o600 });
    await expect(readHomeUpgradeBarrier(f.vault, f.deps)).rejects.toThrow("unknown or missing");
    delete parsed["surprise"];
    await writeFile(path, `${JSON.stringify(parsed)}\n`);
    await chmod(path, 0o644);
    await expect(readHomeUpgradeBarrier(f.vault, f.deps)).rejects.toThrow("bounded regular file");
  });

  test("SQLite ownership serializes same-transaction recovery connections", async () => {
    const f = await fixture();
    await engageHomeUpgradeBarrier({
      vaultPath: f.vault,
      transactionId: "serialized-recovery",
    }, f.deps);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = withHomeUpgradeBarrierOwnership({
      vaultPath: f.vault,
      transactionId: "serialized-recovery",
    }, f.deps, async () => {
      entered();
      await gate;
      return "holder";
    });
    await started;

    let secondEntered = false;
    const second = withHomeUpgradeBarrierOwnership({
      vaultPath: f.vault,
      transactionId: "serialized-recovery",
    }, f.deps, async () => {
      secondEntered = true;
      return "second";
    });
    await Bun.sleep(50);
    expect(secondEntered).toBeFalse();
    release();
    expect(await holder).toEqual({ kind: "owned", value: "holder" });
    expect(await second).toEqual({ kind: "owned", value: "second" });
  });
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dome-home-barrier-")));
  roots.push(root);
  const vault = join(root, "vault");
  await mkdir(join(vault, ".dome", "state"), { recursive: true });
  const deps = { applicationSupportDir: join(root, "Application Support", "Dome", "Home") };
  const paths = homeInstallationPaths(vault, deps);
  await mkdir(paths.installations, { recursive: true, mode: 0o700 });
  return { root, vault, deps };
}
