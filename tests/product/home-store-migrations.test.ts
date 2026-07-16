import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  HOME_STORE_MIGRATIONS,
  migratePreparedHomeStores,
  preflightHomeStoreMigrations,
  type HomeStoreSelectedInventory,
} from "../../src/product-host/home-store-migrations";
import { REQUEST_RECEIPTS_N1_SCHEMA_HASH } from "../../src/request-receipts/db";
import {
  FROZEN_N1_RELEASE,
  materializeFrozenN1Fixture,
} from "../fixtures/home-upgrade/n-1/freeze-n1";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "home-upgrade", "n-1", FROZEN_N1_RELEASE);

describe("Home durable-store migrations", () => {
  test("exposes one closed sorted six-store compatibility inventory", () => {
    expect(HOME_STORE_MIGRATIONS.map((entry) => entry.name)).toEqual([
      "answers.db", "device-authority.db", "outbox.db", "proposals.db", "request-receipts.db", "runs.db",
    ]);
    expect(HOME_STORE_MIGRATIONS.filter((entry) => entry.migratesFrom.length > 0)).toEqual([
      expect.objectContaining({ name: "request-receipts.db", migratesFrom: [REQUEST_RECEIPTS_N1_SCHEMA_HASH] }),
    ]);
  });

  test("all-store preflight prevents any migration when one route is unknown", async () => {
    const root = await materialized();
    try {
      const answers = new Database(join(root, "answers.db"));
      answers.run("UPDATE answers_meta SET schema_hash=?", ["d".repeat(64)]);
      answers.run("PRAGMA wal_checkpoint(TRUNCATE)");
      answers.close();
      await expect(migrate(root)).rejects.toThrow("no durable-state route for answers.db");
      expect(schemaHash(join(root, "request-receipts.db"), "request_receipts_meta"))
        .toBe(REQUEST_RECEIPTS_N1_SCHEMA_HASH);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("legacy prepare accepts the exact predecessor and returns all-six evidence", async () => {
    const root = await materialized();
    try {
      const evidence = await preflight(root, "prepare");
      expect(evidence).toHaveLength(6);
      expect(evidence.find((entry) => entry.name === "request-receipts.db"))
        .toMatchObject({ schemaHash: REQUEST_RECEIPTS_N1_SCHEMA_HASH, state: "predecessor" });
      expect(evidence.filter((entry) => entry.name !== "request-receipts.db")
        .every((entry) => entry.state === "current")).toBeTrue();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("legacy prepare rejects receipts already current as an unjournaled partial migration", async () => {
    const root = await materialized();
    try {
      await migrate(root);
      await expect(preflight(root, "prepare"))
        .rejects.toThrow("requires exact N-1 schema: request-receipts.db");
      expect((await preflight(root, "prepared-retry"))
        .every((entry) => entry.state === "current")).toBeTrue();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("selected-manifest prepare accepts all-six current evidence", async () => {
    const root = await materialized();
    try {
      await migrate(root);
      const evidence = await preflight(root, "prepare", HOME_STORE_MIGRATIONS);
      expect(evidence).toHaveLength(6);
      expect(evidence.every((entry) => entry.state === "current")).toBeTrue();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("selected-manifest prepare rejects mixed predecessor/current state", async () => {
    const root = await materialized();
    try {
      await expect(preflight(root, "prepare", HOME_STORE_MIGRATIONS))
        .rejects.toThrow("differs from selected release schema: request-receipts.db");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("selected-manifest prepare cannot bless an unknown changed-store schema", async () => {
    const root = await materialized();
    try {
      const unknownHash = "d".repeat(64);
      const receipts = new Database(join(root, "request-receipts.db"));
      receipts.run("UPDATE request_receipts_meta SET schema_hash=?", [unknownHash]);
      receipts.run("PRAGMA wal_checkpoint(TRUNCATE)");
      receipts.close();
      const selectedStores = HOME_STORE_MIGRATIONS.map((store) =>
        store.name === "request-receipts.db"
          ? { ...store, currentSchemaHash: unknownHash }
          : store);
      await expect(preflight(root, "prepare", selectedStores))
        .rejects.toThrow(`no durable-state route for request-receipts.db: ${unknownHash}`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("safe live preflight refuses redirected, non-private, or stale snapshot roots", async () => {
    const root = await materialized();
    const snapshotRoot = scratch(root, "unsafe-preflight");
    try {
      await symlink(root, snapshotRoot);
      await expect(preflightHomeStoreMigrations({ stateRoot: root, snapshotRoot, phase: "prepare" }))
        .rejects.toThrow("direct private directory");
      await rm(snapshotRoot);
      await mkdir(snapshotRoot, { mode: 0o700 });
      await chmod(snapshotRoot, 0o755);
      await expect(preflightHomeStoreMigrations({ stateRoot: root, snapshotRoot, phase: "prepare" }))
        .rejects.toThrow("direct private directory");
      await chmod(snapshotRoot, 0o700);
      await writeFile(join(snapshotRoot, "stale.db"), "stale");
      await expect(preflightHomeStoreMigrations({ stateRoot: root, snapshotRoot, phase: "prepare" }))
        .rejects.toThrow("not empty");
      expect(schemaHash(join(root, "request-receipts.db"), "request_receipts_meta"))
        .toBe(REQUEST_RECEIPTS_N1_SCHEMA_HASH);
    } finally {
      await rm(snapshotRoot, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const corruption of ["missing", "symlink", "hard-link", "directory", "fifo", "corrupt", "quick-check"] as const) {
    test(`refuses a ${corruption} durable store before migration`, async () => {
      const root = await materialized();
      let outsideRoot: string | null = null;
      let externalEvidence: { readonly path: string; readonly ino: number; readonly base64: string } | null = null;
      try {
        const target = join(root, "answers.db");
        if (corruption !== "quick-check") await rm(target);
        if (corruption === "symlink") await symlink(join(root, "proposals.db"), target);
        if (corruption === "hard-link") {
          outsideRoot = await mkdtemp(join(tmpdir(), "dome-home-hard-link-"));
          const external = join(outsideRoot, "answers.db");
          const frozen = join(FIXTURE, "answers.sql");
          const restored = new Database(external, { create: true });
          restored.exec(await readFile(frozen, "utf8"));
          restored.close();
          await link(external, target);
          externalEvidence = {
            path: external,
            ino: (await lstat(external)).ino,
            base64: await readFile(external, "base64"),
          };
        }
        if (corruption === "directory") await mkdir(target);
        if (corruption === "fifo") {
          const child = Bun.spawn(["mkfifo", target], { stdout: "ignore", stderr: "pipe" });
          const code = await child.exited;
          if (code !== 0) throw new Error(await new Response(child.stderr).text());
        }
        if (corruption === "corrupt") await writeFile(target, "not sqlite");
        if (corruption === "quick-check") {
          const db = new Database(target);
          const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 4096;
          const rootPage = db.query<{ rootpage: number }, []>(
            "SELECT rootpage FROM sqlite_schema WHERE name='question_answers'",
          ).get()?.rootpage;
          db.close();
          if (rootPage === undefined) throw new Error("fixture table root page is missing");
          const bytes = await readFile(target);
          bytes[(rootPage - 1) * pageSize] = 0xff; // invalid b-tree page type; quick_check must reject it
          await writeFile(target, bytes);
        }
        await expect(preflight(root, "prepared-retry")).rejects.toThrow();
        if (externalEvidence !== null) {
          expect((await lstat(externalEvidence.path)).ino).toBe(externalEvidence.ino);
          expect(await readFile(externalEvidence.path, "base64")).toBe(externalEvidence.base64);
          expect((await lstat(externalEvidence.path)).nlink).toBe(2);
        }
        expect(schemaHash(join(root, "request-receipts.db"), "request_receipts_meta"))
          .toBe(REQUEST_RECEIPTS_N1_SCHEMA_HASH);
      } finally {
        await rm(root, { recursive: true, force: true });
        if (outsideRoot !== null) await rm(outsideRoot, { recursive: true, force: true });
      }
    });
  }
});

async function materialized(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dome-home-store-migrations-")));
  await materializeFrozenN1Fixture({ fixtureRoot: FIXTURE, destination: root });
  return root;
}

async function preflight(
  stateRoot: string,
  phase: "prepare" | "prepared-retry",
  selectedStores?: HomeStoreSelectedInventory,
): ReturnType<typeof preflightHomeStoreMigrations> {
  const snapshotRoot = scratch(stateRoot, `preflight-${phase}`);
  await rm(snapshotRoot, { recursive: true, force: true });
  await mkdir(snapshotRoot, { mode: 0o700 });
  try {
    return await preflightHomeStoreMigrations({
      stateRoot,
      snapshotRoot,
      phase,
      ...(selectedStores !== undefined ? { selectedStores } : {}),
    });
  }
  finally { await rm(snapshotRoot, { recursive: true, force: true }); }
}

async function migrate(stateRoot: string): ReturnType<typeof migratePreparedHomeStores> {
  const preflightRoot = scratch(stateRoot, "migration");
  await rm(preflightRoot, { recursive: true, force: true });
  await mkdir(preflightRoot, { mode: 0o700 });
  try { return await migratePreparedHomeStores({ stateRoot, preflightRoot }); }
  finally { await rm(preflightRoot, { recursive: true, force: true }); }
}

function scratch(stateRoot: string, purpose: string): string {
  return join(dirname(stateRoot), `.${basename(stateRoot)}-${purpose}`);
}

function schemaHash(path: string, table: string): string | undefined {
  const db = new Database(path, { readonly: true, create: false });
  try { return db.query<{ schema_hash: string }, []>(`SELECT schema_hash FROM ${table}`).get()?.schema_hash; }
  finally { db.close(); }
}
