import { describe, expect, test } from "bun:test";

import { HomeLifecycleContentionError } from "../../src/product-host/home-lifecycle-suspension";
import {
  HomeUpgradeBusyError,
  HomeUpgradeSelectionChangedError,
  runHomeUpgradeCutover,
  type HomeUpgradeCutoverDeps,
} from "../../src/product-host/home-upgrade-cutover";
import type { HomeUpgradeTransaction } from "../../src/product-host/home-upgrade-transaction";

const TX = "11111111-1111-4111-8111-111111111111";
const OTHER_TX = "22222222-2222-4222-8222-222222222222";
const OLD = "a".repeat(64);
const CANDIDATE = "b".repeat(64);

describe("private Home upgrade cutover", () => {
  test("owns the exact new-attempt order through lifecycle authorization and release", async () => {
    const calls: string[] = [];
    let current: HomeUpgradeTransaction | null = null;
    const deps = fakeDeps(calls, () => current, (next) => { current = next; });
    const result = await runHomeUpgradeCutover({
      vaultPath: "/vault",
      transactionId: TX,
      candidateArtifactId: CANDIDATE,
      expectedCurrentArtifactId: OLD,
    }, deps);
    expect(result).toMatchObject({ status: "ready", transactionOutcome: { kind: "committed" }, handoffError: null });
    expect(calls).toEqual([
      "inspect", "read-recovery", "suspend:new", "read-recovery", "read-installation", "prepare", "migrate", "vault-id",
      "prove", "commit", "authorize", "release",
    ]);
  });

  test("revalidates the preflight installation under lifecycle ownership", async () => {
    const calls: string[] = [];
    let current: HomeUpgradeTransaction | null = null;
    const selectedCandidate = {
      schema: "dome.home.installation/v1" as const,
      vault: "/vault",
      artifact: { id: CANDIDATE, version: "2.0.0" },
      environment: [],
    };
    const attempt = runHomeUpgradeCutover({
      vaultPath: "/vault",
      transactionId: TX,
      candidateArtifactId: CANDIDATE,
      expectedCurrentArtifactId: OLD,
    }, fakeDeps(calls, () => current, (next) => { current = next; }, {
      readInstallation: async () => { calls.push("read-installation"); return selectedCandidate; },
    }));
    await expect(attempt).rejects.toBeInstanceOf(HomeUpgradeSelectionChangedError);
    expect(calls).not.toContain("prepare");
    expect(calls).not.toContain("restore");
  });

  test("reports typed busy ownership when another lifecycle intent is active", async () => {
    const calls: string[] = [];
    let current: HomeUpgradeTransaction | null = null;
    const exact = activeSuspension();
    const attempt = runHomeUpgradeCutover({
      vaultPath: "/vault",
      transactionId: TX,
      candidateArtifactId: CANDIDATE,
      expectedCurrentArtifactId: OLD,
    }, fakeDeps(calls, () => current, (next) => { current = next; }, {}, {
      ...exact,
      suspension: { ...exact.suspension, operationId: OTHER_TX },
    }));
    await expect(attempt).rejects.toBeInstanceOf(HomeUpgradeBusyError);
    expect(calls).toEqual(["inspect"]);
  });

  test("translates atomic lifecycle contention after an inactive preflight", async () => {
    for (const owner of [
      { purpose: "backup" as const, operationId: "backup-owner" },
      null,
    ]) {
      const calls: string[] = [];
      let current: HomeUpgradeTransaction | null = null;
      const deps = fakeDeps(calls, () => current, (next) => { current = next; });
      const attempt = runHomeUpgradeCutover({
        vaultPath: "/vault",
        transactionId: TX,
        candidateArtifactId: CANDIDATE,
        expectedCurrentArtifactId: OLD,
      }, {
        ...deps,
        suspendHome: (async () => {
          throw new HomeLifecycleContentionError(owner);
        }) as NonNullable<HomeUpgradeCutoverDeps["suspendHome"]>,
      });
      let busy: unknown;
      try { await attempt; }
      catch (error) { busy = error; }
      expect(busy).toBeInstanceOf(HomeUpgradeBusyError);
      expect(busy).toMatchObject(owner === null
        ? { purpose: null, operationId: null }
        : owner);
      expect(calls).toEqual(["inspect", "read-recovery"]);
    }
  });

  test("automatically restores any pre-commit failure before resuming N-1", async () => {
    const calls: string[] = [];
    let current: HomeUpgradeTransaction | null = null;
    const deps = fakeDeps(calls, () => current, (next) => { current = next; }, {
      prove: async () => { calls.push("prove"); throw new Error("dishonest candidate"); },
    });
    const result = await runHomeUpgradeCutover({
      vaultPath: "/vault",
      transactionId: TX,
      candidateArtifactId: CANDIDATE,
      expectedCurrentArtifactId: OLD,
    }, deps);
    expect(result).toMatchObject({
      status: "ready",
      transactionOutcome: { kind: "rolled-back", error: "dishonest candidate" },
      handoffError: null,
    });
    expect(calls).toContain("restore");
    expect(calls).not.toContain("authorize");
    expect(calls).not.toContain("release");
  });

  test("recovers prepared or switching attempts backward before lifecycle resume-only", async () => {
    for (const phase of ["prepared", "switching"] as const) {
      const calls: string[] = [];
      let current: HomeUpgradeTransaction | null = transaction(phase);
      const deps = fakeDeps(calls, () => current, (next) => { current = next; }, {}, activeSuspension());
      const result = await runHomeUpgradeCutover({
        vaultPath: "/vault",
        transactionId: TX,
        candidateArtifactId: CANDIDATE,
        expectedCurrentArtifactId: OLD,
      }, deps);
      expect(result.transactionOutcome.kind).toBe("rolled-back");
      expect(calls).toEqual(["inspect", "read-recovery", "restore", "suspend:resume-only"]);
    }
  });

  test("recovers committed attempts only forward with exact authorization", async () => {
    const calls: string[] = [];
    let current: HomeUpgradeTransaction | null = transaction("committed");
    const deps = fakeDeps(calls, () => current, (next) => { current = next; }, {}, activeSuspension());
    const result = await runHomeUpgradeCutover({
      vaultPath: "/vault",
      transactionId: TX,
      candidateArtifactId: CANDIDATE,
      expectedCurrentArtifactId: OLD,
    }, deps);
    expect(result).toMatchObject({ status: "ready", transactionOutcome: { kind: "committed" }, handoffError: null });
    expect(calls).toEqual([
      "inspect", "read-recovery", "read", "suspend:authorized-upgrade-continuation", "external-authorize",
      "read-recovery", "read", "authorize", "release",
    ]);
  });

  test("treats retained inactive terminal evidence as idempotent and rejects pre-prepare failure", async () => {
    const committedCalls: string[] = [];
    let committed: HomeUpgradeTransaction | null = transaction("committed");
    const committedResult = await runHomeUpgradeCutover({
      vaultPath: "/vault",
      transactionId: TX,
      candidateArtifactId: CANDIDATE,
      expectedCurrentArtifactId: OLD,
    }, fakeDeps(committedCalls, () => committed, (next) => { committed = next; }));
    expect(committedResult).toMatchObject({
      status: "ready",
      transactionOutcome: { kind: "committed" },
      lifecycle: { kind: "not-required", operationRan: false },
    });
    expect(committedCalls).toEqual(["inspect", "read-recovery", "read", "release"]);

    const restoredCalls: string[] = [];
    let restored: HomeUpgradeTransaction | null = transaction("restored");
    const restoredResult = await runHomeUpgradeCutover({
      vaultPath: "/vault",
      transactionId: TX,
      candidateArtifactId: CANDIDATE,
      expectedCurrentArtifactId: OLD,
    }, fakeDeps(restoredCalls, () => restored, (next) => { restored = next; }, {
      read: async () => { throw new Error("candidate payload is gone"); },
    }));
    expect(restoredResult.transactionOutcome.kind).toBe("rolled-back");
    expect(restoredCalls).toEqual(["inspect", "read-recovery"]);

    const failureCalls: string[] = [];
    let absent: HomeUpgradeTransaction | null = null;
    await expect(runHomeUpgradeCutover({
      vaultPath: "/vault",
      transactionId: TX,
      candidateArtifactId: CANDIDATE,
      expectedCurrentArtifactId: OLD,
    }, fakeDeps(failureCalls, () => absent, (next) => { absent = next; }, {
      prepare: async () => { failureCalls.push("prepare"); throw new Error("prepare failed before publication"); },
    }))).rejects.toThrow("prepare failed before publication");
    expect(failureCalls).not.toContain("restore");
  });

  test("models committed candidate loss as forward-only recovery-required state", async () => {
    for (const fault of ["missing", "corrupt"] as const) {
      const calls: string[] = [];
      let current: HomeUpgradeTransaction | null = transaction("committed");
      const result = await runHomeUpgradeCutover({
        vaultPath: "/vault",
        transactionId: TX,
        candidateArtifactId: CANDIDATE,
        expectedCurrentArtifactId: OLD,
      }, fakeDeps(calls, () => current, (next) => { current = next; }, {
        read: async () => { calls.push("read"); throw new Error(`${fault} candidate payload`); },
      }, activeSuspension()));
      expect(result).toMatchObject({
        status: "recovery-required",
        transactionOutcome: { kind: "committed", transaction: { phase: "committed" } },
        handoffError: "exact invoking committed candidate is required for forward repair",
        lifecycle: { kind: "failed", operationRan: false },
      });
      expect(calls).toEqual(["inspect", "read-recovery", "read"]);
      expect(calls).not.toContain("restore");
    }
  });

  test("retains the real suspended lifecycle result when a committed candidate vanishes during recovery", async () => {
    const calls: string[] = [];
    let current: HomeUpgradeTransaction | null = transaction("committed");
    let strictReads = 0;
    const base = fakeDeps(calls, () => current, (next) => { current = next; }, {
      read: async () => {
        calls.push("read");
        strictReads += 1;
        if (strictReads === 1) return current;
        throw new Error("candidate vanished after suspension");
      },
    }, activeSuspension());
    const deps: HomeUpgradeCutoverDeps = {
      ...base,
      suspendHome: (async (invocation, operation) => {
        calls.push("suspend:authorized-upgrade-continuation");
        if (invocation.mode !== "recover") throw new Error("expected recovery");
        await invocation.authorizeContinuation!(activeSuspension().suspension);
        calls.push("external-authorize");
        const value = await operation({
          operationId: TX,
          purpose: "upgrade",
          authorizeCurrentHomeForResume: async () => { calls.push("authorize"); },
        });
        return {
          kind: "deferred",
          reason: "write-barrier-closed",
          transactionId: TX,
          operationId: TX,
          recovered: true,
          operationRan: true,
          value,
        };
      }) as NonNullable<HomeUpgradeCutoverDeps["suspendHome"]>,
    };
    const result = await runHomeUpgradeCutover({
      vaultPath: "/vault",
      transactionId: TX,
      candidateArtifactId: CANDIDATE,
      expectedCurrentArtifactId: OLD,
    }, deps);
    expect(result).toMatchObject({
      status: "recovery-required",
      transactionOutcome: { kind: "committed" },
      handoffError: "candidate vanished after suspension",
      lifecycle: { kind: "deferred", operationRan: true },
    });
    expect(calls).not.toContain("restore");
  });

  test("repair success with release failure remains committed and retries only forward", async () => {
    const calls: string[] = [];
    let current: HomeUpgradeTransaction | null = transaction("committed");
    let repaired = false;
    let failRelease = true;
    const deps = fakeDeps(calls, () => current, (next) => { current = next; }, {
      read: async () => {
        calls.push("read");
        if (!repaired) throw new Error("candidate is incomplete");
        return current;
      },
      repair: async () => {
        calls.push("repair");
        repaired = true;
        return current!;
      },
      release: async () => {
        calls.push("release");
        if (failRelease) throw new Error("barrier release failed after repair");
        return current!;
      },
    }, activeSuspension());
    const input = {
      vaultPath: "/vault",
      transactionId: TX,
      candidateArtifactId: CANDIDATE,
      expectedCurrentArtifactId: OLD,
      repairCandidate: {
        source: "/candidate",
        manifest: { artifact: { id: CANDIDATE }, product: { version: "2.0.0" } } as never,
      },
    };

    const first = await runHomeUpgradeCutover(input, deps);
    expect(first).toMatchObject({
      status: "recovery-required",
      transactionOutcome: { kind: "committed" },
      handoffError: "barrier release failed after repair",
    });
    expect(calls).toContain("repair");
    expect(calls).not.toContain("restore");

    failRelease = false;
    calls.length = 0;
    const retry = await runHomeUpgradeCutover(input, deps);
    expect(retry).toMatchObject({
      status: "ready",
      transactionOutcome: { kind: "committed" },
      handoffError: null,
    });
    expect(calls).not.toContain("repair");
    expect(calls).not.toContain("restore");
  });

  test("keeps durable disposition separate from handoff and lifecycle readiness", async () => {
    const handoffCalls: string[] = [];
    let handoffCurrent: HomeUpgradeTransaction | null = null;
    const handoffResult = await runHomeUpgradeCutover({
      vaultPath: "/vault",
      transactionId: TX,
      candidateArtifactId: CANDIDATE,
      expectedCurrentArtifactId: OLD,
    }, fakeDeps(handoffCalls, () => handoffCurrent, (next) => { handoffCurrent = next; }, {
      release: async () => { handoffCalls.push("release"); throw new Error("barrier release failed"); },
    }));
    expect(handoffResult).toMatchObject({
      status: "recovery-required",
      transactionOutcome: { kind: "committed" },
      handoffError: "barrier release failed",
      lifecycle: { kind: "ready" },
    });

    const lifecycleCalls: string[] = [];
    let lifecycleCurrent: HomeUpgradeTransaction | null = null;
    const lifecycleBase = fakeDeps(
      lifecycleCalls,
      () => lifecycleCurrent,
      (next) => { lifecycleCurrent = next; },
    );
    const lifecycleDeps: HomeUpgradeCutoverDeps = {
      ...lifecycleBase,
      suspendHome: (async (_invocation, operation) => {
        lifecycleCalls.push("suspend:new");
        const value = await operation({
          operationId: TX,
          purpose: "upgrade",
          authorizeCurrentHomeForResume: async () => { lifecycleCalls.push("authorize"); },
        });
        return {
          kind: "failed",
          operationId: TX,
          recovered: false,
          operationRan: true,
          value,
          error: "candidate readiness failed",
        };
      }) as NonNullable<HomeUpgradeCutoverDeps["suspendHome"]>,
    };
    const lifecycleResult = await runHomeUpgradeCutover({
      vaultPath: "/vault",
      transactionId: TX,
      candidateArtifactId: CANDIDATE,
      expectedCurrentArtifactId: OLD,
    }, lifecycleDeps);
    expect(lifecycleResult).toMatchObject({
      status: "recovery-required",
      transactionOutcome: { kind: "committed" },
      handoffError: null,
      lifecycle: { kind: "failed", error: "candidate readiness failed" },
    });
  });
});

