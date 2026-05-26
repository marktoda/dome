// HOOK_DISPATCH_IS_VAULT_BOUND is off-matrix (projection-construction enforced).
// The AC3 lockstep slot points at the two integration tests that pin the
// behavior across the two v0.5-shipped projections (MCP path + AI-SDK path).
// See docs/wiki/invariants/HOOK_DISPATCH_IS_VAULT_BOUND.md §"Structural enforcement"
// and docs/wiki/matrices/tool-invariant-enforcement.md §"HOOK_DISPATCH_IS_VAULT_BOUND
// — projection-enforced (off-matrix)".

import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("HOOK_DISPATCH_IS_VAULT_BOUND (off-matrix lockstep)", () => {
  test("MCP path integration test exists at tests/integration/mcp-hook-dispatch.test.ts", () => {
    const path = join(import.meta.dir, "..", "integration", "mcp-hook-dispatch.test.ts");
    expect(existsSync(path)).toBe(true);
  });

  test("AI-SDK path integration test exists at tests/integration/ai-sdk-hook-dispatch.test.ts", () => {
    const path = join(import.meta.dir, "..", "integration", "ai-sdk-hook-dispatch.test.ts");
    expect(existsSync(path)).toBe(true);
  });
});
