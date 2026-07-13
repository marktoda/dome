import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  engageOperationalWriterBarrier,
  releaseOperationalWriterBarrier,
} from "../../src/operational-state/writer-barrier";
import { homeInstallationPaths } from "../../src/product-host/home-installation";
import {
  homeLifecycleCoordinatorPath,
  inspectHomeLifecycleSuspension,
  withHomeLifecycleMutation,
  withSupervisedHomeSuspended,
  type HomeLifecycleSuspensionDeps,
  type HomeLifecycleSuspensionInspection,
  type HomeLifecycleSuspension,
  type HomeSuspensionPhase,
  type HomeSuspensionOperationContext,
  type HomeResumeAuthorization,
  type HomeSuspensionRecoveryPolicy,
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

  test("closed operational admission defers restart and retains suspended truth", async () => {
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
    if (active.kind === "active") expect(active.suspension.phase).toBe("suspended");
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
    const recovered = await suspend(f, "backup-readiness", async () => { reran = true; }, "backup", "resume-only");
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
      const recovered = await suspend(f, `seed-${phase}`, async () => { runs++; return phase; }, "backup", "retry-idempotent");
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
    await expect(suspend(f, "upgrade-wrong", async () => {}, "upgrade", "authorized-upgrade-continuation")).rejects.toThrow("belongs to operation upgrade-exact");
    f.launchd.runner = f.baseRunner;
    expect((await suspend(f, "upgrade-exact", async () => {}, "upgrade", "authorized-upgrade-continuation")).kind).toBe("ready");
  });

  test("backup recovery also requires the exact operation id", async () => {
    const f = await fixture(true);
    f.launchd.runner = async (args) => args[0] === "bootout"
      ? { exitCode: 5, stdout: "", stderr: "hold" }
      : f.baseRunner(args);
    expect((await suspend(f, "backup-exact", async () => {})).kind).toBe("failed");
    await expect(suspend(f, "backup-wrong", async () => {}, "backup", "retry-idempotent")).rejects.toThrow(
      "belongs to operation backup-exact",
    );
  });

  test("resume-only recovery skips callback from suspending and suspended phases", async () => {
    for (const phase of ["suspending", "suspended"] as const) {
      const f = await fixture(true);
      f.launchd.runner = async (args) => args[0] === "bootout"
        ? { exitCode: 5, stdout: "", stderr: "crash edge" }
        : f.baseRunner(args);
      expect((await suspend(f, `resume-only-${phase}`, async () => "never")).kind).toBe("failed");
      await setPhase(f.vault, phase);
      f.launchd.runner = f.baseRunner;
      let ran = false;
      const recovered = await suspend(f, `resume-only-${phase}`, async () => { ran = true; }, "backup", "resume-only");
      expect(recovered).toMatchObject({ kind: "ready", recovered: true, operationRan: false });
      expect(ran).toBeFalse();
    }
  });

  test("upgrade can durably authorize a changed selector and plist as its exact resume target", async () => {
    const f = await fixture(true);
    const candidateId = "b".repeat(64);
    let firstRuns = 0;
    const prepared = await suspend(f, "upgrade-forward", async (context) => {
      firstRuns++;
      await writeFile(f.installation, `${JSON.stringify({
        schema: "dome.home.installation/v1",
        vault: f.vault,
        artifact: { id: candidateId, version: "2.0.0" },
        environment: [],
      })}\n`, { mode: 0o600 });
      await writeFile(f.plist, "candidate plist bytes\n", { mode: 0o600 });
      await context.authorizeCurrentHomeForResume();
      const engaged = await engageOperationalWriterBarrier({ vaultPath: f.vault, transactionId: "upgrade-forward" });
      expect(engaged.ok).toBeTrue();
      return "candidate-selected";
    }, "upgrade");
    expect(prepared.kind).toBe("deferred");
    const active = await inspectHomeLifecycleSuspension(f.vault);
    expect(active.kind).toBe("active");
    if (active.kind === "active") {
      expect(active.suspension.phase).toBe("suspended");
      expect(active.suspension.resumeArtifactId).toBe(candidateId);
      expect(active.suspension.resumeArtifactVersion).toBe("2.0.0");
    }
    await releaseOperationalWriterBarrier({
      vaultPath: f.vault,
      transactionId: "upgrade-forward",
      validateAndRemoveExternalEvidence: async () => {},
    });
    let continuationRuns = 0;
    const resumed = await suspend(f, "upgrade-forward", async () => { continuationRuns++; }, "upgrade", "authorized-upgrade-continuation");
    expect(resumed.kind).toBe("ready");
    expect(firstRuns).toBe(1);
    expect(continuationRuns).toBe(1); // explicit at-least-once continuation policy
  });

  test("external upgrade authorization seals selector committed before callback sealing", async () => {
    const f = await fixture(true);
    f.launchd.runner = async (args) => args[0] === "bootout"
      ? { exitCode: 5, stdout: "", stderr: "crash before callback" }
      : f.baseRunner(args);
    expect((await suspend(f, "upgrade-gap", async () => {}, "upgrade")).kind).toBe("failed");
    await setPhase(f.vault, "suspended");
    f.launchd.loaded.delete(f.target);
    f.launchd.runner = f.baseRunner;
    const candidateId = "d".repeat(64);
    await writeFile(f.installation, `${JSON.stringify({
      schema: "dome.home.installation/v1",
      vault: f.vault,
      artifact: { id: candidateId, version: "4.0.0" },
      environment: [],
    })}\n`, { mode: 0o600 });
    await writeFile(f.plist, "gap candidate plist\n", { mode: 0o600 });
    const recovered = await suspend(
      f,
      "upgrade-gap",
      async () => "continued",
      "upgrade",
      "authorized-upgrade-continuation",
      async () => ({
        operationId: "upgrade-gap",
        artifactId: candidateId,
        artifactVersion: "4.0.0",
        installationSha256: await fileSha(f.installation),
        plistSha256: await fileSha(f.plist),
      }),
    );
    expect(recovered).toMatchObject({ kind: "ready", value: "continued", recovered: true });
  });

  test("changed upgrade selector without durable resume authorization fails closed", async () => {
    const f = await fixture(true);
    const result = await suspend(f, "upgrade-unsealed", async () => {
      await writeFile(f.installation, `${JSON.stringify({
        schema: "dome.home.installation/v1",
        vault: f.vault,
        artifact: { id: "c".repeat(64), version: "3.0.0" },
        environment: [],
      })}\n`, { mode: 0o600 });
      return "changed";
    }, "upgrade");
    expect(result.kind).toBe("failed");
    const active = await inspectHomeLifecycleSuspension(f.vault);
    expect(active.kind).toBe("active");
    if (active.kind === "active") expect(active.suspension.phase).toBe("suspended");
  });

  test("refuses legacy Serve, foreground Home, and ambiguous launchctl probe failures before intent", async () => {
    const legacy = await fixture(true);
    await writeFile(join(legacy.agents, `com.dome.serve.${vaultServiceSlug(legacy.vault)}.plist`), "legacy\n");
    await expect(suspend(legacy, "legacy-conflict", async () => {})).rejects.toThrow("legacy dome serve");
    expect((await inspectHomeLifecycleSuspension(legacy.vault)).kind).toBe("inactive");

    const foreground = await fixture(false);
    foreground.readiness = async () => true;
    await expect(suspend(foreground, "foreground-conflict", async () => {})).rejects.toThrow("foreground Dome Home");
    expect((await inspectHomeLifecycleSuspension(foreground.vault)).kind).toBe("inactive");

    const ambiguous = await fixture(true);
    ambiguous.launchd.runner = async (args) => args[0] === "print"
      ? { exitCode: 1, stdout: "", stderr: "permission denied" }
      : ambiguous.baseRunner(args);
    await expect(suspend(ambiguous, "ambiguous-probe", async () => {})).rejects.toThrow("permission denied");
    expect((await inspectHomeLifecycleSuspension(ambiguous.vault)).kind).toBe("inactive");
  });

  test("selector or plist drift fails closed during recovery", async () => {
    for (const drift of ["selector", "plist"] as const) {
      const f = await fixture(true);
      f.readiness = async () => false;
      expect((await suspend(f, `drift-${drift}`, async () => "done")).kind).toBe("failed");
      await writeFile(drift === "selector" ? f.installation : f.plist, `${drift} changed\n`, { mode: 0o600 });
      await expect(suspend(f, `drift-${drift}`, async () => {}, "backup", "retry-idempotent")).rejects.toThrow(
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

  test("ready layout never recreates a deleted journal, ownership database, or complete pair", async () => {
    for (const active of [false, true]) {
      for (const deleted of ["journal", "ownership", "both"] as const) {
        const f = await fixture(true);
        if (active) {
          f.readiness = async () => false;
          expect((await suspend(f, `delete-${deleted}`, async () => "held")).kind).toBe("failed");
        } else {
          await withHomeLifecycleMutation(f.vault, async () => "initialized");
        }
        const journal = homeLifecycleCoordinatorPath(f.vault);
        const ownership = join(dirname(journal), "home-lifecycle-suspension-ownership.db");
        if (deleted === "journal" || deleted === "both") await unlink(journal);
        if (deleted === "ownership" || deleted === "both") await unlink(ownership);

        const inspection = await inspectHomeLifecycleSuspension(f.vault);
        expect(inspection.kind).toBe("invalid");
        let mutated = false;
        await expect(withHomeLifecycleMutation(f.vault, async () => { mutated = true; })).rejects.toThrow(/missing|ready layout/);
        expect(mutated).toBeFalse();
        expect(await pathExists(journal)).toBe(deleted === "ownership");
        expect(await pathExists(ownership)).toBe(deleted === "journal");
      }
    }
  });

  test("explicit initializing marker recovers a crash before database publication", async () => {
    const f = await fixture(false);
    const journal = homeLifecycleCoordinatorPath(f.vault);
    const storage = dirname(journal);
    await mkdir(storage, { recursive: true, mode: 0o700 });
    await chmod(storage, 0o700);
    await writeFile(join(storage, "layout.json"), `${JSON.stringify({
      schema: "dome.home-lifecycle-suspension-layout/v1",
      state: "initializing",
    })}\n`, { mode: 0o600 });
    expect((await inspectHomeLifecycleSuspension(f.vault)).kind).toBe("unavailable");
    expect((await withHomeLifecycleMutation(f.vault, async () => "recovered")).kind).toBe("owned");
    expect((await inspectHomeLifecycleSuspension(f.vault)).kind).toBe("inactive");
  });

  test("inspection distinguishes a busy coordinator from corrupt evidence", async () => {
    const f = await fixture(false);
    await withHomeLifecycleMutation(f.vault, async () => {});
    const db = new Database(homeLifecycleCoordinatorPath(f.vault));
    db.run("BEGIN EXCLUSIVE");
    try {
      const inspection = await inspectHomeLifecycleSuspension(f.vault);
      expect(inspection.kind).toBe("unavailable");
    } finally {
      db.run("ROLLBACK");
      db.close();
    }
    expect((await inspectHomeLifecycleSuspension(f.vault)).kind).toBe("inactive");
  });

  test("multiprocess first-open publishes one complete ready layout", async () => {
    const f = await fixture(false);
    const moduleUrl = pathToFileURL(resolve(import.meta.dir, "../../src/product-host/home-lifecycle-suspension.ts")).href;
    const script = `
      import { withHomeLifecycleMutation } from ${JSON.stringify(moduleUrl)};
      const result = await withHomeLifecycleMutation(process.env.DOME_TEST_VAULT, async () => {
        await Bun.sleep(10);
        return process.pid;
      });
      if (result.kind !== "owned") throw new Error("not owned");
    `;
    const children = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, DOME_TEST_VAULT: f.vault },
    }));
    const exits = await Promise.all(children.map(async (child) => ({
      code: await child.exited,
      stderr: await new Response(child.stderr).text(),
    })));
    expect(exits).toEqual(exits.map(() => ({ code: 0, stderr: "" })));
    expect((await inspectHomeLifecycleSuspension(f.vault)).kind).toBe("inactive");
  });

  test("SIGKILL releases child-held Tx2 while durable suspended recovery survives", async () => {
    const f = await fixture(true);
    const entered = join(f.root, "child-entered");
    const moduleUrl = pathToFileURL(resolve(import.meta.dir, "../../src/product-host/home-lifecycle-suspension.ts")).href;
    const script = `
      import { withSupervisedHomeSuspended } from ${JSON.stringify(moduleUrl)};
      let loaded = true;
      const target = process.env.DOME_TEST_TARGET;
      await withSupervisedHomeSuspended({
        mode: "new", vaultPath: process.env.DOME_TEST_VAULT,
        purpose: "backup", operationId: "child-crash",
      }, async () => {
        await Bun.write(process.env.DOME_TEST_ENTERED, "entered");
        await new Promise(() => {});
      }, {
        platform: "darwin", uid: 501,
        launchAgentsDir: process.env.DOME_TEST_AGENTS,
        applicationSupportDir: process.env.DOME_TEST_SUPPORT,
        drainTimeoutMs: 20, readinessTimeoutMs: 1,
        readiness: async () => false,
        legacyServeRunning: async () => false,
        launchctl: async (args) => {
          const candidate = args.at(-1) ?? "";
          if (args[0] === "print") return { exitCode: candidate === target && loaded ? 0 : 113, stdout: "", stderr: "" };
          if (args[0] === "bootout") { loaded = false; return { exitCode: 0, stdout: "", stderr: "" }; }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        DOME_TEST_VAULT: f.vault,
        DOME_TEST_TARGET: f.target,
        DOME_TEST_AGENTS: f.agents,
        DOME_TEST_SUPPORT: f.support,
        DOME_TEST_ENTERED: entered,
      },
    });
    const deadline = Date.now() + 5_000;
    while (!await pathExists(entered) && Date.now() < deadline) await Bun.sleep(10);
    expect(await pathExists(entered)).toBeTrue();
    child.kill("SIGKILL");
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    const active = await inspectHomeLifecycleSuspension(f.vault);
    expect(active.kind).toBe("active");
    if (active.kind === "active") expect(active.suspension.phase).toBe("suspended");

    f.launchd.loaded.delete(f.target);
    let reran = false;
    const recovered = await suspend(f, "child-crash", async () => { reran = true; return "recovered"; }, "backup", "retry-idempotent");
    expect(recovered).toMatchObject({ kind: "ready", value: "recovered", recovered: true });
    expect(reran).toBeTrue();
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
  operation: (context: HomeSuspensionOperationContext) => Promise<T>,
  purpose: "backup" | "upgrade" = "backup",
  recoveryPolicy: HomeSuspensionRecoveryPolicy | null = null,
  authorizeContinuation?: (() => Promise<HomeResumeAuthorization>) | undefined,
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
  const invocation = recoveryPolicy === null
    ? { mode: "new" as const, vaultPath: f.vault, purpose, operationId }
    : {
        mode: "recover" as const,
        vaultPath: f.vault,
        purpose,
        operationId,
        policy: recoveryPolicy,
        ...(recoveryPolicy === "authorized-upgrade-continuation"
          ? { authorizeContinuation: async (active: HomeLifecycleSuspension) =>
              authorizeContinuation?.() ?? {
                operationId: active.operationId,
                artifactId: active.resumeArtifactId,
                artifactVersion: active.resumeArtifactVersion,
                installationSha256: active.resumeInstallationSha256,
                plistSha256: active.resumePlistSha256,
              } }
          : {}),
      };
  return withSupervisedHomeSuspended(invocation, operation, deps);
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

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function fileSha(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
