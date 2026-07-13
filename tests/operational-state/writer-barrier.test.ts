import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireOperationalWriterLease,
  engageOperationalWriterBarrier,
  inspectOperationalWriterBarrier,
  operationalWriterCoordinatorPath,
  releaseOperationalWriterBarrier,
} from "../../src/operational-state/writer-barrier";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("operational writer barrier", () => {
  test("canonical aliases converge and engagement drains both independent leases", async () => {
    const { root, vault } = await fixture();
    const alias = join(root, "vault-alias");
    await symlink(vault, alias);

    const first = await acquireOperationalWriterLease({ vaultPath: vault, command: "dome home" });
    const second = await acquireOperationalWriterLease({ vaultPath: alias, command: "dome sync" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("expected admitted writers");
    expect(first.lease.vaultPath).toBe(await realpath(vault));
    expect(second.lease.vaultPath).toBe(first.lease.vaultPath);
    expect(operationalWriterCoordinatorPath(alias)).toBe(operationalWriterCoordinatorPath(vault));

    let engaged = false;
    const pending = engageOperationalWriterBarrier({
      vaultPath: alias,
      transactionId: "upgrade-alias",
      now: new Date("2026-07-13T12:00:00.000Z"),
    }).then((result) => {
      engaged = true;
      return result;
    });
    await Bun.sleep(50);
    expect(engaged).toBe(false);

    first.lease.close();
    first.lease.close();
    await Bun.sleep(50);
    expect(engaged).toBe(false);

    second.lease.close();
    const result = await pending;
    expect(result).toEqual({
      ok: true,
      resumed: false,
      blockedAt: "2026-07-13T12:00:00.000Z",
    });
  });

  test("DELETE/NORMAL/FULL coordinator is private, strict, and survives reopen", async () => {
    const { vault } = await fixture();
    const admitted = await acquireOperationalWriterLease({ vaultPath: vault, command: "dome serve" });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("expected admitted writer");
    admitted.lease.close();

    const path = operationalWriterCoordinatorPath(vault);
    const info = await lstat(path);
    expect(info.isFile()).toBe(true);
    expect(info.isSymbolicLink()).toBe(false);
    expect(info.nlink).toBe(1);
    expect(info.mode & 0o777).toBe(0o600);

    const db = new Database(path);
    try {
      expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode)
        .toBe("delete");
      expect(db.query<{ locking_mode: string }, []>("PRAGMA locking_mode").get()?.locking_mode)
        .toBe("normal");
      expect(db.query<{ strict: number }, []>("PRAGMA table_list").all()
        .find((row) => row.strict === 1)?.strict).toBe(1);
      expect(db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM operational_writer_barrier",
      ).get()?.count).toBe(1);
    } finally {
      db.close();
    }

    expect(await inspectOperationalWriterBarrier(vault)).toEqual({
      blocked: false,
      transactionId: null,
      blockedAt: null,
    });
  });

  test("engagement drains a separate SQLite reader connection", async () => {
    const { vault } = await fixture();
    const initialized = await acquireOperationalWriterLease({ vaultPath: vault, command: "initialize" });
    if (!initialized.ok) throw new Error("expected initialization");
    initialized.lease.close();

    const reader = new Database(operationalWriterCoordinatorPath(vault));
    reader.run("PRAGMA busy_timeout = 0");
    reader.run("BEGIN");
    reader.query("SELECT singleton FROM operational_writer_barrier").get();

    let engaged = false;
    const pending = engageOperationalWriterBarrier({
      vaultPath: vault,
      transactionId: "upgrade-second-connection",
    }).then((result) => {
      engaged = true;
      return result;
    });
    await Bun.sleep(50);
    expect(engaged).toBe(false);
    reader.run("ROLLBACK");
    reader.close();
    expect((await pending).ok).toBe(true);
  });

  test("blocked state is crash-persistent, same-transaction resumable, and foreign-owned", async () => {
    const { vault } = await fixture();
    const first = await engageOperationalWriterBarrier({
      vaultPath: vault,
      transactionId: "upgrade-42",
      now: new Date("2026-07-13T12:00:00.000Z"),
    });
    expect(first).toEqual({
      ok: true,
      resumed: false,
      blockedAt: "2026-07-13T12:00:00.000Z",
    });
    expect(await inspectOperationalWriterBarrier(vault)).toEqual({
      blocked: true,
      transactionId: "upgrade-42",
      blockedAt: "2026-07-13T12:00:00.000Z",
    });

    const resumed = await engageOperationalWriterBarrier({
      vaultPath: vault,
      transactionId: "upgrade-42",
      now: new Date("2026-07-13T13:00:00.000Z"),
    });
    expect(resumed).toEqual({
      ok: true,
      resumed: true,
      blockedAt: "2026-07-13T12:00:00.000Z",
    });

    const other = await engageOperationalWriterBarrier({
      vaultPath: vault,
      transactionId: "upgrade-other",
    });
    expect(other).toEqual({
      ok: false,
      error: { kind: "owned-by-another-transaction", transactionId: "upgrade-42" },
    });

    const denied = await acquireOperationalWriterLease({ vaultPath: vault, command: "dome devices list" });
    expect(denied).toEqual({
      ok: false,
      error: {
        kind: "write-admission-closed",
        transactionId: "upgrade-42",
        blockedAt: "2026-07-13T12:00:00.000Z",
      },
    });
  });

  test("release clears last only after matching terminal validation", async () => {
    const { vault } = await fixture();
    expect((await engageOperationalWriterBarrier({
      vaultPath: vault,
      transactionId: "upgrade-release",
    })).ok).toBe(true);

    await expect(releaseOperationalWriterBarrier({
      vaultPath: vault,
      transactionId: "wrong-transaction",
      validateAndRemoveExternalEvidence: async () => {},
    })).rejects.toThrow("not owned by this transaction");

    await expect(releaseOperationalWriterBarrier({
      vaultPath: vault,
      transactionId: "upgrade-release",
      validateAndRemoveExternalEvidence: async () => {
        throw new Error("terminal journal is not valid");
      },
    })).rejects.toThrow("terminal journal is not valid");
    expect((await inspectOperationalWriterBarrier(vault)).blocked).toBe(true);

    let validatedWhileClosed = false;
    await releaseOperationalWriterBarrier({
      vaultPath: vault,
      transactionId: "upgrade-release",
      validateAndRemoveExternalEvidence: async () => {
        const admission = await acquireOperationalWriterLease({
          vaultPath: vault,
          command: "concurrent writer",
        });
        validatedWhileClosed = !admission.ok;
      },
    });
    expect(validatedWhileClosed).toBe(true);
    expect(await inspectOperationalWriterBarrier(vault)).toEqual({
      blocked: false,
      transactionId: null,
      blockedAt: null,
    });

    const admitted = await acquireOperationalWriterLease({ vaultPath: vault, command: "dome serve" });
    expect(admitted.ok).toBe(true);
    if (admitted.ok) admitted.lease.close();
  });

  test("unknown schema objects and invalid singleton state fail closed", async () => {
    const { vault } = await fixture();
    const admitted = await acquireOperationalWriterLease({ vaultPath: vault, command: "initialize" });
    if (!admitted.ok) throw new Error("expected initialization");
    admitted.lease.close();

    const path = operationalWriterCoordinatorPath(vault);
    const db = new Database(path);
    db.run(`CREATE TRIGGER unexpected_barrier_trigger
      AFTER UPDATE ON operational_writer_barrier BEGIN SELECT 1; END`);
    db.close();

    const invalid = await acquireOperationalWriterLease({ vaultPath: vault, command: "dome sync" });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) throw new Error("expected fail-closed schema");
    expect(invalid.error.kind).toBe("coordination-invalid");
    expect(invalid.error).toHaveProperty("cause");

    const second = await fixture();
    const secondInit = await acquireOperationalWriterLease({
      vaultPath: second.vault,
      command: "initialize",
    });
    if (!secondInit.ok) throw new Error("expected second initialization");
    secondInit.lease.close();
    const corrupt = new Database(operationalWriterCoordinatorPath(second.vault));
    corrupt.run("PRAGMA ignore_check_constraints = ON");
    corrupt.run("UPDATE operational_writer_barrier SET schema = 'unknown-schema'");
    corrupt.close();
    const corruptAdmission = await acquireOperationalWriterLease({
      vaultPath: second.vault,
      command: "dome serve",
    });
    expect(corruptAdmission.ok).toBe(false);
    if (corruptAdmission.ok) throw new Error("expected invalid singleton refusal");
    expect(corruptAdmission.error.kind).toBe("coordination-invalid");
  });

  test("a persisted WAL mode is fenced back to DELETE before admission", async () => {
    const { vault } = await fixture();
    const initialized = await acquireOperationalWriterLease({ vaultPath: vault, command: "initialize" });
    if (!initialized.ok) throw new Error("expected initialization");
    initialized.lease.close();

    const path = operationalWriterCoordinatorPath(vault);
    const changed = new Database(path);
    expect(changed.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get()?.journal_mode)
      .toBe("wal");
    changed.close();

    const admitted = await acquireOperationalWriterLease({ vaultPath: vault, command: "dome serve" });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("expected journal repair admission");
    admitted.lease.close();
    const verified = new Database(path);
    expect(verified.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode)
      .toBe("delete");
    verified.close();
  });

  test("invalid command and SQLite contention return structured errors", async () => {
    const { vault } = await fixture();
    const invalid = await acquireOperationalWriterLease({ vaultPath: vault, command: "   " });
    expect(invalid).toEqual({
      ok: false,
      error: {
        kind: "coordination-invalid",
        cause: "operational writer command must be non-empty",
      },
    });

    const initialized = await acquireOperationalWriterLease({ vaultPath: vault, command: "initialize" });
    if (!initialized.ok) throw new Error("expected initialization");
    initialized.lease.close();
    const exclusive = new Database(operationalWriterCoordinatorPath(vault));
    exclusive.run("BEGIN EXCLUSIVE");
    const busy = await acquireOperationalWriterLease({ vaultPath: vault, command: "dome sync" });
    expect(busy.ok).toBe(false);
    if (busy.ok) throw new Error("expected busy refusal");
    expect(busy.error.kind).toBe("coordination-busy");
    exclusive.run("ROLLBACK");
    exclusive.close();
  });

  test("redirected coordination directories and files fail closed without chmod", async () => {
    const { root, vault } = await fixture();
    const redirected = join(root, "redirected-state");
    await mkdir(join(vault, ".dome"), { mode: 0o755 });
    await mkdir(redirected, { mode: 0o700 });
    await symlink(redirected, join(vault, ".dome", "state"));

    const result = await acquireOperationalWriterLease({ vaultPath: vault, command: "dome serve" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected redirected state refusal");
    expect(result.error.kind).toBe("coordination-invalid");
    expect((await lstat(join(vault, ".dome"))).mode & 0o777).toBe(0o755);
  });
});

async function fixture(): Promise<{ readonly root: string; readonly vault: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dome-writer-barrier-")));
  roots.push(root);
  const vault = join(root, "vault");
  await mkdir(vault);
  // Keep the fixture recognizably vault-shaped without depending on git.
  await mkdir(join(vault, ".git"));
  return { root, vault };
}
