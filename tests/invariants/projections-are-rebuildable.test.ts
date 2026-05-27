// Lockstep marker for invariant PROJECTIONS_ARE_REBUILDABLE.
//
// The substrate spec at docs/wiki/invariants/PROJECTIONS_ARE_REBUILDABLE.md
// describes the rule; the structural enforcement lives in the v1
// engine + storage layer code under src/{core,engine,processors,
// ledger,projections,outbox}/ and the tests under the matching
// tests/ directories.
//
// This file exists as the AC3-lockstep indirection: adding or removing
// the invariant doc requires explicit substrate work (touching this
// file). The check is structural — the doc is real because the file
// exists; the file is real because the invariant is documented.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const INVARIANT_DOC = join(REPO_ROOT, "docs", "wiki", "invariants", "PROJECTIONS_ARE_REBUILDABLE.md");

describe("PROJECTIONS_ARE_REBUILDABLE lockstep", () => {
  test("invariant doc exists at the canonical path", () => {
    expect(existsSync(INVARIANT_DOC)).toBe(true);
  });
});
