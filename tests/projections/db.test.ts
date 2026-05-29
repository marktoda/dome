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
  markProjectionBuilt,
  openProjectionDb,
  projectionCacheKeysChanged,
  projectionRequiresRebuild,
  resetProjectionDb,
  type OpenProjectionDbResult,
  type ProjectionDb,
} from "../../src/projections/db";
import { commitOid } from "../../src/core/source-ref";

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

    markProjectionBuilt(firstResult.db, {
      adoptedCommit: commitOid("abc1230000000000000000000000000000000000"),
      extensionSet: exts,
      processorVersions: procs,
      builtAt: new Date("2026-05-28T00:00:00.000Z"),
    });
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

  it("resetProjectionDb wipes projection tables and markProjectionBuilt stamps cache keys", async () => {
    const exts = [{ name: "ext.a", version: "1.0.0" }];
    const procs = [{ id: "proc.a", version: "1.0.0" }];
    const adopted = commitOid("def4560000000000000000000000000000000000");
    const r = await openProjectionDb({
      path: dbPath,
      extensionSet: exts,
      processorVersions: procs,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    handles.push(r.value.db);

    r.value.db.raw.run(
      "INSERT INTO facts (namespace, subject_kind, subject_id, predicate, "
        + "object_json, assertion, source_refs, processor_id, adopted_commit, "
        + "written_at) VALUES ('dome.test', 'page', 'wiki/x.md', "
        + "'dome.test.p', '{\"kind\":\"string\",\"value\":\"x\"}', "
        + "'explicit', '[]', 'p1', ?, ?)",
      [adopted, new Date().toISOString()],
    );
    expect(
      r.value.db.raw.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM facts").get()
        ?.count,
    ).toBe(1);

    resetProjectionDb(r.value.db);
    expect(
      r.value.db.raw.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM facts").get()
        ?.count,
    ).toBe(0);

    markProjectionBuilt(r.value.db, {
      adoptedCommit: adopted,
      extensionSet: exts,
      processorVersions: procs,
      builtAt: new Date("2026-05-28T00:00:00.000Z"),
    });
    const meta = r.value.db.raw
      .query<
        {
          adopted_commit: string | null;
          extension_set_hash: string | null;
          processor_versions_hash: string | null;
          built_at: string | null;
        },
        []
      >(
        "SELECT adopted_commit, extension_set_hash, processor_versions_hash, built_at FROM projection_meta",
      )
      .get();
    expect(meta?.adopted_commit).toBe(adopted);
    expect(meta?.extension_set_hash).toBe(computeExtensionSetHash(exts));
    expect(meta?.processor_versions_hash).toBe(
      computeProcessorVersionsHash(procs),
    );
    expect(meta?.built_at).toBe("2026-05-28T00:00:00.000Z");
  });

  it("projectionCacheKeysChanged reports only populated cache-key drift", async () => {
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

    expect(
      projectionCacheKeysChanged(r.value.db, {
        extensionSet: exts,
        processorVersions: procs,
      }),
    ).toBe(false);

    markProjectionBuilt(r.value.db, {
      adoptedCommit: commitOid("def4560000000000000000000000000000000000"),
      extensionSet: exts,
      processorVersions: procs,
      builtAt: new Date("2026-05-28T00:00:00.000Z"),
    });
    expect(
      projectionCacheKeysChanged(r.value.db, {
        extensionSet: exts,
        processorVersions: procs,
      }),
    ).toBe(false);
    expect(
      projectionCacheKeysChanged(r.value.db, {
        extensionSet: exts,
        processorVersions: [{ id: "proc.a", version: "1.1.0" }],
      }),
    ).toBe(true);
    expect(
      projectionCacheKeysChanged(r.value.db, {
        extensionSet: [{ name: "ext.a", version: "2.0.0" }],
        processorVersions: procs,
      }),
    ).toBe(true);
  });

  it("projectionRequiresRebuild treats unbuilt, commit drift, and cache drift as stale", async () => {
    const exts = [{ name: "ext.a", version: "1.0.0" }];
    const procs = [{ id: "proc.a", version: "1.0.0" }];
    const adopted = commitOid("def4560000000000000000000000000000000000");
    const r = await openProjectionDb({
      path: dbPath,
      extensionSet: exts,
      processorVersions: procs,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    handles.push(r.value.db);

    expect(
      projectionRequiresRebuild(r.value.db, {
        adoptedCommit: adopted,
        extensionSet: exts,
        processorVersions: procs,
      }),
    ).toBe(true);

    markProjectionBuilt(r.value.db, {
      adoptedCommit: adopted,
      extensionSet: exts,
      processorVersions: procs,
      builtAt: new Date("2026-05-28T00:00:00.000Z"),
    });
    expect(
      projectionRequiresRebuild(r.value.db, {
        adoptedCommit: adopted,
        extensionSet: exts,
        processorVersions: procs,
      }),
    ).toBe(false);
    expect(
      projectionRequiresRebuild(r.value.db, {
        adoptedCommit: commitOid("abc1230000000000000000000000000000000000"),
        extensionSet: exts,
        processorVersions: procs,
      }),
    ).toBe(true);
    expect(
      projectionRequiresRebuild(r.value.db, {
        adoptedCommit: adopted,
        extensionSet: exts,
        processorVersions: [{ id: "proc.a", version: "1.1.0" }],
      }),
    ).toBe(true);
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
