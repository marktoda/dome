import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { openAnswersDb } from "../../src/answers/db";
import { recordQuestionAnswer } from "../../src/answers/question-answers";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { externalActionEffect, fileChange } from "../../src/core/effect";
import { openDeviceAuthority } from "../../src/device-authority/device-authority";
import { add, commit, initRepo, resolveRef } from "../../src/git";
import { openLedgerDb } from "../../src/ledger/db";
import { insertQueued, markRunning, markSucceeded, newRunId } from "../../src/ledger/runs";
import { openOutboxDb } from "../../src/outbox/db";
import { insertPending } from "../../src/outbox/dispatch";
import {
  acquireOperationalWriterLease,
  inspectOperationalWriterBarrier,
} from "../../src/operational-state/writer-barrier";
import { openProposalsDb } from "../../src/proposals/db";
import { enqueuePendingProposal } from "../../src/proposals/pending-proposals";
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
  inspectHomeUpgradeAdmission,
  prepareHomeUpgrade,
  readHomeUpgrade,
  restoreHomeUpgrade,
  type HomeUpgradeTransactionDeps,
} from "../../src/product-host/home-upgrade-transaction";
import { openRequestReceiptsDb } from "../../src/request-receipts/db";
import { createRequestReceipts } from "../../src/request-receipts/request-receipts";
import type { HomeArtifactManifest } from "../../src/product-host/home-artifact";

const OLD_ID = "a".repeat(64);
const CANDIDATE_ID = "b".repeat(64);
const OID = commitOid("c".repeat(40));
const DATABASES = [
  "answers.db", "proposals.db", "outbox.db", "runs.db", "request-receipts.db", "device-authority.db",
] as const;

