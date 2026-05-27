import { describe, test } from "bun:test";

/**
 * AC3 lockstep for ADOPTED_REF_IS_SEMANTIC_CURSOR — off-matrix. Per
 * docs/wiki/specs/sdk-surface.md §"Off-matrix lockstep convention", the
 * lockstep file delegates to the canonical structural-enforcement test
 * rather than carrying a no-op stub. A regression in the linked test fails
 * the lockstep transitively.
 *
 * Enforcement test: tests/integration/sync-advances-adopted-ref.test.ts.
 */
describe("ADOPTED_REF_IS_SEMANTIC_CURSOR (off-matrix)", () => {
  test("enforced by tests/integration/sync-advances-adopted-ref.test.ts (sync loop + ref advance)", async () => {
    await import("../integration/sync-advances-adopted-ref.test");
  });
});
