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
});