describe("Product Host pre-commit upgrade transaction", () => {
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
        "candidate", "old", "phase", "schema", "selectors", "snapshot", "timestamps", "transactionId", "vault",
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
      await expect(restoreHomeUpgrade(f.vault, f.deps)).rejects.toThrow("plist evidence changed");
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
      await writeFile(join(f.vault, ".dome", "state", "device-authority.db"), "corrupt", { flag: "w" });
      const protectedPaths = [
        join(f.vault, "note.md"),
        join(f.vault, ".dome", "state", "outbox.db"),
        join(f.vault, ".dome", "state", "outbox.db-wal"),
        join(f.vault, ".dome", "state", "device-authority.db"),
      ];
      const corruptBefore = await fileHashes(protectedPaths);
      await expect(prepareHomeUpgrade({ vaultPath: f.vault, transactionId: randomUUID(), candidateArtifactId: CANDIDATE_ID }, f.deps)).rejects.toThrow();
      expect(await fileHashes(protectedPaths)).toEqual(corruptBefore);
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

  test("legacy artifacts stay runnable but are ineligible on either side of upgrade", async () => {
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
    } finally {
      await rm(f.root, { recursive: true, force: true });
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

async function fixture(options: { durableFiles?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dome-home-upgrade-")));
  const vault = join(root, "vault");
  const support = join(root, "Application Support", "Dome", "Home");
  const launchAgentsDir = join(root, "LaunchAgents");
  await initRepo(vault);
  await mkdir(join(vault, ".dome", "state"), { recursive: true });
  await writeFile(join(vault, "note.md"), "# N-1\n");
  await add(vault, "note.md");
  await commit({ path: vault, message: "N-1 fixture" });
  await seedStores(vault);

  let credential = "";
  let csrfSecret = "";
  let unusedPairingCode = "";
  let revokedCredential = "";
  const authority = await openDeviceAuthority({ path: join(vault, ".dome", "state", "device-authority.db") });
  if (!authority.ok) throw new Error("authority fixture failed");
  const first = authority.value.authority.mintPairingGrant({ deviceName: "phone", capabilities: ["read", "capture"], now: new Date("2026-07-13T00:00:00.000Z") });
  if (first.kind !== "minted") throw new Error("grant fixture failed");
  const paired = authority.value.authority.exchangePairingCode({ pairingCode: first.pairingCode, now: new Date("2026-07-13T00:00:01.000Z") });
  if (paired.kind !== "paired") throw new Error("pair fixture failed");
  credential = paired.credential;
  csrfSecret = paired.csrfSecret;
  const unused = authority.value.authority.mintPairingGrant({ deviceName: "tablet", capabilities: ["read"], now: new Date("2026-07-13T00:00:02.000Z") });
  if (unused.kind !== "minted") throw new Error("unused grant fixture failed");
  unusedPairingCode = unused.pairingCode;
  const revokedGrant = authority.value.authority.mintPairingGrant({ deviceName: "old phone", capabilities: ["read"], now: new Date("2026-07-13T00:00:02.000Z") });
  if (revokedGrant.kind !== "minted") throw new Error("revoked grant fixture failed");
  const revoked = authority.value.authority.exchangePairingCode({ pairingCode: revokedGrant.pairingCode, now: new Date("2026-07-13T00:00:03.000Z") });
  if (revoked.kind !== "paired") throw new Error("revoked pair fixture failed");
  revokedCredential = revoked.credential;
  if (authority.value.authority.revokeDevice({ deviceId: revoked.device.id, now: new Date("2026-07-13T00:00:04.000Z") }).kind !== "revoked") throw new Error("revoke fixture failed");
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
    })}\n`, { mode: 0o600 });
  }
  const oldManifest = JSON.parse(await readFile(join(releaseRoot(paths, OLD_ID), "manifest.json"), "utf8")) as HomeArtifactManifest;
  await publishHomeInstallation(paths.record, createHomeInstallation(vault, oldManifest, new Map()), deps);
  await writeFile(join(launchAgentsDir, `${homeServiceLabelForVault(vault)}.plist`), `<plist>${OLD_ID}</plist>\n`, { mode: 0o600 });
  return { root, vault, deps, credential, csrfSecret, revokedCredential, unusedPairingCode, authEpoch };
}

async function seedStores(vault: string): Promise<void> {
  const state = join(vault, ".dome", "state");
  const answers = await openAnswersDb({ path: join(state, "answers.db") });
  if (!answers.ok) throw new Error("answers fixture failed");
  recordQuestionAnswer(answers.value.db, { idempotencyKey: "answer-1", answer: "yes", answeredAt: "2026-07-13T00:00:00.000Z", questionId: 1, question: "Proceed?", processorId: "dome.test", adoptedCommit: OID, answeredBy: "owner" });
  answers.value.db.close();
  const proposals = await openProposalsDb({ path: join(state, "proposals.db") });
  if (!proposals.ok) throw new Error("proposals fixture failed");
  enqueuePendingProposal(proposals.value.db, { processorId: "dome.test", extensionId: "dome.test", runId: null, reason: "fixture", changes: [fileChange({ kind: "write", path: "future.md", content: "future\n" })], sourceRefs: [], baseCommit: OID, baseContents: { "future.md": null }, createdAt: "2026-07-13T00:00:00.000Z" });
  proposals.value.db.close();
  const outbox = await openOutboxDb({ path: join(state, "outbox.db") });
  if (!outbox.ok) throw new Error("outbox fixture failed");
  insertPending(outbox.value.db, { effect: externalActionEffect({ capability: "slack.write", idempotencyKey: "outbox-1", payload: { text: "pending" }, sourceRefs: [sourceRef({ commit: OID, path: "note.md" })] }), runId: "run-fixture", now: new Date("2026-07-13T00:00:00.000Z") });
  outbox.value.db.close();
  const ledger = await openLedgerDb({ path: join(state, "runs.db") });
  if (!ledger.ok) throw new Error("ledger fixture failed");
  const runId = newRunId(new Date("2026-07-13T00:00:00.000Z"), () => "abc123");
  insertQueued(ledger.value.db, { id: runId, proposalId: null, processorId: "dome.test", processorVersion: "1", phase: "garden", inputCommit: OID, triggerKind: "signal", triggerPayload: { name: "fixture" }, startedAt: new Date("2026-07-13T00:00:00.000Z") });
  markRunning(ledger.value.db, runId, new Date("2026-07-13T00:00:00.001Z"));
  markSucceeded(ledger.value.db, { id: runId, effectHashes: ["effect"], costUsd: 0, durationMs: 1, outputCommit: null, finishedAt: new Date("2026-07-13T00:00:00.002Z") });
  ledger.value.db.close();
  const receiptDb = await openRequestReceiptsDb({ path: join(state, "request-receipts.db") });
  if (!receiptDb.ok) throw new Error("receipt fixture failed");
  const receipts = createRequestReceipts(receiptDb.value.db, { now: () => new Date("2026-07-13T00:00:00.000Z"), createId: () => "operation-1" });
  receipts.admit({ requestId: "request-1", actorId: "owner", deviceId: "device-1", credentialId: "credential-1", transport: "cookie", hostInstanceId: "host-1", executor: "http", operation: "capture", operationClass: "workspace-mutation" });
  receipts.close();
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
