import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { chmod, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  homeServiceLabelForVault,
  isHomePairingReadiness,
  manageHome,
  type HomeLifecycleDeps,
} from "../../src/product-host/home-lifecycle";
import { serviceLabelForVault, type LaunchctlRunner } from "../../src/surface/service-probe";
import { initRepo } from "../../src/git";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Fake = {
  readonly calls: string[][];
  readonly loaded: Set<string>;
  readonly runner: LaunchctlRunner;
};

function fakeLaunchctl(fail: "bootstrap" | "kickstart" | "drain" | null = null): Fake {
  const calls: string[][] = [];
  const loaded = new Set<string>();
  const runner: LaunchctlRunner = async (args) => {
    calls.push([...args]);
    const verb = args[0];
    const target = args.at(-1) ?? "";
    if (verb === "print") return outcome(loaded.has(target) ? 0 : 113);
    if (verb === "bootout") {
      if (fail !== "drain") loaded.delete(target);
      return outcome(loaded.has(target) ? 1 : 0);
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
  readonly runtime: string;
  readonly program: string;
  readonly pwa: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "dome-home-lifecycle-"));
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
  return { vault, artifact, agents: join(root, "Launch Agents"), runtime, program, pwa };
}

function deps(f: Awaited<ReturnType<typeof fixture>>, fake: Fake, extra: Partial<HomeLifecycleDeps> = {}): HomeLifecycleDeps {
  return {
    platform: "darwin",
    uid: 501,
    launchAgentsDir: f.agents,
    launchctl: fake.runner,
    runtimePath: f.runtime,
    programPath: f.program,
    pwaDir: f.pwa,
    readiness: async () => fake.loaded.has(`gui/501/${homeServiceLabelForVault(f.vault)}`),
    readinessTimeoutMs: 20,
    drainTimeoutMs: 20,
    ...extra,
  };
}

describe("manageHome macOS lifecycle", () => {
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
      environment: new Map([["HOME_TOKEN", "a&<b>"], ["SPACE_VALUE", "two words"], ["PATH", "/evil"]]),
    }, deps(f, fake));
    expect(result.status).toBe("installed");
    expect(result.ready).toBe(true);
    expect(result.label).toBe(homeServiceLabelForVault(f.vault));
    const plist = await readFile(result.plist, "utf8");
    for (const value of [
      f.runtime, f.program, "home", "--vault", f.vault, "--host", "127.0.0.1",
      "--port", "3663", "--static-dir", f.pwa,
    ]) expect(plist).toContain(`<string>${value}</string>`);
    expect(plist).toContain("a&amp;&lt;b&gt;");
    expect(plist).toContain("two words");
    expect(plist).not.toContain("<string>/evil</string>");
    expect(plist).toContain(`<string>${join(f.artifact, "runtime")}:/usr/local/bin:`);
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
    expect(status.status).toBe("loaded-without-plist");
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
    const missing = join(f.artifact, "missing-program");
    let result = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, fakeLaunchctl(), { programPath: missing }));
    expect(result.status).toBe("error");
    expect(result.error).toContain("Dome program is missing");

    const bootstrap = fakeLaunchctl("bootstrap");
    result = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, bootstrap));
    expect(result.status).toBe("error");
    expect(result.error).toContain("bootstrap");
    expect(result.loaded).toBe(false);
    expect(existsSync(result.plist)).toBe(true);

    const kickstart = fakeLaunchctl("kickstart");
    result = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, kickstart));
    expect(result.status).toBe("error");
    expect(result.error).toContain("kickstart");
    expect(result.loaded).toBe(true);

    const notReady = fakeLaunchctl();
    result = await manageHome({ action: "install", vaultPath: f.vault }, deps(f, notReady, {
      readiness: async () => false,
      readinessTimeoutMs: 1,
    }));
    expect(result.status).toBe("error");
    expect(result.ready).toBe(false);
    expect(result.loaded).toBe(true);
  });

  test("preflight failure makes no launchctl call; absent start is usage", async () => {
    const f = await fixture();
    const missingFake = fakeLaunchctl();
    const missing = join(f.artifact, "gone");
    const failed = await manageHome(
      { action: "install", vaultPath: f.vault },
      deps(f, missingFake, { programPath: missing }),
    );
    expect(failed.status).toBe("error");
    expect(missingFake.calls).toEqual([]);

    const absentFake = fakeLaunchctl();
    const absent = await manageHome(
      { action: "start", vaultPath: f.vault },
      deps(f, absentFake, { programPath: missing }),
    );
    expect(absent.status).toBe("error");
    expect(absent.exitCode).toBe(64);
    expect(absent.error).toContain("dome home install");
  });

  test("status distinguishes loaded-unreachable and reports broken installed program", async () => {
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

    await unlink(f.program);
    const broken = await manageHome({ action: "status", vaultPath: f.vault }, d);
    expect(broken.status).toBe("broken-program");
    expect(broken.installed).toBe(true);
    expect(broken.loaded).toBe(true);
    expect(broken.program).toBe(f.program);
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
});
