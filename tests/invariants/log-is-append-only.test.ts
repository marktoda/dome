// Lockstep marker for invariant LOG_IS_APPEND_ONLY.
//
// The substrate spec at docs/wiki/invariants/LOG_IS_APPEND_ONLY.md
// describes the rule. As of 2026-06-11 log.md is FROZEN (zero appends —
// the degenerate append-only case; the planned dome.log projection is
// retired per NO_ACCRETING_REGISTRIES), so the behavioral enforcement
// lives in tests/invariants/no-accreting-registries.test.ts and
// tests/extensions/dome.agent/grant-aware-tools.test.ts.
//
// This file exists as the AC3-lockstep indirection: adding or removing
// the invariant doc requires explicit substrate work (touching this
// file). The check is structural — the doc is real because the file
// exists; the file is real because the invariant is documented.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const INVARIANT_DOC = join(REPO_ROOT, "docs", "wiki", "invariants", "LOG_IS_APPEND_ONLY.md");

describe("LOG_IS_APPEND_ONLY lockstep", () => {
  test("invariant doc exists at the canonical path", () => {
    expect(existsSync(INVARIANT_DOC)).toBe(true);
  });
});
