import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { openAnswersDb } from "../../src/answers/db";
import { recordQuestionAnswer } from "../../src/answers/question-answers";
import { commitOid } from "../../src/core/source-ref";
import { openDeviceAuthority } from "../../src/device-authority/device-authority";
import { add, commit, initRepo, resolveRef } from "../../src/git";
import {
  acquireOperationalWriterLease,
  inspectOperationalWriterBarrier,
} from "../../src/operational-state/writer-barrier";
import {
  createHomeInstallation,
  homeInstallationPaths,
  publishHomeInstallation,
  releaseRoot,
} from "../../src/product-host/home-installation";
import { homeServiceLabelForVault } from "../../src/product-host/home-lifecycle";
import { startProductHost } from "../../src/product-host/product-host";
import { readHomeUpgradeBarrier } from "../../src/product-host/home-upgrade-barrier";
import {
  readHomeUpgradeCandidateReceipt,
  readLatestHomeUpgradeSummary,
  retireHomeUpgrade,
  type HomeUpgradeHistoryDeps,
  type HomeUpgradeRetirementCheckpoint,
} from "../../src/product-host/home-upgrade-history";
import {
  runHomeUpgradeCutover,
  type HomeUpgradeCutoverDeps,
} from "../../src/product-host/home-upgrade-cutover";
import {
  commitPreparedHomeUpgrade,
  inspectHomeUpgradeAdmission,
  migratePreparedHomeUpgrade,
  prepareHomeUpgrade,
  readCommittedHomeUpgradeForward,
  readHomeUpgrade,
  readHomeUpgradeDisposition,
  readHomeUpgradeDispositionFromInstallation,
  readHomeUpgradeForRecovery,
  readHomeUpgradeHistory,
  readHomeUpgradeHistoryIdentity,
  releaseCommittedHomeUpgrade,
  restoreHomeUpgrade,
  type HomeUpgradeTransactionDeps,
} from "../../src/product-host/home-upgrade-transaction";
import { computeRequestReceiptsSchemaHash, openRequestReceiptsDb, REQUEST_RECEIPTS_N1_SCHEMA_HASH } from "../../src/request-receipts/db";
import type { HomeArtifactManifest } from "../../src/product-host/home-artifact";
import { HOME_DURABLE_STATE_PROTOCOL, HOME_STORE_MIGRATIONS } from "../../src/product-host/home-store-migrations";
import {
  FROZEN_N1_RELEASE,
  materializeFrozenN1Fixture,
} from "../fixtures/home-upgrade/n-1/freeze-n1";

const OLD_ID = "a".repeat(64);
const CANDIDATE_ID = "b".repeat(64);
const OID = commitOid("c".repeat(40));
const DATABASES = [
  "answers.db", "proposals.db", "outbox.db", "runs.db", "request-receipts.db", "device-authority.db",
] as const;

function probationProof(transactionId: string) {
  return {
    schema: "dome.home-upgrade-probation-proof/v1" as const,
    transactionId,
    readinessSchema: "dome.product.readiness/v1" as const,
    hostState: "probation" as const,
    artifactId: CANDIDATE_ID,
    productVersion: "2.0.0",
    vaultId: "stable-vault-id",
    writesAdmitted: false as const,
    provenAt: "2026-07-13T01:00:00.000Z",
  };
}

