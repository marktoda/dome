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
import { homeInstallationPaths, releaseRoot } from "../../src/product-host/home-installation";
import {
  acquireHomeStartupAdmission,
  homeLifecycleCoordinatorPath,
  HomeLifecycleContentionError,
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
  type HomeStartupAdmissionDeps,
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
  test("a recovery caller never recreates a suspension another caller already cleared", async () => {
    const f = await fixture(true);
    await expect(suspend(
      f,
      "already-cleared",
      async () => "must not run",
      "backup",
      "resume-only",
    )).rejects.toThrow("is no longer active");
  });

  test("simultaneous recoverers serialize and only one clears retained lifecycle truth", async () => {
    const f = await fixture(true);
    f.readiness = async () => false;
    expect((await suspend(f, "racing-recovery", async () => "seed")).kind).toBe("failed");
    expect((await inspectHomeLifecycleSuspension(f.vault)).kind).toBe("active");
    f.readiness = async () => true;

    const results = await Promise.allSettled(Array.from({ length: 2 }, () => suspend(
      f,
      "racing-recovery",
      async () => "must not rerun",
      "backup",
      "resume-only",
    )));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results.find((result) => result.status === "fulfilled");
    if (winner?.status === "fulfilled") expect(winner.value.kind).toBe("ready");
    expect((await inspectHomeLifecycleSuspension(f.vault)).kind).toBe("inactive");
  });

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

  test("reports the durable owner when a concurrent suspension reaches the atomic seam", async () => {
    const f = await fixture(true);
    let entered!: () => void;
    const callbackEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = suspend(f, "owning-backup", async () => {
      entered();
      await gate;
      return "done";
    });
    await callbackEntered;

    let contention: unknown;
    try {
      await suspend(f, "competing-upgrade", async () => "must-not-run", "upgrade");
    } catch (error) {
      contention = error;
    } finally {
      release();
    }
    expect(contention).toBeInstanceOf(HomeLifecycleContentionError);
    expect(contention).toMatchObject({
      owner: { purpose: "backup", operationId: "owning-backup" },
    });
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

  test("immutable establishment evidence prevents whole-root state loss", async () => {
    for (const active of [false, true]) {
      const f = await fixture(true);
      if (active) {
        f.readiness = async () => false;
        expect((await suspend(f, "whole-root-active", async () => "held")).kind).toBe("failed");
      } else {
        expect((await withHomeLifecycleMutation(f.vault, async () => "initialized")).kind).toBe("owned");
      }
      const root = dirname(homeLifecycleCoordinatorPath(f.vault));
      await rm(root, { recursive: true });

      expect((await inspectHomeLifecycleSuspension(f.vault)).kind).toBe("invalid");
      let mutated = false;
      await expect(withHomeLifecycleMutation(f.vault, async () => { mutated = true; })).rejects.toThrow(
        "established Home lifecycle coordinator root is missing",
      );
      expect(mutated).toBeFalse();
      expect(await pathExists(root)).toBeFalse();
    }
  });

  test("only an exact empty root may finish the establishment crash gap", async () => {
    const empty = await fixture(false);
    await withHomeLifecycleMutation(empty.vault, async () => "initialized");
    const emptyRoot = dirname(homeLifecycleCoordinatorPath(empty.vault));
    const emptySentinel = join(dirname(emptyRoot), "home-lifecycle-suspension.established");
    await rm(emptySentinel, { recursive: true });
    expect((await inspectHomeLifecycleSuspension(empty.vault)).kind).toBe("unavailable");
    expect((await withHomeLifecycleMutation(empty.vault, async () => "recovered")).kind).toBe("owned");
    expect(await pathExists(emptySentinel)).toBeTrue();

    const active = await fixture(true);
    active.readiness = async () => false;
    expect((await suspend(active, "missing-sentinel-active", async () => "held")).kind).toBe("failed");
    const activeRoot = dirname(homeLifecycleCoordinatorPath(active.vault));
    const activeSentinel = join(dirname(activeRoot), "home-lifecycle-suspension.established");
    await rm(activeSentinel, { recursive: true });
    expect((await inspectHomeLifecycleSuspension(active.vault)).kind).toBe("invalid");
    let mutated = false;
    await expect(withHomeLifecycleMutation(active.vault, async () => { mutated = true; })).rejects.toThrow(
      "active Home lifecycle coordinator is missing immutable establishment evidence",
    );
    expect(mutated).toBeFalse();

    const substituted = await fixture(false);
    await withHomeLifecycleMutation(substituted.vault, async () => "initialized");
    const substitutedRoot = dirname(homeLifecycleCoordinatorPath(substituted.vault));
    const substitutedMarker = join(dirname(substitutedRoot), "home-lifecycle-suspension.established", "layout.json");
    await writeFile(substitutedMarker, `${JSON.stringify({
      schema: "dome.home-lifecycle-suspension-establishment/v1",
      layoutId: "f".repeat(32),
    })}\n`, { mode: 0o600 });
    expect((await inspectHomeLifecycleSuspension(substituted.vault)).kind).toBe("invalid");
    await expect(withHomeLifecycleMutation(substituted.vault, async () => "never")).rejects.toThrow("layout id does not match");
  });

  test("concurrent establishment converges when an active row appears during validation", async () => {
    const f = await fixture(true);
    await withHomeLifecycleMutation(f.vault, async () => "initialized");
    const root = dirname(homeLifecycleCoordinatorPath(f.vault));
    const sentinel = join(dirname(root), "home-lifecycle-suspension.established");
    await rm(sentinel, { recursive: true });

    let validationEntered!: () => void;
    const validating = new Promise<void>((resolve) => { validationEntered = resolve; });
    let releaseValidation!: () => void;
    const validationGate = new Promise<void>((resolve) => { releaseValidation = resolve; });
    const concurrentMutation = withHomeLifecycleMutation(f.vault, async () => "must-not-run", {
      beforeEstablishmentJournalRead: async () => {
        validationEntered();
        await validationGate;
      },
    });
    await validating;

    let intentCommitted!: () => void;
    const committed = new Promise<void>((resolve) => { intentCommitted = resolve; });
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holder = withSupervisedHomeSuspended({
      mode: "new",
      vaultPath: f.vault,
      purpose: "backup",
      operationId: "establishment-race",
    }, async () => "snapshot", {
      platform: "darwin",
      uid: 501,
      launchAgentsDir: f.agents,
      launchctl: (...args) => f.launchd.runner(...args),
      drainTimeoutMs: 20,
      readinessTimeoutMs: 1,
      readiness: () => f.readiness(),
      applicationSupportDir: f.support,
      checkpoint: async (name) => {
        if (name !== "intent-committed") return;
        intentCommitted();
        await holderGate;
      },
    });
    await committed;
    releaseValidation();
    expect((await concurrentMutation).kind).toBe("suspended");
    releaseHolder();
    expect((await holder).kind).toBe("ready");
    expect((await inspectHomeLifecycleSuspension(f.vault)).kind).toBe("inactive");
  });

  test("prepublication crash debris never becomes a partial public layout", async () => {
    const f = await fixture(false);
    const journal = homeLifecycleCoordinatorPath(f.vault);
    const storage = dirname(journal);
    const debris = join(dirname(storage), ".home-lifecycle-suspension.init-crashed-child");
    await mkdir(debris, { recursive: true, mode: 0o700 });
    await writeFile(join(debris, "layout.json"), `${JSON.stringify({
      schema: "dome.home-lifecycle-suspension-layout/v1",
      state: "ready",
    })}\n`, { mode: 0o600 });
    await writeFile(join(debris, "home-lifecycle-suspension-ownership.db"), "partial bytes", { mode: 0o600 });
    expect(await pathExists(storage)).toBeFalse();
    expect((await inspectHomeLifecycleSuspension(f.vault)).kind).toBe("inactive");
    expect((await withHomeLifecycleMutation(f.vault, async () => "recovered")).kind).toBe("owned");
    expect((await inspectHomeLifecycleSuspension(f.vault)).kind).toBe("inactive");
    expect(await pathExists(debris)).toBeTrue();
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
    const moduleUrl = pathToFileURL(resolve(import.meta.dir, "../../src/product-host/home-lifecycle-suspension.ts")).href;
    const script = `
      import { withHomeLifecycleMutation } from ${JSON.stringify(moduleUrl)};
      const result = await withHomeLifecycleMutation(process.env.DOME_TEST_VAULT, async () => {
        await Bun.sleep(10);
        return process.pid;
      });
      if (result.kind !== "owned") throw new Error("not owned");
    `;
    for (let round = 0; round < 4; round++) {
      const f = await fixture(false);
      const children = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, "-e", script], {
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
    }
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

  test("SIGKILL recovery is exact at intent, callback-returned, and readiness-proven windows", async () => {
    const moduleUrl = pathToFileURL(resolve(import.meta.dir, "../../src/product-host/home-lifecycle-suspension.ts")).href;
    const script = `
      import { withSupervisedHomeSuspended } from ${JSON.stringify(moduleUrl)};
      let loaded = true;
      const target = process.env.DOME_TEST_TARGET;
      await withSupervisedHomeSuspended({
        mode: "new", vaultPath: process.env.DOME_TEST_VAULT,
        purpose: "backup", operationId: process.env.DOME_TEST_OPERATION,
      }, async () => "effect-returned", {
        platform: "darwin", uid: 501,
        launchAgentsDir: process.env.DOME_TEST_AGENTS,
        applicationSupportDir: process.env.DOME_TEST_SUPPORT,
        drainTimeoutMs: 20, readinessTimeoutMs: 20,
        readiness: async () => loaded,
        legacyServeRunning: async () => false,
        checkpoint: async (name) => {
          if (name !== process.env.DOME_TEST_CHECKPOINT) return;
          await Bun.write(process.env.DOME_TEST_ENTERED, name);
          await new Promise(() => {});
        },
        launchctl: async (args) => {
          const candidate = args.at(-1) ?? "";
          if (args[0] === "print") return { exitCode: candidate === target && loaded ? 0 : 113, stdout: "", stderr: "" };
          if (args[0] === "bootout") { loaded = false; return { exitCode: 0, stdout: "", stderr: "" }; }
          if (args[0] === "bootstrap" || args[0] === "kickstart") { loaded = true; return { exitCode: 0, stdout: "", stderr: "" }; }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });
    `;
    const cases = [
      { checkpoint: "intent-committed", phase: "suspending", parentLoaded: true },
      { checkpoint: "callback-returned", phase: "suspended", parentLoaded: false },
      { checkpoint: "readiness-proven", phase: "resuming", parentLoaded: true },
    ] as const;
    for (const item of cases) {
      const f = await fixture(true);
      const operationId = `crash-${item.checkpoint}`;
      const entered = join(f.root, `${item.checkpoint}.entered`);
      const child = Bun.spawn([process.execPath, "-e", script], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          DOME_TEST_VAULT: f.vault,
          DOME_TEST_TARGET: f.target,
          DOME_TEST_AGENTS: f.agents,
          DOME_TEST_SUPPORT: f.support,
          DOME_TEST_OPERATION: operationId,
          DOME_TEST_CHECKPOINT: item.checkpoint,
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
      if (active.kind === "active") expect(active.suspension.phase).toBe(item.phase);

      item.parentLoaded ? f.launchd.loaded.add(f.target) : f.launchd.loaded.delete(f.target);
      let reran = false;
      const callsBeforeRecovery = f.launchd.calls.length;
      const recovered = await suspend(f, operationId, async () => { reran = true; }, "backup", "resume-only");
      expect(recovered).toMatchObject({ kind: "ready", recovered: true, operationRan: false });
      expect(reran).toBeFalse();
      if (item.checkpoint === "readiness-proven") {
        const recoveryMutations = f.launchd.calls.slice(callsBeforeRecovery)
          .filter(([verb]) => verb === "bootout" || verb === "bootstrap" || verb === "kickstart");
        expect(recoveryMutations).toEqual([]);
      }
      expect((await inspectHomeLifecycleSuspension(f.vault)).kind).toBe("inactive");
    }
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

  test("inactive startup atomically acquires and returns a lifetime operational lease", async () => {
    const f = await fixture(false);
    const admitted = await acquireHomeStartupAdmission({
      vaultPath: f.vault,
      launchArtifact: { id: "development", version: "0.1.0-dev" },
    });
    expect(admitted.ok).toBeTrue();
    if (!admitted.ok) return;

    let barrierSettled = false;
    const barrier = engageOperationalWriterBarrier({
      vaultPath: f.vault,
      transactionId: "startup-lifetime",
    }).then((value) => { barrierSettled = true; return value; });
    await Bun.sleep(20);
    expect(barrierSettled).toBeFalse();
    admitted.lease.close();
    const engaged = await barrier;
    expect(engaged.ok).toBeTrue();
    await releaseOperationalWriterBarrier({
      vaultPath: f.vault,
      transactionId: "startup-lifetime",
      validateAndRemoveExternalEvidence: async () => {},
    });
  });

  test("inactive read and operational acquisition are one lifecycle-owned decision", async () => {
    const f = await fixture(true);
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const startup = acquireHomeStartupAdmission({
      vaultPath: f.vault,
      launchArtifact: { id: "development", version: "0.1.0-dev" },
    }, {
      beforeInactiveOperationalLease: async () => { entered(); await gate; },
    });
    await inside;

    let callbackRan = false;
    const suspension = suspend(f, "startup-race", async () => { callbackRan = true; }, "backup");
    await Bun.sleep(20);
    expect(callbackRan).toBeFalse();
    release();
    const admitted = await startup;
    expect(admitted.ok).toBeTrue();
    if (admitted.ok) admitted.lease.close();
    await suspension;
    expect(callbackRan).toBeTrue();
  });

  test("closed operational admission and non-resuming phases deny startup", async () => {
    const blocked = await fixture(false);
    const transactionId = "startup-closed";
    expect((await engageOperationalWriterBarrier({ vaultPath: blocked.vault, transactionId })).ok).toBeTrue();
    const denied = await acquireHomeStartupAdmission({
      vaultPath: blocked.vault,
      launchArtifact: { id: "development", version: "0.1.0-dev" },
    });
    expect(denied).toMatchObject({ ok: false, error: { kind: "operational-admission-closed" } });
    await releaseOperationalWriterBarrier({
      vaultPath: blocked.vault,
      transactionId,
      validateAndRemoveExternalEvidence: async () => {},
    });

    for (const phase of ["suspending", "suspended"] as const) {
      const f = await fixture(true);
      await seedResuming(f, `startup-${phase}`);
      await setPhase(f.vault, phase);
      const phaseDenied = await acquireHomeStartupAdmission({
        vaultPath: f.vault,
        launchArtifact: { id: f.artifactId, version: f.artifactVersion },
      }, startupDeps(f));
      expect(phaseDenied).toMatchObject({
        ok: false,
        error: { kind: "lifecycle-closed", operationId: `startup-${phase}` },
      });
    }
  });

  test("only exact verified resuming artifact provenance receives a lease", async () => {
    const exact = await fixture(true);
    await seedResuming(exact, "startup-exact");
    const admitted = await acquireHomeStartupAdmission({
      vaultPath: exact.vault,
      launchArtifact: { id: exact.artifactId, version: exact.artifactVersion },
    }, startupDeps(exact));
    expect(admitted.ok).toBeTrue();
    if (admitted.ok) admitted.lease.close();

    const development = await fixture(true);
    await seedResuming(development, "startup-development");
    expect(await acquireHomeStartupAdmission({
      vaultPath: development.vault,
      launchArtifact: { id: "development", version: development.artifactVersion },
    }, startupDeps(development))).toMatchObject({
      ok: false,
      error: { kind: "resume-evidence-invalid", operationId: "startup-development" },
    });

    const priorStopped = await fixture(true);
    await seedResuming(priorStopped, "startup-prior-stopped");
    const db = new Database(homeLifecycleCoordinatorPath(priorStopped.vault));
    try { db.run("UPDATE home_lifecycle_suspension SET prior_loaded = 0"); }
    finally { db.close(); }
    expect(await acquireHomeStartupAdmission({
      vaultPath: priorStopped.vault,
      launchArtifact: { id: priorStopped.artifactId, version: priorStopped.artifactVersion },
    }, startupDeps(priorStopped))).toMatchObject({
      ok: false,
      error: { kind: "resume-evidence-invalid", operationId: "startup-prior-stopped" },
    });
  });

  test("resuming startup rejects artifact, selector, plist, runtime, and entrypoint mismatch", async () => {
    for (const mismatch of ["artifact", "selector", "plist", "runtime", "entrypoint"] as const) {
      const f = await fixture(true);
      await seedResuming(f, `startup-mismatch-${mismatch}`);
      const deps = { ...startupDeps(f) };
      let artifact = { id: f.artifactId, version: f.artifactVersion };
      if (mismatch === "artifact") artifact = { ...artifact, id: "b".repeat(64) };
      if (mismatch === "selector") await writeFile(f.installation, "{}\n", { mode: 0o600 });
      if (mismatch === "plist") await writeFile(f.plist, "changed plist\n", { mode: 0o600 });
      if (mismatch === "runtime") deps.invokingRuntimePath = f.entrypoint;
      if (mismatch === "entrypoint") deps.invokingEntrypointPath = f.runtime;
      const denied = await acquireHomeStartupAdmission({ vaultPath: f.vault, launchArtifact: artifact }, deps);
      expect(denied).toMatchObject({
        ok: false,
        error: { kind: "resume-evidence-invalid", operationId: `startup-mismatch-${mismatch}` },
      });
    }
  });

  test("resuming startup revalidates exact evidence after operational acquisition", async () => {
    for (const drift of ["row", "plist"] as const) {
      const f = await fixture(true);
      const operationId = `startup-revalidate-${drift}`;
      await seedResuming(f, operationId);
      const denied = await acquireHomeStartupAdmission({
        vaultPath: f.vault,
        launchArtifact: { id: f.artifactId, version: f.artifactVersion },
      }, startupDeps(f, {
        afterResumingOperationalLease: async () => {
          if (drift === "plist") {
            await writeFile(f.plist, "changed after lease\n", { mode: 0o600 });
          } else {
            const db = new Database(homeLifecycleCoordinatorPath(f.vault));
            try { db.run("UPDATE home_lifecycle_suspension SET last_error = 'changed after lease'"); }
            finally { db.close(); }
          }
        },
      }));
      expect(denied).toMatchObject({
        ok: false,
        error: { kind: "resume-evidence-invalid", operationId },
      });
      const transactionId = `startup-revalidate-released-${drift}`;
      expect((await engageOperationalWriterBarrier({ vaultPath: f.vault, transactionId })).ok).toBeTrue();
      await releaseOperationalWriterBarrier({
        vaultPath: f.vault,
        transactionId,
        validateAndRemoveExternalEvidence: async () => {},
      });
    }
  });

  test("startup aliases share lifecycle and operational identity", async () => {
    const f = await fixture(false);
    const alias = join(f.root, "vault-alias");
    await symlink(f.vault, alias);
    const admitted = await acquireHomeStartupAdmission({
      vaultPath: alias,
      launchArtifact: { id: "development", version: "0.1.0-dev" },
    });
    expect(admitted.ok).toBeTrue();
    if (!admitted.ok) return;
    let settled = false;
    const barrier = engageOperationalWriterBarrier({
      vaultPath: f.vault,
      transactionId: "startup-alias",
    }).then((value) => { settled = true; return value; });
    await Bun.sleep(20);
    expect(settled).toBeFalse();
    admitted.lease.close();
    expect((await barrier).ok).toBeTrue();
    await releaseOperationalWriterBarrier({
      vaultPath: alias,
      transactionId: "startup-alias",
      validateAndRemoveExternalEvidence: async () => {},
    });
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
  const artifactId = "a".repeat(64);
  const artifactVersion = "1.0.0";
  const release = releaseRoot(paths, artifactId);
  const runtime = join(release, "runtime", "bun");
  const entrypoint = join(release, "app", "bin", "dome");
  await mkdir(dirname(runtime), { recursive: true });
  await mkdir(dirname(entrypoint), { recursive: true });
  await writeFile(runtime, "test bun runtime\n", { mode: 0o700 });
  await writeFile(entrypoint, "test Dome entrypoint\n", { mode: 0o700 });
  const installation = paths.record;
  await writeFile(installation, `${JSON.stringify({
    schema: "dome.home.installation/v1",
    vault,
    artifact: { id: artifactId, version: artifactVersion },
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
    artifactId, artifactVersion, release, runtime, entrypoint,
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

function startupDeps(
  f: Fixture,
  overrides: Partial<HomeStartupAdmissionDeps> = {},
): HomeStartupAdmissionDeps {
  return {
    applicationSupportDir: f.support,
    launchAgentsDir: f.agents,
    invokingRuntimePath: f.runtime,
    invokingEntrypointPath: f.entrypoint,
    verifyArtifact: async (root) => {
      if (root !== f.release) throw new Error("unexpected managed release path");
      return {
        artifact: { id: f.artifactId },
        product: { version: f.artifactVersion },
      } as never;
    },
    ...overrides,
  };
}

async function seedResuming(f: Fixture, operationId: string): Promise<void> {
  f.readiness = async () => false;
  const result = await suspend(f, operationId, async () => "done");
  expect(result.kind).toBe("failed");
  const active = await inspectHomeLifecycleSuspension(f.vault);
  expect(active).toMatchObject({ kind: "active", suspension: { phase: "resuming", operationId } });
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
