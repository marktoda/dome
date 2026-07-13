import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HOME_STORE_MIGRATIONS,
  migratePreparedHomeStores,
  preflightHomeStoreMigrations,
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
      await expect(migratePreparedHomeStores({ stateRoot: root })).rejects.toThrow("no durable-state route for answers.db");
      expect(schemaHash(join(root, "request-receipts.db"), "request_receipts_meta"))
        .toBe(REQUEST_RECEIPTS_N1_SCHEMA_HASH);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("initial prepare refuses an unjournaled mixed vault with receipts already current", async () => {
    const root = await materialized();
    try {
      await migratePreparedHomeStores({ stateRoot: root });
      await expect(preflightHomeStoreMigrations({ stateRoot: root, phase: "prepare" }))
        .rejects.toThrow("requires exact N-1 schema: request-receipts.db");
      expect((await preflightHomeStoreMigrations({ stateRoot: root, phase: "prepared-retry" }))
        .every((entry) => entry.state === "current")).toBeTrue();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  for (const corruption of ["missing", "symlink", "directory", "fifo", "corrupt", "quick-check"] as const) {
    test(`refuses a ${corruption} durable store before migration`, async () => {
      const root = await materialized();
      try {
        const target = join(root, "answers.db");
        if (corruption !== "quick-check") await rm(target);
        if (corruption === "symlink") await symlink(join(root, "proposals.db"), target);
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
        await expect(preflightHomeStoreMigrations({ stateRoot: root, phase: "prepared-retry" })).rejects.toThrow();
        expect(schemaHash(join(root, "request-receipts.db"), "request_receipts_meta"))
          .toBe(REQUEST_RECEIPTS_N1_SCHEMA_HASH);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
});

async function materialized(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dome-home-store-migrations-"));
  await materializeFrozenN1Fixture({ fixtureRoot: FIXTURE, destination: root });
  return root;
}

function schemaHash(path: string, table: string): string | undefined {
  const db = new Database(path, { readonly: true, create: false });
  try { return db.query<{ schema_hash: string }, []>(`SELECT schema_hash FROM ${table}`).get()?.schema_hash; }
  finally { db.close(); }
}
