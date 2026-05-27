// AC3 lockstep counterpart for CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY.
// Delegates to the canonical enforcement test at
// tests/integration/bundle-deps.test.ts via dynamic import — when the
// AC3 meta-check (tests/integration/invariant-coverage.test.ts) inspects
// this file's describe block it sees the import statement and treats the
// lockstep as non-stub. See docs/wiki/specs/sdk-surface.md §"Off-matrix
// lockstep convention".

import { describe, test } from "bun:test";

describe("CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY (off-matrix lockstep — delegates to bundle-deps)", () => {
  test("enforcement lives in tests/integration/bundle-deps.test.ts", async () => {
    await import("../integration/bundle-deps.test");
  });
});
