import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY,
  ANSWERS_SCHEMA_HASH_BEFORE_AGENT_CONTEXT,
  openAnswersDb,
  type AnswersDb,
} from "../../src/answers/db";

// The current-main `question_answers` CREATE TABLE, verbatim, from before the
// `answered_by` column existed — used to hand-construct a legacy answers.db
// for the migration test below.
const OLD_QUESTION_ANSWERS_DDL =
  "CREATE TABLE question_answers ("
    + "idempotency_key TEXT PRIMARY KEY,"
    + "answer TEXT NOT NULL,"
    + "answered_at TEXT NOT NULL,"
    + "question_id INTEGER,"
    + "question TEXT NOT NULL,"
    + "processor_id TEXT NOT NULL,"
    + "adopted_commit TEXT NOT NULL,"
    + "handler_status TEXT NOT NULL DEFAULT 'pending',"
    + "handler_attempts INTEGER NOT NULL DEFAULT 0,"
    + "last_handler_attempt_at TEXT,"
    + "handled_at TEXT,"
    + "last_handler_error TEXT"
    + ")";

const PRE_AGENT_CONTEXT_DDL = OLD_QUESTION_ANSWERS_DDL.replace(
  "handler_status TEXT NOT NULL DEFAULT 'pending',",
  "answered_by TEXT NOT NULL DEFAULT 'owner'," +
    "handler_status TEXT NOT NULL DEFAULT 'pending',",
);

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

  it("answered_by migration: an old-schema answers.db opens, migrates in place, and preserves rows as 'owner'", async () => {
    mkdirSync(join(root, ".dome", "state"), { recursive: true });
    const legacy = new Database(dbPath, { create: true });
    legacy.run(OLD_QUESTION_ANSWERS_DDL);
    legacy.run(
      "CREATE TABLE answers_meta (schema_hash TEXT NOT NULL PRIMARY KEY, built_at TEXT NOT NULL)",
    );
    legacy.run(
      "INSERT INTO answers_meta (schema_hash, built_at) VALUES (?, ?)",
      [ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY, "2026-01-01T00:00:00.000Z"],
    );
    legacy.run(
      "INSERT INTO question_answers (idempotency_key, answer, answered_at, question_id, question, processor_id, adopted_commit) VALUES ('k1','yes','2026-06-01T00:00:00.000Z',1,'q?','p','c')",
    );
    legacy.close();

    const result = await openAnswersDb({ path: dbPath });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("open failed");
    handles.push(result.value.db);
    expect(result.value.migration).toBe("migrated");
    const row = result.value.db.raw
      .query<{ answered_by: string }, []>(
        "SELECT answered_by FROM question_answers WHERE idempotency_key = 'k1'",
      )
      .get();
    expect(row?.answered_by).toBe("owner");
  });

  it("agent-context migration preserves current answers and adds nullable provenance", async () => {
    mkdirSync(join(root, ".dome", "state"), { recursive: true });
    const legacy = new Database(dbPath, { create: true });
    legacy.run(PRE_AGENT_CONTEXT_DDL);
    legacy.run(
      "CREATE TABLE answers_meta (schema_hash TEXT NOT NULL PRIMARY KEY, built_at TEXT NOT NULL)",
    );
    legacy.run(
      "INSERT INTO answers_meta (schema_hash, built_at) VALUES (?, ?)",
      [ANSWERS_SCHEMA_HASH_BEFORE_AGENT_CONTEXT, "2026-07-08T00:00:00.000Z"],
    );
    legacy.run(
      "INSERT INTO question_answers (idempotency_key, answer, answered_at, question_id, question, processor_id, adopted_commit, answered_by) VALUES ('k1','yes','2026-07-08T00:00:00.000Z',1,'q?','p','c','owner')",
    );
    legacy.close();

    const result = await openAnswersDb({ path: dbPath });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("open failed");
    handles.push(result.value.db);
    expect(result.value.migration).toBe("migrated");
    const row = result.value.db.raw
      .query<{ answer: string; answer_context_json: string | null }, []>(
        "SELECT answer, answer_context_json FROM question_answers WHERE idempotency_key = 'k1'",
      )
      .get();
    expect(row).toEqual({ answer: "yes", answer_context_json: null });
  });

  it("answered_by migration: an unknown stored hash still refuses", async () => {
    mkdirSync(join(root, ".dome", "state"), { recursive: true });
    const legacy = new Database(dbPath, { create: true });
    legacy.run(OLD_QUESTION_ANSWERS_DDL);
    legacy.run(
      "CREATE TABLE answers_meta (schema_hash TEXT NOT NULL PRIMARY KEY, built_at TEXT NOT NULL)",
    );
    legacy.run(
      "INSERT INTO answers_meta (schema_hash, built_at) VALUES (?, ?)",
      ["deadbeef", "2026-01-01T00:00:00.000Z"],
    );
    legacy.close();

    const result = await openAnswersDb({ path: dbPath });
    expect(result.ok).toBe(false);
  });
});
