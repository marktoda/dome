// Lockstep marker for invariant ORPHAN_RECOVERED_RUNS_ARE_SUPPRESSED.
//
// The substrate spec at
// docs/wiki/invariants/ORPHAN_RECOVERED_RUNS_ARE_SUPPRESSED.md describes the
// rule; the structural enforcement lives in src/ledger/runs.ts
// (LATEST_ACTIVE_PROBLEM_WHERE_SQL, isRecoveredOrphanRun,
// ORPHAN_RUN_RECOVERY_ERROR_REASON) and the processor at
// assets/extensions/dome.health/processors/orphan-run-recovery-answer.ts.
//
// This file exists as the AC3-lockstep indirection: adding or removing the
// invariant doc requires explicit substrate work (touching this file). The
// check is structural — the doc is real because the file exists; the file
// is real because the invariant is documented.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const INVARIANT_DOC = join(
  REPO_ROOT,
  "docs",
  "wiki",
  "invariants",
  "ORPHAN_RECOVERED_RUNS_ARE_SUPPRESSED.md",
);

describe("ORPHAN_RECOVERED_RUNS_ARE_SUPPRESSED lockstep", () => {
  test("invariant doc exists at the canonical path", () => {
    expect(existsSync(INVARIANT_DOC)).toBe(true);
  });
});