describe("Product Host pre-commit upgrade transaction", () => {
  test("host inventory reads active disposition after the recorded vault path disappears", async () => {
    const f = await fixture();
    try {
      const transactionId = randomUUID();
      await prepareHomeUpgrade({
        vaultPath: f.vault,
        transactionId,
        candidateArtifactId: CANDIDATE_ID,
      }, f.deps);
      await rename(f.vault, `${f.vault}-moved`);
      const active = await readHomeUpgradeDispositionFromInstallation(f.vault, f.deps);
      expect(active).toMatchObject({
        transactionId,
        old: { artifactId: OLD_ID, version: "1.0.0" },
        candidate: { artifactId: CANDIDATE_ID, version: "2.0.0" },
      });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("commits candidate selection only after exact probation and makes rollback irreversible", async () => {
    const f = await fixture();
    try {
      const transactionId = randomUUID();
      await prepareHomeUpgrade({
        vaultPath: f.vault,
        transactionId,
        candidateArtifactId: CANDIDATE_ID,
      }, f.deps);
      await migratePreparedHomeUpgrade(f.vault, f.deps);
      const committed = await commitPreparedHomeUpgrade({
        vaultPath: f.vault,
        proof: probationProof(transactionId),
      }, f.deps);
      expect(committed).toMatchObject({
        phase: "committed",
        probation: { artifactId: CANDIDATE_ID, vaultId: "stable-vault-id" },
      });
      expect(await readFile(homeInstallationPaths(f.vault, f.deps).record, "utf8")).toContain(CANDIDATE_ID);
      expect(await readFile(join(f.deps.launchAgentsDir!, `${homeServiceLabelForVault(f.vault)}.plist`), "utf8")).toContain(CANDIDATE_ID);
      expect((await inspectOperationalWriterBarrier(f.vault)).blocked).toBeTrue();
      expect((await inspectHomeUpgradeAdmission(f.vault, f.deps)).admitted).toBeFalse();
      expect((await inspectHomeUpgradeAdmission(f.vault, f.deps, {
        id: CANDIDATE_ID,
        version: "wrong",
      })).admitted).toBeFalse();
      expect((await inspectHomeUpgradeAdmission(f.vault, f.deps, {
        id: CANDIDATE_ID,
        version: "2.0.0",
      })).admitted).toBeTrue();
      await expect(restoreHomeUpgrade(f.vault, f.deps)).rejects.toThrow("irreversible");
      expect((await commitPreparedHomeUpgrade({ vaultPath: f.vault, proof: probationProof(transactionId) }, f.deps)).phase).toBe("committed");
      await expect(releaseCommittedHomeUpgrade(f.vault, f.deps)).rejects.toThrow("lifecycle resume authorization");
      expect((await releaseCommittedHomeUpgrade(f.vault, {
        ...f.deps,
        inspectLifecycleSuspension: async () => authorizedLifecycle(committed),
      })).phase).toBe("committed");
      expect((await inspectOperationalWriterBarrier(f.vault)).blocked).toBeFalse();
      expect(await readHomeUpgradeBarrier(f.vault, f.deps)).toBeNull();
      expect((await releaseCommittedHomeUpgrade(f.vault, f.deps)).phase).toBe("committed");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("composes real migration, selector commit, barrier release, and candidate-only admission", async () => {
    const f = await fixture();
    try {
      const transactionId = randomUUID();
      let lifecycleActive = false;
      let candidateAuthorized = false;
      let lifecycleFinished = false;
      let barrierReleasedBeforeLifecycleFinish = false;
      const inspectLifecycle: NonNullable<HomeUpgradeCutoverDeps["inspectLifecycleSuspension"]> = async () => {
        if (!lifecycleActive) return { kind: "inactive" };
        const journal = await readHomeUpgradeForRecovery(f.vault, f.deps);
        if (!candidateAuthorized || journal?.phase !== "committed") {
          throw new Error("candidate lifecycle evidence requested before authorization");
        }
        return authorizedLifecycle(journal);
      };
      const deps: HomeUpgradeCutoverDeps = {
        ...f.deps,
        inspectLifecycleSuspension: inspectLifecycle,
        operations: {
          prove: async (input) => probationProof(input.transactionId),
        },
        suspendHome: (async (invocation, operation) => {
          expect(invocation.mode).toBe("new");
          lifecycleActive = true;
          const value = await operation({
            operationId: transactionId,
            purpose: "upgrade",
            authorizeCurrentHomeForResume: async () => { candidateAuthorized = true; },
          });
          barrierReleasedBeforeLifecycleFinish =
            !(await inspectOperationalWriterBarrier(f.vault)).blocked && !lifecycleFinished;
          lifecycleFinished = true;
          lifecycleActive = false;
          return {
            kind: "ready",
            operationId: transactionId,
            recovered: false,
            operationRan: true,
            value,
          };
        }) as NonNullable<HomeUpgradeCutoverDeps["suspendHome"]>,
      };

      const cutover = await runHomeUpgradeCutover({
        vaultPath: f.vault,
        transactionId,
        candidateArtifactId: CANDIDATE_ID,
        expectedCurrentArtifactId: OLD_ID,
      }, deps);
      expect(cutover).toMatchObject({
        status: "ready",
        transactionOutcome: { kind: "committed", transaction: { phase: "committed" } },
        lifecycle: { kind: "ready" },
      });
      expect(barrierReleasedBeforeLifecycleFinish).toBeTrue();
      expect(await readHomeUpgradeBarrier(f.vault, f.deps)).toBeNull();
      expect((await inspectOperationalWriterBarrier(f.vault)).blocked).toBeFalse();
      expect(await inspectHomeUpgradeAdmission(f.vault, f.deps, {
        id: CANDIDATE_ID,
        version: "2.0.0",
      })).toEqual({ admitted: true });
      expect((await inspectHomeUpgradeAdmission(f.vault, f.deps, {
        id: CANDIDATE_ID,
        version: "wrong",
      })).admitted).toBeFalse();
      expect((await inspectHomeUpgradeAdmission(f.vault, f.deps, {
        id: OLD_ID,
        version: "1.0.0",
      })).admitted).toBeFalse();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("exact invoking candidate repairs committed deletion without N-1 or snapshot dependency", async () => {
    const f = await fixture();
    try {
      const transactionId = randomUUID();
      const paths = homeInstallationPaths(f.vault, f.deps);
      const candidateRoot = releaseRoot(paths, CANDIDATE_ID);
      const repairSource = join(f.root, "self-contained-candidate");
      await cp(candidateRoot, repairSource, { recursive: true });
      const repairManifest = await f.deps.verifyArtifact!(repairSource);
      let lifecycleActive = false;
      let candidateAuthorized = false;
      let crashRelease = true;
      const inspectLifecycle: NonNullable<HomeUpgradeCutoverDeps["inspectLifecycleSuspension"]> = async () => {
        if (!lifecycleActive) return { kind: "inactive" };
        const journal = await readHomeUpgradeDisposition(f.vault, f.deps);
        if (!candidateAuthorized || journal?.phase !== "committed") {
          throw new Error("candidate lifecycle evidence requested before authorization");
        }
        return authorizedLifecycle(journal);
      };
      const deps: HomeUpgradeCutoverDeps = {
        ...f.deps,
        inspectLifecycleSuspension: inspectLifecycle,
        operations: {
          prove: async (input) => probationProof(input.transactionId),
          release: async (vault, releaseDeps) => {
            if (crashRelease) throw new Error("crash before barrier release");
            return releaseCommittedHomeUpgrade(vault, releaseDeps);
          },
        },
        suspendHome: (async (_invocation, operation) => {
          lifecycleActive = true;
          const value = await operation({
            operationId: transactionId,
            purpose: "upgrade",
            authorizeCurrentHomeForResume: async () => { candidateAuthorized = true; },
          });
          return crashRelease ? {
            kind: "deferred",
            reason: "write-barrier-closed",
            transactionId,
            operationId: transactionId,
            recovered: false,
            operationRan: true,
            value,
          } : {
            kind: "ready",
            operationId: transactionId,
            recovered: true,
            operationRan: true,
            value,
          };
        }) as NonNullable<HomeUpgradeCutoverDeps["suspendHome"]>,
      };
      const first = await runHomeUpgradeCutover({
        vaultPath: f.vault,
        transactionId,
        candidateArtifactId: CANDIDATE_ID,
        expectedCurrentArtifactId: OLD_ID,
      }, deps);
      expect(first).toMatchObject({
        status: "recovery-required",
        transactionOutcome: { kind: "committed" },
        handoffError: "crash before barrier release",
      });
      expect((await inspectOperationalWriterBarrier(f.vault)).blocked).toBeTrue();

      crashRelease = false;
      await rm(candidateRoot, { recursive: true });
      await rm(releaseRoot(paths, OLD_ID), { recursive: true });
      await rm(paths.record);
      const plistPath = join(f.deps.launchAgentsDir!, `${homeServiceLabelForVault(f.vault)}.plist`);
      await writeFile(plistPath, "bounded corrupt candidate selector\n", { mode: 0o600 });
      const snapshotEntries = (await readHomeUpgradeDisposition(f.vault, f.deps))!.snapshot.inventory
        .filter((entry) => entry.present);
      await rm(join(paths.installations, "upgrade", "active", "snapshot", snapshotEntries[0]!.name));
      await writeFile(
        join(paths.installations, "upgrade", "active", "snapshot", snapshotEntries[1]!.name),
        "irrelevant",
      );
      const recovered = await runHomeUpgradeCutover({
        vaultPath: f.vault,
        transactionId,
        candidateArtifactId: CANDIDATE_ID,
        expectedCurrentArtifactId: OLD_ID,
        repairCandidate: { source: repairSource, manifest: repairManifest },
      }, deps);
      expect(recovered).toMatchObject({
        status: "ready",
        transactionOutcome: { kind: "committed", transaction: { phase: "committed" } },
        lifecycle: { kind: "ready", operationRan: true },
      });
      expect((await readCommittedHomeUpgradeForward(f.vault, f.deps))?.phase).toBe("committed");
      expect(JSON.parse(await readFile(paths.record, "utf8")).artifact).toEqual({
        id: CANDIDATE_ID,
        version: "2.0.0",
      });
      expect(await readFile(plistPath, "utf8")).toContain(CANDIDATE_ID);
      expect(await readFile(plistPath, "utf8")).not.toContain("bounded corrupt");
      expect((await inspectOperationalWriterBarrier(f.vault)).blocked).toBeFalse();
      expect((await inspectHomeUpgradeAdmission(f.vault, f.deps, {
        id: CANDIDATE_ID,
        version: "2.0.0",
      })).admitted).toBeTrue();
      const retired = await retireHomeUpgrade(
        { vaultPath: f.vault, transactionId },
        historyDeps(f, recovered.transactionOutcome.transaction, "ready"),
      );
      expect(retired).toMatchObject({ retired: true, transaction: { phase: "committed" } });
      expect(await readHomeUpgradeDisposition(f.vault, f.deps)).toBeNull();
      expect((await readHomeUpgradeHistoryIdentity(f.vault, transactionId, f.deps))?.outcome).toBe("committed");
      expect(await readLatestHomeUpgradeSummary(f.vault, f.deps)).toMatchObject({
        operationId: transactionId,
        outcome: "committed",
      });
      await expect(readHomeUpgradeHistory(f.vault, transactionId, f.deps)).rejects.toThrow(
        "snapshot inventory is not closed",
      );
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("simultaneous cutover recoverers restore once and never recreate cleared lifecycle state", async () => {
    const f = await fixture();
    try {
      const transactionId = randomUUID();
      const prepared = await prepareHomeUpgrade({
        vaultPath: f.vault,
        transactionId,
        candidateArtifactId: CANDIDATE_ID,
      }, f.deps);
      await migratePreparedHomeUpgrade(f.vault, f.deps);
      let inspected = 0;
      let releaseInspections!: () => void;
      const bothInspected = new Promise<void>((resolve) => { releaseInspections = resolve; });
      let lifecycleCleared = false;
      const deps: HomeUpgradeCutoverDeps = {
        ...f.deps,
        inspectLifecycleSuspension: async () => {
          inspected += 1;
          if (inspected === 2) releaseInspections();
          await bothInspected;
          return oldLifecycle(prepared);
        },
        suspendHome: (async (invocation) => {
          expect(invocation).toMatchObject({ mode: "recover", policy: "resume-only" });
          if (lifecycleCleared) {
            throw new Error(`Home lifecycle suspension ${transactionId} is no longer active`);
          }
          lifecycleCleared = true;
          return {
            kind: "ready",
            operationId: transactionId,
            recovered: true,
            operationRan: false,
          };
        }) as NonNullable<HomeUpgradeCutoverDeps["suspendHome"]>,
      };
      const attempts = await Promise.allSettled(Array.from({ length: 2 }, () => runHomeUpgradeCutover({
        vaultPath: f.vault,
        transactionId,
        candidateArtifactId: CANDIDATE_ID,
        expectedCurrentArtifactId: OLD_ID,
      }, deps)));
      expect(inspected).toBe(2);
      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
      const winner = attempts.find((attempt) => attempt.status === "fulfilled");
      if (winner?.status === "fulfilled") {
        expect(winner.value).toMatchObject({
          status: "ready",
          transactionOutcome: { kind: "rolled-back", transaction: { phase: "restored" } },
        });
      }
      expect(lifecycleCleared).toBeTrue();
      expect((await readHomeUpgradeForRecovery(f.vault, f.deps))?.phase).toBe("restored");
      expect((await inspectOperationalWriterBarrier(f.vault)).blocked).toBeFalse();
      expect(await readHomeUpgradeBarrier(f.vault, f.deps)).toBeNull();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  for (const crashAt of ["probation-recorded", "switching-recorded"] as const) {
    test(`composed cutover automatically rolls back and retries after ${crashAt}`, async () => {
      const f = await fixture();
      try {
        const transactionId = randomUUID();
        const before = await logicalState(f.vault);
        const paths = homeInstallationPaths(f.vault, f.deps);
        const plist = join(f.deps.launchAgentsDir!, `${homeServiceLabelForVault(f.vault)}.plist`);
        const oldInstallation = await readFile(paths.record);
        const oldPlist = await readFile(plist);
        let suspendCalls = 0;
        let authorized = false;
        const deps: HomeUpgradeCutoverDeps = {
          ...f.deps,
          selectionCheckpoint: async (name) => {
            if (name === crashAt) throw new Error(`crash at ${name}`);
          },
          inspectLifecycleSuspension: async () => ({ kind: "inactive" }),
          operations: {
            prove: async (input) => probationProof(input.transactionId),
          },
          suspendHome: (async (invocation, operation) => {
            suspendCalls += 1;
            expect(invocation.mode).toBe("new");
            const value = await operation({
              operationId: transactionId,
              purpose: "upgrade",
              authorizeCurrentHomeForResume: async () => { authorized = true; },
            });
            return {
              kind: "ready",
              operationId: transactionId,
              recovered: false,
              operationRan: true,
              value,
            };
          }) as NonNullable<HomeUpgradeCutoverDeps["suspendHome"]>,
        };

        const first = await runHomeUpgradeCutover({
          vaultPath: f.vault,
          transactionId,
          candidateArtifactId: CANDIDATE_ID,
          expectedCurrentArtifactId: OLD_ID,
        }, deps);
        expect(first).toMatchObject({
          status: "ready",
          transactionOutcome: {
            kind: "rolled-back",
            transaction: { phase: "restored" },
            error: `crash at ${crashAt}`,
          },
          lifecycle: { kind: "ready", operationRan: true },
        });
        expect(authorized).toBeFalse();
        expect(await readFile(paths.record)).toEqual(oldInstallation);
        expect(await readFile(plist)).toEqual(oldPlist);
        expect(await logicalState(f.vault)).toEqual(before);
        expect((await inspectOperationalWriterBarrier(f.vault)).blocked).toBeFalse();
        expect(await readHomeUpgradeBarrier(f.vault, f.deps)).toBeNull();

        const retried = await runHomeUpgradeCutover({
          vaultPath: f.vault,
          transactionId,
          candidateArtifactId: CANDIDATE_ID,
          expectedCurrentArtifactId: OLD_ID,
        }, deps);
        expect(retried).toMatchObject({
          status: "ready",
          transactionOutcome: { kind: "rolled-back", transaction: { phase: "restored" } },
          lifecycle: { kind: "not-required", operationRan: false },
        });
        expect(suspendCalls).toBe(1);
      } finally { await rm(f.root, { recursive: true, force: true }); }
    });
  }

  for (const crashAt of ["candidate-plist-published", "candidate-installation-published"] as const) {
    test(`switching crash at ${crashAt} restores exact old selectors and stores`, async () => {
      const f = await fixture();
      try {
        const before = await logicalState(f.vault);
        const transactionId = randomUUID();
        const oldInstallation = await readFile(homeInstallationPaths(f.vault, f.deps).record);
        const plist = join(f.deps.launchAgentsDir!, `${homeServiceLabelForVault(f.vault)}.plist`);
        const oldPlist = await readFile(plist);
        await prepareHomeUpgrade({ vaultPath: f.vault, transactionId, candidateArtifactId: CANDIDATE_ID }, f.deps);
        await migratePreparedHomeUpgrade(f.vault, f.deps);
        await expect(commitPreparedHomeUpgrade({ vaultPath: f.vault, proof: probationProof(transactionId) }, {
          ...f.deps,
          selectionCheckpoint: async (name) => { if (name === crashAt) throw new Error(`crash at ${name}`); },
        })).rejects.toThrow(`crash at ${crashAt}`);
        expect((await readHomeUpgrade(f.vault, f.deps))?.phase).toBe("switching");
        if (crashAt === "candidate-installation-published") {
          await expect(restoreHomeUpgrade(f.vault, {
            ...f.deps,
            selectionCheckpoint: async (name) => {
              if (name === "old-installation-restored") throw new Error("crash during selector rollback");
            },
          })).rejects.toThrow("crash during selector rollback");
          expect((await readHomeUpgrade(f.vault, f.deps))?.phase).toBe("switching");
        }
        const restored = await restoreHomeUpgrade(f.vault, f.deps);
        expect(restored.phase).toBe("restored");
        expect(await readFile(homeInstallationPaths(f.vault, f.deps).record)).toEqual(oldInstallation);
        expect(await readFile(plist)).toEqual(oldPlist);
        expect(await logicalState(f.vault)).toEqual(before);
      } finally { await rm(f.root, { recursive: true, force: true }); }
    });
  }

  test("rejects corrupted persisted probation bindings while rollback remains vault-identity tolerant", async () => {
    const f = await fixture();
    try {
      const transactionId = randomUUID();
      await prepareHomeUpgrade({ vaultPath: f.vault, transactionId, candidateArtifactId: CANDIDATE_ID }, f.deps);
      await migratePreparedHomeUpgrade(f.vault, f.deps);
      await expect(commitPreparedHomeUpgrade({ vaultPath: f.vault, proof: probationProof(transactionId) }, {
        ...f.deps,
        selectionCheckpoint: async (name) => {
          if (name === "candidate-plist-published") throw new Error("retain switching journal");
        },
      })).rejects.toThrow("retain switching journal");

      const journalPath = join(
        homeInstallationPaths(f.vault, f.deps).installations,
        "upgrade", "active", "journal.json",
      );
      const original = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
      const writeMutation = async (mutate: (journal: Record<string, unknown>) => void) => {
        const journal = structuredClone(original);
        mutate(journal);
        await writeFile(journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
      };

      await writeMutation((journal) => {
        (journal["probation"] as Record<string, unknown>)["transactionId"] = randomUUID();
      });
      await expect(readHomeUpgradeForRecovery(f.vault, f.deps)).rejects.toThrow("probation proof is invalid");

      await writeMutation((journal) => {
        (journal["probation"] as Record<string, unknown>)["provenAt"] = "2026-07-13T00:59:59.000Z";
      });
      await expect(readHomeUpgradeForRecovery(f.vault, f.deps)).rejects.toThrow("precedes preparation");

      await writeMutation((journal) => {
        (journal["probation"] as Record<string, unknown>)["provenAt"] = "2026-07-13T01:00:01.000Z";
      });
      await expect(readHomeUpgradeForRecovery(f.vault, f.deps)).rejects.toThrow("follows selector switching");

      await writeMutation((journal) => {
        (journal["probation"] as Record<string, unknown>)["vaultId"] = "corrupt-live-vault-binding";
      });
      await expect(readHomeUpgrade(f.vault, f.deps)).rejects.toThrow("live vault");
      expect((await readHomeUpgradeForRecovery(f.vault, f.deps))?.phase).toBe("switching");
      const restored = await restoreHomeUpgrade(f.vault, f.deps);
      expect(restored.phase).toBe("restored");

      await writeMutation((journal) => {
        journal["phase"] = "restored";
        (journal["timestamps"] as Record<string, unknown>)["switchingAt"] = null;
        (journal["timestamps"] as Record<string, unknown>)["restoredAt"] = "2026-07-13T01:00:00.000Z";
        (journal["probation"] as Record<string, unknown>)["provenAt"] = "2026-07-13T01:00:01.000Z";
      });
      await expect(readHomeUpgradeForRecovery(f.vault, f.deps)).rejects.toThrow("follows restoration");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("refuses selector commit before every live store is current or when proof names another vault", async () => {
    const f = await fixture();
    try {
      const transactionId = randomUUID();
      await prepareHomeUpgrade({ vaultPath: f.vault, transactionId, candidateArtifactId: CANDIDATE_ID }, f.deps);
      await expect(commitPreparedHomeUpgrade({ vaultPath: f.vault, proof: probationProof(transactionId) }, f.deps))
        .rejects.toThrow("not current");
      expect((await readHomeUpgrade(f.vault, f.deps))?.phase).toBe("prepared");
      await migratePreparedHomeUpgrade(f.vault, f.deps);
      for (const provenAt of ["2026-07-13T00:59:59.000Z", "2026-07-13T01:00:01.000Z"]) {
        await expect(commitPreparedHomeUpgrade({
          vaultPath: f.vault,
          proof: { ...probationProof(transactionId), provenAt },
        }, f.deps)).rejects.toThrow("prepared-to-commit interval");
      }
      await expect(commitPreparedHomeUpgrade({
        vaultPath: f.vault,
        proof: { ...probationProof(transactionId), transactionId: randomUUID() },
      }, f.deps)).rejects.toThrow("does not match");
      await expect(commitPreparedHomeUpgrade({
        vaultPath: f.vault,
        proof: { ...probationProof(transactionId), vaultId: "another-vault" },
      }, f.deps)).rejects.toThrow("does not match");
      expect((await readHomeUpgrade(f.vault, f.deps))?.phase).toBe("prepared");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("a crash after durable commit recovers forward and can never restore", async () => {
    const f = await fixture();
    try {
      const transactionId = randomUUID();
      await prepareHomeUpgrade({ vaultPath: f.vault, transactionId, candidateArtifactId: CANDIDATE_ID }, f.deps);
      await migratePreparedHomeUpgrade(f.vault, f.deps);
      await expect(commitPreparedHomeUpgrade({ vaultPath: f.vault, proof: probationProof(transactionId) }, {
        ...f.deps,
        selectionCheckpoint: async (name) => { if (name === "committed-recorded") throw new Error("crash after commit"); },
      })).rejects.toThrow("crash after commit");
      expect((await readHomeUpgrade(f.vault, f.deps))?.phase).toBe("committed");
      expect((await commitPreparedHomeUpgrade({ vaultPath: f.vault, proof: probationProof(transactionId) }, f.deps)).phase).toBe("committed");
      await expect(restoreHomeUpgrade(f.vault, f.deps)).rejects.toThrow("irreversible");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("migrates a prepared N-1 receipt store, preserves all canaries, stays closed, retries, and restores exactly", async () => {
    const f = await fixture();
    try {
      const before = await logicalState(f.vault);
      const transactionId = randomUUID();
      const prepared = await prepareHomeUpgrade({
        vaultPath: f.vault,
        transactionId,
        candidateArtifactId: CANDIDATE_ID,
      }, f.deps);
      expect(prepared.snapshot.inventory.find((entry) => entry.name === "request-receipts.db")?.schemaHash)
        .toBe(REQUEST_RECEIPTS_N1_SCHEMA_HASH);

      const migrated = await migratePreparedHomeUpgrade(f.vault, f.deps);
      expect(migrated.phase).toBe("prepared");
      expect((await inspectOperationalWriterBarrier(f.vault)).blocked).toBeTrue();
      expect(await readHomeUpgradeBarrier(f.vault, f.deps)).not.toBeNull();
      expect((await inspectHomeUpgradeAdmission(f.vault, f.deps)).admitted).toBeFalse();

      const afterMigration = await logicalState(f.vault);
      for (const name of DATABASES.filter((name) => name !== "request-receipts.db")) {
        expect(afterMigration[name]).toEqual(before[name]);
      }

      const receiptPath = join(f.vault, ".dome", "state", "request-receipts.db");
      const receipts = await openRequestReceiptsDb({ path: receiptPath });
      if (!receipts.ok) throw new Error(JSON.stringify(receipts.error));
      try {
        expect(receipts.value.db.schemaHash).toBe(computeRequestReceiptsSchemaHash());
        expect(receipts.value.db.raw.query<{ operation_id: string; state: string }, []>(
          "SELECT operation_id,state FROM request_receipts ORDER BY operation_id",
        ).all()).toEqual([
          { operation_id: "receipt-admitted", state: "admitted" },
          { operation_id: "receipt-interrupted", state: "interrupted" },
          { operation_id: "receipt-succeeded", state: "succeeded" },
        ]);
        expect(receipts.value.db.raw.query<{ name: string }, []>(
          "SELECT name FROM sqlite_schema WHERE name='request_receipts_prunable'",
        ).get()?.name).toBe("request_receipts_prunable");
      } finally { receipts.value.db.close(); }
      const authorityBeforeRestore = await openDeviceAuthority({ path: join(f.vault, ".dome", "state", "device-authority.db") });
      if (!authorityBeforeRestore.ok) throw new Error(JSON.stringify(authorityBeforeRestore.error));
      try {
        expect(authorityBeforeRestore.value.authority.authenticate({
          credential: f.credential,
          csrfSecret: f.csrfSecret,
          requireCsrf: true,
          now: new Date("2026-07-13T00:05:00.000Z"),
        }).kind).toBe("authenticated");
        expect(authorityBeforeRestore.value.authority.authenticate({
          credential: f.revokedCredential,
          now: new Date("2026-07-13T00:05:00.000Z"),
        }).kind).toBe("revoked");
      } finally { authorityBeforeRestore.value.authority.close(); }

      expect((await migratePreparedHomeUpgrade(f.vault, f.deps)).phase).toBe("prepared");
      const restored = await restoreHomeUpgrade(f.vault, f.deps);
      expect(restored.phase).toBe("restored");
      expect(await logicalState(f.vault)).toEqual(before);
      const oldReceipts = new Database(receiptPath, { readonly: true, create: false });
      try {
        expect(oldReceipts.query<{ schema_hash: string }, []>("SELECT schema_hash FROM request_receipts_meta").get()?.schema_hash)
          .toBe(REQUEST_RECEIPTS_N1_SCHEMA_HASH);
        expect(oldReceipts.query("SELECT name FROM sqlite_schema WHERE name='request_receipts_prunable'").all()).toEqual([]);
      } finally { oldReceipts.close(); }
      const authority = await openDeviceAuthority({ path: join(f.vault, ".dome", "state", "device-authority.db") });
      if (!authority.ok) throw new Error(JSON.stringify(authority.error));
      try {
        expect(authority.value.authority.authenticate({
          credential: f.credential,
          csrfSecret: f.csrfSecret,
          requireCsrf: true,
          now: new Date("2026-07-13T00:05:00.000Z"),
        }).kind).toBe("authenticated");
        expect(authority.value.authority.authenticate({
          credential: f.revokedCredential,
          now: new Date("2026-07-13T00:05:00.000Z"),
        }).kind).toBe("revoked");
      } finally { authority.value.authority.close(); }
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("post-commit migration failure remains prepared and closed, then retry converges", async () => {
    const f = await fixture();
    try {
      const transactionId = randomUUID();
      await prepareHomeUpgrade({ vaultPath: f.vault, transactionId, candidateArtifactId: CANDIDATE_ID }, f.deps);
      const preflightRoot = join(
        homeInstallationPaths(f.vault, f.deps).installations,
        "upgrade",
        `.migration-preflight-${transactionId}`,
      );
      await expect(migratePreparedHomeUpgrade(f.vault, {
        ...f.deps,
        afterStoreMigration: async (name) => { throw new Error(`injected after ${name}`); },
      })).rejects.toThrow("injected after request-receipts.db");
      expect(await exists(preflightRoot)).toBeFalse();
      expect((await readHomeUpgrade(f.vault, f.deps))?.phase).toBe("prepared");
      expect((await inspectOperationalWriterBarrier(f.vault)).blocked).toBeTrue();
      expect((await inspectHomeUpgradeAdmission(f.vault, f.deps)).admitted).toBeFalse();
      const current = await openRequestReceiptsDb({ path: join(f.vault, ".dome", "state", "request-receipts.db") });
      expect(current.ok).toBeTrue();
      if (current.ok) current.value.db.close();
      expect((await migratePreparedHomeUpgrade(f.vault, f.deps)).phase).toBe("prepared");
      expect(await exists(preflightRoot)).toBeFalse();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("rollback after a post-commit migration crash restores exact N-1 store and credential truth", async () => {
    const f = await fixture();
    try {
      const before = await logicalState(f.vault);
      await prepareHomeUpgrade({ vaultPath: f.vault, transactionId: randomUUID(), candidateArtifactId: CANDIDATE_ID }, f.deps);
      await expect(migratePreparedHomeUpgrade(f.vault, {
        ...f.deps,
        afterStoreMigration: async () => { throw new Error("crash after committed store"); },
      })).rejects.toThrow("crash after committed store");
      expect((await restoreHomeUpgrade(f.vault, f.deps)).phase).toBe("restored");
      expect(await logicalState(f.vault)).toEqual(before);
      const authority = await openDeviceAuthority({ path: join(f.vault, ".dome", "state", "device-authority.db") });
      if (!authority.ok) throw new Error(JSON.stringify(authority.error));
      try {
        expect(authority.value.authority.authenticate({
          credential: f.credential,
          csrfSecret: f.csrfSecret,
          requireCsrf: true,
          now: new Date("2026-07-13T00:05:00.000Z"),
        }).kind).toBe("authenticated");
        expect(authority.value.authority.authenticate({
          credential: f.revokedCredential,
          now: new Date("2026-07-13T00:05:00.000Z"),
        }).kind).toBe("revoked");
      } finally { authority.value.authority.close(); }
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  for (const candidateFault of ["missing", "incompatible"] as const) {
    test(`candidate durable-state ${candidateFault} evidence refuses before active publication`, async () => {
      const f = await fixture();
      try {
        const before = await logicalState(f.vault);
        const paths = homeInstallationPaths(f.vault, f.deps);
        const manifestPath = join(releaseRoot(paths, CANDIDATE_ID), "manifest.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          durableState?: { stores: Array<{ currentSchemaHash: string }> };
        };
        if (candidateFault === "missing") delete manifest.durableState;
        else manifest.durableState!.stores[0]!.currentSchemaHash = "e".repeat(64);
        await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
        await expect(prepareHomeUpgrade({
          vaultPath: f.vault,
          transactionId: randomUUID(),
          candidateArtifactId: CANDIDATE_ID,
        }, f.deps)).rejects.toThrow(candidateFault === "missing" ? "lacks supported-upgrade" : "differs from this build");
        expect(await readHomeUpgrade(f.vault, f.deps)).toBeNull();
        expect((await inspectOperationalWriterBarrier(f.vault)).blocked).toBeFalse();
        expect(await logicalState(f.vault)).toEqual(before);
      } finally { await rm(f.root, { recursive: true, force: true }); }
    });
  }

  test("candidate manifest drift refuses migration without touching N-1 stores", async () => {
    const f = await fixture();
    try {
      await prepareHomeUpgrade({ vaultPath: f.vault, transactionId: randomUUID(), candidateArtifactId: CANDIDATE_ID }, f.deps);
      const paths = homeInstallationPaths(f.vault, f.deps);
      const manifestPath = join(releaseRoot(paths, CANDIDATE_ID), "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      manifest["future"] = true;
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
      await expect(migratePreparedHomeUpgrade(f.vault, f.deps)).rejects.toThrow("manifest changed");
      const db = new Database(join(f.vault, ".dome", "state", "request-receipts.db"), { readonly: true, create: false });
      try {
        expect(db.query<{ schema_hash: string }, []>("SELECT schema_hash FROM request_receipts_meta").get()?.schema_hash)
          .toBe(REQUEST_RECEIPTS_N1_SCHEMA_HASH);
      } finally { db.close(); }
      expect((await inspectOperationalWriterBarrier(f.vault)).blocked).toBeTrue();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("prepares a closed external snapshot and restores exact N-1 logical state", async () => {
    const f = await fixture();
    try {
      const transactionId = randomUUID();
      const before = await logicalState(f.vault);
      const gitBefore = await gitEvidence(f.vault);
      const upgradeRoot = join(homeInstallationPaths(f.vault, f.deps).installations, "upgrade");
      await mkdir(join(upgradeRoot, `.staging-${transactionId}`), { recursive: true });
      await writeFile(join(upgradeRoot, `.staging-${transactionId}`, "partial"), "crash debris");
      const prepared = await prepareHomeUpgrade({
        vaultPath: f.vault,
        transactionId,
        candidateArtifactId: CANDIDATE_ID,
      }, f.deps);

      expect(prepared.phase).toBe("prepared");
      expect(Object.keys(prepared).sort()).toEqual([
        "candidate", "old", "phase", "probation", "schema", "selection", "selectors", "snapshot", "timestamps", "transactionId", "vault",
      ]);
      expect(prepared.old).toMatchObject({ artifactId: OLD_ID, version: "1.0.0" });
      expect(prepared.candidate).toMatchObject({ artifactId: CANDIDATE_ID, version: "2.0.0" });
      expect(prepared.snapshot.inventory.map((entry) => entry.name)).toEqual([
        ...DATABASES, "quarantined.json", "product-host-id",
      ]);
      expect(prepared.snapshot.inventory.every((entry) => entry.present)).toBeTrue();
      expect(prepared.snapshot.inventory.slice(0, 6).every((entry) => entry.schemaHash?.length === 64)).toBeTrue();
      expect(await readFile(homeInstallationPaths(f.vault, f.deps).record, "utf8")).toContain(OLD_ID);
      const active = join(homeInstallationPaths(f.vault, f.deps).installations, "upgrade", "active");
      expect((await stat(active)).mode & 0o777).toBe(0o700);
      expect((await stat(join(active, "journal.json"))).mode & 0o777).toBe(0o600);
      expect((await readdir(active)).sort()).toEqual(["journal.json", "selectors", "snapshot"]);
      expect((await readdir(join(active, "selectors"))).sort()).toEqual([
        "candidate-installation.json", "candidate.plist", "old-installation.json", "old.plist",
      ]);
      for (const name of await readdir(join(active, "selectors"))) {
        expect((await stat(join(active, "selectors", name))).mode & 0o777).toBe(0o600);
      }
      expect((await readdir(join(active, "snapshot"))).sort()).not.toContain("projection.db");
      for (const entry of prepared.snapshot.inventory) {
        if (entry.present) expect((await stat(join(active, "snapshot", entry.name))).mode & 0o777).toBe(0o600);
      }
      expect((await inspectHomeUpgradeAdmission(f.vault, f.deps)).admitted).toBeFalse();
      const blockedStart = await startProductHost({ vaultPath: f.vault, port: 0 }, { upgradeTransaction: f.deps });
      expect(blockedStart.ok).toBeFalse();
      if (!blockedStart.ok) expect(blockedStart.error.message).toContain("write admission is closed");
      expect(await logicalState(f.vault)).toEqual(before);
      expect(await prepareHomeUpgrade({ vaultPath: f.vault, transactionId, candidateArtifactId: CANDIDATE_ID }, f.deps)).toEqual(prepared);
      await expect(prepareHomeUpgrade({ vaultPath: f.vault, transactionId: randomUUID(), candidateArtifactId: CANDIDATE_ID }, f.deps)).rejects.toThrow("another");

      const extra = join(active, "snapshot", "future.db");
      await writeFile(extra, "unknown");
      await expect(restoreHomeUpgrade(f.vault, f.deps)).rejects.toThrow("not closed");
      await rm(extra);
      const plist = join(f.deps.launchAgentsDir!, `${homeServiceLabelForVault(f.vault)}.plist`);
      const oldPlist = await readFile(plist);
      await writeFile(plist, "candidate selector\n");
      await expect(restoreHomeUpgrade(f.vault, f.deps)).rejects.toThrow("selector state invalid");
      await writeFile(plist, oldPlist);
      await chmod(plist, prepared.selectors.plist.mode);

      const journalDebris = join(dirname(active), `.journal-${transactionId}.tmp`);
      await writeFile(journalDebris, "partial terminal journal\n", { mode: 0o600 });
      await mutateDurableState(f.vault);
      const restored = await restoreHomeUpgrade(f.vault, f.deps);
      expect(restored.phase).toBe("restored");
      expect(await exists(journalDebris)).toBeFalse();
      expect(await logicalState(f.vault)).toEqual(before);
      expect(await gitEvidence(f.vault)).toEqual(gitBefore);
      for (const name of DATABASES) {
        expect(await exists(join(f.vault, ".dome", "state", `${name}-wal`))).toBeFalse();
        expect(await exists(join(f.vault, ".dome", "state", `${name}-shm`))).toBeFalse();
      }
      const answersAfterRollback = await openAnswersDb({ path: join(f.vault, ".dome", "state", "answers.db") });
      if (!answersAfterRollback.ok) throw new Error("post-rollback answers did not open");
      recordQuestionAnswer(answersAfterRollback.value.db, {
        idempotencyKey: "answer-after-rollback",
        answer: "preserve me",
        answeredAt: "2026-07-13T02:00:00.000Z",
        questionId: 2,
        question: "Did rollback finish?",
        processorId: "dome.test",
        adoptedCommit: OID,
        answeredBy: "owner",
      });
      answersAfterRollback.value.db.close();
      const legitimatePostRollbackState = await logicalState(f.vault);
      expect(legitimatePostRollbackState).not.toEqual(before);
      const ordinaryWriter = await acquireOperationalWriterLease({
        vaultPath: f.vault,
        command: "post-rollback-writer",
      });
      if (!ordinaryWriter.ok) throw new Error("post-rollback writer was not admitted");
      try {
        expect(await Promise.race([
          restoreHomeUpgrade(f.vault, f.deps),
          Bun.sleep(250).then(() => { throw new Error("terminal restore tried to drain N-1 writers"); }),
        ])).toEqual(restored);
      } finally {
        ordinaryWriter.lease.close();
      }
      expect(await logicalState(f.vault)).toEqual(legitimatePostRollbackState);
      expect((await inspectHomeUpgradeAdmission(f.vault, f.deps)).admitted).toBeTrue();
      expect(await prepareHomeUpgrade({
        vaultPath: f.vault,
        transactionId,
        candidateArtifactId: CANDIDATE_ID,
      }, f.deps)).toEqual(restored);
      expect((await inspectOperationalWriterBarrier(f.vault)).blocked).toBeFalse();
      expect(await readHomeUpgradeBarrier(f.vault, f.deps)).toBeNull();

      await writeFile(join(active, "snapshot", "answers.db"), "corrupt retained recovery snapshot");
      expect((await inspectHomeUpgradeAdmission(f.vault, f.deps)).admitted).toBeTrue();
      await expect(readHomeUpgrade(f.vault, f.deps)).rejects.toThrow("evidence changed");

      const authority = await openDeviceAuthority({ path: join(f.vault, ".dome", "state", "device-authority.db") });
      if (!authority.ok) throw new Error("restored authority did not open");
      expect(authority.value.authority.authEpoch()).toBe(f.authEpoch);
      expect(authority.value.authority.authenticate({
        credential: f.credential,
        csrfSecret: f.csrfSecret,
        requireCsrf: true,
        now: new Date("2026-07-13T00:05:00.000Z"),
      }).kind).toBe("authenticated");
      expect(authority.value.authority.authenticate({
        credential: f.revokedCredential,
        now: new Date("2026-07-13T00:05:00.000Z"),
      }).kind).toBe("revoked");
      expect(authority.value.authority.exchangePairingCode({ pairingCode: f.unusedPairingCode, now: new Date("2026-07-13T00:05:00.000Z") }).kind).toBe("paired");
      authority.value.authority.close();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("rollback succeeds when the failed candidate artifact is missing", async () => {
    const f = await fixture();
    try {
      const before = await logicalState(f.vault);
      const gitBefore = await gitEvidence(f.vault);
      await prepareHomeUpgrade({
        vaultPath: f.vault,
        transactionId: randomUUID(),
        candidateArtifactId: CANDIDATE_ID,
      }, f.deps);
      const paths = homeInstallationPaths(f.vault, f.deps);
      const journalPath = join(paths.installations, "upgrade", "active", "journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
        candidate: { releasePath: string };
      };
      const candidatePath = journal.candidate.releasePath;
      journal.candidate.releasePath = releaseRoot(paths, OLD_ID);
      await writeFile(journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
      await expect(restoreHomeUpgrade(f.vault, f.deps)).rejects.toThrow("release path is not canonical");
      journal.candidate.releasePath = candidatePath;
      await writeFile(journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
      await rm(releaseRoot(paths, CANDIDATE_ID), { recursive: true });
      await expect(readHomeUpgrade(f.vault, f.deps)).rejects.toThrow();

      await mutateDurableState(f.vault);
      const restored = await restoreHomeUpgrade(f.vault, f.deps);
      expect(restored.phase).toBe("restored");
      expect(await logicalState(f.vault)).toEqual(before);
      expect(await gitEvidence(f.vault)).toEqual(gitBefore);
      expect((await inspectHomeUpgradeAdmission(f.vault, f.deps)).admitted).toBeTrue();
      expect(await restoreHomeUpgrade(f.vault, f.deps)).toEqual(restored);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  for (const candidateFault of ["missing", "corrupt"] as const) {
    test(`switching rollback ignores ${candidateFault} candidate payload`, async () => {
      const f = await fixture();
      try {
        const transactionId = randomUUID();
        const before = await logicalState(f.vault);
        await prepareHomeUpgrade({ vaultPath: f.vault, transactionId, candidateArtifactId: CANDIDATE_ID }, f.deps);
        await migratePreparedHomeUpgrade(f.vault, f.deps);
        await expect(commitPreparedHomeUpgrade({ vaultPath: f.vault, proof: probationProof(transactionId) }, {
          ...f.deps,
          selectionCheckpoint: async (name) => {
            if (name === "candidate-plist-published") throw new Error("switching crash");
          },
        })).rejects.toThrow("switching crash");
        const candidate = releaseRoot(homeInstallationPaths(f.vault, f.deps), CANDIDATE_ID);
        if (candidateFault === "missing") await rm(candidate, { recursive: true });
        else await writeFile(join(candidate, "manifest.json"), "corrupt candidate\n", { mode: 0o600 });
        await expect(readHomeUpgrade(f.vault, f.deps)).rejects.toThrow();
        expect((await readHomeUpgradeForRecovery(f.vault, f.deps))?.phase).toBe("switching");
        expect((await restoreHomeUpgrade(f.vault, f.deps)).phase).toBe("restored");
        expect(await logicalState(f.vault)).toEqual(before);
      } finally { await rm(f.root, { recursive: true, force: true }); }
    });
  }

  test("partial restore retries, absent files are restored as absent, and corrupt evidence fails closed", async () => {
    const f = await fixture({ durableFiles: false });
    try {
      const transactionId = randomUUID();
      const prepared = await prepareHomeUpgrade({ vaultPath: f.vault, transactionId, candidateArtifactId: CANDIDATE_ID }, f.deps);
      expect(prepared.snapshot.inventory.slice(-2).every((entry) => !entry.present)).toBeTrue();
      await writeFile(join(f.vault, ".dome", "state", "quarantined.json"), "{\"candidate\":true}\n");
      await writeFile(join(f.vault, ".dome", "state", "product-host-id"), "candidate-id\n");
      let replacements = 0;
      await expect(restoreHomeUpgrade(f.vault, {
        ...f.deps,
        afterRestoreEntry: async () => {
          replacements += 1;
          if (replacements === 3) throw new Error("simulated power loss");
        },
      })).rejects.toThrow("simulated power loss");
      expect((await readHomeUpgrade(f.vault, f.deps))?.phase).toBe("prepared");
      expect((await restoreHomeUpgrade(f.vault, f.deps)).phase).toBe("restored");
      expect(await exists(join(f.vault, ".dome", "state", "quarantined.json"))).toBeFalse();
      expect(await exists(join(f.vault, ".dome", "state", "product-host-id"))).toBeFalse();

      const journalPath = join(homeInstallationPaths(f.vault, f.deps).installations, "upgrade", "active", "journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
      for (const phase of ["preparing", "prepared", "rolling-back", "recovery-required"]) {
        journal["phase"] = phase;
        await writeFile(journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
        expect((await inspectHomeUpgradeAdmission(f.vault, f.deps)).admitted).toBeFalse();
        const started = await startProductHost({ vaultPath: f.vault, port: 0 }, { upgradeTransaction: f.deps });
        expect(started.ok).toBeFalse();
        if (!started.ok) expect(started.error.message).toContain("write admission is closed");
      }
      await expect(readHomeUpgrade(f.vault, f.deps)).rejects.toThrow("unknown phase");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("reads and restores a legacy v1 transaction without inventing forward evidence", async () => {
    const f = await fixture();
    try {
      const before = await logicalState(f.vault);
      await prepareHomeUpgrade({
        vaultPath: f.vault,
        transactionId: randomUUID(),
        candidateArtifactId: CANDIDATE_ID,
      }, f.deps);
      const active = join(homeInstallationPaths(f.vault, f.deps).installations, "upgrade", "active");
      const journalPath = join(active, "journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
      journal["schema"] = "dome.home-upgrade-transaction/v1";
      delete journal["selection"];
      delete journal["probation"];
      const timestamps = journal["timestamps"] as Record<string, unknown>;
      journal["timestamps"] = {
        preparedAt: timestamps["preparedAt"],
        restoredAt: null,
      };
      await rm(join(active, "selectors"), { recursive: true });
      await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });

      const legacy = await readHomeUpgrade(f.vault, f.deps);
      expect(legacy).toMatchObject({
        schema: "dome.home-upgrade-transaction/v1",
        phase: "prepared",
        selection: null,
        probation: null,
      });
      await expect(migratePreparedHomeUpgrade(f.vault, f.deps)).rejects.toThrow("restore-only");
      await mutateDurableState(f.vault);
      const restored = await restoreHomeUpgrade(f.vault, f.deps);
      expect(restored).toMatchObject({ schema: "dome.home-upgrade-transaction/v1", phase: "restored" });
      expect(await logicalState(f.vault)).toEqual(before);
      const terminal = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
      expect(Object.keys(terminal).sort()).toEqual([
        "candidate", "old", "phase", "schema", "selectors", "snapshot", "timestamps", "transactionId", "vault",
      ]);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("failed preparation is source-read-only and redirected roots are refused", async () => {
    const f = await fixture();
    let walDb: Database | null = null;
    try {
      const gitBefore = await gitEvidence(f.vault);
      const paths = homeInstallationPaths(f.vault, f.deps);
      const attacker = join(f.root, "attacker");
      const upgrade = join(paths.installations, "upgrade");
      await mkdir(attacker);
      await symlink(attacker, upgrade);
      expect((await inspectHomeUpgradeAdmission(f.vault, f.deps)).admitted).toBeFalse();
      await expect(prepareHomeUpgrade({ vaultPath: f.vault, transactionId: randomUUID(), candidateArtifactId: CANDIDATE_ID }, f.deps)).rejects.toThrow("direct owned directory");
      expect(await readdir(attacker)).toEqual([]);
      await rm(upgrade);

      walDb = new Database(join(f.vault, ".dome", "state", "outbox.db"));
      walDb.run("PRAGMA journal_mode = WAL");
      walDb.run("PRAGMA wal_autocheckpoint = 0");
      walDb.run("UPDATE outbox SET last_error = 'committed WAL evidence'");
      const later = new Database(join(f.vault, ".dome", "state", "runs.db"));
      later.run("UPDATE ledger_meta SET schema_hash = ?", ["d".repeat(64)]);
      later.close();
      const protectedPaths = [
        join(f.vault, "note.md"),
        join(f.vault, ".dome", "state", "outbox.db"),
        join(f.vault, ".dome", "state", "outbox.db-wal"),
        join(f.vault, ".dome", "state", "outbox.db-shm"),
        join(f.vault, ".dome", "state", "runs.db"),
      ];
      const sourceBefore = await fileHashes(protectedPaths);
      await expect(prepareHomeUpgrade({
        vaultPath: f.vault,
        transactionId: randomUUID(),
        candidateArtifactId: CANDIDATE_ID,
      }, f.deps)).rejects.toThrow("requires exact N-1 schema: runs.db");
      expect(await fileHashes(protectedPaths)).toEqual(sourceBefore);
      expect(await readHomeUpgrade(f.vault, f.deps)).toBeNull();
      expect(await gitEvidence(f.vault)).toEqual(gitBefore);
    } finally {
      walDb?.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("a refusal before active publication reopens ordinary writer admission", async () => {
    const f = await fixture();
    try {
      await expect(prepareHomeUpgrade({
        vaultPath: f.vault,
        transactionId: randomUUID(),
        candidateArtifactId: "d".repeat(64),
      }, f.deps)).rejects.toThrow();

      expect(await readHomeUpgrade(f.vault, f.deps)).toBeNull();
      expect(await readHomeUpgradeBarrier(f.vault, f.deps)).toBeNull();
      expect(await inspectOperationalWriterBarrier(f.vault)).toEqual({
        blocked: false,
        transactionId: null,
        blockedAt: null,
      });
      const admitted = await acquireOperationalWriterLease({
        vaultPath: f.vault,
        command: "post-refusal-writer",
      });
      expect(admitted.ok).toBeTrue();
      if (admitted.ok) admitted.lease.close();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("an abort-release failure reports recovery-required evidence and stays closed", async () => {
    const f = await fixture();
    try {
      const markerPath = join(
        homeInstallationPaths(f.vault, f.deps).installations,
        "upgrade",
        "writer-barrier.json",
      );
      const baseVerify = f.deps.verifyArtifact!;
      await expect(prepareHomeUpgrade({
        vaultPath: f.vault,
        transactionId: randomUUID(),
        candidateArtifactId: CANDIDATE_ID,
      }, {
        ...f.deps,
        verifyArtifact: async (path) => {
          if (path.endsWith(CANDIDATE_ID)) {
            await writeFile(markerPath, "{corrupt marker\n", { mode: 0o600 });
            throw new Error("candidate verification failed");
          }
          return baseVerify(path);
        },
      })).rejects.toThrow(
        "preparation failed and write admission remains closed for recovery",
      );
      expect((await inspectOperationalWriterBarrier(f.vault)).blocked).toBeTrue();
      await expect(readHomeUpgradeBarrier(f.vault, f.deps)).rejects.toThrow("corrupt");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("writer-barrier omission is upgrade-ineligible, while old-side durable-state omission is eligible", async () => {
    const f = await fixture();
    try {
      const paths = homeInstallationPaths(f.vault, f.deps);
      for (const artifactId of [CANDIDATE_ID, OLD_ID]) {
        const manifestPath = join(releaseRoot(paths, artifactId), "manifest.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
        delete manifest["writerBarrier"];
        await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
        await expect(prepareHomeUpgrade({
          vaultPath: f.vault,
          transactionId: randomUUID(),
          candidateArtifactId: CANDIDATE_ID,
        }, f.deps)).rejects.toThrow("writer-barrier protocol 1 is required");
        manifest["writerBarrier"] = { protocol: 1 };
        await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
      }
      expect((await inspectOperationalWriterBarrier(f.vault)).blocked).toBeFalse();
      expect((await prepareHomeUpgrade({
        vaultPath: f.vault,
        transactionId: randomUUID(),
        candidateArtifactId: CANDIDATE_ID,
      }, f.deps)).phase).toBe("prepared");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("candidate compatibility requires the explicit supported-upgrade capability", async () => {
    const f = await fixture();
    try {
      const paths = homeInstallationPaths(f.vault, f.deps);
      const manifestPath = join(releaseRoot(paths, CANDIDATE_ID), "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        distribution: { upgradeSupported: boolean };
      };
      manifest.distribution.upgradeSupported = false;
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
      await expect(prepareHomeUpgrade({
        vaultPath: f.vault,
        transactionId: randomUUID(),
        candidateArtifactId: CANDIDATE_ID,
      }, f.deps)).rejects.toThrow("lacks supported-upgrade");
      expect(await readHomeUpgrade(f.vault, f.deps)).toBeNull();
      expect((await inspectOperationalWriterBarrier(f.vault)).blocked).toBeFalse();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("candidate compatibility rejects non-advancing SemVer without changing vault fingerprints", async () => {
    const malformed = ["v1.0.1", "=1.0.1", "01.0.1", "1.0.0-01", " 1.0.1", "1.0.1 "] as const;
    for (const [side, version] of [
      ["candidate", "1.0.0"],
      ["candidate", "0.9.9"],
      ...malformed.map((value) => ["candidate", value] as const),
      ...malformed.map((value) => ["selected", value] as const),
    ] as const) {
      const f = await fixture();
      try {
        const before = await logicalState(f.vault);
        const gitBefore = await gitEvidence(f.vault);
        const paths = homeInstallationPaths(f.vault, f.deps);
        const artifactId = side === "candidate" ? CANDIDATE_ID : OLD_ID;
        const manifestPath = join(releaseRoot(paths, artifactId), "manifest.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          product: { version: string };
        };
        manifest.product.version = version;
        await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
        if (side === "selected") {
          const installation = JSON.parse(await readFile(paths.record, "utf8")) as {
            artifact: { version: string };
          };
          installation.artifact.version = version;
          await writeFile(paths.record, `${JSON.stringify(installation)}\n`, { mode: 0o600 });
        }

        await expect(prepareHomeUpgrade({
          vaultPath: f.vault,
          transactionId: randomUUID(),
          candidateArtifactId: CANDIDATE_ID,
        }, f.deps)).rejects.toThrow("must be a valid SemVer version newer");
        expect(await logicalState(f.vault)).toEqual(before);
        expect(await gitEvidence(f.vault)).toEqual(gitBefore);
        expect(await readHomeUpgrade(f.vault, f.deps)).toBeNull();
        expect((await inspectOperationalWriterBarrier(f.vault)).blocked).toBeFalse();
      } finally { await rm(f.root, { recursive: true, force: true }); }
    }
  });

  test("historical durable-state drift is old-side eligible but candidate-side incompatible", async () => {
    for (const artifactId of [OLD_ID, CANDIDATE_ID]) {
      const f = await fixture();
      try {
        const paths = homeInstallationPaths(f.vault, f.deps);
        const manifestPath = join(releaseRoot(paths, artifactId), "manifest.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
        const historical = structuredClone({
          protocol: HOME_DURABLE_STATE_PROTOCOL,
          stores: HOME_STORE_MIGRATIONS,
        }) as unknown as {
          protocol: number;
          stores: Array<{ currentSchemaHash: string; migratesFrom: string[] }>;
        };
        historical.stores[0]!.currentSchemaHash = "e".repeat(64);
        historical.stores[0]!.migratesFrom = ["f".repeat(64)];
        manifest["durableState"] = historical;
        await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
        const prepare = prepareHomeUpgrade({
          vaultPath: f.vault,
          transactionId: randomUUID(),
          candidateArtifactId: CANDIDATE_ID,
        }, f.deps);
        if (artifactId === OLD_ID) expect((await prepare).phase).toBe("prepared");
        else await expect(prepare).rejects.toThrow("differs from this build");
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    }
  });

  test("prepared restore recreates a missing external marker before ownership", async () => {
    const f = await fixture();
    try {
      await prepareHomeUpgrade({
        vaultPath: f.vault,
        transactionId: randomUUID(),
        candidateArtifactId: CANDIDATE_ID,
      }, f.deps);
      const marker = join(
        homeInstallationPaths(f.vault, f.deps).installations,
        "upgrade",
        "writer-barrier.json",
      );
      await rm(marker);
      await mutateDurableState(f.vault);
      expect((await restoreHomeUpgrade(f.vault, f.deps)).phase).toBe("restored");
      expect((await inspectOperationalWriterBarrier(f.vault)).blocked).toBeFalse();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe("Product Host terminal upgrade history", () => {
  test("retires exact committed and restored outcomes without keeping history live-coupled", async () => {
    for (const outcome of ["committed", "restored"] as const) {
      const f = await fixture();
      try {
        const transactionId = randomUUID();
        const terminal = outcome === "committed"
          ? await committedTerminal(f, transactionId)
          : await restoredTerminal(f, transactionId);
        const retired = await retireHomeUpgrade(
          { vaultPath: f.vault, transactionId },
          historyDeps(f, terminal, outcome === "committed" ? "ready" : "stopped"),
        );
        expect(retired).toMatchObject({ retired: true, transaction: { transactionId, phase: outcome } });
        expect(await readHomeUpgrade(f.vault, f.deps)).toBeNull();
        expect((await readHomeUpgradeHistory(f.vault, transactionId, f.deps))?.phase).toBe(outcome);
        expect(await readLatestHomeUpgradeSummary(f.vault, f.deps)).toMatchObject({ operationId: transactionId, outcome });
        expect(await readHomeUpgradeCandidateReceipt(f.vault, CANDIDATE_ID, f.deps)).toEqual(
          outcome === "restored"
            ? expect.objectContaining({ operationId: transactionId, outcome: "restored" })
            : null,
        );
        const paths = homeInstallationPaths(f.vault, f.deps);
        const historyRoot = join(paths.installations, "upgrade", "history");
        await mkdir(join(historyRoot, "unknown-entry"));
        expect(await readLatestHomeUpgradeSummary(f.vault, f.deps)).toMatchObject({ operationId: transactionId });
        await rm(join(historyRoot, "unknown-entry"), { recursive: true });

        // Historical truth is intrinsic. A future selection or release GC
        // must not make last-attempt evidence unreadable.
        await rm(releaseRoot(paths, outcome === "committed" ? CANDIDATE_ID : OLD_ID), {
          recursive: true,
          force: true,
        });
        expect((await readHomeUpgradeHistory(f.vault, transactionId, f.deps))?.phase).toBe(outcome);

        // Intent/status history is deliberately journal-only: retained state
        // can be very large and full snapshot validation remains an audit API.
        const retained = terminal.snapshot.inventory.find((entry) => entry.present);
        if (retained === undefined) throw new Error("fixture lacks retained snapshot state");
        await writeFile(join(historyRoot, transactionId, "snapshot", retained.name), "corrupt");
        expect(await readLatestHomeUpgradeSummary(f.vault, f.deps)).toMatchObject({
          operationId: transactionId,
          outcome,
        });
        await expect(readHomeUpgradeHistory(f.vault, transactionId, f.deps)).rejects.toThrow();
      } finally { await rm(f.root, { recursive: true, force: true }); }
    }
  });

  test("every retirement crash window retries to one immutable row", async () => {
    for (const checkpoint of [
      "summary-published",
      "receipts-published",
      "before-rename",
      "after-rename",
      "history-synced",
      "upgrade-synced",
    ] as const satisfies readonly HomeUpgradeRetirementCheckpoint[]) {
      const f = await fixture();
      try {
        const transactionId = randomUUID();
        const terminal = await committedTerminal(f, transactionId);
        let injected = false;
        await expect(retireHomeUpgrade({ vaultPath: f.vault, transactionId }, {
          ...historyDeps(f, terminal),
          retirementCheckpoint: async (name) => {
            if (!injected && name === checkpoint) {
              injected = true;
              throw new Error(`crash at ${checkpoint}`);
            }
          },
        })).rejects.toThrow(`crash at ${checkpoint}`);
        expect(await readLatestHomeUpgradeSummary(f.vault, f.deps)).toMatchObject({
          operationId: transactionId,
          outcome: "committed",
        });

        if (["after-rename", "history-synced", "upgrade-synced"].includes(checkpoint)) {
          const paths = homeInstallationPaths(f.vault, f.deps);
          await rm(releaseRoot(paths, OLD_ID), { recursive: true, force: true });
          const archivedSnapshot = join(
            paths.installations,
            "upgrade", "history", transactionId, "snapshot",
          );
          const retained = terminal.snapshot.inventory.filter((entry) => entry.present);
          await rm(join(archivedSnapshot, retained[0]!.name));
          await writeFile(join(archivedSnapshot, retained[1]!.name), "corrupt\n", { mode: 0o600 });
        }

        const retry = await retireHomeUpgrade(
          { vaultPath: f.vault, transactionId },
          historyDeps(f, terminal),
        );
        expect(retry.transaction.transactionId).toBe(transactionId);
        const upgrade = join(homeInstallationPaths(f.vault, f.deps).installations, "upgrade");
        expect(await readdir(join(upgrade, "history"))).toEqual([transactionId]);
        await expect(stat(join(upgrade, "active"))).rejects.toThrow();
        expect((await inspectOperationalWriterBarrier(f.vault)).blocked).toBeFalse();
        expect(await readHomeUpgradeBarrier(f.vault, f.deps)).toBeNull();
        expect(await readLatestHomeUpgradeSummary(f.vault, f.deps)).toMatchObject({
          operationId: transactionId,
          outcome: "committed",
        });
      } finally { await rm(f.root, { recursive: true, force: true }); }
    }
  });

  test("restored retirement keeps full rollback proof and leaves active on snapshot damage", async () => {
    const f = await fixture();
    try {
      const transactionId = randomUUID();
      const terminal = await restoredTerminal(f, transactionId);
      const paths = homeInstallationPaths(f.vault, f.deps);
      const retained = terminal.snapshot.inventory.filter((entry) => entry.present);
      await rm(join(paths.installations, "upgrade", "active", "snapshot", retained[0]!.name));
      await expect(retireHomeUpgrade(
        { vaultPath: f.vault, transactionId },
        historyDeps(f, terminal, "stopped"),
      )).rejects.toThrow("snapshot inventory is not closed");
      expect((await readHomeUpgradeDisposition(f.vault, f.deps))?.phase).toBe("restored");
      await expect(stat(join(paths.installations, "upgrade", "active"))).resolves.toBeDefined();
      await expect(stat(join(paths.installations, "upgrade", "history", transactionId))).rejects.toThrow();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("committed retirement refuses broken forward candidate or selector truth without moving active", async () => {
    for (const fault of ["missing-candidate", "corrupt-candidate", "selector-drift"] as const) {
      const f = await fixture();
      try {
        const transactionId = randomUUID();
        const terminal = await committedTerminal(f, transactionId);
        const paths = homeInstallationPaths(f.vault, f.deps);
        const candidate = releaseRoot(paths, CANDIDATE_ID);
        if (fault === "missing-candidate") await rm(candidate, { recursive: true });
        else if (fault === "corrupt-candidate") {
          await writeFile(join(candidate, "manifest.json"), "corrupt\n", { mode: 0o600 });
        } else await writeFile(paths.record, "selector drift\n", { mode: 0o600 });

        await expect(retireHomeUpgrade(
          { vaultPath: f.vault, transactionId },
          historyDeps(f, terminal, "ready"),
        )).rejects.toThrow();
        await expect(stat(join(paths.installations, "upgrade", "active"))).resolves.toBeDefined();
        await expect(stat(join(paths.installations, "upgrade", "history", transactionId))).rejects.toThrow();
      } finally { await rm(f.root, { recursive: true, force: true }); }
    }
  });

  test("O(1) receipts ignore lifetime history volume and never follow a swapped summary link", async () => {
    const f = await fixture();
    try {
      const transactionId = randomUUID();
      const terminal = await restoredTerminal(f, transactionId);
      await retireHomeUpgrade(
        { vaultPath: f.vault, transactionId },
        historyDeps(f, terminal, "stopped"),
      );
      const upgrade = join(homeInstallationPaths(f.vault, f.deps).installations, "upgrade");
      const history = join(upgrade, "history");
      for (let offset = 0; offset < 1025; offset += 64) {
        await Promise.all(Array.from({ length: Math.min(64, 1025 - offset) }, (_, index) =>
          mkdir(join(history, `gc-substrate-${offset + index}`))));
      }
      expect(await readHomeUpgradeCandidateReceipt(f.vault, CANDIDATE_ID, f.deps)).toMatchObject({
        operationId: transactionId,
        outcome: "restored",
      });
      expect(await readLatestHomeUpgradeSummary(f.vault, f.deps)).toMatchObject({ operationId: transactionId });

      const latest = join(upgrade, "receipts", "latest.json");
      const outside = join(f.root, "outside-summary.json");
      const outsideBytes = await readFile(latest);
      const transactionRoot = join(history, transactionId);
      await rm(join(transactionRoot, "journal.json"));
      await rm(join(transactionRoot, "selectors"), { recursive: true });
      await rm(join(transactionRoot, "snapshot"), { recursive: true });
      await expect(readHomeUpgradeCandidateReceipt(f.vault, CANDIDATE_ID, f.deps)).rejects.toThrow(
        "lacks its journal",
      );
      await expect(readLatestHomeUpgradeSummary(f.vault, f.deps)).rejects.toThrow("lacks its journal");
      await rm(join(history, transactionId), { recursive: true });
      expect(await readHomeUpgradeCandidateReceipt(f.vault, CANDIDATE_ID, f.deps)).toBeNull();
      expect(await readLatestHomeUpgradeSummary(f.vault, f.deps)).toBeNull();
      await writeFile(outside, outsideBytes, { mode: 0o600 });
      await rm(latest);
      await symlink(outside, latest);
      await expect(readLatestHomeUpgradeSummary(f.vault, f.deps)).rejects.toThrow("without following links");
      expect(await readFile(outside)).toEqual(outsideBytes);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("a pre-rename restored receipt stays subordinate to active then becomes O(1) history", async () => {
    const f = await fixture();
    try {
      const transactionId = randomUUID();
      const terminal = await restoredTerminal(f, transactionId);
      await expect(retireHomeUpgrade({ vaultPath: f.vault, transactionId }, {
        ...historyDeps(f, terminal, "stopped"),
        retirementCheckpoint: async (name) => {
          if (name === "receipts-published") throw new Error("crash before retirement rename");
        },
      })).rejects.toThrow("crash before retirement rename");
      expect(await readHomeUpgradeCandidateReceipt(f.vault, CANDIDATE_ID, f.deps)).toBeNull();
      expect(await readLatestHomeUpgradeSummary(f.vault, f.deps)).toMatchObject({
        operationId: transactionId,
        outcome: "restored",
      });
      await retireHomeUpgrade({ vaultPath: f.vault, transactionId }, historyDeps(f, terminal, "stopped"));
      expect(await readHomeUpgradeCandidateReceipt(f.vault, CANDIDATE_ID, f.deps)).toMatchObject({
        operationId: transactionId,
        outcome: "restored",
      });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("O(1) readers fall through when active retires between observation and open", async () => {
    for (const consumer of ["candidate", "latest"] as const) {
      const f = await fixture();
      try {
        const transactionId = randomUUID();
        const terminal = await restoredTerminal(f, transactionId);
        await expect(retireHomeUpgrade({ vaultPath: f.vault, transactionId }, {
          ...historyDeps(f, terminal, "stopped"),
          retirementCheckpoint: async (name) => {
            if (name === "receipts-published") throw new Error("hold before rename");
          },
        })).rejects.toThrow("hold before rename");
        const upgrade = join(homeInstallationPaths(f.vault, f.deps).installations, "upgrade");
        let raced = false;
        const deps: HomeUpgradeHistoryDeps = {
          ...f.deps,
          receiptCheckpoint: async (name) => {
            if (!raced && name === `${consumer}-active-observed`) {
              raced = true;
              await rename(join(upgrade, "active"), join(upgrade, "history", transactionId));
            }
          },
        };
        const summary = consumer === "candidate"
          ? await readHomeUpgradeCandidateReceipt(f.vault, CANDIDATE_ID, deps)
          : await readLatestHomeUpgradeSummary(f.vault, deps);
        expect(raced).toBeTrue();
        expect(summary).toMatchObject({ operationId: transactionId, outcome: "restored" });
      } finally { await rm(f.root, { recursive: true, force: true }); }
    }
  });

  test("O(1) readers treat an atomic history GC rename as an expired receipt", async () => {
    for (const consumer of ["candidate", "latest"] as const) {
      const f = await fixture();
      try {
        const transactionId = randomUUID();
        const terminal = await restoredTerminal(f, transactionId);
        await retireHomeUpgrade(
          { vaultPath: f.vault, transactionId },
          historyDeps(f, terminal, "stopped"),
        );
        const upgrade = join(homeInstallationPaths(f.vault, f.deps).installations, "upgrade");
        const archived = join(upgrade, "history", transactionId);
        const garbage = join(upgrade, `gc-${transactionId}`);
        let raced = false;
        const deps: HomeUpgradeHistoryDeps = {
          ...f.deps,
          historyIdentityCheckpoint: async () => {
            if (!raced) {
              raced = true;
              await rename(archived, garbage);
            }
          },
        };
        const summary = consumer === "candidate"
          ? await readHomeUpgradeCandidateReceipt(f.vault, CANDIDATE_ID, deps)
          : await readLatestHomeUpgradeSummary(f.vault, deps);
        expect(raced).toBeTrue();
        expect(summary).toBeNull();
        expect(await stat(garbage)).toBeDefined();
      } finally { await rm(f.root, { recursive: true, force: true }); }
    }
  });

  test("receipt proof never follows a journal swapped to a symlink", async () => {
    const f = await fixture();
    try {
      const transactionId = randomUUID();
      const terminal = await restoredTerminal(f, transactionId);
      await retireHomeUpgrade(
        { vaultPath: f.vault, transactionId },
        historyDeps(f, terminal, "stopped"),
      );
      const upgrade = join(homeInstallationPaths(f.vault, f.deps).installations, "upgrade");
      const journal = join(upgrade, "history", transactionId, "journal.json");
      const retainedJournal = `${journal}.retained`;
      const sentinel = join(f.root, "journal-sentinel.json");
      const sentinelBytes = "sentinel must not be opened\n";
      await writeFile(sentinel, sentinelBytes, { mode: 0o600 });
      let swapped = false;
      const deps: HomeUpgradeHistoryDeps = {
        ...f.deps,
        journalReadCheckpoint: async (name) => {
          if (!swapped && name === "root-opened") {
            swapped = true;
            await rename(journal, retainedJournal);
            await symlink(sentinel, journal);
          }
        },
      };
      await expect(readHomeUpgradeCandidateReceipt(f.vault, CANDIDATE_ID, deps)).rejects.toThrow(
        "cannot be opened without following links",
      );
      expect(swapped).toBeTrue();
      expect(await readFile(sentinel, "utf8")).toBe(sentinelBytes);

      await rm(journal);
      await rename(retainedJournal, journal);
      expect(await readHomeUpgradeCandidateReceipt(f.vault, CANDIDATE_ID, f.deps)).toMatchObject({
        operationId: transactionId,
        outcome: "restored",
      });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("receipt proof rejects journal replacement after its stable handle opens", async () => {
    const f = await fixture();
    try {
      const transactionId = randomUUID();
      const terminal = await restoredTerminal(f, transactionId);
      await retireHomeUpgrade(
        { vaultPath: f.vault, transactionId },
        historyDeps(f, terminal, "stopped"),
      );
      const upgrade = join(homeInstallationPaths(f.vault, f.deps).installations, "upgrade");
      const journal = join(upgrade, "history", transactionId, "journal.json");
      const retainedJournal = `${journal}.retained`;
      const journalBytes = await readFile(journal);
      let swapped = false;
      const deps: HomeUpgradeHistoryDeps = {
        ...f.deps,
        journalReadCheckpoint: async (name) => {
          if (!swapped && name === "journal-opened") {
            swapped = true;
            await rename(journal, retainedJournal);
            await writeFile(journal, journalBytes, { mode: 0o600 });
          }
        },
      };
      await expect(readLatestHomeUpgradeSummary(f.vault, deps)).rejects.toThrow(
        "journal changed during bounded inspection",
      );
      expect(swapped).toBeTrue();

      await rm(journal);
      await rename(retainedJournal, journal);
      expect(await readLatestHomeUpgradeSummary(f.vault, f.deps)).toMatchObject({
        operationId: transactionId,
        outcome: "restored",
      });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("receipt proof rejects transaction-root inode replacement during closure", async () => {
    const f = await fixture();
    try {
      const transactionId = randomUUID();
      const terminal = await restoredTerminal(f, transactionId);
      await retireHomeUpgrade(
        { vaultPath: f.vault, transactionId },
        historyDeps(f, terminal, "stopped"),
      );
      const upgrade = join(homeInstallationPaths(f.vault, f.deps).installations, "upgrade");
      const archived = join(upgrade, "history", transactionId);
      const replacement = join(upgrade, "history", `.replacement-${transactionId}`);
      const retained = join(upgrade, "history", `.retained-${transactionId}`);
      await cp(archived, replacement, { recursive: true });
      let swapped = false;
      const deps: HomeUpgradeHistoryDeps = {
        ...f.deps,
        journalReadCheckpoint: async (name) => {
          if (!swapped && name === "before-root-recheck") {
            swapped = true;
            await rename(archived, retained);
            await rename(replacement, archived);
          }
        },
      };
      await expect(readHomeUpgradeCandidateReceipt(f.vault, CANDIDATE_ID, deps)).rejects.toThrow(
        "transaction root changed during bounded inspection",
      );
      expect(swapped).toBeTrue();

      await rm(archived, { recursive: true });
      await rename(retained, archived);
      expect(await readHomeUpgradeCandidateReceipt(f.vault, CANDIDATE_ID, f.deps)).toMatchObject({
        operationId: transactionId,
        outcome: "restored",
      });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("concurrent retirees converge and preserve history-before-upgrade fsync order", async () => {
    const f = await fixture();
    try {
      const transactionId = randomUUID();
      const terminal = await committedTerminal(f, transactionId);
      const synced: string[] = [];
      const deps = {
        ...historyDeps(f, terminal),
        syncHistoryDirectory: async (path: string) => { synced.push(path); },
      };
      const [first, second] = await Promise.all([
        retireHomeUpgrade({ vaultPath: f.vault, transactionId }, deps),
        retireHomeUpgrade({ vaultPath: f.vault, transactionId }, deps),
      ]);
      expect([first.retired, second.retired].sort()).toEqual([false, true]);
      const upgrade = join(homeInstallationPaths(f.vault, f.deps).installations, "upgrade");
      expect(await readdir(join(upgrade, "history"))).toEqual([transactionId]);
      expect(synced.slice(-2)).toEqual([join(upgrade, "history"), upgrade]);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("production service inspection accepts ready/stopped and rejects loaded-unreachable without deadlock", async () => {
    for (const state of ["ready", "stopped", "loaded-unreachable"] as const) {
      const f = await fixture();
      try {
        const transactionId = randomUUID();
        await committedTerminal(f, transactionId);
        const loaded = state !== "stopped";
        const attempt = retireHomeUpgrade({ vaultPath: f.vault, transactionId }, {
          ...f.deps,
          uid: 501,
          publishHistory: rename,
          launchctl: async (args) => ({
            exitCode: args[0] === "print" ? loaded ? 0 : 113 : 0,
            stdout: "",
            stderr: "",
          }),
          readiness: async () => state === "ready",
        });
        if (state === "loaded-unreachable") {
          await expect(attempt).rejects.toThrow("neither ready nor stopped");
          expect((await readHomeUpgrade(f.vault, f.deps))?.phase).toBe("committed");
        } else {
          expect((await attempt).transaction.phase).toBe("committed");
          expect(await readHomeUpgrade(f.vault, f.deps)).toBeNull();
        }
      } finally { await rm(f.root, { recursive: true, force: true }); }
    }
  });

  test("a redirected history-root race is rejected without chmodding its target", async () => {
    const f = await fixture();
    try {
      const transactionId = randomUUID();
      const terminal = await restoredTerminal(f, transactionId);
      const upgrade = join(homeInstallationPaths(f.vault, f.deps).installations, "upgrade");
      const target = join(f.root, "unowned-history-target");
      await mkdir(target, { mode: 0o755 });
      await symlink(target, join(upgrade, "history"), "dir");
      await expect(retireHomeUpgrade(
        { vaultPath: f.vault, transactionId },
        historyDeps(f, terminal),
      )).rejects.toThrow("direct owned directory");
      expect((await stat(target)).mode & 0o777).toBe(0o755);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("fails closed for non-terminal, wrong-service, and duplicate destination evidence", async () => {
    const f = await fixture();
    try {
      const transactionId = randomUUID();
      await prepareHomeUpgrade({
        vaultPath: f.vault,
        transactionId,
        candidateArtifactId: CANDIDATE_ID,
      }, f.deps);
      await expect(retireHomeUpgrade({ vaultPath: f.vault, transactionId }, {
        ...f.deps,
        publishHistory: rename,
        inspectTerminalService: async () => ({
          state: "stopped",
          artifactId: OLD_ID,
          productVersion: "1.0.0",
        }),
      })).rejects.toThrow("write admission");

      const terminal = await restoreHomeUpgrade(f.vault, f.deps);
      await expect(retireHomeUpgrade({ vaultPath: f.vault, transactionId }, {
        ...historyDeps(f, terminal),
        inspectTerminalService: async () => ({
          state: "stopped",
          artifactId: CANDIDATE_ID,
          productVersion: "2.0.0",
        }),
      })).rejects.toThrow("does not select");

      const upgrade = join(homeInstallationPaths(f.vault, f.deps).installations, "upgrade");
      const history = join(upgrade, "history");
      await mkdir(history, { recursive: true });
      await mkdir(join(history, transactionId));
      await writeFile(join(history, transactionId, "unknown"), "ambiguous\n");
      await expect(retireHomeUpgrade(
        { vaultPath: f.vault, transactionId },
        historyDeps(f, terminal),
      )).rejects.toThrow();
      expect((await readHomeUpgradeForRecovery(f.vault, f.deps))?.phase).toBe("restored");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("rejects exact duplicates, redirected destinations, and conflicting full history identity", async () => {
    for (const corruption of ["duplicate", "redirect", "wrong-identity", "same-summary-different-journal"] as const) {
      const f = await fixture();
      try {
        const transactionId = randomUUID();
        const terminal = await restoredTerminal(f, transactionId);
        const upgrade = join(homeInstallationPaths(f.vault, f.deps).installations, "upgrade");
        const active = join(upgrade, "active");
        const history = join(upgrade, "history");
        const destination = join(history, transactionId);
        await mkdir(history, { mode: 0o700 });
        if (corruption === "redirect") {
          await symlink(active, destination, "dir");
        } else {
          await cp(active, destination, { recursive: true, preserveTimestamps: true });
          if (corruption === "wrong-identity" || corruption === "same-summary-different-journal") {
            const journalPath = join(destination, "journal.json");
            const journal = JSON.parse(await readFile(journalPath, "utf8"));
            if (corruption === "wrong-identity") journal.transactionId = randomUUID();
            else journal.old.manifestSha256 = "e".repeat(64);
            await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
          }
        }
        const failure = retireHomeUpgrade(
          { vaultPath: f.vault, transactionId },
          historyDeps(f, terminal),
        );
        if (corruption === "duplicate") await expect(failure).rejects.toThrow("both active");
        else await expect(failure).rejects.toThrow();
        expect((await readHomeUpgradeForRecovery(f.vault, f.deps))?.phase).toBe("restored");
      } finally { await rm(f.root, { recursive: true, force: true }); }
    }
  });
});

type UpgradeFixture = Awaited<ReturnType<typeof fixture>>;

async function committedTerminal(f: UpgradeFixture, transactionId: string) {
  await prepareHomeUpgrade({
    vaultPath: f.vault,
    transactionId,
    candidateArtifactId: CANDIDATE_ID,
  }, f.deps);
  await migratePreparedHomeUpgrade(f.vault, f.deps);
  const committed = await commitPreparedHomeUpgrade({
    vaultPath: f.vault,
    proof: probationProof(transactionId),
  }, f.deps);
  await releaseCommittedHomeUpgrade(f.vault, {
    ...f.deps,
    inspectLifecycleSuspension: async () => authorizedLifecycle(committed),
  });
  return committed;
}

async function restoredTerminal(f: UpgradeFixture, transactionId: string) {
  await prepareHomeUpgrade({
    vaultPath: f.vault,
    transactionId,
    candidateArtifactId: CANDIDATE_ID,
  }, f.deps);
  return restoreHomeUpgrade(f.vault, f.deps);
}

function historyDeps(
  f: UpgradeFixture,
  terminal: Awaited<ReturnType<typeof committedTerminal>>,
  state: "ready" | "stopped" = "stopped",
): HomeUpgradeHistoryDeps {
  const selected = terminal.phase === "committed" ? terminal.candidate : terminal.old;
  return {
    ...f.deps,
    publishHistory: rename,
    inspectTerminalService: async () => Object.freeze({
      state,
      artifactId: selected.artifactId,
      productVersion: selected.version,
    }),
  };
}

async function fixture(options: { durableFiles?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dome-home-upgrade-")));
  const vault = join(root, "vault");
  const support = join(root, "Application Support", "Dome", "Home");
  const launchAgentsDir = join(root, "LaunchAgents");
  await initRepo(vault);
  await mkdir(join(vault, ".dome", "state"), { recursive: true });
  await writeFile(join(vault, ".dome", "config.yaml"), "extensions: {}\n");
  await writeFile(join(vault, "note.md"), "# N-1\n");
  await add(vault, "note.md");
  await commit({ path: vault, message: "N-1 fixture" });
  const frozen = await seedStores(vault);

  const credential = frozen.authorityCanary.activeCredential;
  const csrfSecret = frozen.authorityCanary.activeCsrf;
  let unusedPairingCode = "";
  const revokedCredential = frozen.authorityCanary.revokedCredential;
  const authority = await openDeviceAuthority({ path: join(vault, ".dome", "state", "device-authority.db") });
  if (!authority.ok) throw new Error("authority fixture failed");
  const unused = authority.value.authority.mintPairingGrant({ deviceName: "tablet", capabilities: ["read"], now: new Date("2026-07-13T00:00:02.000Z") });
  if (unused.kind !== "minted") throw new Error("unused grant fixture failed");
  unusedPairingCode = unused.pairingCode;
  const authEpoch = authority.value.authority.authEpoch();
  authority.value.authority.close();

  if (options.durableFiles !== false) {
    await writeFile(join(vault, ".dome", "state", "quarantined.json"), `${JSON.stringify({ version: 1, entries: [{ phase: "garden", processorId: "dome.test", processorVersion: "1", triggerHash: "x", consecutiveRetryableFailures: 3 }] })}\n`, { mode: 0o600 });
    await writeFile(join(vault, ".dome", "state", "product-host-id"), "stable-vault-id\n", { mode: 0o600 });
  }

  const deps: HomeUpgradeTransactionDeps = {
    applicationSupportDir: support,
    launchAgentsDir,
    platform: "darwin",
    publishTransaction: rename,
    now: () => new Date("2026-07-13T01:00:00.000Z"),
    verifyArtifact: async (path) => JSON.parse(await readFile(join(path, "manifest.json"), "utf8")) as HomeArtifactManifest,
  };
  const paths = homeInstallationPaths(vault, deps);
  await mkdir(launchAgentsDir, { recursive: true });
  for (const [id, version] of [[OLD_ID, "1.0.0"], [CANDIDATE_ID, "2.0.0"]] as const) {
    const release = releaseRoot(paths, id);
    await mkdir(release, { recursive: true });
    await writeFile(join(release, "manifest.json"), `${JSON.stringify({
      artifact: { id },
      product: { name: "Dome Home", version },
      writerBarrier: { protocol: 1 },
      ...(id === CANDIDATE_ID ? {
        distribution: { signed: false, notarized: false, upgradeSupported: true },
        durableState: {
          protocol: HOME_DURABLE_STATE_PROTOCOL,
          stores: HOME_STORE_MIGRATIONS,
        },
      } : {}),
    })}\n`, { mode: 0o600 });
  }
  const oldManifest = JSON.parse(await readFile(join(releaseRoot(paths, OLD_ID), "manifest.json"), "utf8")) as HomeArtifactManifest;
  await publishHomeInstallation(paths.record, createHomeInstallation(vault, oldManifest, new Map()), deps);
  await writeFile(join(launchAgentsDir, `${homeServiceLabelForVault(vault)}.plist`), `<plist>${OLD_ID}</plist>\n`, { mode: 0o600 });
  return { root, vault, deps, credential, csrfSecret, revokedCredential, unusedPairingCode, authEpoch };
}

function authorizedLifecycle(journal: Awaited<ReturnType<typeof commitPreparedHomeUpgrade>>) {
  const selection = journal.selection!;
  return {
    kind: "active" as const,
    suspension: {
      schema: "dome.home-lifecycle-suspension/v1" as const,
      phase: "suspended" as const,
      purpose: "upgrade" as const,
      operationId: journal.transactionId,
      vault: journal.vault,
      priorLoaded: true,
      installationPath: journal.selectors.installation.path,
      installationSha256: journal.selectors.installation.sha256,
      artifactId: journal.old.artifactId,
      artifactVersion: journal.old.version,
      plistPath: journal.selectors.plist.path,
      plistSha256: journal.selectors.plist.sha256,
      resumeInstallationPath: selection.candidate.installation.path,
      resumeInstallationSha256: selection.candidate.installation.sha256,
      resumeArtifactId: journal.candidate.artifactId,
      resumeArtifactVersion: journal.candidate.version,
      resumePlistPath: selection.candidate.plist.path,
      resumePlistSha256: selection.candidate.plist.sha256,
      requestedAt: journal.timestamps.preparedAt,
      phaseChangedAt: journal.timestamps.preparedAt,
      lastError: null,
    },
  };
}

function oldLifecycle(journal: Awaited<ReturnType<typeof prepareHomeUpgrade>>) {
  const selection = journal.selection!;
  return {
    kind: "active" as const,
    suspension: {
      schema: "dome.home-lifecycle-suspension/v1" as const,
      phase: "suspended" as const,
      purpose: "upgrade" as const,
      operationId: journal.transactionId,
      vault: journal.vault,
      priorLoaded: true,
      installationPath: journal.selectors.installation.path,
      installationSha256: journal.selectors.installation.sha256,
      artifactId: journal.old.artifactId,
      artifactVersion: journal.old.version,
      plistPath: journal.selectors.plist.path,
      plistSha256: journal.selectors.plist.sha256,
      resumeInstallationPath: selection.old.installation.path,
      resumeInstallationSha256: selection.old.installation.sha256,
      resumeArtifactId: journal.old.artifactId,
      resumeArtifactVersion: journal.old.version,
      resumePlistPath: selection.old.plist.path,
      resumePlistSha256: selection.old.plist.sha256,
      requestedAt: journal.timestamps.preparedAt,
      phaseChangedAt: journal.timestamps.preparedAt,
      lastError: null,
    },
  };
}

async function seedStores(vault: string) {
  const state = join(vault, ".dome", "state");
  return await materializeFrozenN1Fixture({
    fixtureRoot: join(import.meta.dir, "..", "fixtures", "home-upgrade", "n-1", FROZEN_N1_RELEASE),
    destination: state,
  });
}

async function mutateDurableState(vault: string): Promise<void> {
  const state = join(vault, ".dome", "state");
  for (const name of DATABASES) {
    const db = new Database(join(state, name));
    for (const table of db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%_meta' AND name <> 'sqlite_sequence'").all()) db.run(`DELETE FROM ${table.name}`);
    db.close();
    await writeFile(join(state, `${name}-wal`), "candidate wal");
    await writeFile(join(state, `${name}-shm`), "candidate shm");
  }
  await writeFile(join(state, "quarantined.json"), "{\"candidate\":true}\n");
  await writeFile(join(state, "product-host-id"), "candidate-vault-id\n");
}

async function logicalState(vault: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  const state = join(vault, ".dome", "state");
  for (const name of DATABASES) {
    const db = new Database(join(state, name), { readonly: true, create: false });
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name <> 'sqlite_sequence' ORDER BY name").all();
    result[name] = tables.map(({ name: table }) => ({ table, rows: db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() }));
    db.close();
  }
  for (const name of ["quarantined.json", "product-host-id"]) result[name] = await exists(join(state, name)) ? await readFile(join(state, name), "utf8") : null;
  return result;
}

async function gitEvidence(vault: string) {
  return { head: await resolveRef({ path: vault, ref: "HEAD" }), note: await readFile(join(vault, "note.md"), "utf8") };
}

async function fileHashes(paths: ReadonlyArray<string>): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of paths) result[path] = createHash("sha256").update(await readFile(path)).digest("hex");
  return result;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
