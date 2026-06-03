// Normative substrate docs should not point at deleted test files.
//
// Historical review and delta-ledger documents can preserve stale references
// as archive, but the surfaces contributors are told to trust before changing
// code must name tests that exist.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SUBSTRATE_ROOTS = Object.freeze([
  join(REPO_ROOT, "docs", "wiki", "invariants"),
  join(REPO_ROOT, "docs", "wiki", "specs"),
  join(REPO_ROOT, "docs", "wiki", "matrices"),
  join(REPO_ROOT, "docs", "wiki", "gotchas"),
  join(REPO_ROOT, "docs", "wiki", "linters"),
]);

const TEST_REF_RE = /tests\/[A-Za-z0-9_./<>-]+\.test\.ts/g;
const PLANNED_RE =
  /\b(Planned|planned|future|should|until|Required test guarantee)\b/;

describe("substrate docs test references", () => {
  test("active test references in normative substrate docs exist", async () => {
    const missing: string[] = [];
    for (const root of SUBSTRATE_ROOTS) {
      const files = await readdir(root);
      for (const file of files.filter((name) => name.endsWith(".md"))) {
        const path = join(root, file);
        const raw = await readFile(path, "utf8");
        const parsed = matter(raw);
        if (isDeferredOrProposed(parsed.data)) continue;
        const lines = parsed.content.split("\n");
        for (const [index, line] of lines.entries()) {
          if (PLANNED_RE.test(line)) continue;
          for (const match of line.matchAll(TEST_REF_RE)) {
            const ref = match[0];
            if (ref.includes("<")) continue;
            if (!existsSync(join(REPO_ROOT, ref))) {
              missing.push(`${path}:${index + 1}: ${ref}`);
            }
          }
        }
      }
    }

    expect(missing).toEqual([]);
  });
});

function isDeferredOrProposed(data: Record<string, unknown>): boolean {
  return data.enforced_at_status === "deferred" ||
    (typeof data.status === "string" && data.status.includes("proposed"));
}
