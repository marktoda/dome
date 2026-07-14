import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

import {
  homeServiceLabelForVault,
  isHomePairingReadiness,
  manageHome,
  type HomeLifecycleDeps,
} from "../../src/product-host/home-lifecycle";
import {
  homeLifecycleCoordinatorPath,
  inspectHomeLifecycleSuspension,
  withHomeLifecycleMutation,
  withSupervisedHomeSuspended,
} from "../../src/product-host/home-lifecycle-suspension";
import { serviceLabelForVault, type LaunchctlRunner } from "../../src/surface/service-probe";
import { add, commit, initRepo } from "../../src/git";
import type { HomeArtifactManifest } from "../../src/product-host/home-artifact";
import { engageHomeUpgradeBarrier } from "../../src/product-host/home-upgrade-barrier";
import {
  engageOperationalWriterBarrier,
  releaseOperationalWriterBarrier,
} from "../../src/operational-state/writer-barrier";
import { startProductHost, type ProductHost } from "../../src/product-host/product-host";
import {
  ensureManagedRelease,
  homeInstallationPaths,
  publishHomeInstallation,
  releaseRoot,
  syncDirectory,
} from "../../src/product-host/home-installation";
import { collectManagedReleaseGarbage } from "../../src/product-host/managed-release-gc";
import { withManagedReleaseStoreCoordinator } from "../../src/product-host/managed-release-store-coordinator";

const roots: string[] = [];
const hosts: ProductHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Fake = {
  readonly calls: string[][];
  readonly loaded: Set<string>;
  readonly runner: LaunchctlRunner;
};

function fakeLaunchctl(fail: "bootstrap" | "kickstart" | "bootout" | "drain" | null = null): Fake {
  const calls: string[][] = [];
  const loaded = new Set<string>();
  const runner: LaunchctlRunner = async (args) => {
    calls.push([...args]);
    const verb = args[0];
    const target = args.at(-1) ?? "";
    if (verb === "print") return outcome(loaded.has(target) ? 0 : 113);
    if (verb === "bootout") {
      if (fail === "bootout") return outcome(5, "bootout failed");
      if (fail !== "drain") loaded.delete(target);
      return outcome(0);
    }
    if (verb === "bootstrap" && fail === "bootstrap") return outcome(5, "bootstrap failed");
    if (verb === "bootstrap") {
      const label = basename(args[2] ?? "").replace(/\.plist$/, "");
      loaded.add(`${args[1]}/${label}`);
    }
    if (verb === "kickstart" && fail === "kickstart") return outcome(5, "kickstart failed");
    if (verb === "kickstart") loaded.add(target);
    return outcome(0);
  };
  return { calls, loaded, runner };
}

function outcome(exitCode: number, stderr = "") {
  return { exitCode, stdout: "", stderr };
}

async function fixture(): Promise<{
  readonly vault: string;
  readonly artifact: string;
  readonly agents: string;
  readonly support: string;
  readonly runtime: string;
  readonly program: string;
  readonly pwa: string;
}> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dome-home-lifecycle-")));
  roots.push(root);
  const vault = join(root, "Owner Vault");
  await initRepo(vault);
  await mkdir(join(vault, ".dome", "state"), { recursive: true });
  await writeFile(join(vault, ".dome", "config.yaml"), "extensions: {}\n");
  const artifact = join(root, "Dome Artifact");
  const runtime = join(artifact, "runtime", "bun");
  const program = join(artifact, "app", "bin", "dome");
  const pwa = join(artifact, "app", "pwa", "dist");
  await mkdir(join(artifact, "runtime"), { recursive: true });
  await mkdir(join(artifact, "app", "bin"), { recursive: true });
  await mkdir(pwa, { recursive: true });
  await writeFile(runtime, "runtime bytes");
  await writeFile(program, "program bytes");
  await chmod(runtime, 0o755);
  await chmod(program, 0o755);
  await writeFile(join(pwa, "index.html"), "Dome Home");
  return { vault, artifact, agents: join(root, "Launch Agents"), support: join(root, "Application Support", "Dome", "Home"), runtime, program, pwa };
}

const ARTIFACT_ID = "a".repeat(64);
async function verifyFixtureArtifact(root: string): Promise<HomeArtifactManifest> {
  for (const path of [join(root, "runtime", "bun"), join(root, "app", "bin", "dome"), join(root, "app", "pwa", "dist", "index.html")]) {
    try { if (!(await lstat(path)).isFile()) throw new Error(); }
    catch { throw new Error(`Dome artifact payload is missing at ${path}`); }
  }
  if (await readFile(join(root, "runtime", "bun"), "utf8") !== "runtime bytes" ||
    await readFile(join(root, "app", "bin", "dome"), "utf8") !== "program bytes") {
    throw new Error("Dome artifact payload checksum mismatch");
  }
  return { artifact: { id: ARTIFACT_ID }, product: { name: "Dome Home", version: "1.0.0" } } as HomeArtifactManifest;
}

function deps(f: Awaited<ReturnType<typeof fixture>>, fake: Fake, extra: Partial<HomeLifecycleDeps> = {}): HomeLifecycleDeps {
  return {
    platform: "darwin",
    uid: 501,
    launchAgentsDir: f.agents,
    launchctl: fake.runner,
    artifactRoot: f.artifact,
    applicationSupportDir: f.support,
    verifyArtifact: verifyFixtureArtifact,
    publishRelease: rename,
    syncRelease: async () => {},
    readiness: async () => fake.loaded.has(`gui/501/${homeServiceLabelForVault(f.vault)}`),
    readinessTimeoutMs: 20,
    drainTimeoutMs: 20,
    ...extra,
  };
}

