// Tests for the shared store-opener seam (prepareStore + openSimpleStore).
// Plan: docs/superpowers/plans/2026-06-22-store-opener-deepening.md (Task 1).
// The SQLite boundary must hit real I/O, so these use a real temp dir.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  prepareStore,
  openSimpleStore,
  type SimpleStorePolicy,
} from "../../src/sqlite/open-store";
import { computeDdlHash } from "../../src/sqlite/hash";

const META = "x_meta";

function ddl(withIndex: boolean): ReadonlyArray<string> {
  const base = [
    `CREATE TABLE IF NOT EXISTS ${META} (schema_hash TEXT NOT NULL PRIMARY KEY, built_at TEXT NOT NULL)`,
    "CREATE TABLE IF NOT EXISTS x (id INTEGER PRIMARY KEY, v TEXT)",
  ];
  return withIndex
    ? [...base, "CREATE INDEX IF NOT EXISTS x_by_v ON x(v)"]
    : base;
}

const SHAPES = [
  { table: META, columns: ["schema_hash", "built_at"] },
  { table: "x", columns: ["id", "v"] },
];

const HASH_A = computeDdlHash(ddl(false));
const HASH_B = computeDdlHash(ddl(true));

function simpleSpec(
  path: string,
  opts: { withIndex: boolean; policy: SimpleStorePolicy },
) {
  return {
    path,
    metaTable: META,
    ddl: ddl(opts.withIndex),
    currentHash: opts.withIndex ? HASH_B : HASH_A,
    shapes: SHAPES,
    policy: opts.policy,
  };
}

describe("store-opener seam", () => {
  let root: string;
  let dbPath: string;
  const open: Database[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dome-open-store-"));
    dbPath = join(root, ".dome", "state", "x.db");
  });

  afterEach(() => {
    for (const db of open.splice(0)) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  describe("prepareStore", () => {
    it("reports a fresh file (no meta table) as isFresh, storedHash null", () => {
      const r = prepareStore({ path: dbPath, metaTable: META, currentHash: HASH_A });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      open.push(r.value.raw);
      expect(r.value.storedHash).toBeNull();
      expect(r.value.isFresh).toBe(true);
      expect(r.value.isSchemaChanged).toBe(false);
      expect(r.value.currentHash).toBe(HASH_A);
    });

    it("reads a stored hash and flags a mismatch as isSchemaChanged", () => {
      // Seed a meta table + row by hand.
      mkdirSync(dirname(dbPath), { recursive: true });
      const seed = new Database(dbPath);
      seed.run(`CREATE TABLE ${META} (schema_hash TEXT, built_at TEXT)`);
      seed.run(`INSERT INTO ${META} (schema_hash, built_at) VALUES (?, ?)`, [
        "stored-hash",
        "t",
      ]);
      seed.close();

      const r = prepareStore({ path: dbPath, metaTable: META, currentHash: HASH_A });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      open.push(r.value.raw);
      expect(r.value.storedHash).toBe("stored-hash");
      expect(r.value.isFresh).toBe(false);
      expect(r.value.isSchemaChanged).toBe(true);
    });

    it("returns directory-create-failed when the parent path is a file", () => {
      const blocker = join(root, "blocker");
      writeFileSync(blocker, "x");
      const r = prepareStore({
        path: join(blocker, "sub", "x.db"),
        metaTable: META,
        currentHash: HASH_A,
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe("directory-create-failed");
    });

    it("honors foreignKeys: true", () => {
      const r = prepareStore({
        path: dbPath,
        metaTable: META,
        currentHash: HASH_A,
        foreignKeys: true,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      open.push(r.value.raw);
      const row = r.value.raw
        .query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
        .get();
      expect(row?.foreign_keys).toBe(1);
    });
  });

  describe("openSimpleStore", () => {
    it("fresh open: migration 'fresh', exactly one meta row, shape valid", () => {
      const r = openSimpleStore(simpleSpec(dbPath, { withIndex: false, policy: { kind: "refuse" } }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      open.push(r.value.raw);
      expect(r.value.migration).toBe("fresh");
      expect(r.value.schemaHash).toBe(HASH_A);
      const rows = r.value.raw.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM ${META}`).get();
      expect(rows?.c).toBe(1);
    });

    it("reopen with matching schema: migration 'ok'", () => {
      const first = openSimpleStore(simpleSpec(dbPath, { withIndex: false, policy: { kind: "refuse" } }));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      first.value.raw.close();
      const second = openSimpleStore(simpleSpec(dbPath, { withIndex: false, policy: { kind: "refuse" } }));
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      open.push(second.value.raw);
      expect(second.value.migration).toBe("ok");
    });

    it("refuse policy: schema-mismatch on hash change, handle closed, file unmutated", () => {
      const first = openSimpleStore(simpleSpec(dbPath, { withIndex: false, policy: { kind: "refuse" } }));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      first.value.raw.close();

      const changed = openSimpleStore(simpleSpec(dbPath, { withIndex: true, policy: { kind: "refuse" } }));
      expect(changed.ok).toBe(false);
      if (changed.ok) return;
      expect(changed.error.kind).toBe("schema-mismatch");

      // File unmutated: reopening at the ORIGINAL schema still reports 'ok'.
      const reopened = openSimpleStore(simpleSpec(dbPath, { withIndex: false, policy: { kind: "refuse" } }));
      expect(reopened.ok).toBe(true);
      if (!reopened.ok) return;
      open.push(reopened.value.raw);
      expect(reopened.value.migration).toBe("ok");
    });

    it("migrate policy: tryMigrate handled -> migration 'migrated', receives stored hash", () => {
      const first = openSimpleStore(simpleSpec(dbPath, { withIndex: false, policy: { kind: "refuse" } }));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      first.value.raw.close();

      let seen: string | null = null;
      const migrated = openSimpleStore(
        simpleSpec(dbPath, {
          withIndex: true,
          policy: {
            kind: "migrate",
            tryMigrate: (_db, storedHash) => {
              seen = storedHash;
              return true;
            },
          },
        }),
      );
      expect(migrated.ok).toBe(true);
      if (!migrated.ok) return;
      open.push(migrated.value.raw);
      expect(migrated.value.migration).toBe("migrated");
      expect(seen).toBe(HASH_A);
    });

    it("migrate policy: tryMigrate declines -> schema-mismatch", () => {
      const first = openSimpleStore(simpleSpec(dbPath, { withIndex: false, policy: { kind: "refuse" } }));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      first.value.raw.close();

      const declined = openSimpleStore(
        simpleSpec(dbPath, {
          withIndex: true,
          policy: { kind: "migrate", tryMigrate: () => false },
        }),
      );
      expect(declined.ok).toBe(false);
      if (declined.ok) return;
      expect(declined.error.kind).toBe("schema-mismatch");
    });
  });
});
