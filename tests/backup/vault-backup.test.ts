import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createVaultBackup, generateBackupIdentity, rehearseBlankTargetRestore, verifyVaultBackup } from "../../src/backup/vault-backup";
import { add, commit, initRepo } from "../../src/git";
import { extractTarFile, inspectTar, writeTarTree } from "../../src/backup/tar";
import { openDeviceAuthority } from "../../src/device-authority/device-authority";

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
      const priorPath = process.env.PATH;
      process.env.PATH = "/path-without-git";
      const created = await createVaultBackup({ vaultPath: vault, output: archive, recipient: key.recipient! }, lifecycle(tools));
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

      const restored = join(root, "restored");
      const existingEmpty = join(root, "existing-empty");
      await mkdir(existingEmpty);
      await expect(rehearseBlankTargetRestore({ archive, identity, target: existingEmpty }, tools)).rejects.toThrow("must be absent");
      await rehearseBlankTargetRestore({ archive, identity, target: restored }, tools);
      expect(await readFile(join(restored, "index.md"), "utf8")).toBe("# Vault\n");
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
      const launchAgentsDir = join(root, "LaunchAgents");
      await mkdir(launchAgentsDir);
      const { homeServiceLabelForVault } = await import("../../src/product-host/home-lifecycle");
      const label = homeServiceLabelForVault(vault);
      await writeFile(join(launchAgentsDir, `${label}.plist`), "plist");
      let loaded = true;
      const calls: string[] = [];
      const result = await createVaultBackup({ vaultPath: vault, output: join(root, "backup.age"), recipient: "age1fixture" }, {
        ...tools, platform: "darwin", uid: 501, launchAgentsDir, drainTimeoutMs: 10,
        readiness: async () => loaded,
        launchctl: async (args) => {
          calls.push(args.join(" "));
          if (args[0] === "print") return { exitCode: args.at(-1)?.endsWith(label) === true && loaded ? 0 : 1, stdout: "", stderr: "" };
          if (args[0] === "bootout") loaded = false;
          if (args[0] === "bootstrap") loaded = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });
      expect(result.status).toBe("error");
      expect(result.error).toContain("future.db");
      expect(result.restart).toBe("restarted");
      expect(calls.some((call) => call.startsWith("bootout"))).toBeTrue();
      expect(calls.some((call) => call.startsWith("bootstrap"))).toBeTrue();

      await rm(join(vault, ".dome", "state", "future.db"));
      await mkdir(join(vault, ".git", "objects", "info"), { recursive: true });
      await writeFile(join(vault, ".git", "objects", "info", "alternates"), "/external/objects\n");
      const alternates = await createVaultBackup({ vaultPath: vault, output: join(root, "alternates.age"), recipient: "age1fixture" }, {
        ...tools, platform: "darwin", uid: 501, launchAgentsDir, readiness: async () => loaded,
        launchctl: async (args) => {
          if (args[0] === "print") return { exitCode: args.at(-1)?.endsWith(label) === true && loaded ? 0 : 1, stdout: "", stderr: "" };
          if (args[0] === "bootout") loaded = false;
          if (args[0] === "bootstrap") loaded = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });
      expect(alternates.error).toContain("external Git object dependency");
      await rm(join(vault, ".git", "objects", "info", "alternates"));

      const drifted = await createVaultBackup({ vaultPath: vault, output: join(root, "drift.age"), recipient: "age1fixture" }, {
        ...tools, platform: "darwin", uid: 501, launchAgentsDir, readiness: async () => loaded,
        beforeSourceRecheck: async () => { await writeFile(join(vault, ".dome", "config.yaml"), "version: 2\n"); },
        launchctl: async (args) => {
          if (args[0] === "print") return { exitCode: args.at(-1)?.endsWith(label) === true && loaded ? 0 : 1, stdout: "", stderr: "" };
          if (args[0] === "bootout") loaded = false;
          if (args[0] === "bootstrap") loaded = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });
      expect(drifted.status).toBe("error");
      expect(drifted.restart).toBe("restarted");
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
      const launchAgentsDir = join(root, "LaunchAgents");
      await mkdir(launchAgentsDir);
      const { homeServiceLabelForVault } = await import("../../src/product-host/home-lifecycle");
      const label = homeServiceLabelForVault(vault);
      await writeFile(join(launchAgentsDir, `${label}.plist`), "plist");
      const result = await createVaultBackup({ vaultPath: vault, output: join(root, "backup.age"), recipient: "age1fixture" }, {
        ...tools, platform: "darwin", uid: 501, launchAgentsDir, drainTimeoutMs: 0, readinessTimeoutMs: 0,
        readiness: async () => false,
        launchctl: async (args) => ({
          exitCode: args[0] === "print" && args.at(-1)?.endsWith(label) !== true ? 1 : 0,
          stdout: "", stderr: "",
        }),
      });
      expect(result.status).toBe("error");
      expect(result.restart).toBe("failed");
      expect(result.exitCode).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

function lifecycle<T extends Record<string, unknown>>(tools: T): T & { platform: "darwin"; uid: number; launchAgentsDir: string; launchctl: (args: ReadonlyArray<string>) => Promise<{ exitCode: number; stdout: string; stderr: string }> } {
  return { ...tools, platform: "darwin", uid: 501, launchAgentsDir: "/nonexistent-launch-agents", launchctl: async () => ({ exitCode: 1, stdout: "", stderr: "" }) };
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
    if (entry.type === "directory") await mkdir(target, { recursive: true });
    else {
      await mkdir(dirname(target), { recursive: true });
      await extractTarFile(archive, entry.path, target);
    }
  }
}