describe("manageHome macOS lifecycle", () => {
  test("ordinary install holds global ownership through durable selector publication", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    let reportRecord!: () => void;
    let releaseRecord!: () => void;
    const recordEntered = new Promise<void>((resolve) => { reportRecord = resolve; });
    const recordGate = new Promise<void>((resolve) => { releaseRecord = resolve; });
    const d = deps(f, fake, {
      publishRecord: async (path, record) => {
        reportRecord();
        await recordGate;
        await publishHomeInstallation(path, record);
      },
    });
    const installing = manageHome({ action: "install", vaultPath: f.vault }, d);
    await recordEntered;

    await expect(collectManagedReleaseGarbage({ homeRoot: f.support, mode: "inspect" }, {
      verifyRelease: async (root) => ({
        artifactId: basename(root), version: "1.0.0", manifestSha256: "f".repeat(64),
      }),
      readActiveProtection: async () => null,
    })).rejects.toThrow("coordinator is busy");

    const manifest = await verifyFixtureArtifact(f.artifact);
    let writerSettled = false;
    const writer = ensureManagedRelease({
      source: f.artifact,
      manifest,
      paths: homeInstallationPaths(f.vault, d),
      platform: "darwin",
    }, d).finally(() => { writerSettled = true; });
    await Bun.sleep(50);
    expect(writerSettled).toBeFalse();

    releaseRecord();
    expect((await installing).status).toBe("installed");
    expect(await writer).toMatchObject({ published: false });
    expect(writerSettled).toBeTrue();
  });

  test("same-artifact reinstall keeps the selector in the global ownership span", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const initialDeps = deps(f, fake);
    expect((await manageHome({ action: "install", vaultPath: f.vault }, initialDeps)).status).toBe("installed");
    let reportRecord!: () => void;
    let releaseRecord!: () => void;
    const recordEntered = new Promise<void>((resolve) => { reportRecord = resolve; });
    const recordGate = new Promise<void>((resolve) => { releaseRecord = resolve; });
    const reinstalling = manageHome({ action: "install", vaultPath: f.vault }, deps(f, fake, {
      publishRecord: async (path, record) => {
        reportRecord();
        await recordGate;
        await publishHomeInstallation(path, record);
      },
    }));
    await recordEntered;
    expect((await withManagedReleaseStoreCoordinator(f.support, async () => "collector", { waitMs: 0 })).kind)
      .toBe("busy");
    releaseRecord();
    const result = await reinstalling;
    expect(result.status).toBe("installed");
    expect(result.releasePublished).toBeFalse();
  });

  test("ordinary install releases global ownership before plist and readiness", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const observations: string[] = [];
    const result = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, fake, {
      publishPlist: async (path, contents) => {
        const ownership = await withManagedReleaseStoreCoordinator(f.support, async () => "plist", { waitMs: 0 });
        expect(ownership).toEqual({ kind: "owned", value: "plist" });
        observations.push("plist");
        await writeFile(path, contents);
      },
      readiness: async () => {
        if (!existsSync(f.support)) return false;
        const ownership = await withManagedReleaseStoreCoordinator(f.support, async () => "readiness", { waitMs: 0 });
        expect(ownership).toEqual({ kind: "owned", value: "readiness" });
        observations.push("readiness");
        return fake.loaded.has(`gui/501/${homeServiceLabelForVault(f.vault)}`);
      },
    }));
    expect(result.status).toBe("installed");
    expect(observations).toEqual(["plist", "readiness"]);
  });

  test("fresh install durably establishes every ancestor before publishing its dependent entry", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const base = dirname(dirname(dirname(f.support)));
    const paths = homeInstallationPaths(f.vault, { applicationSupportDir: f.support });
    const events: string[] = [];
    const result = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, fake, {
      directoryDurabilityCheckpoint: async (step) => {
        events.push(`${step.kind}:${relative(base, step.subject)}->${relative(base, step.path)}`);
      },
      publishRelease: async (source, target) => {
        events.push("release-published");
        await rename(source, target);
      },
      syncReleaseParent: async (path) => {
        events.push("release-parent-durable");
        await syncDirectory(path);
      },
      publishRecord: async (path, record) => {
        await publishHomeInstallation(path, record);
        events.push("record-durable");
      },
      publishPlist: async (path, contents) => {
        events.push("plist-published");
        await writeFile(path, contents);
      },
    }));
    expect(result.status).toBe("installed");
    const requiredOrder = [
      "directory:Application Support->Application Support",
      "parent-entry:Application Support->",
      "directory:Application Support/Dome->Application Support/Dome",
      "parent-entry:Application Support/Dome->Application Support",
      "directory:Application Support/Dome/Home->Application Support/Dome/Home",
      "parent-entry:Application Support/Dome/Home->Application Support/Dome",
      "directory:Application Support/Dome/Home/releases->Application Support/Dome/Home/releases",
      "parent-entry:Application Support/Dome/Home/releases->Application Support/Dome/Home",
      "release-published",
      "release-parent-durable",
      "directory:Application Support/Dome/Home/installations->Application Support/Dome/Home/installations",
      "parent-entry:Application Support/Dome/Home/installations->Application Support/Dome/Home",
      `directory:${relative(base, paths.installations)}->${relative(base, paths.installations)}`,
      `parent-entry:${relative(base, paths.installations)}->Application Support/Dome/Home/installations`,
      "record-durable",
      "plist-published",
    ];
    let cursor = -1;
    for (const marker of requiredOrder) {
      const index = events.indexOf(marker, cursor + 1);
      expect(index).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  test("fresh install stops at every failed directory or parent-entry fsync", async () => {
    for (const failed of [
      "application support", "Dome", "Home", "releases", "installations", "vault selector",
    ] as const) {
      for (const kind of ["directory", "parent-entry"] as const) {
        const f = await fixture();
        const fake = fakeLaunchctl();
        const paths = homeInstallationPaths(f.vault, { applicationSupportDir: f.support });
        const subject = failed === "application support" ? dirname(dirname(paths.root))
          : failed === "Dome" ? dirname(paths.root)
          : failed === "Home" ? paths.root
          : failed === "releases" ? paths.releases
          : failed === "installations" ? dirname(paths.installations)
          : paths.installations;
        const hits = { directory: 0, "parent-entry": 0 };
        const d = deps(f, fake, {
          directoryDurabilityCheckpoint: async (step) => {
            if (step.subject !== subject) return;
            hits[step.kind] += 1;
            if (step.kind === kind && hits[step.kind] === 1) {
              throw new Error(`${failed} ${kind} durability failed`);
            }
          },
        });
        const result = await manageHome({ action: "install", vaultPath: f.vault }, d);
        expect(result.status).toBe("error");
        expect(result.error).toContain(`${failed} ${kind} durability failed`);
        expect(existsSync(paths.record)).toBeFalse();
        expect(existsSync(result.plist)).toBeFalse();
        expect(fake.calls.some((call) => call[0] === "bootstrap")).toBeFalse();
        expect(existsSync(releaseRoot(paths, ARTIFACT_ID))).toBe(
          failed === "installations" || failed === "vault selector",
        );
        const retry = await manageHome({ action: "install", vaultPath: f.vault }, d);
        expect(retry.status).toBe("installed");
        expect(existsSync(paths.record)).toBeTrue();
        expect(existsSync(retry.plist)).toBeTrue();
        expect(hits.directory).toBeGreaterThanOrEqual(2);
        expect(hits["parent-entry"]).toBeGreaterThanOrEqual(kind === "parent-entry" ? 2 : 1);
      }
    }
  });

  test("selector publication failure retains exact release-publication truth", async () => {
    const f = await fixture();
    const result = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, fakeLaunchctl(), {
      publishRecord: async () => { throw new Error("selector durability failed"); },
    }));
    expect(result.status).toBe("error");
    expect(result.error).toContain("selector durability failed");
    expect(result.releasePublished).toBeTrue();
    expect(existsSync(result.release!)).toBeTrue();
    expect(existsSync(result.installation)).toBeFalse();
  });

  test("readiness accepts only a 200 recognized pairing document", async () => {
    expect(await isHomePairingReadiness(Response.json({
      schema: "dome.device.pairing/v1",
      available: true,
      paired: false,
    }))).toBe(true);
    expect(await isHomePairingReadiness(Response.json({
      schema: "dome.device.pairing/v1",
      available: true,
      paired: true,
    }))).toBe(true);
    expect(await isHomePairingReadiness(Response.json({ schema: "dome.pairing/v1", available: true, paired: false }))).toBe(false);
    expect(await isHomePairingReadiness(Response.json({ schema: "dome.device.pairing/v1", available: false, paired: false }))).toBe(false);
    expect(await isHomePairingReadiness(Response.json({ schema: "wrong" }))).toBe(false);
    expect(await isHomePairingReadiness(new Response("no", { status: 503 }))).toBe(false);
  });
  test("installs exact pinned paths, fixed listener args, escaped env, and becomes ready", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const result = await manageHome({
      action: "install",
      vaultPath: f.vault,
      environment: new Map([["HOME_LABEL", "a&<b>"], ["SPACE_VALUE", "two words"], ["PATH", "/evil"]]),
    }, deps(f, fake));
    expect(result.status).toBe("installed");
    expect(result.ready).toBe(true);
    expect(result.label).toBe(homeServiceLabelForVault(f.vault));
    const plist = await readFile(result.plist, "utf8");
    for (const value of [
      join(result.release!, "runtime", "bun"), result.program, "home", "--vault", f.vault, "--host", "127.0.0.1",
      "--port", "3663", "--static-dir", join(result.release!, "app", "pwa", "dist"),
    ]) expect(plist).toContain(`<string>${value}</string>`);
    expect(plist).toContain("a&amp;&lt;b&gt;");
    expect(plist).toContain("two words");
    expect(plist).not.toContain("<string>/evil</string>");
    expect(plist).toContain(`<string>${join(result.release!, "runtime")}:/usr/local/bin:`);
    expect(plist).toContain(join(f.vault, ".dome", "state", "home.log"));
    expect(fake.calls.some((call) => call[0] === "bootstrap")).toBe(true);
    expect(fake.calls.some((call) => call[0] === "kickstart")).toBe(true);
  });

  test("idempotent install replaces while restart preserves plist bytes", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const d = deps(f, fake);
    expect((await manageHome({ action: "install", vaultPath: f.vault }, d)).status).toBe("installed");
    const second = await manageHome({ action: "install", vaultPath: f.vault }, d);
    expect(second.status).toBe("installed");
    expect(second.replaced).toBe(true);
    const before = await readFile(second.plist, "utf8");
    expect((await manageHome({ action: "restart", vaultPath: f.vault }, d)).status).toBe("restarted");
    expect(await readFile(second.plist, "utf8")).toBe(before);
  });

  test("prepared upgrade denies lifecycle mutations while status remains available", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const d = deps(f, fake);
    const installed = await manageHome({ action: "install", vaultPath: f.vault }, d);
    expect(installed.status).toBe("installed");
    const plistBefore = await readFile(installed.plist);
    const selectorBefore = await readFile(installed.installation);
    const loadedBefore = new Set(fake.loaded);
    await engageHomeUpgradeBarrier({
      vaultPath: f.vault,
      transactionId: "lifecycle-prepared",
    }, { applicationSupportDir: f.support });
    fake.calls.splice(0);

    for (const action of ["install", "start", "restart", "uninstall"] as const) {
      const denied = await manageHome({ action, vaultPath: f.vault }, d);
      expect(denied.status).toBe("error");
      expect(denied.error).toContain("write-admission-closed");
    }
    expect(fake.calls.filter((call) =>
      call[0] === "bootout" || call[0] === "bootstrap" || call[0] === "kickstart"
    )).toEqual([]);
    expect(await readFile(installed.plist)).toEqual(plistBefore);
    expect(await readFile(installed.installation)).toEqual(selectorBefore);
    expect(fake.loaded).toEqual(loadedBefore);

    const status = await manageHome({ action: "status", vaultPath: f.vault }, d);
    expect(status.status).toBe("ready");
  });

  test("publishes a closed record selecting one immutable content-addressed release", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const installed = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, fake));
    expect(installed.release).toBe(join(f.support, "releases", ARTIFACT_ID));
    expect(installed.program).toBe(join(installed.release!, "app", "bin", "dome"));
    expect(installed.releasePublished).toBe(true);
    const record = JSON.parse(await readFile(installed.installation, "utf8")) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(["artifact", "environment", "schema", "vault"]);
    expect(record).toEqual({
      schema: "dome.home.installation/v1",
      vault: f.vault,
      artifact: { id: ARTIFACT_ID, version: "1.0.0" },
      environment: [],
    });
    const second = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, fake));
    expect(second.releasePublished).toBe(false);
  });

  test("canonical vault aliases share one selector and service identity", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const alias = join(dirname(f.vault), "Vault Alias");
    await symlink(f.vault, alias);
    const installed = await manageHome({ action: "install", vaultPath: alias }, deps(f, fake));
    expect(installed.vault).toBe(f.vault);
    const status = await manageHome({ action: "status", vaultPath: f.vault }, deps(f, fake));
    expect(status.installation).toBe(installed.installation);
    expect(status.label).toBe(installed.label);
    expect(status.status).toBe("ready");
  });

  test("refuses a symlinked managed Home root before release publication", async () => {
    const f = await fixture();
    const attacker = join(dirname(f.support), "attacker-owned");
    await mkdir(dirname(f.support), { recursive: true });
    await mkdir(attacker);
    await symlink(attacker, f.support);
    const result = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, fakeLaunchctl()));
    expect(result.status).toBe("error");
    expect(result.error).toContain("not a direct owned directory");
    expect(existsSync(join(attacker, "releases"))).toBe(false);
  });

  test("refuses artifact changes outside upgrade and never replaces a corrupt immutable release", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const d = deps(f, fake);
    const installed = await manageHome({ action: "install", vaultPath: f.vault }, d);
    const different = await manageHome({ action: "install", vaultPath: f.vault }, {
      ...d,
      verifyArtifact: async () => ({ artifact: { id: "b".repeat(64) }, product: { name: "Dome Home", version: "2.0.0" } } as HomeArtifactManifest),
    });
    expect(different.status).toBe("error");
    expect(different.exitCode).toBe(64);
    expect(different.error).toContain("dome home upgrade");
    await writeFile(installed.program, "corrupt immutable bytes");
    const corrupt = await manageHome({ action: "install", vaultPath: f.vault }, d);
    expect(corrupt.status).toBe("error");
    expect(corrupt.error).toContain("immutable managed release is corrupt");
    expect(await readFile(installed.program, "utf8")).toBe("corrupt immutable bytes");
  });

  test("refuses one-time adoption of an unmanaged pre-record Home service", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    await mkdir(f.agents, { recursive: true });
    const plist = join(f.agents, `${homeServiceLabelForVault(f.vault)}.plist`);
    await writeFile(plist, "legacy direct-artifact Home plist\n");
    const result = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, fake));
    expect(result.status).toBe("orphaned-service");
    expect(result.exitCode).toBe(64);
    expect(result.error).toContain("dome home uninstall");
    expect(await readFile(plist, "utf8")).toBe("legacy direct-artifact Home plist\n");
    expect(fake.calls.some((call) => call[0] === "bootstrap")).toBe(false);
  });

  test("status distinguishes missing release and plist mismatch from stopped", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const d = deps(f, fake);
    const installed = await manageHome({ action: "install", vaultPath: f.vault }, d);
    await writeFile(installed.plist, "wrong artifact\n");
    const mismatch = await manageHome({ action: "status", vaultPath: f.vault }, d);
    expect(mismatch.status).toBe("plist-mismatch");
    expect(mismatch.artifactId).toBe(ARTIFACT_ID);
    await rm(installed.release!, { recursive: true, force: true });
    const missing = await manageHome({ action: "status", vaultPath: f.vault }, d);
    expect(missing.status).toBe("missing-release");
    expect(missing.release).toBe(installed.release);
  });

  test("status rejects an installation record with unknown selector fields", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const d = deps(f, fake);
    const installed = await manageHome({ action: "install", vaultPath: f.vault }, d);
    const record = JSON.parse(await readFile(installed.installation, "utf8")) as Record<string, unknown>;
    record["current"] = "mutable";
    await writeFile(installed.installation, `${JSON.stringify(record)}\n`);
    const status = await manageHome({ action: "status", vaultPath: f.vault }, d);
    expect(status.status).toBe("invalid-installation");
    expect(status.error).toContain("unknown or missing fields");
    expect(status.installed).toBe(true);
  });

  test("same-artifact repair preserves stored environment and uninstall preserves selector and release", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const d = deps(f, fake);
    const installed = await manageHome({ action: "install", vaultPath: f.vault, environment: new Map([["DOME_SETTING", "kept"]]) }, d);
    const repaired = await manageHome({ action: "install", vaultPath: f.vault }, d);
    expect(await readFile(repaired.plist, "utf8")).toContain("DOME_SETTING");
    expect(await readFile(repaired.plist, "utf8")).toContain("kept");
    const recordBefore = await readFile(repaired.installation, "utf8");
    const programBefore = await readFile(repaired.program, "utf8");
    expect((await manageHome({ action: "uninstall", vaultPath: f.vault }, d)).status).toBe("uninstalled");
    expect(await readFile(repaired.installation, "utf8")).toBe(recordBefore);
    expect(await readFile(repaired.program, "utf8")).toBe(programBefore);
    const status = await manageHome({ action: "status", vaultPath: f.vault }, d);
    expect(status.status).toBe("not-installed");
    expect(status.installed).toBe(false);
    expect(status.artifactId).toBe(ARTIFACT_ID);
    expect(installed.release).toBe(repaired.release);
  });

  test("legacy secret-bearing reinstall is migration-required before selector or launchctl mutation", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const d = deps(f, fake);
    const installed = await manageHome({ action: "install", vaultPath: f.vault }, d);
    const record = JSON.parse(await readFile(installed.installation, "utf8")) as {
      environment: Array<{ name: string; value: string }>;
    };
    record.environment = [{ name: "ANTHROPIC_API_KEY", value: "legacy-secret" }];
    await writeFile(installed.installation, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    const beforePlist = await readFile(installed.plist, "utf8");
    const coordinator = homeLifecycleCoordinatorPath(f.vault);
    const coordinatorBefore = await readFile(coordinator);
    const ownershipBefore = await readFile(join(dirname(coordinator), "home-lifecycle-suspension-ownership.db"));
    const callsBefore = fake.calls.length;
    let operationalAdmissions = 0;
    const refused = await manageHome({ action: "install", vaultPath: f.vault }, {
      ...d,
      beforeOperationalAdmission: async () => { operationalAdmissions += 1; },
    });
    expect(refused).toMatchObject({ status: "credential-migration-required", exitCode: 64 });
    expect(await readFile(installed.plist, "utf8")).toBe(beforePlist);
    expect(await readFile(coordinator)).toEqual(coordinatorBefore);
    expect(await readFile(join(dirname(coordinator), "home-lifecycle-suspension-ownership.db")))
      .toEqual(ownershipBefore);
    expect(operationalAdmissions).toBe(0);
    expect(fake.calls).toHaveLength(callsBefore);
  });

  test("explicit secret environment refuses before lifecycle, operational, or publication state exists", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    let operationalAdmissions = 0;
    const refused = await manageHome({
      action: "install",
      vaultPath: f.vault,
      environment: new Map([["SERVICE_TOKEN", "must-not-persist"]]),
    }, deps(f, fake, {
      beforeOperationalAdmission: async () => { operationalAdmissions += 1; },
    }));
    expect(refused).toMatchObject({ status: "credential-migration-required", exitCode: 64 });
    expect(existsSync(dirname(homeLifecycleCoordinatorPath(f.vault)))).toBeFalse();
    expect(existsSync(f.support)).toBeFalse();
    expect(existsSync(f.agents)).toBeFalse();
    expect(operationalAdmissions).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  test("status reports deleted-plist loaded edge and uninstall preserves every owned byte", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const d = deps(f, fake);
    const installed = await manageHome({ action: "install", vaultPath: f.vault }, d);
    const markdown = join(f.vault, "knowledge.md");
    const state = join(f.vault, ".dome", "state", "sentinel.db");
    const log = installed.log;
    await writeFile(markdown, "knowledge\n");
    await writeFile(state, "state\n");
    await writeFile(log, "log\n");
    await unlink(installed.plist);
    const status = await manageHome({ action: "status", vaultPath: f.vault }, d);
    expect(status.status).toBe("orphaned-service");
    expect(status.loaded).toBe(true);
    expect(status.exitCode).toBe(1);
    expect(status.artifactId).toBe(ARTIFACT_ID);
    expect((await manageHome({ action: "uninstall", vaultPath: f.vault }, d)).status).toBe("uninstalled");
    expect(await readFile(markdown, "utf8")).toBe("knowledge\n");
    expect(await readFile(state, "utf8")).toBe("state\n");
    expect(await readFile(log, "utf8")).toBe("log\n");
    expect(await readFile(f.runtime, "utf8")).toBe("runtime bytes");
    expect(await readFile(f.program, "utf8")).toBe("program bytes");
  });

  test("refuses an installed or live legacy serve service before mutation", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    await mkdir(f.agents, { recursive: true });
    await writeFile(join(f.agents, `${serviceLabelForVault(f.vault)}.plist`), "legacy");
    const result = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, fake));
    expect(result.status).toBe("error");
    expect(result.legacyServeConflict).toBe(true);
    expect(result.error).toContain("dome uninstall");
    expect(existsSync(result.plist)).toBe(false);
  });

  test("preflight and activation/readiness failures are truthful", async () => {
    const f = await fixture();
    const missing = join(f.artifact, "missing-artifact");
    let result = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, fakeLaunchctl(), { artifactRoot: missing }));
    expect(result.status).toBe("error");
    expect(result.error).toContain("artifact failed verification");

    const bootstrap = fakeLaunchctl("bootstrap");
    result = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, bootstrap));
    expect(result.status).toBe("error");
    expect(result.error).toContain("bootstrap");
    expect(result.loaded).toBe(false);
    expect(result.ready).toBeNull();
    expect(existsSync(result.plist)).toBe(true);

    const kickstart = fakeLaunchctl("kickstart");
    result = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, kickstart));
    expect(result.status).toBe("error");
    expect(result.error).toContain("kickstart");
    expect(result.loaded).toBe(true);
    expect(result.ready).toBe(true);

    const throwingKickstart = fakeLaunchctl();
    result = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, throwingKickstart, {
      launchctl: async (args) => {
        if (args[0] === "kickstart") throw new Error("kickstart transport broke");
        return throwingKickstart.runner(args);
      },
    }));
    expect(result).toMatchObject({
      status: "error",
      installed: true,
      loaded: true,
      ready: true,
      replaced: true,
      releasePublished: false,
    });
    expect(result.error).toContain("kickstart transport broke");

    const notReady = fakeLaunchctl();
    result = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, notReady, {
      readiness: async () => false,
      readinessTimeoutMs: 1,
    }));
    expect(result.status).toBe("error");
    expect(result.ready).toBe(false);
    expect(result.loaded).toBe(true);

    const readinessThrows = fakeLaunchctl();
    let readinessCalls = 0;
    result = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, readinessThrows, {
      readiness: async () => {
        readinessCalls += 1;
        if (readinessCalls === 1) return false;
        throw new Error("readiness transport broke");
      },
    }));
    expect(result.status).toBe("error");
    expect(result.installed).toBe(true);
    expect(result.loaded).toBe(true);
    expect(result.ready).toBeNull();
    expect(result.error).toContain("readiness transport broke");
  });

  test("preflight failure makes no launchctl call; absent start is usage", async () => {
    const f = await fixture();
    const missingFake = fakeLaunchctl();
    const missing = join(f.artifact, "gone");
    const failed = await manageHome(
      { action: "install", vaultPath: f.vault },
      deps(f, missingFake, { artifactRoot: missing }),
    );
    expect(failed.status).toBe("error");
    expect(missingFake.calls).toEqual([]);

    const absentFake = fakeLaunchctl();
    const absent = await manageHome(
      { action: "start", vaultPath: f.vault },
      deps(f, absentFake, { artifactRoot: missing }),
    );
    expect(absent.status).toBe("error");
    expect(absent.exitCode).toBe(64);
    expect(absent.error).toContain("dome home install");
  });

  test("status distinguishes loaded-unreachable and reports a corrupt selected release", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const d = deps(f, fake);
    const installed = await manageHome({ action: "install", vaultPath: f.vault }, d);
    const unreachable = await manageHome({ action: "status", vaultPath: f.vault }, {
      ...d,
      readiness: async () => false,
    });
    expect(unreachable.status).toBe("loaded-unreachable");
    expect(unreachable.installed).toBe(true);
    expect(unreachable.loaded).toBe(true);
    expect(unreachable.ready).toBe(false);

    const compatibility = await manageHome({ action: "status", vaultPath: f.vault }, {
      ...d,
      readiness: async () => isHomePairingReadiness(Response.json({
        schema: "dome.pairing/v1",
        available: true,
        paired: false,
      })),
    });
    expect(compatibility.status).toBe("loaded-unreachable");
    expect(compatibility.ready).toBe(false);

    await unlink(installed.program);
    const broken = await manageHome({ action: "status", vaultPath: f.vault }, d);
    expect(broken.status).toBe("corrupt-release");
    expect(broken.installed).toBe(true);
    expect(broken.loaded).toBe(true);
    expect(broken.program).toBe(installed.program);
    expect(existsSync(installed.plist)).toBe(true);
  });

  test("refuses foreground Home and injected running serve heartbeat", async () => {
    const f = await fixture();
    const foregroundFake = fakeLaunchctl();
    const foreground = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, foregroundFake, {
      readiness: async () => true,
    }));
    expect(foreground.status).toBe("error");
    expect(foreground.error).toContain("foreground host");
    expect(foregroundFake.calls.some((call) => call[0] === "bootstrap")).toBe(false);

    const heartbeatFake = fakeLaunchctl();
    const heartbeat = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, heartbeatFake, {
      legacyServeRunning: async () => true,
    }));
    expect(heartbeat.status).toBe("error");
    expect(heartbeat.legacyServeConflict).toBe(true);
    expect(heartbeatFake.calls.some((call) => call[0] === "bootstrap")).toBe(false);
  });

  test("drain timeout never unlinks or bootstraps an overlapping service", async () => {
    const f = await fixture();
    const initial = fakeLaunchctl();
    const installed = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, initial));
    const plistBefore = await readFile(installed.plist, "utf8");
    const stuck = fakeLaunchctl("drain");
    const target = `gui/501/${homeServiceLabelForVault(f.vault)}`;
    stuck.loaded.add(target);
    const d = deps(f, stuck, { drainTimeoutMs: 1 });
    const restart = await manageHome({ action: "restart", vaultPath: f.vault }, d);
    expect(restart.status).toBe("error");
    expect(restart.error).toContain("drain timeout");
    expect(stuck.calls.some((call) => call[0] === "bootstrap")).toBe(false);
    expect(await readFile(installed.plist, "utf8")).toBe(plistBefore);

    const uninstall = await manageHome({ action: "uninstall", vaultPath: f.vault }, d);
    expect(uninstall.status).toBe("error");
    expect(existsSync(installed.plist)).toBe(true);
  });

  test("uninitialized install is usage and never calls launchctl", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const notVault = join(f.artifact, "not-a-vault");
    await mkdir(notVault);
    const result = await manageHome({ action: "install", vaultPath: notVault }, deps(f, fake));
    expect(result.status).toBe("error");
    expect(result.exitCode).toBe(64);
    expect(result.error).toContain("dome init");
    expect(fake.calls).toEqual([]);
  });

  test("operational exceptions always become structured truth and preserve bytes", async () => {
    const f = await fixture();

    const publishFake = fakeLaunchctl();
    const publish = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, publishFake, {
      publishPlist: async () => { throw new Error("publish exploded"); },
    }));
    expect(publish.schema).toBe("dome.home.lifecycle/v1");
    expect(publish.status).toBe("error");
    expect(publish.error).toContain("publish exploded");
    expect(publish.loaded).toBe(false);
    expect(existsSync(publish.plist)).toBe(false);
    expect(publishFake.calls.some((call) => call[0] === "bootstrap")).toBe(false);

    const partialPublishFake = fakeLaunchctl();
    let publishedPlist = "";
    const partialPublish = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, partialPublishFake, {
      publishPlist: async (path, contents) => {
        publishedPlist = contents;
        await writeFile(path, contents);
        throw new Error("plist parent durability exploded");
      },
    }));
    expect(partialPublish.status).toBe("error");
    expect(partialPublish.error).toContain("plist parent durability exploded");
    expect(partialPublish.installed).toBe(true);
    expect(partialPublish.releasePublished).toBe(false);
    expect(await readFile(partialPublish.plist, "utf8")).toBe(publishedPlist);
    expect(partialPublishFake.calls.some((call) => call[0] === "bootstrap")).toBe(false);

    const readinessFake = fakeLaunchctl();
    let readinessProbes = 0;
    const readiness = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, readinessFake, {
      readiness: async () => {
        readinessProbes += 1;
        if (readinessProbes === 1) return false;
        throw new Error("readiness exploded");
      },
    }));
    expect(readiness.status).toBe("error");
    expect(readiness.error).toContain("readiness exploded");
    expect(readiness.loaded).toBe(true);
    expect(existsSync(readiness.plist)).toBe(true);

    const launchctl = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, fakeLaunchctl(), {
      launchctl: async () => { throw new Error("launchctl exploded"); },
    }));
    expect(launchctl.status).toBe("error");
    expect(launchctl.error).toContain("launchctl exploded");
    expect(launchctl.loaded).toBeNull();

    const installedFake = fakeLaunchctl();
    const installed = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, installedFake));
    const plistBytes = await readFile(installed.plist, "utf8");
    const unlinkFailure = await manageHome({ action: "uninstall", vaultPath: f.vault }, deps(f, installedFake, {
      unlinkPlist: async () => { throw new Error("unlink exploded"); },
    }));
    expect(unlinkFailure.status).toBe("error");
    expect(unlinkFailure.error).toContain("unlink exploded");
    expect(unlinkFailure.installed).toBe(true);
    expect(unlinkFailure.loaded).toBe(false);
    expect(await readFile(installed.plist, "utf8")).toBe(plistBytes);
    expect(await readFile(f.runtime, "utf8")).toBe("runtime bytes");
  });

  test("every mutating action is denied with exact truth in each suspension phase", async () => {
    for (const phase of ["suspending", "suspended", "resuming"] as const) {
      const f = await fixture();
      const fake = fakeLaunchctl();
      const d = deps(f, fake);
      const installed = await manageHome({ action: "install", vaultPath: f.vault }, d);
      expect(installed.status).toBe("installed");
      const operationId = `manage-home-${phase}`;
      const held = await holdSuspensionPhase(f, fake, phase, operationId);
      const plistBefore = await readFile(installed.plist);
      const selectorBefore = await readFile(installed.installation);
      const programBefore = await readFile(installed.program);
      const loadedBefore = new Set(fake.loaded);
      fake.calls.splice(0);

      for (const action of ["install", "start", "restart", "uninstall"] as const) {
        const denied = await manageHome({ action, vaultPath: f.vault }, d);
        expect(denied).toMatchObject({
          schema: "dome.home.lifecycle/v1",
          status: "error",
          installed: null,
          loaded: null,
          ready: null,
          lifecycle: {
            state: "active",
            phase,
            purpose: "backup",
            operationId,
          },
        });
        expect(denied.error).toContain(operationId);
      }
      const status = await manageHome({ action: "status", vaultPath: f.vault }, d);
      expect(status.lifecycle).toMatchObject({ state: "active", phase, purpose: "backup", operationId });
      expect(status.exitCode).toBe(1);
      expect(status.artifactId).toBe(ARTIFACT_ID);
      expect(fake.calls.filter((call) => ["bootout", "bootstrap", "kickstart"].includes(call[0] ?? ""))).toEqual([]);
      expect(await readFile(installed.plist)).toEqual(plistBefore);
      expect(await readFile(installed.installation)).toEqual(selectorBefore);
      expect(await readFile(installed.program)).toEqual(programBefore);
      expect(fake.loaded).toEqual(loadedBefore);

      held.release();
      expect((await held.done).kind).toBe("ready");
    }
  }, 30_000);

  test("recomputes mutable evidence after waiting for lifecycle ownership", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const d = deps(f, fake);
    const installed = await manageHome({ action: "install", vaultPath: f.vault }, d);
    let releaseOwner!: () => void;
    let reportOwner!: () => void;
    const ownerEntered = new Promise<void>((resolve) => { reportOwner = resolve; });
    const ownerGate = new Promise<void>((resolve) => { releaseOwner = resolve; });
    const owner = withHomeLifecycleMutation(f.vault, async () => {
      reportOwner();
      await ownerGate;
    });
    await ownerEntered;
    const alias = join(dirname(f.vault), "queued-vault-alias");
    await symlink(f.vault, alias);
    fake.calls.splice(0);
    const restart = manageHome({ action: "restart", vaultPath: alias }, d);
    await Bun.sleep(25);
    expect(fake.calls).toEqual([]);
    await writeFile(installed.plist, "raced plist bytes\n");
    releaseOwner();
    expect((await owner).kind).toBe("owned");
    const denied = await restart;
    expect(denied.status).toBe("error");
    expect(denied.error).toContain("does not match installation record");
    expect(fake.calls.filter((call) => ["bootout", "bootstrap", "kickstart"].includes(call[0] ?? ""))).toEqual([]);
    expect(await readFile(installed.plist, "utf8")).toBe("raced plist bytes\n");
  });

  test("operational denial occurs while lifecycle is owned and reports unknown installation truth", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const baseDeps = deps(f, fake);
    const installed = await manageHome({ action: "install", vaultPath: f.vault }, baseDeps);
    const plistBefore = await readFile(installed.plist);
    const selectorBefore = await readFile(installed.installation);
    let releaseAdmission!: () => void;
    let reportAdmission!: () => void;
    const admissionReached = new Promise<void>((resolve) => { reportAdmission = resolve; });
    const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    fake.calls.splice(0);
    const mutation = manageHome({ action: "install", vaultPath: f.vault }, {
      ...baseDeps,
      beforeOperationalAdmission: async () => {
        reportAdmission();
        await admissionGate;
      },
    });
    await admissionReached;
    let contenderEntered = false;
    const contender = withHomeLifecycleMutation(f.vault, async () => { contenderEntered = true; });
    await Bun.sleep(25);
    expect(contenderEntered).toBeFalse();
    const transactionId = "home-owned-operational-denial";
    expect((await engageOperationalWriterBarrier({ vaultPath: f.vault, transactionId })).ok).toBeTrue();
    releaseAdmission();
    const denied = await mutation;
    expect(denied).toMatchObject({
      status: "error",
      installed: null,
      loaded: null,
      lifecycle: { state: "inactive" },
    });
    expect(denied.error).toContain("write-admission-closed");
    expect(denied.error).toContain(transactionId);
    expect((await contender).kind).toBe("owned");
    expect(contenderEntered).toBeTrue();
    expect(await readFile(installed.plist)).toEqual(plistBefore);
    expect(await readFile(installed.installation)).toEqual(selectorBefore);
    expect(fake.calls.filter((call) => ["bootout", "bootstrap", "kickstart"].includes(call[0] ?? ""))).toEqual([]);
    await releaseOperationalWriterBarrier({
      vaultPath: f.vault,
      transactionId,
      validateAndRemoveExternalEvidence: async () => {},
    });
  });

  test("post-mutation lifecycle and lease-close failures preserve provisional external truth", async () => {
    const lifecycle = await fixture();
    const lifecycleFake = fakeLaunchctl();
    const lifecycleFailure = await manageHome({ action: "install", vaultPath: lifecycle.vault }, deps(lifecycle, lifecycleFake, {
      afterOwnedMutation: async () => { throw new Error("post-mutation lifecycle failure"); },
    }));
    expect(lifecycleFailure).toMatchObject({
      schema: "dome.home.lifecycle/v1",
      status: "error",
      artifactId: ARTIFACT_ID,
      productVersion: "1.0.0",
      installed: true,
      releasePublished: true,
      replaced: false,
      lifecycle: { state: "unavailable" },
    });
    expect(lifecycleFailure.error).toContain("post-mutation lifecycle failure");
    expect(existsSync(lifecycleFailure.plist)).toBeTrue();
    expect(existsSync(lifecycleFailure.installation)).toBeTrue();
    expect(existsSync(lifecycleFailure.release!)).toBeTrue();

    const close = await fixture();
    const closeFake = fakeLaunchctl();
    const closeFailure = await manageHome({ action: "install", vaultPath: close.vault }, deps(close, closeFake, {
      closeOperationalLease: (lease) => {
        lease.close();
        throw new Error("lease close exploded");
      },
    }));
    expect(closeFailure).toMatchObject({
      status: "error",
      artifactId: ARTIFACT_ID,
      installed: true,
      releasePublished: true,
      lifecycle: { state: "unavailable" },
    });
    expect(closeFailure.error).toContain("lease close exploded");
    expect(existsSync(closeFailure.plist)).toBeTrue();

    const combined = await fixture();
    const combinedFailure = await manageHome({ action: "install", vaultPath: combined.vault }, deps(combined, fakeLaunchctl(), {
      afterOwnedMutation: async () => { throw new Error("lifecycle commit exploded"); },
      closeOperationalLease: (lease) => {
        lease.close();
        throw new Error("combined lease close exploded");
      },
    }));
    expect(combinedFailure).toMatchObject({
      status: "error",
      artifactId: ARTIFACT_ID,
      installed: true,
      releasePublished: true,
      lifecycle: { state: "unavailable" },
    });
    expect(combinedFailure.error).toContain("lifecycle commit exploded");
    expect(combinedFailure.error).toContain("combined lease close exploded");
  });

  test("post-lifecycle readiness retains SHARED admission until observation finishes", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const d = deps(f, fake);
    const installed = await manageHome({ action: "install", vaultPath: f.vault }, d);
    expect(installed.status).toBe("installed");
    let releaseReadiness!: () => void;
    let reportReadiness!: () => void;
    const readinessEntered = new Promise<void>((resolve) => { reportReadiness = resolve; });
    const readinessGate = new Promise<void>((resolve) => { releaseReadiness = resolve; });
    let readinessCalls = 0;
    const restart = manageHome({ action: "restart", vaultPath: f.vault }, deps(f, fake, {
      readiness: async () => {
        readinessCalls += 1;
        if (readinessCalls === 1) return false;
        reportReadiness();
        await readinessGate;
        return true;
      },
      readinessTimeoutMs: 5_000,
    }));
    await readinessEntered;
    const transactionId = "readiness-retains-shared";
    let barrierSettled = false;
    const barrier = engageOperationalWriterBarrier({ vaultPath: f.vault, transactionId })
      .then((value) => { barrierSettled = true; return value; });
    await Bun.sleep(50);
    expect(barrierSettled).toBeFalse();
    releaseReadiness();
    expect((await restart).status).toBe("restarted");
    expect((await barrier).ok).toBeTrue();
    await releaseOperationalWriterBarrier({
      vaultPath: f.vault,
      transactionId,
      validateAndRemoveExternalEvidence: async () => {},
    });
  }, 30_000);

  test("post-lifecycle readiness observes a concurrent uninstall instead of returning stale success", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const installed = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, fake));
    expect(installed.status).toBe("installed");

    let releaseReadiness!: () => void;
    let reportReadiness!: () => void;
    const readinessEntered = new Promise<void>((resolve) => { reportReadiness = resolve; });
    const readinessGate = new Promise<void>((resolve) => { releaseReadiness = resolve; });
    let readinessCalls = 0;
    const restart = manageHome({ action: "restart", vaultPath: f.vault }, deps(f, fake, {
      readiness: async () => {
        readinessCalls += 1;
        if (readinessCalls === 1) return false;
        reportReadiness();
        await readinessGate;
        return true;
      },
      readinessTimeoutMs: 5_000,
    }));
    await readinessEntered;

    const uninstalled = await manageHome({ action: "uninstall", vaultPath: f.vault }, deps(f, fake));
    expect(uninstalled.status).toBe("uninstalled");
    expect(uninstalled.installed).toBe(false);
    releaseReadiness();

    const observed = await restart;
    expect(observed.status).toBe("error");
    expect(observed.installed).toBe(false);
    expect(observed.loaded).toBe(false);
    expect(observed.ready).toBe(true);
    expect(observed.error).toContain("plist was removed during readiness observation");
  }, 30_000);

  test("restart releases lifecycle ownership before awaiting a real Product Host child", async () => {
    const f = await fixture();
    await mkdir(join(f.vault, "wiki"), { recursive: true });
    await writeFile(join(f.vault, "wiki", "child.md"), "# Child\n");
    await add(f.vault, "wiki/child.md");
    await commit({ path: f.vault, message: "seed live Home child" });
    const fake = fakeLaunchctl();
    const installed = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, fake));
    expect(installed.status).toBe("installed");
    let childStart: ReturnType<typeof startProductHost> | null = null;
    let childRecorded = false;
    const launchctl: LaunchctlRunner = async (args) => {
      const outcome = await fake.runner(args);
      if (args[0] === "kickstart" && childStart === null) {
        childStart = startProductHost({
          vaultPath: f.vault,
          port: 0,
          launch: { kind: "normal", artifact: { id: ARTIFACT_ID, version: "1.0.0" } },
        }, {
          homeStartup: {
            applicationSupportDir: f.support,
            launchAgentsDir: f.agents,
            invokingRuntimePath: join(installed.release!, "runtime", "bun"),
            invokingEntrypointPath: installed.program,
            verifyArtifact: verifyFixtureArtifact,
          },
        });
      }
      return outcome;
    };
    const restarted = await within(manageHome({ action: "restart", vaultPath: f.vault }, deps(f, fake, {
      launchctl,
      readiness: async () => {
        if (childStart === null) return false;
        const child = await childStart;
        if (child.ok && !childRecorded) {
          childRecorded = true;
          hosts.push(child.value);
        }
        return child.ok;
      },
      readinessTimeoutMs: 5_000,
    })), 10_000);
    expect(restarted.status).toBe("restarted");
    expect(childStart).not.toBeNull();
    expect((await childStart!).ok).toBeTrue();
    expect(await inspectHomeLifecycleSuspension(f.vault)).toEqual({ kind: "inactive" });
  }, 30_000);

  test("status is coordinator-pure and reports inactive, invalid, and unavailable lifecycle truth", async () => {
    const fresh = await fixture();
    const fake = fakeLaunchctl();
    const journal = homeLifecycleCoordinatorPath(fresh.vault);
    const coordinatorRoot = dirname(journal);
    const establishmentRoot = join(dirname(coordinatorRoot), "home-lifecycle-suspension.established");
    expect(existsSync(coordinatorRoot)).toBeFalse();
    expect(existsSync(establishmentRoot)).toBeFalse();
    const inactive = await manageHome({ action: "status", vaultPath: fresh.vault }, deps(fresh, fake));
    expect(inactive.lifecycle).toEqual({ state: "inactive" });
    expect(inactive.exitCode).toBe(0);
    expect(existsSync(coordinatorRoot)).toBeFalse();
    expect(existsSync(establishmentRoot)).toBeFalse();

    expect((await withHomeLifecycleMutation(fresh.vault, async () => {})).kind).toBe("owned");
    const corruptBefore = Buffer.from("corrupt lifecycle journal\n");
    await writeFile(journal, corruptBefore);
    const invalid = await manageHome({ action: "status", vaultPath: fresh.vault }, deps(fresh, fake));
    expect(invalid.lifecycle).toMatchObject({ state: "invalid" });
    expect(invalid.status).toBe("error");
    expect(invalid.exitCode).toBe(1);
    expect(await readFile(journal)).toEqual(corruptBefore);

    const busy = await fixture();
    expect((await withHomeLifecycleMutation(busy.vault, async () => {})).kind).toBe("owned");
    const busyJournal = homeLifecycleCoordinatorPath(busy.vault);
    const ownership = new Database(join(dirname(busyJournal), "home-lifecycle-suspension-ownership.db"));
    ownership.run("BEGIN EXCLUSIVE");
    try {
      const unavailable = await manageHome({ action: "status", vaultPath: busy.vault }, deps(busy, fakeLaunchctl()));
      expect(unavailable.lifecycle).toMatchObject({ state: "unavailable" });
      expect(unavailable.status).toBe("error");
      expect(unavailable.exitCode).toBe(1);
    } finally {
      ownership.run("ROLLBACK");
      ownership.close();
    }
  }, 30_000);

  test("malformed lifecycle ancestors remain structured and never bypass lease cleanup", async () => {
    const statusFixture = await fixture();
    const statusLocks = dirname(dirname(homeLifecycleCoordinatorPath(statusFixture.vault)));
    const malformedBytes = Buffer.from("locks is not a directory\n");
    await writeFile(statusLocks, malformedBytes);

    const inspection = await inspectHomeLifecycleSuspension(statusFixture.vault);
    expect(inspection).toMatchObject({ kind: "invalid" });
    const status = await manageHome(
      { action: "status", vaultPath: statusFixture.vault },
      deps(statusFixture, fakeLaunchctl()),
    );
    expect(status).toMatchObject({
      schema: "dome.home.lifecycle/v1",
      action: "status",
      status: "error",
      lifecycle: { state: "invalid" },
    });
    expect(await readFile(statusLocks)).toEqual(malformedBytes);

    const mutationFixture = await fixture();
    const mutationLocks = dirname(dirname(homeLifecycleCoordinatorPath(mutationFixture.vault)));
    const displacedLocks = `${mutationLocks}.displaced`;
    let closeCalls = 0;
    const mutation = await manageHome(
      { action: "uninstall", vaultPath: mutationFixture.vault },
      deps(mutationFixture, fakeLaunchctl(), {
        afterOwnedMutation: async () => {
          await rename(mutationLocks, displacedLocks);
          await writeFile(mutationLocks, malformedBytes);
          throw new Error("post-mutation lifecycle failure");
        },
        closeOperationalLease: (lease) => {
          closeCalls += 1;
          lease.close();
        },
      }),
    );
    expect(mutation).toMatchObject({
      schema: "dome.home.lifecycle/v1",
      action: "uninstall",
      status: "error",
      lifecycle: { state: "invalid" },
    });
    expect(closeCalls).toBe(1);
    expect(await readFile(mutationLocks)).toEqual(malformedBytes);
    expect(existsSync(displacedLocks)).toBeTrue();
  });

  test("symlinked and non-private lifecycle ancestors are invalid without inspection repair", async () => {
    for (const ancestor of ["dome", "state", "locks"] as const) {
      const f = await fixture();
      const dome = join(f.vault, ".dome");
      const state = join(dome, "state");
      const locks = join(state, "locks");
      const path = ancestor === "dome" ? dome : ancestor === "state" ? state : locks;
      const external = join(dirname(f.vault), `external-${ancestor}`);
      await mkdir(external);
      if (ancestor === "dome") {
        await writeFile(join(external, "config.yaml"), "extensions: {}\n");
      }
      if (existsSync(path)) await rename(path, `${path}.direct`);
      await symlink(external, path);

      expect(await inspectHomeLifecycleSuspension(f.vault)).toMatchObject({ kind: "invalid" });
      const status = await manageHome({ action: "status", vaultPath: f.vault }, deps(f, fakeLaunchctl()));
      expect(status.exitCode).toBe(1);
      expect(status.lifecycle).toMatchObject({ state: "invalid" });
      expect((await lstat(path)).isSymbolicLink()).toBeTrue();
      expect(existsSync(join(external, "home-lifecycle-suspension"))).toBeFalse();
    }

    const nonPrivate = await fixture();
    const locks = dirname(dirname(homeLifecycleCoordinatorPath(nonPrivate.vault)));
    await mkdir(locks, { mode: 0o755 });
    await chmod(locks, 0o755);
    expect(await inspectHomeLifecycleSuspension(nonPrivate.vault)).toMatchObject({ kind: "invalid" });
    const status = await manageHome({ action: "status", vaultPath: nonPrivate.vault }, deps(nonPrivate, fakeLaunchctl()));
    expect(status.exitCode).toBe(1);
    expect(status.lifecycle).toMatchObject({ state: "invalid" });
    expect((await lstat(locks)).mode & 0o077).not.toBe(0);
    expect(existsSync(dirname(homeLifecycleCoordinatorPath(nonPrivate.vault)))).toBeFalse();
  });

  test("unsupported and invalid vault preflights never scaffold lifecycle state", async () => {
    const f = await fixture();
    const journal = homeLifecycleCoordinatorPath(f.vault);
    const unsupported = await manageHome({ action: "install", vaultPath: f.vault }, {
      ...deps(f, fakeLaunchctl()),
      platform: "linux",
    });
    expect(unsupported.status).toBe("error");
    expect(existsSync(dirname(journal))).toBeFalse();
    const unsupportedStatus = await manageHome({ action: "status", vaultPath: f.vault }, {
      ...deps(f, fakeLaunchctl()),
      platform: "linux",
    });
    expect(unsupportedStatus.exitCode).toBe(64);
    expect(unsupportedStatus.lifecycle).toMatchObject({ state: "unavailable" });
    expect(existsSync(dirname(journal))).toBeFalse();

    const invalid = join(dirname(f.vault), "not-a-vault");
    await mkdir(invalid);
    const denied = await manageHome({ action: "restart", vaultPath: invalid }, deps(f, fakeLaunchctl()));
    expect(denied.exitCode).toBe(64);
    expect(existsSync(dirname(homeLifecycleCoordinatorPath(invalid)))).toBeFalse();
    const status = await manageHome({ action: "status", vaultPath: invalid }, deps(f, fakeLaunchctl()));
    expect(status.exitCode).toBe(64);
    expect(status.lifecycle).toMatchObject({ state: "unavailable" });
    expect(existsSync(dirname(homeLifecycleCoordinatorPath(invalid)))).toBeFalse();

    const nested = join(f.vault, "nested-vault-lookalike");
    await mkdir(join(nested, ".dome"), { recursive: true });
    await writeFile(join(nested, ".dome", "config.yaml"), "extensions: {}\n");
    const nestedDenied = await manageHome({ action: "install", vaultPath: nested }, deps(f, fakeLaunchctl()));
    expect(nestedDenied.exitCode).toBe(64);
    expect(nestedDenied.error).toContain("not an initialized Dome vault");
    expect(existsSync(dirname(homeLifecycleCoordinatorPath(nested)))).toBeFalse();
  });

  test("ambiguous print and bootout failures refuse before further launchd mutation", async () => {
    const f = await fixture();
    const installedFake = fakeLaunchctl();
    const installed = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, installedFake));
    const plistBefore = await readFile(installed.plist);
    const ambiguousCalls: string[][] = [];
    const ambiguous = await manageHome({ action: "restart", vaultPath: f.vault }, {
      ...deps(f, installedFake),
      launchctl: async (args) => {
        ambiguousCalls.push([...args]);
        return args[0] === "print" ? outcome(5, "ambiguous domain") : installedFake.runner(args);
      },
    });
    expect(ambiguous.status).toBe("error");
    expect(ambiguous.loaded).toBeNull();
    expect(ambiguous.error).toContain("launchctl print");
    expect(ambiguousCalls.filter((call) => ["bootout", "bootstrap", "kickstart"].includes(call[0] ?? ""))).toEqual([]);
    expect(await readFile(installed.plist)).toEqual(plistBefore);

    const bootout = fakeLaunchctl("bootout");
    bootout.loaded.add(`gui/501/${homeServiceLabelForVault(f.vault)}`);
    const refused = await manageHome({ action: "restart", vaultPath: f.vault }, deps(f, bootout));
    expect(refused.status).toBe("error");
    expect(refused.error).toContain("bootout failed");
    expect(bootout.calls.some((call) => call[0] === "bootstrap")).toBeFalse();
    expect(await readFile(installed.plist)).toEqual(plistBefore);

    const removed = fakeLaunchctl();
    removed.loaded.add(`gui/501/${homeServiceLabelForVault(f.vault)}`);
    const removedResult = await manageHome({ action: "restart", vaultPath: f.vault }, {
      ...deps(f, removed),
      launchctl: async (args) => {
        const observed = await removed.runner(args);
        return args[0] === "bootout" ? outcome(5, "bootout failed after removal") : observed;
      },
    });
    expect(removedResult.status).toBe("error");
    expect(removedResult.loaded).toBe(false);
    expect(removed.calls.some((call) => call[0] === "bootstrap")).toBeFalse();
    expect(await readFile(installed.plist)).toEqual(plistBefore);

    const thrown = fakeLaunchctl();
    thrown.loaded.add(`gui/501/${homeServiceLabelForVault(f.vault)}`);
    let bootoutThrew = false;
    const thrownResult = await manageHome({ action: "uninstall", vaultPath: f.vault }, {
      ...deps(f, thrown),
      launchctl: async (args) => {
        if (args[0] === "print" && bootoutThrew) throw new Error("diagnostic print ambiguous");
        if (args[0] === "bootout") {
          await thrown.runner(args);
          bootoutThrew = true;
          throw new Error("bootout transport broke after removal");
        }
        return thrown.runner(args);
      },
    });
    expect(thrownResult.status).toBe("error");
    expect(thrownResult.loaded).toBeNull();
    expect(thrownResult.error).toContain("bootout transport broke after removal");
    expect(await readFile(installed.plist)).toEqual(plistBefore);
  });

  test("status and initial readiness exceptions stay structured with selected evidence", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const d = deps(f, fake);
    const installed = await manageHome({ action: "install", vaultPath: f.vault }, d);
    const readiness = await manageHome({ action: "status", vaultPath: f.vault }, {
      ...d,
      readiness: async () => { throw new Error("status readiness exploded"); },
    });
    expect(readiness).toMatchObject({
      schema: "dome.home.lifecycle/v1",
      status: "error",
      artifactId: ARTIFACT_ID,
      installed: true,
      lifecycle: { state: "inactive" },
    });
    expect(readiness.error).toContain("status readiness exploded");

    await rm(installed.plist);
    await mkdir(installed.plist);
    const unreadable = await manageHome({ action: "status", vaultPath: f.vault }, d);
    expect(unreadable.status).toBe("error");
    expect(unreadable.artifactId).toBe(ARTIFACT_ID);
    expect(unreadable.error).toBeDefined();

    const first = await fixture();
    const firstFake = fakeLaunchctl();
    const failed = await manageHome({ action: "install", vaultPath: first.vault }, deps(first, firstFake, {
      readiness: async () => { throw new Error("initial readiness exploded"); },
    }));
    expect(failed.status).toBe("error");
    expect(failed.error).toContain("initial readiness exploded");
    expect(existsSync(failed.installation)).toBeFalse();
    expect(existsSync(failed.plist)).toBeFalse();
    expect(firstFake.calls.filter((call) => ["bootout", "bootstrap", "kickstart"].includes(call[0] ?? ""))).toEqual([]);
  });

  test("same artifact id with a different product version requires upgrade", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const d = deps(f, fake);
    const installed = await manageHome({ action: "install", vaultPath: f.vault }, d);
    const selectorBefore = await readFile(installed.installation);
    fake.calls.splice(0);
    const refused = await manageHome({ action: "install", vaultPath: f.vault }, {
      ...d,
      verifyArtifact: async () => ({
        artifact: { id: ARTIFACT_ID },
        product: { name: "Dome Home", version: "2.0.0" },
      } as HomeArtifactManifest),
    });
    expect(refused.status).toBe("error");
    expect(refused.exitCode).toBe(64);
    expect(refused.error).toContain("dome home upgrade");
    expect(await readFile(installed.installation)).toEqual(selectorBefore);
    expect(fake.calls.filter((call) => ["bootout", "bootstrap", "kickstart"].includes(call[0] ?? ""))).toEqual([]);
  });

  test("managed release publication rejects product-version drift at staged verification", async () => {
    const f = await fixture();
    const fake = fakeLaunchctl();
    const drifted = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, fake, {
      verifyArtifact: async (candidate) => {
        const verified = await verifyFixtureArtifact(candidate);
        return candidate === f.artifact
          ? verified
          : { ...verified, product: { ...verified.product, version: "2.0.0" } } as HomeArtifactManifest;
      },
    }));
    expect(drifted.status).toBe("error");
    expect(drifted.error).toContain("staged release identity changed");
    expect(existsSync(drifted.installation)).toBeFalse();
    expect(existsSync(drifted.plist)).toBeFalse();
    expect(fake.calls.some((call) => call[0] === "bootstrap")).toBeFalse();
  });
});

async function holdSuspensionPhase(
  f: Awaited<ReturnType<typeof fixture>>,
  fake: Fake,
  phase: "suspending" | "suspended" | "resuming",
  operationId: string,
): Promise<{ readonly release: () => void; readonly done: ReturnType<typeof withSupervisedHomeSuspended<string>> }> {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const phaseReached = new Promise<void>((resolve) => { reached = resolve; });
  const done = withSupervisedHomeSuspended({
    mode: "new",
    vaultPath: f.vault,
    purpose: "backup",
    operationId,
  }, async () => "held", {
    ...deps(f, fake),
    checkpoint: async (name) => {
      const checkpoint = phase === "suspending" ? "intent-committed" : "callback-returned";
      if (phase !== "resuming" && name === checkpoint) {
        reached();
        await gate;
      }
    },
    readiness: phase === "resuming"
      ? async () => {
          reached();
          await gate;
          return true;
        }
      : async () => fake.loaded.has(`gui/501/${homeServiceLabelForVault(f.vault)}`),
  });
  await phaseReached;
  const inspection = await inspectHomeLifecycleSuspension(f.vault);
  expect(inspection.kind === "active" ? inspection.suspension.phase : inspection.kind).toBe(phase);
  return { release, done };
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`operation exceeded ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
