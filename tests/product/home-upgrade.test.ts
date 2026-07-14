import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HomeArtifactManifest } from "../../src/product-host/home-artifact";
import {
  ensureManagedRelease,
  homeInstallationPaths,
} from "../../src/product-host/home-installation";
import { homeServiceLabelForVault } from "../../src/product-host/home-lifecycle";
import { inspectHomeLifecycleSuspension } from "../../src/product-host/home-lifecycle-suspension";
import {
  HomeUpgradeBusyError,
  HomeUpgradeSelectionChangedError,
  type HomeUpgradeCutoverResult,
} from "../../src/product-host/home-upgrade-cutover";
import {
  manageHomeUpgrade,
  type HomeUpgradeIntentDeps,
} from "../../src/product-host/home-upgrade";
import type {
  HomeUpgradeTransaction,
} from "../../src/product-host/home-upgrade-transaction";
import type { HomeUpgradeHistorySummary } from "../../src/product-host/home-upgrade-history";
import type { HomeLifecycleSuspensionInspection } from "../../src/product-host/home-lifecycle-suspension";

const TX = "11111111-1111-4111-8111-111111111111";
const RETAINED_TX = "22222222-2222-4222-8222-222222222222";
const OLD = "a".repeat(64);
const REQUESTED = "b".repeat(64);
const OTHER = "c".repeat(64);

