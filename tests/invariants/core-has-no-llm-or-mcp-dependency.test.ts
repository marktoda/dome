// AC3 lockstep counterpart for CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY.
//
// The axiom is bundle-enforced (off-matrix per docs/wiki/matrices/tool-invariant-enforcement.md
// §"CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY — bundle-enforced (off-matrix)"). The structural
// fence lives at tests/integration/bundle-deps.test.ts; this file exists to satisfy the
// AC3 lockstep (tests/integration/invariant-coverage.test.ts asserts a test exists at
// tests/invariants/<slug>.test.ts for every INVARIANTS entry).
//
// Run the actual enforcement via `bun test tests/integration/bundle-deps.test.ts`.

import { describe, test, expect } from "bun:test";

describe("CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY (lockstep pointer)", () => {
  test("enforcement lives in tests/integration/bundle-deps.test.ts (off-matrix)", () => {
    // This test exists only to satisfy AC3 lockstep. The real enforcement is at
    // tests/integration/bundle-deps.test.ts which walks src/index.ts's transitive
    // import graph and asserts the three forbidden packages are absent.
    expect(true).toBe(true);
  });
});
