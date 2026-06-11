// AC3 lockstep — every docs/wiki/invariants/*.md must have a corresponding
// tests/invariants/<slug>.test.ts OR carry `tier: deferred` in its
// frontmatter to mark planned-not-shipped.
//
// Pinned by the substrate-as-tests scaffold (Phase 10 rebuild for v1).
// The pattern mirrors gotcha-coverage.test.ts: walk the docs surface,
// resolve frontmatter, assert structural enforcement exists or is
// explicitly deferred.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import matter from "gray-matter";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const INVARIANTS_DIR = join(REPO_ROOT, "docs", "wiki", "invariants");
const TESTS_INVARIANTS_DIR = join(REPO_ROOT, "tests", "invariants");

describe("invariant-coverage (AC3 lockstep)", async () => {
  const files = await readdir(INVARIANTS_DIR);
  const invariants = files.filter((f) => f.endsWith(".md"));

  for (const file of invariants) {
    const name = file.replace(/\.md$/, "");
    const slug = name.toLowerCase().replace(/_/g, "-");

    test(`${name} has a corresponding tests/invariants/${slug}.test.ts or is deferred`, async () => {
      const text = await readFile(join(INVARIANTS_DIR, file), "utf8");
      const fm = matter(text).data as { tier?: string; enforced_by?: unknown };
      const tier = fm.tier;

      expect(
        tier,
        `invariant ${file} is missing 'tier:' frontmatter (expected: axiom | shipped-default | deferred)`,
      ).toBeDefined();

      if (tier === "deferred") {
        // Planned-not-shipped — no structural enforcement required yet.
        return;
      }

      const testPath = join(TESTS_INVARIANTS_DIR, `${slug}.test.ts`);
      expect(
        existsSync(testPath),
        `invariant ${name} (tier: ${tier}) requires tests/invariants/${slug}.test.ts. ` +
          `Either ship the enforcement test or set tier: deferred in the invariant's frontmatter.`,
      ).toBe(true);

      const enforcedBy = (fm as { tier?: string; enforced_by?: unknown }).enforced_by;
      expect(
        Array.isArray(enforcedBy) && enforcedBy.length > 0,
        `invariant ${name} (tier: ${tier}) requires 'enforced_by:' frontmatter — ` +
          `a non-empty list of repo-relative test files that behaviorally enforce it. ` +
          `The tests/invariants/ marker is the lockstep anchor; enforced_by names the real coverage.`,
      ).toBe(true);
      for (const entry of enforcedBy as ReadonlyArray<unknown>) {
        expect(typeof entry, `${name} enforced_by entries must be strings`).toBe("string");
        expect(
          existsSync(join(REPO_ROOT, entry as string)),
          `invariant ${name} enforced_by path does not exist: ${entry}`,
        ).toBe(true);
      }
    });
  }
});
