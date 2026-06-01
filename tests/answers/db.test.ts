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

  it("does not delete answers_meta when reopening a matching schema", async () => {
    const first = await openAnswersDb({ path: dbPath });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    handles.push(first.value.db);

    first.value.db.raw.run(
      "CREATE TRIGGER fail_answers_meta_delete "
        + "BEFORE DELETE ON answers_meta "
        + "BEGIN SELECT RAISE(FAIL, 'answers_meta delete is not expected'); END",
    );

    const second = await openAnswersDb({ path: dbPath });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    handles.push(second.value.db);
    expect(second.value.migration).toBe("ok");
  });
});
