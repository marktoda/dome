// AC3 lockstep counterpart for HOOK_DISPATCH_IS_VAULT_BOUND.
// Delegates to the two canonical enforcement tests via dynamic import —
// one for the MCP projection path, one for the AI-SDK projection path.
// See docs/wiki/specs/sdk-surface.md §"Off-matrix lockstep convention".

import { describe, test } from "bun:test";

describe("HOOK_DISPATCH_IS_VAULT_BOUND (off-matrix lockstep — delegates to projection tests)", () => {
  test("MCP projection enforcement lives in tests/integration/mcp-hook-dispatch.test.ts", async () => {
    await import("../integration/mcp-hook-dispatch.test");
  });
  test("AI-SDK projection enforcement lives in tests/integration/ai-sdk-hook-dispatch.test.ts", async () => {
    await import("../integration/ai-sdk-hook-dispatch.test");
  });
});