function fakeDeps(
  calls: string[],
  read: () => HomeUpgradeTransaction | null,
  set: (value: HomeUpgradeTransaction) => void,
  overrides: Partial<NonNullable<HomeUpgradeCutoverDeps["operations"]>> = {},
  suspension: Awaited<ReturnType<NonNullable<HomeUpgradeCutoverDeps["inspectLifecycleSuspension"]>>> = { kind: "inactive" },
): HomeUpgradeCutoverDeps {
  const operations: NonNullable<HomeUpgradeCutoverDeps["operations"]> = {
    readInstallation: async () => {
      calls.push("read-installation");
      return {
        schema: "dome.home.installation/v1",
        vault: "/vault",
        artifact: { id: OLD, version: "1.0.0" },
        environment: [],
      };
    },
    read: async () => { calls.push("read"); return read(); },
    readDisposition: async () => { calls.push("read-recovery"); return read(); },
    readRecovery: async () => { calls.push("read-recovery"); return read(); },
    inspectRepair: async () => { calls.push("inspect-repair"); return read()!; },
    repair: async () => { calls.push("repair"); return read()!; },
    prepare: async () => { calls.push("prepare"); const value = transaction("prepared"); set(value); return value; },
    migrate: async () => { calls.push("migrate"); return read()!; },
    prove: async (input) => {
      calls.push("prove");
      return {
        schema: "dome.home-upgrade-probation-proof/v1",
        transactionId: input.transactionId,
        readinessSchema: "dome.product.readiness/v1",
        hostState: "probation",
        artifactId: CANDIDATE,
        productVersion: "2.0.0",
        vaultId: "vault-id",
        writesAdmitted: false,
        provenAt: "2026-07-13T01:00:00.000Z",
      };
    },
    commit: async () => { calls.push("commit"); const value = transaction("committed"); set(value); return value; },
    restore: async () => { calls.push("restore"); const value = transaction("restored"); set(value); return value; },
    release: async () => { calls.push("release"); return read()!; },
    readVaultId: async () => { calls.push("vault-id"); return "vault-id"; },
    ...overrides,
  };
  const suspendHome = (async (invocation: Parameters<NonNullable<HomeUpgradeCutoverDeps["suspendHome"]>>[0], operation: Parameters<NonNullable<HomeUpgradeCutoverDeps["suspendHome"]>>[1]) => {
    calls.push(`suspend:${invocation.mode === "new" ? "new" : invocation.mode === "repair" ? "repair" : invocation.policy}`);
    if (invocation.mode === "repair") {
      await invocation.authorizeContinuation(activeSuspension().suspension);
      calls.push("external-authorize");
    }
    if (invocation.mode === "recover" && invocation.policy === "authorized-upgrade-continuation") {
      await invocation.authorizeContinuation!(activeSuspension().suspension);
      calls.push("external-authorize");
    }
    if (invocation.mode === "recover" && invocation.policy === "resume-only") {
      return { kind: "ready", operationId: TX, recovered: true, operationRan: false };
    }
    const value = await operation({
      operationId: TX,
      purpose: "upgrade",
      authorizeCurrentHomeForResume: async () => { calls.push("authorize"); },
    });
    return { kind: "ready", operationId: TX, recovered: invocation.mode !== "new", operationRan: true, value };
  }) as NonNullable<HomeUpgradeCutoverDeps["suspendHome"]>;
  return {
    operations,
    suspendHome,
    inspectLifecycleSuspension: async () => { calls.push("inspect"); return suspension; },
  };
}

