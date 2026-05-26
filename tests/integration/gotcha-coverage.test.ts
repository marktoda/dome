// AC3-lockstep test for gotcha coverage. Parallel to the
// invariant-coverage test: every docs/wiki/gotchas/*.md file's
// `coverage:` frontmatter drives what we require.
//
// - coverage: matrix → assert tests/gotchas/<slug>.test.ts exists
// - coverage: off-matrix → skip (structural mitigation named elsewhere)
// - coverage: deferred → emit a console warning, do not fail
// - coverage missing → fail (frontmatter must declare)
//
// See docs/wiki/specs/page-schema.md §"Extension types" for the convention.

import { describe, test, expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const GOTCHA_DIR = join(REPO_ROOT, "docs", "wiki", "gotchas");
const TESTS_GOTCHA_DIR = join(REPO_ROOT, "tests", "gotchas");

const VALID_COVERAGE = new Set(["matrix", "off-matrix", "deferred"]);

describe("gotcha-coverage (AC3-lockstep)", async () => {
  const files = await readdir(GOTCHA_DIR);
  const gotchas = files.filter(f => f.endsWith(".md"));

  for (const file of gotchas) {
    const slug = file.replace(/\.md$/, "");
    test(`${slug} declares coverage and (if matrix) has tests/gotchas/${slug}.test.ts`, async () => {
      const text = await readFile(join(GOTCHA_DIR, file), "utf8");
      const fm = matter(text).data as { coverage?: string };
      const coverage = fm.coverage;

      expect(coverage,
        `gotcha ${file} is missing 'coverage:' frontmatter — see page-schema.md §"Extension types"`).toBeDefined();
      expect(VALID_COVERAGE.has(coverage!),
        `gotcha ${file} has invalid coverage: "${coverage}"; must be matrix | off-matrix | deferred`).toBe(true);

      if (coverage === "matrix") {
        const testPath = join(TESTS_GOTCHA_DIR, `${slug}.test.ts`);
        expect(existsSync(testPath),
          `gotcha ${slug} declares coverage: matrix but tests/gotchas/${slug}.test.ts does not exist`).toBe(true);
      }
      if (coverage === "deferred") {
        console.warn(`gotcha-coverage: ${slug} has coverage: deferred — promote to matrix when the test ships`);
      }
    });
  }
});
