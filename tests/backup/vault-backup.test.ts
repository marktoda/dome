import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createVaultBackup, generateBackupIdentity, restoreVaultBackup, verifyVaultBackup } from "../../src/backup/vault-backup";
import { add, commit, initRepo, readStandaloneBackupSource, statusMatrix } from "../../src/git";
import { extractTarFile, inspectTar, writeTarTree } from "../../src/backup/tar";
import { openDeviceAuthority } from "../../src/device-authority/device-authority";
import { homeInstallationPaths } from "../../src/product-host/home-installation";
import { externalProductHostLockPath } from "../../src/product-host/host-ownership";
import { inspectHomeLifecycleSuspension } from "../../src/product-host/home-lifecycle-suspension";
import { withExclusiveFileLock } from "../../src/engine/host/file-lock";
import { engageOperationalWriterBarrier, releaseOperationalWriterBarrier } from "../../src/operational-state/writer-barrier";
import { vaultServiceSlug } from "../../src/surface/service-probe";

const MULTI_TRANSACTION_SCENARIO_TIMEOUT_MS = 15_000;

describe("encrypted vault backup checkpoint", () => {
  test("keygen, create, verify, and internal blank-target rehearsal need no native git", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-backup-"));
    try {
      const tools = await fakeAgeTools(root);
      const vault = join(root, "vault");
      await mkdir(join(vault, ".dome", "state"), { recursive: true });
      await initRepo(vault);
      await writeFile(join(vault, ".dome", "config.yaml"), "version: 1\n");
      await writeFile(join(vault, "index.md"), "# Vault\n");
      await add(vault, ".dome/config.yaml");
      await add(vault, "index.md");
      await commit({ path: vault, message: "fixture" });
      let walDb: Database | null = null;
      for (const name of ["answers.db", "proposals.db", "outbox.db", "runs.db", "request-receipts.db", "projection.db"]) {
        const db = new Database(join(vault, ".dome", "state", name));
        if (name === "answers.db") {
          db.run("PRAGMA journal_mode = WAL");
          db.run("PRAGMA wal_autocheckpoint = 0");
        }
        db.run("CREATE TABLE evidence (value TEXT NOT NULL)");
        db.query("INSERT INTO evidence VALUES (?)").run(name);
        if (name === "answers.db") walDb = db;
        else db.close();
      }
      const authorityOpened = await openDeviceAuthority({ path: join(vault, ".dome", "state", "device-authority.db") });
      if (!authorityOpened.ok) throw new Error("device authority fixture failed");
      const authority = authorityOpened.value.authority;
      const oldGrant = authority.mintPairingGrant({ deviceName: "old-phone", capabilities: ["read"] });
      if (oldGrant.kind !== "minted") throw new Error("pairing fixture failed");
      const paired = authority.exchangePairingCode({ pairingCode: oldGrant.pairingCode });
      if (paired.kind !== "paired") throw new Error("credential fixture failed");
      const unusedGrant = authority.mintPairingGrant({ deviceName: "unused-phone", capabilities: ["read"] });
      if (unusedGrant.kind !== "minted") throw new Error("unused grant fixture failed");
      authority.close();
      await writeFile(join(vault, ".dome", "state", "product-host-id"), "vault-fixture\n");
      await writeFile(join(vault, ".dome", "state", "quarantined.json"), "{}\n");
      const identity = join(root, "identity.txt");
      const key = await generateBackupIdentity({ output: identity }, { ...tools });
      expect(key.status).toBe("created");
      expect((await stat(identity)).mode & 0o777).toBe(0o600);

      const archive = join(root, "backup.dome.age");
      const home = await installedHome(vault, root, false);
      const priorPath = process.env.PATH;
      process.env.PATH = "/path-without-git";
      const created = await createVaultBackup({ vaultPath: vault, output: archive, recipient: key.recipient! }, { ...tools, ...home.deps });
      process.env.PATH = priorPath;
      walDb?.close();
      expect(created.status).toBe("created");
      expect((await inspectTar(archive)).some((entry) => entry.path === "vault/.git/HEAD")).toBeTrue();
      expect(created.restart).toBe("not-running");
      expect((await stat(archive)).mode & 0o777).toBe(0o600);
      const verified = await verifyVaultBackup({ archive, identity }, tools);
      expect(verified.status).toBe("verified");

      const tamperedTree = join(root, "tampered-tree");
      await extractArchiveForTest(archive, tamperedTree);
      const manifestPath = join(tamperedTree, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { databases: Array<{ present: boolean }> };
      manifest.databases[0]!.present = false;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const tampered = join(root, "tampered.age");
      await writeTarTree(tamperedTree, tampered);
      const rejectedTamper = await verifyVaultBackup({ archive: tampered, identity }, tools);
      expect(rejectedTamper.status).toBe("error");
      expect(rejectedTamper.error).toContain("presence disagrees");

      const archiveHash = fileHash(await readFile(archive));
      const identityHash = fileHash(await readFile(identity));
      const mismatchedTree = join(root, "mismatched-tree");
      await extractArchiveForTest(archive, mismatchedTree);
      const mismatchedBytes = Buffer.from("# Different working tree\n");
      await writeFile(join(mismatchedTree, "vault", "index.md"), mismatchedBytes);
      const mismatchedManifestPath = join(mismatchedTree, "manifest.json");
      const mismatchedManifest = JSON.parse(await readFile(mismatchedManifestPath, "utf8")) as {
        entries: Array<{ path: string; size: number; sha256?: string }>;
      };
      const mismatchedEntry = mismatchedManifest.entries.find((entry) => entry.path === "vault/index.md");
      if (!mismatchedEntry) throw new Error("index.md manifest fixture missing");
      mismatchedEntry.size = mismatchedBytes.byteLength;
      mismatchedEntry.sha256 = fileHash(mismatchedBytes);
      await writeFile(mismatchedManifestPath, `${JSON.stringify(mismatchedManifest, null, 2)}\n`);
      const mismatchedArchive = join(root, "mismatched.age");
      await writeTarTree(mismatchedTree, mismatchedArchive);
      const mismatchedTarget = join(root, "mismatched-target");
      const rejectedMismatch = await restoreVaultBackup({
        archive: mismatchedArchive,
        identity,
        target: mismatchedTarget,
      }, tools);
      expect(rejectedMismatch.status).toBe("error");
      expect(rejectedMismatch.error).toContain("reconstructed working tree differs from committed Git: index.md");
      expect(await pathPresent(mismatchedTarget)).toBeFalse();

      const restored = join(root, "restored");
      const existingEmpty = join(root, "existing-empty");
      await mkdir(existingEmpty);
      const refusedExisting = await restoreVaultBackup({ archive, identity, target: existingEmpty }, tools);
      expect(refusedExisting).toMatchObject({ status: "error", exitCode: 64 });
      const dangling = join(root, "dangling-target");
      await symlink(join(root, "missing"), dangling);
      expect((await restoreVaultBackup({ archive, identity, target: dangling }, tools)).exitCode).toBe(64);
      const restoredResult = await restoreVaultBackup({ archive, identity, target: restored }, tools);
      expect(restoredResult).toMatchObject({
        status: "restored", exitCode: 0, authority: "invalidated", durability: "durable",
      });
      expect(fileHash(await readFile(archive))).toBe(archiveHash);
      expect(fileHash(await readFile(identity))).toBe(identityHash);
      expect(await readFile(join(restored, "index.md"), "utf8")).toBe("# Vault\n");
      expect((await readStandaloneBackupSource(restored)).clean).toBeTrue();
      expect(await statusMatrix(restored)).toEqual([
        [".dome/config.yaml", 1, 1, 1],
        ["index.md", 1, 1, 1],
      ]);
      for (const name of ["answers.db", "proposals.db", "outbox.db", "runs.db", "request-receipts.db", "projection.db"]) {
        const db = new Database(join(restored, ".dome", "state", name), { readonly: true });
        expect(db.query<{ value: string }, []>("SELECT value FROM evidence").get()?.value).toBe(name);
        db.close();
      }
      const restoredAuthority = await openDeviceAuthority({ path: join(restored, ".dome", "state", "device-authority.db") });
      if (!restoredAuthority.ok) throw new Error("restored device authority failed");
      expect(restoredAuthority.value.authority.authenticate({ credential: paired.credential })).toEqual({ kind: "epoch-invalid" });
      expect(restoredAuthority.value.authority.exchangePairingCode({ pairingCode: unusedGrant.pairingCode })).toEqual({ kind: "epoch-invalid" });
      const freshGrant = restoredAuthority.value.authority.mintPairingGrant({ deviceName: "new-phone", capabilities: ["read"] });
      if (freshGrant.kind !== "minted") throw new Error("fresh grant failed");
      expect(restoredAuthority.value.authority.exchangePairingCode({ pairingCode: freshGrant.pairingCode }).kind).toBe("paired");
      restoredAuthority.value.authority.close();

      const corruptTarget = join(root, "corrupt-target");
      const corruptRestore = await restoreVaultBackup({ archive: tampered, identity, target: corruptTarget }, tools);
      expect(corruptRestore.status).toBe("error");
      expect(await pathPresent(corruptTarget)).toBeFalse();

      const failedTarget = join(root, "failed-target");
      const failedPublication = await restoreVaultBackup({ archive, identity, target: failedTarget }, {
        ...tools,
        publishRestoredVault: async () => { throw new Error("injected publication failure"); },
      });
      expect(failedPublication.error).toContain("injected publication failure");
      expect(await pathPresent(failedTarget)).toBeFalse();
      expect((await readdir(root)).filter((name) => name.startsWith(".failed-target.restore-"))).toEqual([]);

      const unsyncedTarget = join(root, "unsynced-target");
      let unsyncedPublished = false;
      const unsynced = await restoreVaultBackup({ archive, identity, target: unsyncedTarget }, {
        ...tools,
        syncRestoreTree: async () => { throw new Error("injected restored-tree fsync failure"); },
        publishRestoredVault: async () => { unsyncedPublished = true; },
      });
      expect(unsynced.error).toContain("restored-tree fsync failure");
      expect(unsyncedPublished).toBeFalse();
      expect(await pathPresent(unsyncedTarget)).toBeFalse();
      expect((await readdir(root)).filter((name) => name.startsWith(".unsynced-target.restore-"))).toEqual([]);

      const racedTarget = join(root, "raced-target");
      const raced = await restoreVaultBackup({ archive, identity, target: racedTarget }, {
        ...tools,
        publishRestoredVault: async (_source, target) => {
          await mkdir(target);
          await writeFile(join(target, "winner"), "other restore\n");
          throw new Error("exclusive publication lost race");
        },
      });
      expect(raced.status).toBe("error");
      expect(await readFile(join(racedTarget, "winner"), "utf8")).toBe("other restore\n");

      let enterPublisher!: () => void;
      let releasePublisher!: () => void;
      const entered = new Promise<void>((resolve) => { enterPublisher = resolve; });
      const released = new Promise<void>((resolve) => { releasePublisher = resolve; });
      const canonicalParent = join(root, "canonical-parent");
      const alternateParent = join(root, "alternate-parent");
      const linkedParent = join(root, "linked-parent");
      await mkdir(canonicalParent);
      await mkdir(alternateParent);
      await symlink(canonicalParent, linkedParent);
      const canonicalTarget = join(await realpath(canonicalParent), "concurrent-target");
      const requestedTarget = join(linkedParent, "concurrent-target");
      const first = restoreVaultBackup({ archive, identity, target: requestedTarget }, {
        ...tools,
        publishRestoredVault: async (source, target) => {
          enterPublisher();
          await released;
          await rename(source, target);
        },
      });
      await entered;
      await rm(linkedParent);
      await symlink(alternateParent, linkedParent);
      const second = await restoreVaultBackup({ archive, identity, target: canonicalTarget }, tools);
      expect(second.error).toContain("another restore owns the target");
      releasePublisher();
      expect(await first).toMatchObject({ status: "restored", target: canonicalTarget });
      expect(await readFile(join(canonicalTarget, "index.md"), "utf8")).toBe("# Vault\n");
      expect(await pathPresent(join(alternateParent, "concurrent-target"))).toBeFalse();

      const uncertainTarget = join(root, "uncertain-target");
      const uncertain = await restoreVaultBackup({ archive, identity, target: uncertainTarget }, {
        ...tools,
        publishRestoredVault: rename,
        syncRestoreParent: async () => { throw new Error("injected parent fsync failure"); },
      });
      expect(uncertain).toMatchObject({ status: "restored", exitCode: 1, durability: "uncertain" });
      expect(uncertain.error).toContain("published");
      expect(await readFile(join(uncertainTarget, "index.md"), "utf8")).toBe("# Vault\n");
      expect(fileHash(await readFile(archive))).toBe(archiveHash);
      expect(fileHash(await readFile(identity))).toBe(identityHash);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("fails closed on unknown state and still restarts a previously loaded Home", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-backup-restart-"));
    try {
      const tools = await fakeAgeTools(root);
      const vault = join(root, "vault");
      await mkdir(join(vault, ".dome", "state"), { recursive: true });
      await initRepo(vault);
      await writeFile(join(vault, ".dome", "config.yaml"), "version: 1\n");
      await add(vault, ".dome/config.yaml");
      await commit({ path: vault, message: "fixture" });
      await writeFile(join(vault, ".dome", "state", "future.db"), "unknown");
      const home = await installedHome(vault, root, true);
      const result = await createVaultBackup({ vaultPath: vault, output: join(root, "backup.age"), recipient: "age1fixture" }, {
        ...tools, ...home.deps,
      });
      expect(result.status).toBe("error");
      expect(result.error).toContain("future.db");
      expect(result.restart).toBe("restarted");
      expect(home.calls.some((call) => call[0] === "bootout")).toBeTrue();
      expect(home.calls.some((call) => call[0] === "bootstrap")).toBeTrue();

      await rm(join(vault, ".dome", "state", "future.db"));
      await mkdir(join(vault, ".git", "objects", "info"), { recursive: true });
      await writeFile(join(vault, ".git", "objects", "info", "alternates"), "/external/objects\n");
      const alternates = await createVaultBackup({ vaultPath: vault, output: join(root, "alternates.age"), recipient: "age1fixture" }, {
        ...tools, ...home.deps,
      });
      expect(alternates.error).toContain("external Git object dependency");
      await rm(join(vault, ".git", "objects", "info", "alternates"));

      const drifted = await createVaultBackup({ vaultPath: vault, output: join(root, "drift.age"), recipient: "age1fixture" }, {
        ...tools, ...home.deps,
        beforeSourceRecheck: async () => { await writeFile(join(vault, ".dome", "config.yaml"), "version: 2\n"); },
      });
      expect(drifted.status).toBe("error");
      expect(drifted.restart).toBe("restarted");

      await writeFile(join(vault, ".dome", "config.yaml"), "version: 1\n");
      const stateDrift = await createVaultBackup({ vaultPath: vault, output: join(root, "state-drift.age"), recipient: "age1fixture" }, {
        ...tools, ...home.deps,
        beforeSourceRecheck: async () => {
          await writeFile(join(vault, ".dome", "state", "quarantined.json"), "{}\n");
        },
      });
      expect(stateDrift.status).toBe("error");
      expect(stateDrift.error).toContain("operational state changed");
      expect(stateDrift.restart).toBe("restarted");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("drain and restart failures remain explicit and nonzero", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-backup-drain-"));
    try {
      const tools = await fakeAgeTools(root);
      const vault = join(root, "vault");
      await mkdir(join(vault, ".dome", "state"), { recursive: true });
      await initRepo(vault);
      await writeFile(join(vault, ".dome", "config.yaml"), "version: 1\n");
      await add(vault, ".dome/config.yaml");
      await commit({ path: vault, message: "fixture" });
      const home = await installedHome(vault, root, true);
      const drainFailure = await createVaultBackup({ vaultPath: vault, output: join(root, "drain.age"), recipient: "age1fixture" }, {
        ...tools,
        ...home.deps,
        drainTimeoutMs: 0,
        launchctl: async (args) => args[0] === "bootout"
          ? outcome(0)
          : args[0] === "print" && args.at(-1) === home.target ? outcome(0) : outcome(113),
      });
      expect(drainFailure.status).toBe("error");
      expect(drainFailure.error).toContain("drain timeout");
      expect(drainFailure.restart).toBe("failed");
      expect(drainFailure.exitCode).toBe(1);

    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("retains a created archive when Home restart fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-backup-restart-failure-"));
    try {
      const tools = await fakeAgeTools(root);
      const vault = await basicVault(root);
      const home = await installedHome(vault, root, true);
      const archive = join(await realpath(root), "backup.age");
      const result = await createVaultBackup({ vaultPath: vault, output: archive, recipient: "age1fixture" }, {
        ...tools,
        ...home.deps,
        launchctl: async (args) => {
          if (args[0] === "bootstrap") return outcome(5, "injected bootstrap failure");
          return home.launchctl(args);
        },
      });
      expect(result).toMatchObject({ status: "created", exitCode: 1, restart: "failed", archive });
      expect(result.backupId).toBeDefined();
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.restartError).toContain("injected bootstrap failure");
      expect(await pathPresent(archive)).toBeTrue();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("retains a created archive when suspension infrastructure fails after callback", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-backup-post-callback-"));
    try {
      const tools = await fakeAgeTools(root);
      const vault = await basicVault(root);
      const home = await installedHome(vault, root, true);
      const archive = join(await realpath(root), "backup.age");
      const result = await createVaultBackup({ vaultPath: vault, output: archive, recipient: "age1fixture" }, {
        ...tools,
        ...home.deps,
        checkpoint: async (name) => {
          if (name === "callback-returned") throw new Error("injected lifecycle persistence failure");
        },
      });
      expect(result).toMatchObject({ status: "created", exitCode: 1, restart: "failed", archive });
      expect(result.backupId).toBeDefined();
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.restartError).toContain("injected lifecycle persistence failure");
      expect(await pathPresent(archive)).toBeTrue();
      const active = await inspectHomeLifecycleSuspension(vault);
      expect(active.kind).toBe("active");
      if (active.kind === "active") expect(result.restartError).toContain(active.suspension.operationId);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("retains exact archive truth when parent durability fails after publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-backup-parent-sync-"));
    try {
      const tools = await fakeAgeTools(root);
      const vault = await basicVault(root);
      const home = await installedHome(vault, root, false);
      const archive = join(await realpath(root), "backup.age");
      const result = await createVaultBackup({ vaultPath: vault, output: archive, recipient: "age1fixture" }, {
        ...tools,
        ...home.deps,
        syncBackupParent: async () => { throw new Error("injected backup parent fsync failure"); },
      });
      expect(result).toMatchObject({
        status: "created",
        exitCode: 1,
        restart: "not-running",
        archive,
      });
      expect(result.backupId).toBeDefined();
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.error).toContain("published but parent-directory durability is uncertain");
      expect(result.error).toContain("injected backup parent fsync failure");
      if (result.sha256 === undefined) throw new Error("created backup result omitted its checksum");
      expect(fileHash(await readFile(archive))).toBe(result.sha256);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("reports barrier closure before backup and during resume without false success", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-backup-barrier-"));
    try {
      const tools = await fakeAgeTools(root);
      const vault = await basicVault(root);
      const home = await installedHome(vault, root, false);
      const beforeId = "backup-blocked-before";
      expect((await engageOperationalWriterBarrier({ vaultPath: vault, transactionId: beforeId })).ok).toBeTrue();
      const blocked = await createVaultBackup({ vaultPath: vault, output: join(root, "blocked.age"), recipient: "age1fixture" }, {
        ...tools, ...home.deps,
      });
      expect(blocked).toMatchObject({ status: "error", exitCode: 1, restart: "failed" });
      expect(blocked.error).toContain("write-admission-closed");
      expect(blocked.restartError).toContain(beforeId);
      expect(await pathPresent(join(root, "blocked.age"))).toBeFalse();
      await releaseOperationalWriterBarrier({ vaultPath: vault, transactionId: beforeId, validateAndRemoveExternalEvidence: async () => {} });

      const secondRoot = join(root, "resume");
      const secondVault = await basicVault(secondRoot);
      const secondHome = await installedHome(secondVault, secondRoot, true);
      const resumeId = "backup-blocked-resume";
      const archive = join(await realpath(secondRoot), "created.age");
      const deferred = await createVaultBackup({ vaultPath: secondVault, output: archive, recipient: "age1fixture" }, {
        ...tools,
        ...secondHome.deps,
        checkpoint: async (name) => {
          if (name !== "callback-returned") return;
          const engaged = await engageOperationalWriterBarrier({ vaultPath: secondVault, transactionId: resumeId });
          if (!engaged.ok) throw new Error(`fixture barrier failed: ${engaged.error.kind}`);
        },
      });
      expect(deferred).toMatchObject({ status: "created", exitCode: 1, restart: "failed", archive });
      expect(deferred.backupId).toBeDefined();
      expect(deferred.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(deferred.restartError).toContain(resumeId);
      expect(await pathPresent(archive)).toBeTrue();
      await releaseOperationalWriterBarrier({ vaultPath: secondVault, transactionId: resumeId, validateAndRemoveExternalEvidence: async () => {} });
      const takeoverOutput = join(await realpath(secondRoot), "takeover.age");
      const takeover = await createVaultBackup({ vaultPath: secondVault, output: takeoverOutput, recipient: "age1fixture" }, {
        ...tools, ...secondHome.deps,
      });
      expect(takeover.status).toBe("error");
      expect(takeover.error).toContain("Home lifecycle is suspended by backup:");
      expect(await pathPresent(takeoverOutput)).toBeFalse();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("takes canonical external and vault-local Product Host ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-backup-host-locks-"));
    try {
      const tools = await fakeAgeTools(root);
      const vault = await basicVault(root);
      const alias = join(root, "vault-alias");
      await symlink(vault, alias);
      const home = await installedHome(vault, root, false);
      const external = await withExclusiveFileLock({
        lockPath: externalProductHostLockPath(await realpath(vault)), command: "test-external-holder",
      }, async () => createVaultBackup({ vaultPath: alias, output: join(root, "external.age"), recipient: "age1fixture" }, {
        ...tools, ...home.deps,
      }));
      if (external.kind !== "acquired") throw new Error("fixture failed to own external lock");
      expect(external.value).toMatchObject({ status: "error", restart: "not-running" });
      expect(external.value.error).toContain("owns the vault");

      const localPath = join(await realpath(vault), ".dome", "state", "locks", "product-host.lock");
      await mkdir(dirname(localPath), { recursive: true });
      const local = await withExclusiveFileLock({ lockPath: localPath, command: "test-local-holder" }, async () =>
        createVaultBackup({ vaultPath: vault, output: join(root, "local.age"), recipient: "age1fixture" }, {
          ...tools, ...home.deps,
        }));
      if (local.kind !== "acquired") throw new Error("fixture failed to own local lock");
      expect(local.value).toMatchObject({ status: "error", restart: "not-running" });
      expect(local.value.error).toContain("owns the vault");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("fails closed on ambiguous launchctl and Home evidence drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-backup-evidence-"));
    try {
      const tools = await fakeAgeTools(root);
      const vault = await basicVault(root);
      const ambiguousHome = await installedHome(vault, root, false);
      const ambiguous = await createVaultBackup({ vaultPath: vault, output: join(root, "ambiguous.age"), recipient: "age1fixture" }, {
        ...tools,
        ...ambiguousHome.deps,
        launchctl: async (args) => args[0] === "print" && args.at(-1) === ambiguousHome.target
          ? outcome(1, "ambiguous launchctl failure")
          : ambiguousHome.launchctl(args),
      });
      expect(ambiguous.status).toBe("error");
      expect(ambiguous.error).toContain("ambiguous launchctl failure");

      const legacy = await createVaultBackup({ vaultPath: vault, output: join(root, "legacy.age"), recipient: "age1fixture" }, {
        ...tools, ...ambiguousHome.deps, legacyServeRunning: async () => true,
      });
      expect(legacy.status).toBe("error");
      expect(legacy.error).toContain("legacy dome serve");

      const foreground = await createVaultBackup({ vaultPath: vault, output: join(root, "foreground.age"), recipient: "age1fixture" }, {
        ...tools, ...ambiguousHome.deps, readiness: async () => true,
      });
      expect(foreground.status).toBe("error");
      expect(foreground.error).toContain("foreground Dome Home");

      const driftRoot = join(root, "drift");
      const driftVault = await basicVault(driftRoot);
      const driftHome = await installedHome(driftVault, driftRoot, true);
      const driftArchive = join(await realpath(driftRoot), "drift.age");
      const drifted = await createVaultBackup({ vaultPath: driftVault, output: driftArchive, recipient: "age1fixture" }, {
        ...tools,
        ...driftHome.deps,
        checkpoint: async (name) => {
          if (name === "callback-returned") {
            await writeFile(driftHome.plist, "drifted plist bytes\n", { mode: 0o600 });
          }
        },
      });
      expect(drifted).toMatchObject({ status: "created", exitCode: 1, restart: "failed", archive: driftArchive });
      expect(drifted.backupId).toBeDefined();
      expect(drifted.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(drifted.restartError).toContain("not the authorized resume target");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // Three real backup transactions need harness headroom on hosted macOS;
  // product deadlines remain independently injected and asserted.
  test("serializes same-output backups and never replaces an external winner", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-backup-publication-"));
    try {
      const tools = await fakeAgeTools(root);
      const vault = await basicVault(root);
      const home = await installedHome(vault, root, false);
      const output = join(await realpath(root), "same.age");
      let entered!: () => void;
      let release!: () => void;
      const paused = new Promise<void>((resolve) => { entered = resolve; });
      const resumed = new Promise<void>((resolve) => { release = resolve; });
      const first = createVaultBackup({ vaultPath: vault, output, recipient: "age1fixture" }, {
        ...tools, ...home.deps,
        beforeSourceRecheck: async () => { entered(); await resumed; },
      });
      await paused;
      const second = createVaultBackup({ vaultPath: vault, output, recipient: "age1fixture" }, { ...tools, ...home.deps });
      await Bun.sleep(10); // let the second caller pass its outer absence check and queue on lifecycle ownership
      release();
      const firstResult = await first;
      const firstHash = fileHash(await readFile(output));
      const secondResult = await second;
      expect(firstResult).toMatchObject({ status: "created", restart: "not-running" });
      expect(secondResult).toMatchObject({ status: "error", exitCode: 64, restart: "not-running" });
      expect(secondResult.error).toContain("already exists");
      expect(fileHash(await readFile(output))).toBe(firstHash);

      const racedOutput = join(await realpath(root), "external.age");
      const raced = await createVaultBackup({ vaultPath: vault, output: racedOutput, recipient: "age1fixture" }, {
        ...tools, ...home.deps,
        beforeSourceRecheck: async () => { await writeFile(racedOutput, "external winner\n"); },
      });
      expect(raced).toMatchObject({ status: "error", restart: "not-running" });
      expect(raced.error).toContain("target may already exist");
      expect(await readFile(racedOutput, "utf8")).toBe("external winner\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, MULTI_TRANSACTION_SCENARIO_TIMEOUT_MS);
});

async function basicVault(root: string): Promise<string> {
  const vault = join(root, "vault");
  await mkdir(join(vault, ".dome", "state"), { recursive: true });
  await initRepo(vault);
  await writeFile(join(vault, ".dome", "config.yaml"), "version: 1\n");
  await add(vault, ".dome/config.yaml");
  await commit({ path: vault, message: "fixture" });
  return vault;
}

async function installedHome(vaultPath: string, root: string, loaded: boolean) {
  const vault = await realpath(vaultPath);
  await mkdir(root, { recursive: true });
  const fixtureRoot = await realpath(root);
  const applicationSupportDir = join(fixtureRoot, "Application Support", "Dome", "Home");
  const launchAgentsDir = join(fixtureRoot, "LaunchAgents");
  const installation = homeInstallationPaths(vault, { applicationSupportDir });
  await mkdir(installation.installations, { recursive: true });
  await mkdir(launchAgentsDir, { recursive: true });
  await writeFile(installation.record, `${JSON.stringify({
    schema: "dome.home.installation/v1",
    vault,
    artifact: { id: "a".repeat(64), version: "1.0.0" },
    environment: [],
  })}\n`, { mode: 0o600 });
  const label = `com.dome.home.${vaultServiceSlug(vault)}`;
  const target = `gui/501/${label}`;
  const plist = join(launchAgentsDir, `${label}.plist`);
  await writeFile(plist, "strict plist bytes\n", { mode: 0o600 });
  const loadedTargets = new Set<string>(loaded ? [target] : []);
  const calls: string[][] = [];
  const launchctl = async (args: ReadonlyArray<string>) => {
    calls.push([...args]);
    const candidate = args.at(-1) ?? "";
    if (args[0] === "print") return outcome(loadedTargets.has(candidate) ? 0 : 113);
    if (args[0] === "bootout") { loadedTargets.delete(candidate); return outcome(0); }
    if (args[0] === "bootstrap") {
      const bootLabel = (args[2] ?? "").split("/").at(-1)?.replace(/\.plist$/, "") ?? "";
      loadedTargets.add(`${args[1]}/${bootLabel}`);
      return outcome(0);
    }
    if (args[0] === "kickstart") { loadedTargets.add(candidate); return outcome(0); }
    return outcome(0);
  };
  return {
    target,
    plist,
    calls,
    launchctl,
    deps: {
      platform: "darwin" as const,
      uid: 501,
      applicationSupportDir,
      launchAgentsDir,
      launchctl,
      drainTimeoutMs: 20,
      readinessTimeoutMs: 1,
      readiness: async () => loadedTargets.has(target),
    },
  };
}

function outcome(exitCode: number, stderr = "") { return { exitCode, stdout: "", stderr }; }

function fileHash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

async function pathPresent(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function fakeAgeTools(root: string): Promise<{ agePath: string; ageKeygenPath: string }> {
  const age = join(root, "age");
  const keygen = join(root, "age-keygen");
  await writeFile(keygen, "#!/bin/sh\nif [ \"$1\" = \"-y\" ]; then echo age1fixture; else printf 'AGE-SECRET-KEY-FIXTURE\\n' > \"$2\"; fi\n");
  await writeFile(age, "#!/bin/sh\nout=''\nin=''\nwhile [ $# -gt 0 ]; do\n  case \"$1\" in -o) out=\"$2\"; shift 2;; -i|-r) shift 2;; --decrypt) shift;; *) in=\"$1\"; shift;; esac\ndone\n/bin/cp \"$in\" \"$out\"\n");
  await chmod(age, 0o755);
  await chmod(keygen, 0o755);
  return { agePath: age, ageKeygenPath: keygen };
}

async function extractArchiveForTest(archive: string, destination: string): Promise<void> {
  const entries = await inspectTar(archive);
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const target = join(destination, entry.path);
    if (entry.type === "directory") {
      await mkdir(target, { recursive: true });
      await chmod(target, entry.mode);
    }
    else {
      await mkdir(dirname(target), { recursive: true });
      await extractTarFile(archive, entry.path, target);
      await chmod(target, entry.mode);
    }
  }
}