function transaction(phase: "prepared" | "switching" | "committed" | "restored"): HomeUpgradeTransaction {
  const installation = { path: "/installation.json", mode: 0o600, size: 3, sha256: "c".repeat(64), stored: "selectors/candidate-installation.json" as const };
  const plist = { path: "/home.plist", mode: 0o600, size: 3, sha256: "d".repeat(64), stored: "selectors/candidate.plist" as const };
  return {
    schema: "dome.home-upgrade-transaction/v2",
    vault: "/vault",
    transactionId: TX,
    phase,
    old: { artifactId: OLD, version: "1.0.0", releasePath: `/releases/${OLD}`, manifestSha256: "e".repeat(64) },
    candidate: { artifactId: CANDIDATE, version: "2.0.0", releasePath: `/releases/${CANDIDATE}`, manifestSha256: "f".repeat(64) },
    selectors: {
      installation: { path: "/installation.json", mode: 0o600, size: 3, sha256: "1".repeat(64) },
      plist: { path: "/home.plist", mode: 0o600, size: 3, sha256: "2".repeat(64) },
    },
    selection: {
      old: {
        installation: { ...installation, sha256: "1".repeat(64), stored: "selectors/old-installation.json" },
        plist: { ...plist, sha256: "2".repeat(64), stored: "selectors/old.plist" },
      },
      candidate: { installation, plist },
    },
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

function activeSuspension() {
  return {
    kind: "active" as const,
    suspension: {
      schema: "dome.home-lifecycle-suspension/v1" as const,
      phase: "suspended" as const,
      purpose: "upgrade" as const,
      operationId: TX,
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
