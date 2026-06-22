import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAnswersDb, type AnswersDb } from "../../src/answers/db";

describe("openAnswersDb", () => {
  let root: string;
  let dbPath: string;
  let handles: AnswersDb[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dome-answers-open-"));
    dbPath = join(root, ".dome", "state", "answers.db");
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

  it("returns migration: 'fresh' on a never-before-opened path", async () => {
    const r = await openAnswersDb({ path: dbPath });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    handles.push(r.value.db);
    expect(r.value.migration).toBe("fresh");
  });

  it("configures a busy timeout for concurrent readers", async () => {
    const r = await openAnswersDb({ path: dbPath });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    handles.push(r.value.db);
    const row = r.value.db.raw
      .query<{ timeout: number }, []>("PRAGMA busy_timeout")
      .get();
    expect(row?.timeout).toBe(5000);
  });

  // Reopening a matching schema preserves durable answer rows. The meta row is
  // now replaced via DELETE+INSERT in a tx (the shared seam's mechanic — see
  // docs/superpowers/plans/2026-06-22-store-opener-deepening.md), which is
  // observably equivalent: one meta row, current hash. The contract that
  // matters is that durable question_answers rows survive — not the meta SQL.
  it("reopening a matching schema preserves durable answer rows", async () => {
    const first = await openAnswersDb({ path: dbPath });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    first.value.db.raw.run(
      "INSERT INTO question_answers "
        + "(idempotency_key, answer, answered_at, question, processor_id, adopted_commit) "
        + "VALUES (?, ?, ?, ?, ?, ?)",
      ["k1", "yes", "2026-06-22T00:00:00Z", "Ship it?", "dome.test", "abc123"],
    );
    first.value.db.close();

    const second = await openAnswersDb({ path: dbPath });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    handles.push(second.value.db);
    expect(second.value.migration).toBe("ok");

    const row = second.value.db.raw
      .query<{ answer: string }, []>(
        "SELECT answer FROM question_answers WHERE idempotency_key = 'k1'",
      )
      .get();
    expect(row?.answer).toBe("yes");
    const meta = second.value.db.raw
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM answers_meta")
      .get();
    expect(meta?.c).toBe(1);
  });
});
