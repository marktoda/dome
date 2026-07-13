import { describe, expect, test } from "bun:test";

import {
  runHomeUpgradeCutover,
  type HomeUpgradeCutoverDeps,
} from "../../src/product-host/home-upgrade-cutover";
import type { HomeUpgradeTransaction } from "../../src/product-host/home-upgrade-transaction";

const TX = "11111111-1111-4111-8111-111111111111";
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
    }, deps);
    expect(result.outcome.kind).toBe("committed");
    expect(calls).toEqual([
      "inspect", "read-recovery", "suspend:new", "read-recovery", "prepare", "migrate", "vault-id",
      "prove", "commit", "authorize", "release",
    ]);
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
    }, deps);
    expect(result.outcome).toMatchObject({ kind: "rolled-back", error: "dishonest candidate" });
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
      }, deps);
      expect(result.outcome.kind).toBe("rolled-back");
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
    }, deps);
    expect(result.outcome.kind).toBe("committed");
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
    }, fakeDeps(committedCalls, () => committed, (next) => { committed = next; }));
    expect(committedResult).toMatchObject({
      outcome: { kind: "committed" },
      lifecycle: { kind: "not-required", operationRan: false },
    });
    expect(committedCalls).toEqual(["inspect", "read-recovery", "read", "release"]);

    const restoredCalls: string[] = [];
    let restored: HomeUpgradeTransaction | null = transaction("restored");
    const restoredResult = await runHomeUpgradeCutover({
      vaultPath: "/vault",
      transactionId: TX,
      candidateArtifactId: CANDIDATE,
    }, fakeDeps(restoredCalls, () => restored, (next) => { restored = next; }, {
      read: async () => { throw new Error("candidate payload is gone"); },
    }));
    expect(restoredResult.outcome.kind).toBe("rolled-back");
    expect(restoredCalls).toEqual(["inspect", "read-recovery"]);

    const failureCalls: string[] = [];
    let absent: HomeUpgradeTransaction | null = null;
    await expect(runHomeUpgradeCutover({
      vaultPath: "/vault",
      transactionId: TX,
      candidateArtifactId: CANDIDATE,
    }, fakeDeps(failureCalls, () => absent, (next) => { absent = next; }, {
      prepare: async () => { failureCalls.push("prepare"); throw new Error("prepare failed before publication"); },
    }))).rejects.toThrow("prepare failed before publication");
    expect(failureCalls).not.toContain("restore");
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
    read: async () => { calls.push("read"); return read(); },
    readRecovery: async () => { calls.push("read-recovery"); return read(); },
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
    calls.push(`suspend:${invocation.mode === "new" ? "new" : invocation.policy}`);
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
    return { kind: "ready", operationId: TX, recovered: invocation.mode === "recover", operationRan: true, value };
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
