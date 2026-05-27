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
      const fm = matter(text).data as { tier?: string };
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
    });
  }
});
