import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileChange } from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { openProposalsDb, type ProposalsDb } from "../../src/proposals/db";
import {
  decideProposal,
  enqueuePendingProposal,
  getProposal,
  listProposals,
  proposalDedupeKey,
  type EnqueuePendingProposalInput,
} from "../../src/proposals/pending-proposals";

describe("proposals.db + pending-proposals", () => {
  let root: string;
  let dbPath: string;
  let handles: ProposalsDb[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dome-proposals-"));
    dbPath = join(root, ".dome", "state", "proposals.db");
    handles = [];
  });

  afterEach(() => {
    for (const h of handles) {
      try {
        h.close();
      } catch {
        // already closed
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  async function openDb(): Promise<ProposalsDb> {
    const r = await openProposalsDb({ path: dbPath });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("open failed");
    handles.push(r.value.db);
    return r.value.db;
  }

  function baseInput(
    overrides: Partial<EnqueuePendingProposalInput> = {},
  ): EnqueuePendingProposalInput {
    return {
      processorId: "dome.test.garden",
      extensionId: "test",
      runId: "run_1",
      reason: "tidy up the notes",
      changes: [
        fileChange({ kind: "write", path: "notes/a.md", content: "hello" }),
      ],
      sourceRefs: [
        sourceRef({ commit: commitOid("a".repeat(40)), path: "notes/a.md" }),
      ],
      baseCommit: "b".repeat(40),
      baseContents: { "notes/a.md": null },
      createdAt: "2026-07-06T00:00:00.000Z",
      ...overrides,
    };
  }

  it("returns migration: 'fresh' on a never-before-opened path", async () => {
    const r = await openProposalsDb({ path: dbPath });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    handles.push(r.value.db);
    expect(r.value.migration).toBe("fresh");
  });

  it("reopening a matching schema is 'ok' and preserves rows", async () => {
    const db = await openDb();
    enqueuePendingProposal(db, baseInput());
    db.close();
    handles = [];

    const r2 = await openProposalsDb({ path: dbPath });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    handles.push(r2.value.db);
    expect(r2.value.migration).toBe("ok");
    expect(listProposals(r2.value.db)).toHaveLength(1);
  });

  it("refuses on schema-hash mismatch", async () => {
    const db = await openDb();
    db.raw.run("DELETE FROM proposals_meta");
    db.raw.run(
      "INSERT INTO proposals_meta (schema_hash, built_at) VALUES ('deadbeef', ?)",
      [new Date().toISOString()],
    );
    db.close();
    handles = [];

    const r2 = await openProposalsDb({ path: dbPath });
    expect(r2.ok).toBe(false);
  });

  it("enqueue inserts and returns an id", async () => {
    const db = await openDb();
    const result = enqueuePendingProposal(db, baseInput());
    expect(result.inserted).toBe(true);
    expect(typeof result.id).toBe("number");
  });

  it("identical enqueue (same processorId + changes) is inserted:false and returns the existing id", async () => {
    const db = await openDb();
    const first = enqueuePendingProposal(db, baseInput());
    expect(first.inserted).toBe(true);

    const second = enqueuePendingProposal(db, baseInput({ runId: "run_2" }));
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);

    expect(listProposals(db)).toHaveLength(1);
  });

  it("proposalDedupeKey is stable across change order but sensitive to content", () => {
    const changesA = [
      fileChange({ kind: "write", path: "b.md", content: "2" }),
      fileChange({ kind: "write", path: "a.md", content: "1" }),
    ];
    const changesB = [
      fileChange({ kind: "write", path: "a.md", content: "1" }),
      fileChange({ kind: "write", path: "b.md", content: "2" }),
    ];
    expect(proposalDedupeKey("p", changesA)).toBe(
      proposalDedupeKey("p", changesB),
    );

    const changesC = [
      fileChange({ kind: "write", path: "a.md", content: "different" }),
      fileChange({ kind: "write", path: "b.md", content: "2" }),
    ];
    expect(proposalDedupeKey("p", changesA)).not.toBe(
      proposalDedupeKey("p", changesC),
    );

    expect(proposalDedupeKey("p1", changesA)).not.toBe(
      proposalDedupeKey("p2", changesA),
    );
  });

  it("list filters by status and orders newest-first", async () => {
    const db = await openDb();
    const a = enqueuePendingProposal(
      db,
      baseInput({ createdAt: "2026-07-06T00:00:00.000Z" }),
    );
    const b = enqueuePendingProposal(
      db,
      baseInput({
        createdAt: "2026-07-06T01:00:00.000Z",
        changes: [
          fileChange({ kind: "write", path: "notes/b.md", content: "other" }),
        ],
      }),
    );
    if (a.id === null || b.id === null) throw new Error("expected ids");

    decideProposal(db, {
      id: a.id,
      status: "rejected",
      decidedBy: "owner",
      decidedAt: "2026-07-06T02:00:00.000Z",
    });

    const all = listProposals(db);
    expect(all.map((p) => p.id)).toEqual([b.id, a.id]);

    const pending = listProposals(db, { status: "pending" });
    expect(pending.map((p) => p.id)).toEqual([b.id]);

    const rejected = listProposals(db, { status: "rejected" });
    expect(rejected.map((p) => p.id)).toEqual([a.id]);

    const limited = listProposals(db, { limit: 1 });
    expect(limited.map((p) => p.id)).toEqual([b.id]);
  });

  it("decide CAS applies once and refuses a second decide", async () => {
    const db = await openDb();
    const inserted = enqueuePendingProposal(db, baseInput());
    if (inserted.id === null) throw new Error("expected id");

    const first = decideProposal(db, {
      id: inserted.id,
      status: "applied",
      decidedBy: "owner",
      appliedCommit: "c".repeat(40),
      decidedAt: "2026-07-06T03:00:00.000Z",
    });
    expect(first).toBe(true);

    const second = decideProposal(db, {
      id: inserted.id,
      status: "rejected",
      decidedBy: "owner",
      decidedAt: "2026-07-06T04:00:00.000Z",
    });
    expect(second).toBe(false);

    const row = getProposal(db, inserted.id);
    expect(row?.status).toBe("applied");
    expect(row?.appliedCommit).toBe("c".repeat(40));
    expect(row?.decidedBy).toBe("owner");
  });

  it("decide on an unknown id returns false", async () => {
    const db = await openDb();
    const result = decideProposal(db, {
      id: 9999,
      status: "applied",
      decidedBy: "owner",
      decidedAt: "2026-07-06T05:00:00.000Z",
    });
    expect(result).toBe(false);
  });

  it("round-trips changes, sourceRefs, and baseContents through JSON storage", async () => {
    const db = await openDb();
    const changes = [
      fileChange({ kind: "write", path: "notes/a.md", content: "hello" }),
      fileChange({ kind: "delete", path: "notes/old.md" }),
    ];
    const sourceRefs = [
      sourceRef({ commit: commitOid("a".repeat(40)), path: "notes/a.md" }),
    ];
    const baseContents = { "notes/a.md": "prior content", "notes/old.md": null };

    const inserted = enqueuePendingProposal(
      db,
      baseInput({ changes, sourceRefs, baseContents }),
    );
    if (inserted.id === null) throw new Error("expected id");

    const row = getProposal(db, inserted.id);
    expect(row).not.toBeNull();
    expect(row?.changes).toEqual(changes);
    expect(row?.sourceRefs).toEqual(sourceRefs);
    expect(row?.baseContents).toEqual(baseContents);
  });

  it("a rejected row stays rejected when the same patch is re-enqueued", async () => {
    const db = await openDb();
    const inserted = enqueuePendingProposal(db, baseInput());
    if (inserted.id === null) throw new Error("expected id");

    decideProposal(db, {
      id: inserted.id,
      status: "rejected",
      decidedBy: "owner",
      decidedAt: "2026-07-06T06:00:00.000Z",
    });

    const reEnqueued = enqueuePendingProposal(db, baseInput({ runId: "run_3" }));
    expect(reEnqueued.inserted).toBe(false);
    expect(reEnqueued.id).toBe(inserted.id);

    const row = getProposal(db, inserted.id);
    expect(row?.status).toBe("rejected");
  });

  it("re-enqueuing identical changes against a pending row refreshes its recorded base (stale-pending wedge)", async () => {
    const db = await openDb();
    const first = enqueuePendingProposal(
      db,
      baseInput({
        baseCommit: "b".repeat(40),
        baseContents: { "notes/a.md": "old base" },
        createdAt: "2026-07-06T00:00:00.000Z",
      }),
    );
    expect(first.inserted).toBe(true);
    expect(first.refreshed).toBe(false);
    if (first.id === null) throw new Error("expected id");

    const second = enqueuePendingProposal(
      db,
      baseInput({
        runId: "run_2",
        baseCommit: "c".repeat(40),
        baseContents: { "notes/a.md": "new base" },
        createdAt: "2026-07-06T05:00:00.000Z",
      }),
    );

    expect(second.inserted).toBe(false);
    expect(second.refreshed).toBe(true);
    expect(second.id).toBe(first.id);

    const row = getProposal(db, first.id);
    expect(row?.id).toBe(first.id);
    expect(row?.baseContents).toEqual({ "notes/a.md": "new base" });
    expect(row?.baseCommit).toBe("c".repeat(40));
    // created_at, status, and changes are untouched by a refresh.
    expect(row?.createdAt).toBe("2026-07-06T00:00:00.000Z");
    expect(row?.status).toBe("pending");
    expect(row?.changes).toEqual(baseInput().changes);

    expect(listProposals(db)).toHaveLength(1);
  });

  it("re-enqueuing identical changes against a rejected row does not refresh its base", async () => {
    const db = await openDb();
    const inserted = enqueuePendingProposal(
      db,
      baseInput({ baseContents: { "notes/a.md": "original base" } }),
    );
    if (inserted.id === null) throw new Error("expected id");

    decideProposal(db, {
      id: inserted.id,
      status: "rejected",
      decidedBy: "owner",
      decidedAt: "2026-07-06T06:00:00.000Z",
    });

    const reEnqueued = enqueuePendingProposal(
      db,
      baseInput({
        runId: "run_3",
        baseContents: { "notes/a.md": "attempted new base" },
      }),
    );

    expect(reEnqueued.inserted).toBe(false);
    expect(reEnqueued.refreshed).toBe(false);
    expect(reEnqueued.id).toBe(inserted.id);

    const row = getProposal(db, inserted.id);
    expect(row?.status).toBe("rejected");
    expect(row?.baseContents).toEqual({ "notes/a.md": "original base" });
  });

  it("re-enqueuing identical changes against an applied row does not refresh its base", async () => {
    const db = await openDb();
    const inserted = enqueuePendingProposal(
      db,
      baseInput({ baseContents: { "notes/a.md": "original base" } }),
    );
    if (inserted.id === null) throw new Error("expected id");

    decideProposal(db, {
      id: inserted.id,
      status: "applied",
      decidedBy: "owner",
      appliedCommit: "c".repeat(40),
      decidedAt: "2026-07-06T06:00:00.000Z",
    });

    const reEnqueued = enqueuePendingProposal(
      db,
      baseInput({
        runId: "run_3",
        baseContents: { "notes/a.md": "attempted new base" },
      }),
    );

    expect(reEnqueued.inserted).toBe(false);
    expect(reEnqueued.refreshed).toBe(false);
    expect(reEnqueued.id).toBe(inserted.id);

    const row = getProposal(db, inserted.id);
    expect(row?.status).toBe("applied");
    expect(row?.baseContents).toEqual({ "notes/a.md": "original base" });
  });
});
