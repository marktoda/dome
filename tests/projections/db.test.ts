// Smoke tests for src/projections/db.ts: the open/close lifecycle, the
// fresh-vs-existing migration verdict, the projection_meta seed row, and the
// order-insensitivity of the public hash helpers.
//
// These are real integration tests against `bun:sqlite` in tmpdirs. The
// projection store IS the SQL boundary — mocking SQLite would defeat the
// test's purpose (per the test plan).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeExtensionSetHash,
  computeProcessorVersionsHash,
  computeSchemaHash,
  openProjectionDb,
  type OpenProjectionDbResult,
  type ProjectionDb,
} from "../../src/projections/db";

const EMPTY_EXT: ReadonlyArray<{ readonly name: string; readonly version: string }> =
  [];
const EMPTY_PROCS: ReadonlyArray<{ readonly id: string; readonly version: string }> =
  [];

describe("openProjectionDb", () => {
  let root: string;
  let dbPath: string;
  let handles: ProjectionDb[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dome-projection-db-"));
    dbPath = join(root, ".dome", "state", "projection.db");
    handles = [];
  });

  afterEach(() => {
    for (const h of handles) {
      try {
        h.close();
      } catch {
        // already closed — best-effort cleanup
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("returns migration: 'fresh' on a never-before-opened path", async () => {
    const r = await openProjectionDb({
      path: dbPath,
      extensionSet: EMPTY_EXT,
      processorVersions: EMPTY_PROCS,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    handles.push(r.value.db);
    expect(r.value.migration).toBe("fresh");
  });

  it("returns migration: 'ok' on re-open with identical inputs", async () => {
    // First open populates the cache-key columns. The "fresh" path leaves
    // them NULL, so we need to do a populated-meta write first to land in
    // the "ok" branch on re-open. Use a non-empty extension set + processor
    // set so the populated path has something to hash; manually write the
    // cache-key columns through the raw handle the same way a rebuild pass
    // would.
    const exts = [{ name: "ext.a", version: "1.0.0" }];
    const procs = [{ id: "proc.a", version: "1.0.0" }];

    const first = await openProjectionDb({
      path: dbPath,
      extensionSet: exts,
      processorVersions: procs,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstResult: OpenProjectionDbResult = first.value;
    handles.push(firstResult.db);
    expect(firstResult.migration).toBe("fresh");

    // Simulate the rebuild pass writing the cache-key columns. This is what
    // the eventual `dome rebuild` would do after openProjectionDb returns
    // migration: "fresh".
    firstResult.db.raw.run(
      "UPDATE projection_meta SET extension_set_hash = ?, processor_versions_hash = ?, built_at = ?",
      [
        computeExtensionSetHash(exts),
        computeProcessorVersionsHash(procs),
        new Date().toISOString(),
      ],
    );
    firstResult.db.close();
    handles.pop();

    const second = await openProjectionDb({
      path: dbPath,
      extensionSet: exts,
      processorVersions: procs,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    handles.push(second.value.db);
    expect(second.value.migration).toBe("ok");
    // Same schema hash on both opens — schema is deterministic by DDL.
    expect(second.value.db.meta.schemaHash).toBe(firstResult.db.meta.schemaHash);
  });

  it("populates projection_meta with schema_hash on fresh open", async () => {
    const exts = [{ name: "ext.a", version: "1.0.0" }];
    const procs = [{ id: "proc.a", version: "1.0.0" }];

    const r = await openProjectionDb({
      path: dbPath,
      extensionSet: exts,
      processorVersions: procs,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    handles.push(r.value.db);

    const rows = r.value.db.raw
      .query<
        {
          schema_hash: string;
          adopted_commit: string | null;
          extension_set_hash: string | null;
          processor_versions_hash: string | null;
          built_at: string | null;
        },
        []
      >(
        "SELECT schema_hash, adopted_commit, extension_set_hash, "
          + "processor_versions_hash, built_at FROM projection_meta",
      )
      .all();
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.schema_hash).toBe(computeSchemaHash());
    // Fresh open leaves cache-key columns NULL — the eventual rebuild pass
    // populates them.
    expect(row.adopted_commit).toBeNull();
    expect(row.extension_set_hash).toBeNull();
    expect(row.processor_versions_hash).toBeNull();
    expect(row.built_at).toBeNull();
  });

  it("close() releases the handle", async () => {
    const r = await openProjectionDb({
      path: dbPath,
      extensionSet: EMPTY_EXT,
      processorVersions: EMPTY_PROCS,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    r.value.db.close();
    // A closed handle should throw on further queries — Bun's sqlite raises
    // when the connection is gone. We don't push to `handles` since we
    // already closed it.
    expect(() =>
      r.value.db.raw.query("SELECT 1").all(),
    ).toThrow();
  });
});

describe("computeExtensionSetHash", () => {
  it("is order-insensitive — same elements, different order, same hash", () => {
    const a = [
      { name: "ext.b", version: "1.0.0" },
      { name: "ext.a", version: "1.0.0" },
      { name: "ext.c", version: "2.0.0" },
    ];
    const b = [
      { name: "ext.c", version: "2.0.0" },
      { name: "ext.a", version: "1.0.0" },
      { name: "ext.b", version: "1.0.0" },
    ];
    expect(computeExtensionSetHash(a)).toBe(computeExtensionSetHash(b));
  });
});

describe("computeProcessorVersionsHash", () => {
  it("is order-insensitive — same elements, different order, same hash", () => {
    const a = [
      { id: "proc.b", version: "1.0.0" },
      { id: "proc.a", version: "1.0.0" },
      { id: "proc.c", version: "2.0.0" },
    ];
    const b = [
      { id: "proc.c", version: "2.0.0" },
      { id: "proc.a", version: "1.0.0" },
      { id: "proc.b", version: "1.0.0" },
    ];
    expect(computeProcessorVersionsHash(a)).toBe(
      computeProcessorVersionsHash(b),
    );
  });
});