describe("Home upgrade intent", () => {
  test("runs one verified candidate in closed order and returns only the public v1 shape", async () => {
    const f = intentFixture();
    const result = await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, f.deps);
    expect(result).toMatchObject({
      schema: "dome.home.upgrade/v1",
      operation: "upgrade",
      status: "upgraded",
      exitCode: 0,
      requestedArtifact: { artifactId: REQUESTED, productVersion: "2.0.0" },
      transaction: { operationId: TX, outcome: "committed" },
      selectedArtifact: { artifactId: REQUESTED, productVersion: "2.0.0" },
      recovered: false,
      service: "ready",
      reason: null,
      nextAction: "none",
    });
    expect(f.calls).toEqual([
      "canonicalize", "verify", "inspect-lifecycle", "read-active", "read-installation",
      "read-installation", "read-candidate-receipt", "publish", "uuid", "cutover", "retire",
    ]);
    expect(Object.keys(result)).toEqual([
      "schema", "operation", "status", "exitCode", "vault", "requestedArtifact",
      "transaction", "selectedArtifact", "recovered", "service", "reason", "message", "nextAction",
    ]);
    expect(JSON.stringify(result)).not.toContain("releasePath");
    expect(JSON.stringify(result)).not.toContain("snapshot");
    expect(JSON.stringify(result)).not.toContain('"phase"');
  });

  test("usage failures, current selection, and prior exact rollback allocate no operation", async () => {
    const invalidArtifact = intentFixture({ verifyError: new Error("manifest missing") });
    expect(await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, invalidArtifact.deps)).toMatchObject({
      exitCode: 64,
      requestedArtifact: null,
      reason: "preflight-failed",
    });
    expect(invalidArtifact.calls).not.toContain("read-installation");

    const missing = intentFixture({ selected: null });
    expect((await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, missing.deps)).exitCode).toBe(64);
    expect(missing.calls).not.toContain("publish");
    expect(missing.calls).not.toContain("uuid");

    const current = intentFixture({ selected: installation(REQUESTED, "2.0.0") });
    expect((await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, current.deps)).status).toBe("already-current");
    expect(current.calls).not.toContain("publish");
    expect(current.calls).not.toContain("uuid");

    const restored = historySummary("restored", TX, REQUESTED);
    const prior = intentFixture({ history: [restored] });
    const priorResult = await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, prior.deps);
    expect(priorResult).toMatchObject({ status: "rolled-back", exitCode: 1, recovered: true });
    expect(prior.calls).not.toContain("publish");
    expect(prior.calls).not.toContain("uuid");
  });

  test("refuses an artifact without the explicit supported-upgrade capability using a fixed public message", async () => {
    const unsupported = intentFixture({
      manifest: { ...manifest(), distribution: { signed: false, notarized: false, upgradeSupported: false } },
    });
    const result = await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, unsupported.deps);
    expect(result).toEqual({
      schema: "dome.home.upgrade/v1",
      operation: "upgrade",
      status: "error",
      exitCode: 64,
      vault: "/vault",
      requestedArtifact: { artifactId: REQUESTED, productVersion: "2.0.0" },
      transaction: null,
      selectedArtifact: { artifactId: OLD, productVersion: "1.0.0" },
      recovered: false,
      service: "unknown",
      reason: "preflight-failed",
      message: "invoking artifact is not upgrade-capable",
      nextAction: "inspect-home-status",
    });
    expect(unsupported.calls).not.toContain("publish");
    expect(JSON.stringify(result)).not.toContain("distribution");
    expect(JSON.stringify(result)).not.toContain("artifactRoot");
  });

  test("new attempts require a strict SemVer advance before publication or operation allocation", async () => {
    const malformed = ["v1.0.1", "=1.0.1", "01.0.1", "1.0.0-01", " 1.0.1", "1.0.1 "] as const;
    for (const [selectedVersion, candidateVersion] of [
      ["1.0.0", "1.0.0"],
      ["2.0.0", "1.9.9"],
      ...malformed.map((version) => ["1.0.0", version] as const),
      ...malformed.map((version) => [version, "2.0.0"] as const),
    ] as const) {
      const base = manifest();
      const candidate = {
        ...base,
        product: { ...base.product, version: candidateVersion },
      };
      const f = intentFixture({
        selected: installation(OLD, selectedVersion),
        manifest: candidate,
      });
      expect(await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, f.deps)).toMatchObject({
        status: "error",
        exitCode: 64,
        reason: "preflight-failed",
        message: "invoking artifact does not advance the installed SemVer version",
      });
      expect(f.calls).not.toContain("publish");
      expect(f.calls).not.toContain("uuid");
      expect(f.calls).not.toContain("cutover");
    }
  });

  test("committed repair requires the exact raw candidate fingerprint before any mutation", async () => {
    const committed = transaction("committed", RETAINED_TX, REQUESTED);
    for (const f of [
      intentFixture({
        active: committed,
        selected: installation(REQUESTED, "2.0.0"),
        inspectRepairError: new Error("raw manifest fingerprint differs"),
      }),
      intentFixture({
        active: committed,
        verifyError: new Error("invoking candidate is unavailable"),
      }),
      intentFixture({
        active: transaction("committed", RETAINED_TX, OTHER),
        selected: null,
        readForwardError: new Error("committed candidate release is missing"),
      }),
    ]) {
      const result = await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, f.deps);
      expect(result).toMatchObject({
        status: "recovery-required",
        exitCode: 1,
        reason: "candidate-repair-required",
        nextAction: "supply-exact-candidate",
        transaction: { operationId: RETAINED_TX, outcome: "committed" },
      });
      expect(f.calls).not.toContain("publish");
      expect(f.calls).not.toContain("uuid");
      expect(f.calls).not.toContain("cutover");
      expect(f.calls).not.toContain("retire");
      expect(JSON.stringify(result)).not.toContain("/artifact");
      expect(JSON.stringify(result)).not.toContain("manifestSha256");
      expect(JSON.stringify(result)).not.toContain('"phase"');
    }
  });

  test("recovers an orphan lifecycle intent by its durable id before any publication", async () => {
    const f = intentFixture({ suspension: activeSuspension(RETAINED_TX), active: null });
    const first = await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, f.deps);
    expect(first).toMatchObject({
      status: "recovered-rerun-required",
      exitCode: 1,
      recovered: true,
      reason: "prior-attempt-recovered",
      nextAction: "rerun-requested-upgrade",
    });
    expect(f.recoveredIds).toEqual([RETAINED_TX]);
    expect(f.calls).not.toContain("publish");
    expect(f.calls).not.toContain("uuid");
    expect(f.calls).not.toContain("cutover");
  });

  test("disposes a different retained attempt once and requires a rerun", async () => {
    const retained = transaction("prepared", RETAINED_TX, OTHER);
    const f = intentFixture({ active: retained, suspension: activeSuspension(RETAINED_TX) });
    const result = await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, f.deps);
    expect(result).toMatchObject({
      status: "recovered-rerun-required",
      exitCode: 1,
      transaction: { operationId: RETAINED_TX, candidate: { artifactId: OTHER }, outcome: "restored" },
      nextAction: "rerun-requested-upgrade",
    });
    expect(f.calls).toContain("cutover");
    expect(f.calls).toContain("retire");
    expect(f.calls).not.toContain("publish");
    expect(f.calls).not.toContain("uuid");
  });

  test("refuses to restore a pre-commit journal without its lifecycle suspension", async () => {
    for (const phase of ["prepared", "switching"] as const) {
      const f = intentFixture({ active: transaction(phase, RETAINED_TX, OTHER) });
      const result = await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, f.deps);
      expect(result).toMatchObject({
        status: "recovery-required",
        exitCode: 1,
        transaction: { operationId: RETAINED_TX },
        reason: "coordination-failed",
        nextAction: "retry-recovery",
      });
      expect(f.calls).not.toContain("cutover");
      expect(f.calls).not.toContain("retire");
      expect(f.calls).not.toContain("publish");
      expect(f.calls).not.toContain("uuid");
    }
  });

  test("recovers retained ownership before applying new-candidate eligibility gates", async () => {
    const f = intentFixture({
      manifest: { ...manifest(), writerBarrier: undefined, durableState: undefined } as unknown as HomeArtifactManifest,
      suspension: activeSuspension(RETAINED_TX),
      active: null,
    });
    const result = await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, f.deps);
    expect(result).toMatchObject({ status: "recovered-rerun-required", reason: "prior-attempt-recovered" });
    expect(f.recoveredIds).toEqual([RETAINED_TX]);
    expect(f.calls).not.toContain("publish");
    expect(f.calls).not.toContain("uuid");
  });

  test("distinguishes temporary lifecycle contention from corrupt lifecycle evidence", async () => {
    const unavailable = intentFixture({ suspension: { kind: "unavailable", error: "coordinator busy" } });
    expect(await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, unavailable.deps)).toMatchObject({
      status: "error",
      exitCode: 75,
      reason: "busy",
      nextAction: "rerun-requested-upgrade",
    });
    const invalid = intentFixture({ suspension: { kind: "invalid", error: "coordinator corrupt" } });
    expect(await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, invalid.deps)).toMatchObject({
      status: "recovery-required",
      exitCode: 1,
      reason: "coordination-failed",
      nextAction: "inspect-home-status",
    });
  });

  test("retires inactive terminal housekeeping before starting a different candidate", async () => {
    for (const phase of ["restored", "committed"] as const) {
      const retained = transaction(phase, RETAINED_TX, OTHER);
      const f = intentFixture({
        active: retained,
        selected: phase === "committed" ? installation(OTHER, "3.0.0") : installation(OLD, "1.0.0"),
        ...(phase === "committed" ? {
          manifest: {
            ...manifest(),
            product: { ...manifest().product, version: "4.0.0" },
          },
        } : {}),
      });
      const result = await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, f.deps);
      expect(result.status).toBe("upgraded");
      expect(f.calls.indexOf("retire")).toBeLessThan(f.calls.indexOf("publish"));
      expect(f.calls.filter((call) => call === "retire")).toHaveLength(2);
    }
  });

  test("classifies same-candidate and different-candidate selection races", async () => {
    for (const [selectedId, selectedVersion] of [
      [REQUESTED, "2.0.0"],
      [REQUESTED, "9.0.0"],
      [OTHER, "3.0.0"],
    ] as const) {
      const selected = installation(selectedId, selectedVersion);
      const f = intentFixture({
        cutoverError: new HomeUpgradeSelectionChangedError(OLD, selected),
      });
      const result = await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, f.deps);
      if (selectedId === REQUESTED && selectedVersion === "2.0.0") {
        expect(result).toMatchObject({ status: "already-current", exitCode: 0 });
      } else {
        expect(result).toMatchObject({
          status: "error",
          exitCode: 75,
          reason: "selection-changed",
          selectedArtifact: { artifactId: selectedId, productVersion: selectedVersion },
        });
      }
    }
  });

  test("classifies failures without durable recovery evidence as ordinary errors", async () => {
    for (const options of [
      { historyError: new Error("history unavailable") },
      { publishError: new Error("publication unavailable") },
    ]) {
      const f = intentFixture(options);
      const result = await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, f.deps);
      expect(result).toMatchObject({
        status: "error",
        exitCode: 1,
        transaction: null,
        reason: "coordination-failed",
      });
    }
    const retained = intentFixture({ active: transaction("prepared", RETAINED_TX, OTHER) });
    expect(await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, retained.deps)).toMatchObject({
      status: "recovery-required",
      transaction: { operationId: RETAINED_TX },
    });
  });

  test("reports the exact internal error without changing the public coordination result", async () => {
    const diagnostics: unknown[] = [];
    const failure = new Error("publication failed for a private internal path");
    const f = intentFixture({
      publishError: failure,
    });
    const result = await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, {
      ...f.deps,
      onCoordinationError: (error) => { diagnostics.push(error); },
    });
    expect(result).toMatchObject({
      status: "error",
      exitCode: 1,
      transaction: null,
      selectedArtifact: null,
      reason: "coordination-failed",
      message: "Dome Home upgrade coordination failed",
    });
    expect(JSON.stringify(result)).not.toContain("publication failed");
    expect(diagnostics).toEqual([failure]);

    const stable = await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, {
      ...f.deps,
      onCoordinationError: () => { throw new Error("observer failed"); },
    });
    expect(stable).toMatchObject({
      status: "error",
      reason: "coordination-failed",
      message: "Dome Home upgrade coordination failed",
    });
  });

  test("public handoff failures hide internals and reserve exact-candidate guidance for candidate absence", async () => {
    for (const phase of ["committed", "restored"] as const) {
      const value = transaction(phase, TX, REQUESTED);
      const transactionOutcome = phase === "committed"
        ? { kind: "committed" as const, transaction: value }
        : { kind: "rolled-back" as const, transaction: value, error: "/secret/snapshot restore failed" };
      const f = intentFixture({
        cutoverResult: {
          status: "recovery-required",
          transactionOutcome,
          handoffError: "/secret/releases/candidate barrier failed",
          lifecycle: {
            kind: "failed",
            operationId: TX,
            recovered: true,
            operationRan: true,
            error: "/secret/lifecycle journal failed",
          },
        },
      });
      const result = await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, f.deps);
      expect(result).toMatchObject({
        status: "recovery-required",
        reason: "coordination-failed",
        nextAction: "retry-recovery",
        message: "Dome Home upgrade handoff requires recovery",
      });
      expect(JSON.stringify(result)).not.toContain("/secret");
      expect(result.reason).not.toBe("candidate-repair-required");
    }
  });

  test("overlapping same-candidate intents return typed busy then converge on retry", async () => {
    const f = intentFixture({ operationIds: [TX, RETAINED_TX] });
    const original = f.operations.cutover!;
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const allowFirst = new Promise<void>((resolve) => { release = resolve; });
    let owner: string | null = null;
    f.setCutover(async (input, deps) => {
      if (owner !== null) throw new HomeUpgradeBusyError("upgrade", owner);
      owner = input.transactionId;
      entered();
      await allowFirst;
      try { return await original(input, deps); }
      finally { owner = null; }
    });

    const winnerPromise = manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, f.deps);
    await firstEntered;
    const loser = await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, f.deps);
    expect(loser).toMatchObject({ status: "error", exitCode: 75, reason: "busy" });
    release();
    expect(await winnerPromise).toMatchObject({ status: "upgraded", exitCode: 0 });
    expect(await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, f.deps)).toMatchObject({
      status: "already-current",
      exitCode: 0,
    });
  });

  test("composed intents translate real atomic lifecycle contention and retry to current", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dome-upgrade-intent-contention-")));
    try {
      const vault = join(root, "vault");
      const support = join(root, "support");
      const agents = join(root, "LaunchAgents");
      await mkdir(join(vault, ".dome", "state"), { recursive: true });
      await mkdir(agents, { recursive: true });
      const paths = homeInstallationPaths(vault, { applicationSupportDir: support });
      await mkdir(paths.installations, { recursive: true });
      const installationPath = paths.record;
      const plistPath = join(agents, `${homeServiceLabelForVault(vault)}.plist`);
      let selected = installation(OLD, "1.0.0", vault);
      await writeFile(installationPath, `${JSON.stringify(selected)}\n`, { mode: 0o600 });
      await writeFile(plistPath, `old ${OLD}\n`, { mode: 0o600 });
      expect((await inspectHomeLifecycleSuspension(vault)).kind).toBe("inactive");

      let current: HomeUpgradeTransaction | null = null;
      let operationIndex = 0;
      let intentInspections = 0;
      let releaseIntentInspections!: () => void;
      const bothIntentInspected = new Promise<void>((resolve) => { releaseIntentInspections = resolve; });
      let cutoverInspections = 0;
      let releaseCutoverInspections!: () => void;
      const bothCutoversInspected = new Promise<void>((resolve) => { releaseCutoverInspections = resolve; });
      let enteredPrepare!: () => void;
      const prepareEntered = new Promise<void>((resolve) => { enteredPrepare = resolve; });
      let releasePrepare!: () => void;
      const allowPrepare = new Promise<void>((resolve) => { releasePrepare = resolve; });
      let prepareCalls = 0;
      const deps: HomeUpgradeIntentDeps = {
        platform: "darwin",
        uid: 501,
        artifactRoot: "/artifact",
        applicationSupportDir: support,
        launchAgentsDir: agents,
        launchctl: async () => ({ exitCode: 113, stdout: "", stderr: "not loaded" }),
        drainTimeoutMs: 20,
        readinessTimeoutMs: 20,
        readiness: async () => false,
        inspectLifecycleSuspension: async (path) => {
          const observed = await inspectHomeLifecycleSuspension(path);
          cutoverInspections += 1;
          if (cutoverInspections === 2) releaseCutoverInspections();
          await bothCutoversInspected;
          return observed;
        },
        operations: {
          readInstallation: async () => selected,
          read: async () => current,
          readRecovery: async () => current,
          prepare: async (input) => {
            prepareCalls += 1;
            current = { ...transaction("prepared", input.transactionId, input.candidateArtifactId), vault };
            if (prepareCalls === 1) {
              enteredPrepare();
              await allowPrepare;
            }
            return current;
          },
          migrate: async () => current!,
          prove: async (input) => ({
            schema: "dome.home-upgrade-probation-proof/v1",
            transactionId: input.transactionId,
            readinessSchema: "dome.product.readiness/v1",
            hostState: "probation",
            artifactId: REQUESTED,
            productVersion: "2.0.0",
            vaultId: "vault-id",
            writesAdmitted: false,
            provenAt: "2026-07-13T01:00:00.000Z",
          }),
          commit: async () => {
            if (current === null) throw new Error("missing prepared transaction");
            current = { ...transaction("committed", current.transactionId, REQUESTED), vault };
            selected = installation(REQUESTED, "2.0.0", vault);
            await writeFile(installationPath, `${JSON.stringify(selected)}\n`, { mode: 0o600 });
            await writeFile(plistPath, `candidate ${REQUESTED}\n`, { mode: 0o600 });
            return current;
          },
          restore: async () => { throw new Error("unexpected restore"); },
          release: async () => current!,
          readVaultId: async () => "vault-id",
        },
        intentOperations: {
          verifyInvokingArtifact: async () => manifest(),
          publishCandidate: async () => ({ root: "/release", published: false }),
          inspectLifecycle: async (path) => {
            const observed = await inspectHomeLifecycleSuspension(path);
            intentInspections += 1;
            if (intentInspections === 2) releaseIntentInspections();
            await bothIntentInspected;
            return observed;
          },
          operationId: () => [TX, RETAINED_TX][operationIndex++]!,
          retire: async ({ transactionId }) => ({
            transaction: current ?? transaction("committed", transactionId, REQUESTED),
            retired: true,
          }),
          inspectService: async () => "stopped",
        },
      };

      const attempts = [
        manageHomeUpgrade({ action: "run", vaultPath: vault }, deps),
        manageHomeUpgrade({ action: "run", vaultPath: vault }, deps),
      ];
      await prepareEntered;
      const first = await Promise.race(attempts.map(async (attempt, index) => ({ index, result: await attempt })));
      expect(first.result).toMatchObject({ status: "error", exitCode: 75, reason: "busy" });
      releasePrepare();
      const settled = await Promise.all(attempts);
      expect(settled.filter((result) => result.status === "upgraded")).toHaveLength(1);
      expect(await manageHomeUpgrade({ action: "run", vaultPath: vault }, deps)).toMatchObject({
        status: "already-current",
        exitCode: 0,
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("same-artifact release publication loss converges on the verified winner", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dome-release-race-")));
    try {
      const source = join(root, "artifact");
      const support = join(root, "support");
      await mkdir(source);
      await writeFile(join(source, "manifest.json"), `${JSON.stringify({ id: REQUESTED })}\n`);
      const value = manifest();
      const verify = async (path: string) => {
        const parsed = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
        if (parsed.id !== REQUESTED) throw new Error("wrong artifact");
        return value;
      };
      const published = await ensureManagedRelease({
        source,
        manifest: value,
        paths: homeInstallationPaths("/vault", { applicationSupportDir: support }),
        platform: "darwin",
      }, {
        applicationSupportDir: support,
        verifyArtifact: verify,
        syncRelease: async () => {},
        publishRelease: async (staging, target) => {
          await rename(staging, target);
          throw new Error("publisher lost the success response");
        },
      });
      expect(published.published).toBeFalse();
      expect((await verify(published.root)).artifact.id).toBe(REQUESTED);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

function intentFixture(options: {
  readonly selected?: ReturnType<typeof installation> | null;
  readonly active?: HomeUpgradeTransaction | null;
  readonly history?: ReadonlyArray<HomeUpgradeHistorySummary>;
  readonly suspension?: HomeLifecycleSuspensionInspection;
  readonly cutoverError?: Error;
  readonly cutoverResult?: HomeUpgradeCutoverResult;
  readonly verifyError?: Error;
  readonly historyError?: Error;
  readonly publishError?: Error;
  readonly readForwardError?: Error;
  readonly inspectRepairError?: Error;
  readonly manifest?: HomeArtifactManifest;
  readonly operationIds?: ReadonlyArray<string>;
} = {}) {
  const calls: string[] = [];
  const recoveredIds: string[] = [];
  let operationIndex = 0;
  let selected = options.selected === undefined ? installation(OLD, "1.0.0") : options.selected;
  let active = options.active ?? null;
  const operations: NonNullable<HomeUpgradeIntentDeps["intentOperations"]> = {
    canonicalizeVault: async () => { calls.push("canonicalize"); return "/vault"; },
    verifyInvokingArtifact: async () => {
      calls.push("verify");
      if (options.verifyError !== undefined) throw options.verifyError;
      return options.manifest ?? manifest();
    },
    readInstallation: async () => { calls.push("read-installation"); return selected; },
    inspectLifecycle: async () => {
      calls.push("inspect-lifecycle");
      return options.suspension ?? { kind: "inactive" };
    },
    readActive: async () => { calls.push("read-active"); return active; },
    readCandidateReceipt: async (_vault, artifactId) => {
      calls.push("read-candidate-receipt");
      if (options.historyError !== undefined) throw options.historyError;
      return options.history?.find((summary) => summary.candidate.artifactId === artifactId) ?? null;
    },
    readForward: async () => {
      calls.push("read-forward");
      if (options.readForwardError !== undefined) throw options.readForwardError;
      return active;
    },
    inspectRepair: async () => {
      calls.push("inspect-repair");
      if (options.inspectRepairError !== undefined) throw options.inspectRepairError;
      if (active === null) throw new Error("no committed transaction");
      return active;
    },
    publishCandidate: async () => {
      calls.push("publish");
      if (options.publishError !== undefined) throw options.publishError;
      return { root: "/releases/requested", published: true };
    },
    operationId: () => {
      calls.push("uuid");
      return options.operationIds?.[operationIndex++] ?? TX;
    },
    cutover: async (input) => {
      calls.push("cutover");
      if (options.cutoverError !== undefined) throw options.cutoverError;
      if (options.cutoverResult !== undefined) return options.cutoverResult;
      expect(input.expectedCurrentArtifactId).toBe(selected!.artifact.id);
      if (active?.phase === "prepared" || active?.phase === "switching") {
        const restored = transaction("restored", active.transactionId, active.candidate.artifactId);
        active = restored;
        selected = installation(OLD, "1.0.0");
        return cutoverResult(restored, "rolled-back");
      }
      const committed = transaction("committed", input.transactionId, input.candidateArtifactId);
      selected = installation(input.candidateArtifactId, committed.candidate.version);
      active = committed;
      return cutoverResult(committed);
    },
    retire: async ({ transactionId }) => {
      calls.push("retire");
      const value = active ?? transaction("restored", transactionId, OTHER);
      active = null;
      return { transaction: value, retired: true };
    },
    recoverOrphan: async (_vault, operationId) => {
      calls.push("recover-orphan");
      recoveredIds.push(operationId);
      return { kind: "ready", operationId, recovered: true, operationRan: false };
    },
    inspectService: async () => { calls.push("inspect-service"); return "ready"; },
  };
  return {
    calls,
    recoveredIds,
    operations,
    setCutover(value: NonNullable<NonNullable<HomeUpgradeIntentDeps["intentOperations"]>["cutover"]>) {
      Object.assign(operations, { cutover: value });
    },
    deps: {
      platform: "darwin" as const,
      artifactRoot: "/artifact",
      intentOperations: operations,
    } satisfies HomeUpgradeIntentDeps,
  };
}

function installation(id: string, version: string, vault = "/vault") {
  return {
    schema: "dome.home.installation/v1" as const,
    vault,
    artifact: { id, version },
    environment: [],
  };
}

function manifest(): HomeArtifactManifest {
  return {
    artifact: { id: REQUESTED },
    product: { name: "Dome Home", version: "2.0.0" },
    writerBarrier: { protocol: 1 },
    durableState: { protocol: 1, stores: [] },
    distribution: { signed: false, notarized: false, upgradeSupported: true },
  } as unknown as HomeArtifactManifest;
}

function cutoverResult(
  value: HomeUpgradeTransaction,
  kind: "committed" | "rolled-back" = "committed",
): HomeUpgradeCutoverResult {
  const transactionOutcome = kind === "committed"
    ? { kind: "committed" as const, transaction: value }
    : { kind: "rolled-back" as const, transaction: value, error: "recovered prior upgrade" };
  return {
    status: "ready",
    transactionOutcome,
    handoffError: null,
    lifecycle: {
      kind: "ready",
      operationId: value.transactionId,
      recovered: false,
      operationRan: true,
      value: {
        transactionOutcome,
        handoffError: null,
      },
    },
  };
}

function historySummary(
  outcome: "committed" | "restored",
  operationId: string,
  candidateId: string,
): HomeUpgradeHistorySummary {
  return {
    schema: "dome.home-upgrade-terminal-summary/v1",
    operationId,
    candidate: {
      artifactId: candidateId,
      productVersion: candidateId === REQUESTED ? "2.0.0" : "3.0.0",
    },
    outcome,
    terminalAt: "2026-07-13T01:03:00.000Z",
  };
}

function transaction(
  phase: "prepared" | "switching" | "committed" | "restored",
  transactionId: string,
  candidateId: string,
): HomeUpgradeTransaction {
  return {
    schema: "dome.home-upgrade-transaction/v2",
    vault: "/vault",
    transactionId,
    phase,
    old: { artifactId: OLD, version: "1.0.0", releasePath: `/releases/${OLD}`, manifestSha256: "d".repeat(64) },
    candidate: {
      artifactId: candidateId,
      version: candidateId === REQUESTED ? "2.0.0" : "3.0.0",
      releasePath: `/releases/${candidateId}`,
      manifestSha256: "e".repeat(64),
    },
    selectors: {
      installation: { path: "/installation.json", mode: 0o600, size: 1, sha256: "1".repeat(64) },
      plist: { path: "/home.plist", mode: 0o600, size: 1, sha256: "2".repeat(64) },
    },
    selection: null,
    probation: null,
    snapshot: { root: "snapshot", inventory: [] },
    timestamps: {
      preparedAt: "2026-07-13T01:00:00.000Z",
      switchingAt: phase === "switching" || phase === "committed" ? "2026-07-13T01:01:00.000Z" : null,
      committedAt: phase === "committed" ? "2026-07-13T01:02:00.000Z" : null,
      restoredAt: phase === "restored" ? "2026-07-13T01:03:00.000Z" : null,
    },
  };
}

function activeSuspension(operationId: string) {
  return {
    kind: "active" as const,
    suspension: {
      schema: "dome.home-lifecycle-suspension/v1" as const,
      phase: "suspended" as const,
      purpose: "upgrade" as const,
      operationId,
      vault: "/vault",
      priorLoaded: true,
      installationPath: "/installation.json",
      installationSha256: "1".repeat(64),
      artifactId: OLD,
      artifactVersion: "1.0.0",
      plistPath: "/home.plist",
      plistSha256: "2".repeat(64),
      resumeInstallationPath: "/installation.json",
      resumeInstallationSha256: "1".repeat(64),
      resumeArtifactId: OLD,
      resumeArtifactVersion: "1.0.0",
      resumePlistPath: "/home.plist",
      resumePlistSha256: "2".repeat(64),
      requestedAt: "2026-07-13T01:00:00.000Z",
      phaseChangedAt: "2026-07-13T01:00:00.000Z",
      lastError: null,
    },
  };
}
