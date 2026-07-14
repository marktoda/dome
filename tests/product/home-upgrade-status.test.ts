import { describe, expect, test } from "bun:test";

import {
  inspectHomeUpgradeStatus,
  type HomeUpgradeStatusDeps,
} from "../../src/product-host/home-upgrade-status";
import type { HomeUpgradeTransaction } from "../../src/product-host/home-upgrade-transaction";

const OPERATION = "11111111-1111-4111-8111-111111111111";
const CANDIDATE = "b".repeat(64);

describe("Home upgrade lifecycle projection", () => {
  test("maps no active transaction and private precommit phases without leaking phase data", async () => {
    expect(await inspectHomeUpgradeStatus("/vault", deps(null))).toEqual({
      state: "inactive",
      candidate: null,
      operationId: null,
      outcome: null,
      nextAction: "none",
    });
    for (const phase of ["prepared", "switching"] as const) {
      const value = await inspectHomeUpgradeStatus("/vault", deps(transaction(phase)));
      expect(value).toEqual({
        state: "active",
        candidate: { artifactId: CANDIDATE, productVersion: "2.0.0" },
        operationId: OPERATION,
        outcome: null,
        nextAction: "retry-recovery",
      });
      expect(JSON.stringify(value)).not.toContain(phase);
      expect(JSON.stringify(value)).not.toContain("releasePath");
    }
  });

  test("reports terminal truth only while the terminal transaction remains active", async () => {
    expect(await inspectHomeUpgradeStatus("/vault", deps(transaction("restored")))).toEqual({
      state: "complete",
      candidate: { artifactId: CANDIDATE, productVersion: "2.0.0" },
      operationId: OPERATION,
      outcome: "restored",
      nextAction: "none",
    });
    expect(await inspectHomeUpgradeStatus("/vault", deps(transaction("committed")))).toEqual({
      state: "complete",
      candidate: { artifactId: CANDIDATE, productVersion: "2.0.0" },
      operationId: OPERATION,
      outcome: "committed",
      nextAction: "none",
    });
  });

  test("distinguishes broken committed forward truth from unavailable disposition truth", async () => {
    expect(await inspectHomeUpgradeStatus("/vault", deps(transaction("committed"), {
      readForward: async () => { throw new Error("/private/release/corrupt"); },
    }))).toEqual({
      state: "recovery-required",
      candidate: { artifactId: CANDIDATE, productVersion: "2.0.0" },
      operationId: OPERATION,
      outcome: "committed",
      nextAction: "supply-exact-candidate",
    });
    const unavailable = await inspectHomeUpgradeStatus("/vault", deps(null, {
      readDisposition: async () => { throw new Error("/private/journal/corrupt"); },
    }));
    expect(unavailable).toEqual({
      state: "unavailable",
      candidate: null,
      operationId: null,
      outcome: null,
      nextAction: "inspect-home-status",
    });
    expect(JSON.stringify(unavailable)).not.toContain("private");
  });

  test("treats strict identity mismatch as unavailable and retirement during inspection as inactive", async () => {
    const other = { ...transaction("committed"), transactionId: "22222222-2222-4222-8222-222222222222" };
    expect(await inspectHomeUpgradeStatus("/vault", deps(transaction("committed"), {
      readForward: async () => other,
    }))).toEqual({
      state: "unavailable",
      candidate: null,
      operationId: null,
      outcome: null,
      nextAction: "inspect-home-status",
    });
    expect(await inspectHomeUpgradeStatus("/vault", deps(transaction("committed"), {
      readForward: async () => null,
    }))).toEqual({
      state: "inactive",
      candidate: null,
      operationId: null,
      outcome: null,
      nextAction: "none",
    });
  });

  test("rechecks disposition when strict forward inspection races retirement or a successor", async () => {
    const committed = transaction("committed");
    let retiredReads = 0;
    expect(await inspectHomeUpgradeStatus("/vault", deps(committed, {
      readDisposition: async () => retiredReads++ === 0 ? committed : null,
      readForward: async () => { throw Object.assign(new Error("active disappeared"), { code: "ENOENT" }); },
    }))).toEqual({
      state: "inactive",
      candidate: null,
      operationId: null,
      outcome: null,
      nextAction: "none",
    });

    const successor = { ...committed, transactionId: "22222222-2222-4222-8222-222222222222" };
    let successorReads = 0;
    expect(await inspectHomeUpgradeStatus("/vault", deps(committed, {
      readDisposition: async () => successorReads++ === 0 ? committed : successor,
      readForward: async () => { throw new Error("active identity changed"); },
    }))).toEqual({
      state: "unavailable",
      candidate: null,
      operationId: null,
      outcome: null,
      nextAction: "inspect-home-status",
    });
  });
});

function deps(
  active: HomeUpgradeTransaction | null,
  overrides: NonNullable<HomeUpgradeStatusDeps["upgradeStatusOperations"]> = {},
): HomeUpgradeStatusDeps {
  return {
    upgradeStatusOperations: {
      readDisposition: async () => active,
      readForward: async () => active,
      ...overrides,
    },
  };
}

function transaction(phase: HomeUpgradeTransaction["phase"]): HomeUpgradeTransaction {
  return {
    schema: "dome.home-upgrade-transaction/v2",
    vault: "/vault",
    transactionId: OPERATION,
    phase,
    old: { artifactId: "a".repeat(64), version: "1.0.0", releasePath: "/old", manifestSha256: "c".repeat(64) },
    candidate: { artifactId: CANDIDATE, version: "2.0.0", releasePath: "/candidate", manifestSha256: "d".repeat(64) },
    selectors: {
      installation: { path: "/installation.json", mode: 0o600, size: 1, sha256: "1".repeat(64) },
      plist: { path: "/home.plist", mode: 0o600, size: 1, sha256: "2".repeat(64) },
    },
    selection: null,
    probation: null,
    snapshot: { root: "snapshot", inventory: [] },
    timestamps: {
      preparedAt: "2026-07-13T00:00:00.000Z",
      switchingAt: phase === "prepared" ? null : "2026-07-13T00:01:00.000Z",
      committedAt: phase === "committed" ? "2026-07-13T00:02:00.000Z" : null,
      restoredAt: phase === "restored" ? "2026-07-13T00:02:00.000Z" : null,
    },
  };
}
