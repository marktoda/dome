import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  engageOperationalWriterBarrier,
} from "../../src/operational-state/writer-barrier";
import { homeInstallationPaths } from "../../src/product-host/home-installation";
import {
  homeLifecycleCoordinatorPath,
  inspectHomeLifecycleSuspension,
  withHomeLifecycleMutation,
  withSupervisedHomeSuspended,
  type HomeLifecycleSuspensionDeps,
  type HomeLifecycleSuspensionInspection,
  type HomeSuspensionPhase,
} from "../../src/product-host/home-lifecycle-suspension";
import { vaultServiceSlug, type LaunchctlRunner } from "../../src/surface/service-probe";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type FakeLaunchd = {
  readonly calls: string[][];
  readonly loaded: Set<string>;
  runner: LaunchctlRunner;
};

describe("supervised Home lifecycle suspension", () => {
  test("publishes durable suspending intent before bootout", async () => {
    const f = await fixture(true);
    const observed: HomeLifecycleSuspensionInspection[] = [];
    f.launchd.runner = async (args) => {
      if (args[0] === "bootout") observed.push(await inspectHomeLifecycleSuspension(f.vault));
      return f.baseRunner(args);
    };

    const result = await suspend(f, "backup-1", async () => "snapshot");
    expect(result.kind).toBe("ready");
    expect(observed[0]?.kind).toBe("active");
    if (observed[0]?.kind === "active") expect(observed[0].suspension.phase).toBe("suspending");
  });

  test("denies a concurrent lifecycle mutator while Tx2 owns the seam", async () => {
    const f = await fixture(true);
    let entered!: () => void;
    const callbackEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = suspend(f, "backup-2", async () => {
      entered();
      await gate;
      return "done";
    });
    await callbackEntered;

    let mutated = false;
    const denied = await withHomeLifecycleMutation(f.vault, async () => { mutated = true; });
    expect(denied.kind).toBe("suspended");
    expect(mutated).toBeFalse();
    release();
    expect((await holder).kind).toBe("ready");
  });

  test("boots out, proves loaded drain, then runs the callback", async () => {
    const f = await fixture(true);
    let callbackSawLoaded = true;
    const result = await suspend(f, "backup-3", async () => {
      callbackSawLoaded = f.launchd.loaded.has(f.target);
      return 3;
    });
    expect(callbackSawLoaded).toBeFalse();
    expect(result).toMatchObject({ kind: "ready", value: 3, operationRan: true });
    const verbs = f.launchd.calls.map((call) => call[0]);
    expect(verbs.indexOf("bootout")).toBeGreaterThan(-1);
    expect(verbs.indexOf("bootstrap")).toBeGreaterThan(verbs.indexOf("bootout"));
  });

  test("a previously stopped Home is never started", async () => {
    const f = await fixture(false);
    const result = await suspend(f, "backup-stopped", async () => "ok");
    expect(result).toMatchObject({ kind: "not-required", value: "ok" });
    expect(f.launchd.calls.some((call) => call[0] === "bootstrap" || call[0] === "kickstart")).toBeFalse();
    expect(await inspectHomeLifecycleSuspension(f.vault)).toEqual({ kind: "inactive" });
  });

  test("callback failure still resumes; callback plus resume failure is aggregated", async () => {
    const resumed = await fixture(true);
    const callbackFailure = new Error("snapshot failed");
    await expect(suspend(resumed, "backup-callback", async () => { throw callbackFailure; })).rejects.toBe(callbackFailure);
    expect(resumed.launchd.loaded.has(resumed.target)).toBeTrue();
    expect((await inspectHomeLifecycleSuspension(resumed.vault)).kind).toBe("inactive");

    const failed = await fixture(true);
    failed.readiness = async () => false;
    try {
      await suspend(failed, "backup-both", async () => { throw new Error("operation exploded"); });
      throw new Error("expected aggregate failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect(aggregate.errors.map(String).join("\n")).toContain("operation exploded");
      expect(aggregate.errors.map(String).join("\n")).toContain("pairing-ready");
    }
    const active = await inspectHomeLifecycleSuspension(failed.vault);
    expect(active.kind).toBe("active");
    if (active.kind === "active") expect(active.suspension.phase).toBe("resuming");
  });

  test("closed operational admission defers restart and retains resuming truth", async () => {
    const f = await fixture(true);
    const result = await suspend(f, "upgrade-deferred", async () => {
      const engaged = await engageOperationalWriterBarrier({ vaultPath: f.vault, transactionId: "upgrade-deferred" });
      expect(engaged.ok).toBeTrue();
      return "prepared";
    }, "upgrade");
    expect(result).toMatchObject({ kind: "deferred", transactionId: "upgrade-deferred", value: "prepared" });
    expect(f.launchd.loaded.has(f.target)).toBeFalse();
    const active = await inspectHomeLifecycleSuspension(f.vault);
    expect(active.kind).toBe("active");
    if (active.kind === "active") expect(active.suspension.phase).toBe("resuming");
  });

  test("readiness failure keeps resuming evidence and recovery clears only after ready", async () => {
    const f = await fixture(true);
    f.readiness = async () => false;
    const failed = await suspend(f, "backup-readiness", async () => "snapshot");
    expect(failed.kind).toBe("failed");
    let active = await inspectHomeLifecycleSuspension(f.vault);
    expect(active.kind).toBe("active");
    if (active.kind === "active") expect(active.suspension.phase).toBe("resuming");

    f.readiness = async () => f.launchd.loaded.has(f.target);
    let reran = false;
    const recovered = await suspend(f, "different-backup-id", async () => { reran = true; }, "backup", true);
    expect(recovered).toMatchObject({ kind: "ready", recovered: true, operationRan: false });
    expect(reran).toBeFalse();
    active = await inspectHomeLifecycleSuspension(f.vault);
    expect(active.kind).toBe("inactive");
  });

  test("recovers durable suspending, suspended, and resuming crash phases", async () => {
    for (const phase of ["suspending", "suspended", "resuming"] as const) {
      const f = await fixture(true);
      f.launchd.runner = async (args) => args[0] === "bootout"
        ? { exitCode: 5, stdout: "", stderr: "simulated crash edge" }
        : f.baseRunner(args);
      expect((await suspend(f, `seed-${phase}`, async () => "never")).kind).toBe("failed");
      await setPhase(f.vault, phase);
      // Crash after bootout is representable for every durable phase.
      f.launchd.loaded.delete(f.target);
      f.launchd.runner = f.baseRunner;
      let runs = 0;
      const recovered = await suspend(f, `recover-${phase}`, async () => { runs++; return phase; }, "backup", true);
      expect(recovered.kind).toBe("ready");
      expect(runs).toBe(phase === "resuming" ? 0 : 1);
      expect((await inspectHomeLifecycleSuspension(f.vault)).kind).toBe("inactive");
    }
  });

  test("upgrade recovery requires the exact operation id", async () => {
    const f = await fixture(true);
    f.launchd.runner = async (args) => args[0] === "bootout"
      ? { exitCode: 5, stdout: "", stderr: "hold" }
      : f.baseRunner(args);
    expect((await suspend(f, "upgrade-exact", async () => {}, "upgrade")).kind).toBe("failed");
    await expect(suspend(f, "upgrade-wrong", async () => {}, "upgrade", true)).rejects.toThrow("belongs to operation upgrade-exact");
    f.launchd.runner = f.baseRunner;
    expect((await suspend(f, "upgrade-exact", async () => {}, "upgrade", true)).kind).toBe("ready");
  });

  test("selector or plist drift fails closed during recovery", async () => {
    for (const drift of ["selector", "plist"] as const) {
      const f = await fixture(true);
      f.readiness = async () => false;
      expect((await suspend(f, `drift-${drift}`, async () => "done")).kind).toBe("failed");
      await writeFile(drift === "selector" ? f.installation : f.plist, `${drift} changed\n`, { mode: 0o600 });
      await expect(suspend(f, `recover-${drift}`, async () => {}, "backup", true)).rejects.toThrow(
        drift === "selector" ? /installation record|invalid/ : /evidence changed/,
      );
      expect((await inspectHomeLifecycleSuspension(f.vault)).kind).toBe("active");
    }
  });

  test("canonical aliases share one journal and suspension owner", async () => {
    const f = await fixture(true);
    const alias = join(dirname(f.vault), "vault-alias");
    await symlink(f.vault, alias);
    f.readiness = async () => false;
    await suspend({ ...f, vault: alias }, "alias-owner", async () => "done");
    const canonical = await inspectHomeLifecycleSuspension(f.vault);
    const throughAlias = await inspectHomeLifecycleSuspension(alias);
    expect(canonical).toEqual(throughAlias);
    expect(homeLifecycleCoordinatorPath(alias)).toBe(homeLifecycleCoordinatorPath(f.vault));
    expect((await withHomeLifecycleMutation(alias, async () => "mutated")).kind).toBe("suspended");
  });

  test("corrupt, symlinked, non-private, and foreign coordinator state fails closed", async () => {
    const corrupt = await fixture(false);
    await withHomeLifecycleMutation(corrupt.vault, async () => {});
    const journal = homeLifecycleCoordinatorPath(corrupt.vault);
    const db = new Database(journal);
    db.run("CREATE TABLE foreign_state (value TEXT)");
    db.close();
    expect((await inspectHomeLifecycleSuspension(corrupt.vault)).kind).toBe("invalid");
    await expect(withHomeLifecycleMutation(corrupt.vault, async () => {})).rejects.toThrow("unknown schema");

    const linked = await fixture(false);
    await withHomeLifecycleMutation(linked.vault, async () => {});
    const linkedJournal = homeLifecycleCoordinatorPath(linked.vault);
    const moved = `${linkedJournal}.moved`;
    await unlink(linkedJournal);
    await writeFile(moved, "attacker", { mode: 0o600 });
    await symlink(moved, linkedJournal);
    expect((await inspectHomeLifecycleSuspension(linked.vault)).kind).toBe("invalid");
    await expect(withHomeLifecycleMutation(linked.vault, async () => {})).rejects.toThrow("direct private regular file");

    const publicMode = await fixture(false);
    await withHomeLifecycleMutation(publicMode.vault, async () => {});
    await chmod(homeLifecycleCoordinatorPath(publicMode.vault), 0o644);
    expect((await inspectHomeLifecycleSuspension(publicMode.vault)).kind).toBe("invalid");
  });

  test("simultaneous first open initializes once and serializes every mutator", async () => {
    const f = await fixture(false);
    let inside = 0;
    let maximum = 0;
    const results = await Promise.all(Array.from({ length: 16 }, (_, index) =>
      withHomeLifecycleMutation(f.vault, async () => {
        inside++;
        maximum = Math.max(maximum, inside);
        await Bun.sleep(2);
        inside--;
        return index;
      })));
    expect(maximum).toBe(1);
    expect(results.every((result) => result.kind === "owned")).toBeTrue();
    expect((await inspectHomeLifecycleSuspension(f.vault)).kind).toBe("inactive");
  });
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(loaded: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dome-home-suspension-")));
  roots.push(root);
  const vault = join(root, "vault");
  await mkdir(join(vault, ".dome", "state"), { recursive: true });
  const support = join(root, "Application Support", "Dome", "Home");
  const agents = join(root, "LaunchAgents");
  const paths = homeInstallationPaths(vault, { applicationSupportDir: support });
  await mkdir(paths.installations, { recursive: true });
  await mkdir(agents, { recursive: true });
  const installation = paths.record;
  await writeFile(installation, `${JSON.stringify({
    schema: "dome.home.installation/v1",
    vault,
    artifact: { id: "a".repeat(64), version: "1.0.0" },
    environment: [],
  })}\n`, { mode: 0o600 });
  const label = `com.dome.home.${vaultServiceSlug(vault)}`;
  const target = `gui/501/${label}`;
  const plist = join(agents, `${label}.plist`);
  await writeFile(plist, "strict plist bytes\n", { mode: 0o600 });
  const calls: string[][] = [];
  const loadedTargets = new Set<string>(loaded ? [target] : []);
  const baseRunner: LaunchctlRunner = async (args) => {
    calls.push([...args]);
    const verb = args[0];
    const candidate = args.at(-1) ?? "";
    if (verb === "print") return outcome(loadedTargets.has(candidate) ? 0 : 113);
    if (verb === "bootout") { loadedTargets.delete(candidate); return outcome(0); }
    if (verb === "bootstrap") {
      const serviceLabel = basename(args[2] ?? "").replace(/\.plist$/, "");
      loadedTargets.add(`${args[1]}/${serviceLabel}`);
      return outcome(0);
    }
    if (verb === "kickstart") { loadedTargets.add(candidate); return outcome(0); }
    return outcome(0);
  };
  const launchd: FakeLaunchd = { calls, loaded: loadedTargets, runner: baseRunner };
  return {
    root, vault, support, agents, installation, plist, label, target, launchd, baseRunner,
    readiness: async () => launchd.loaded.has(target),
  };
}

async function suspend<T>(
  f: Fixture,
  operationId: string,
  operation: () => Promise<T>,
  purpose: "backup" | "upgrade" = "backup",
  recoverExisting = false,
) {
  const deps: HomeLifecycleSuspensionDeps = {
    platform: "darwin",
    uid: 501,
    launchAgentsDir: f.agents,
    launchctl: (...args) => f.launchd.runner(...args),
    drainTimeoutMs: 20,
    readinessTimeoutMs: 1,
    readiness: () => f.readiness(),
    applicationSupportDir: f.support,
  };
  return withSupervisedHomeSuspended({ vaultPath: f.vault, purpose, operationId, recoverExisting }, operation, deps);
}

async function setPhase(vault: string, phase: HomeSuspensionPhase): Promise<void> {
  const db = new Database(homeLifecycleCoordinatorPath(vault));
  try {
    db.query("UPDATE home_lifecycle_suspension SET phase = ?, last_error = NULL").run(phase);
  } finally { db.close(); }
}

function outcome(exitCode: number, stderr = "") {
  return { exitCode, stdout: "", stderr };
}
