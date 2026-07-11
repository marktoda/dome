// AC3 lockstep marker for ATTENTION_IS_DERIVED.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

describe("ATTENTION_IS_DERIVED lockstep", () => {
  test("the canonical module and invariant doc exist", () => {
    expect(existsSync(join(REPO_ROOT, "src", "attention", "attention.ts"))).toBe(true);
    expect(existsSync(join(
      REPO_ROOT,
      "docs",
      "wiki",
      "invariants",
      "ATTENTION_IS_DERIVED.md",
    ))).toBe(true);
  });
});
